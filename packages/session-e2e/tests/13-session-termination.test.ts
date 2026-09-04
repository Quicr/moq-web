// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Draft-18 §3.5 inbound Session Termination + §3.6 Migration surface tests.
 *
 * These tests don't require the relay to actively terminate or issue GOAWAY
 * with a `newSessionUri` — we drive the client-side event plumbing via the
 * private `handleIncomingGoAwayDraft18` path and via `session.close()`. That
 * proves:
 *   - the `session-terminated` event exists and does not fire for local closes
 *   - GOAWAY with a `newSessionUri` populates `pendingMigrationUri`
 *   - `migrate()` rejects with a clear error in main-thread mode
 *
 * A full over-the-wire migration test needs coordinated dual-relay support and
 * is out of scope for the browser CI matrix; see docs/draft-18-interop-plan.md.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { MessageTypeDraft18 } from '@moq-web/core';

import { makeSession, type SessionHandle } from '../lib/session-factory.js';
import { resolveProfile, type Profile } from '../lib/profile.js';
import chatStream from '../profiles/chat-stream.json';
import chatDatagram from '../profiles/chat-datagram.json';

const MOQT_VERSION = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_MOQT_VERSION ?? 'draft-18';
const isDraft18 = MOQT_VERSION === 'draft-18';

describe.skipIf(!isDraft18).each([
  ['chat-stream', chatStream as Profile],
  ['chat-datagram', chatDatagram as Profile],
])('Session termination + migration [%s]', (_label, raw) => {
  let handle: SessionHandle | undefined;

  afterEach(async () => {
    try { await handle?.close(); } catch { /* ignore */ }
    handle = undefined;
  });

  it('local session.close() does NOT emit session-terminated', async () => {
    const profile = resolveProfile(raw);
    handle = await makeSession(profile);

    const events: Array<{ code: number; remote: boolean }> = [];
    handle.session.on('session-terminated', (e) => events.push(e));

    await handle.session.close();
    // Allow the transport `closed` promise a tick to settle.
    await new Promise((r) => setTimeout(r, 50));

    expect(events).toHaveLength(0);
  });

  it('incoming GOAWAY with newSessionUri populates pendingMigrationUri', async () => {
    const profile = resolveProfile(raw);
    handle = await makeSession(profile);

    // Drive the private handler directly — same path a real GOAWAY takes.
    (handle.session as unknown as {
      handleIncomingGoAwayDraft18(m: {
        type: number;
        newSessionUri?: string;
        timeout: bigint;
        requestId?: bigint;
      }): void;
    }).handleIncomingGoAwayDraft18({
      type: MessageTypeDraft18.GOAWAY,
      newSessionUri: 'https://alt-relay.example/moq',
      timeout: 5000n,
    });

    expect(handle.session.pendingMigrationUri).toBe('https://alt-relay.example/moq');
    expect(handle.session.state).toBe('closing');
  });

  it('migrate() rejects with a clear error in main-thread mode', async () => {
    const profile = resolveProfile(raw);
    handle = await makeSession(profile);

    await expect(handle.session.migrate('https://foo.example/moq')).rejects.toThrow(/worker mode/);
  });
});
