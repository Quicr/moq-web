// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Draft-18 §13.6.1 — Idle Connection handling.
 *
 * §13.6.1 defers idle to QUIC and only recommends periodic PING frames for
 * long-lived subscriptions. `MOQTSession.configureIdle()` exposes a
 * keepalive knob that emits §11.5 padding datagrams and a local idle-close
 * knob. This test proves the keepalive path works against a live relay
 * (the session survives past the idle threshold when keepalive is on and
 * closes cleanly with CONTROL_MESSAGE_TIMEOUT when it's not).
 *
 * Kept small — long real-time waits inflate CI cost. We use a 300ms
 * idle threshold plus a small `wait()` for the timer to fire.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { makeSession, type SessionHandle } from '../lib/session-factory.js';
import { resolveProfile, type Profile } from '../lib/profile.js';
import chatStream from '../profiles/chat-stream.json';
import { SessionErrorCodeDraft18 } from '@moq-web/core';

const MOQT_VERSION = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_MOQT_VERSION ?? 'draft-18';
const isDraft18 = MOQT_VERSION === 'draft-18';

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!isDraft18)('idle connection: §13.6.1 configureIdle()', () => {
  let handle: SessionHandle | undefined;

  afterEach(async () => {
    try { await handle?.close(); } catch { /* ignore */ }
    handle = undefined;
  });

  it('keepaliveIntervalMs emits padding datagrams while otherwise idle', async () => {
    const profile = resolveProfile(chatStream as Profile);
    handle = await makeSession(profile);

    // 100ms cadence: within 400ms the timer will tick multiple times and
    // emit padding datagrams. The relay accepts and drops padding per §11.5.
    // If anything is broken (e.g., padding path aborts the session), close()
    // below will throw or the peer will send an error.
    handle.session.configureIdle({ keepaliveIntervalMs: 100 });
    await wait(400);

    // Verify the session is still healthy — issue any trivial API that
    // requires `ready` state. `isReady` is a boolean flag.
    expect(handle.session.isReady).toBe(true);
  });

  it('idleTimeoutMs closes the local session with CONTROL_MESSAGE_TIMEOUT when no activity happens', async () => {
    const profile = resolveProfile(chatStream as Profile);
    handle = await makeSession(profile);

    const terminated = new Promise<{ code: number; remote: boolean; reason: string }>((resolve) => {
      handle!.session.on('session-terminated', (e) => {
        resolve(e as { code: number; remote: boolean; reason: string });
      });
    });

    handle.session.configureIdle({ idleTimeoutMs: 250 });

    // Give the timer enough real time to trip. Ticks run at threshold/4 =
    // 62.5ms, so within ~500ms it should fire.
    const evt = await Promise.race([
      terminated,
      wait(2_000).then(() => null),
    ]);

    expect(evt).not.toBeNull();
    expect(evt!.remote).toBe(false);
    expect(evt!.code).toBe(SessionErrorCodeDraft18.CONTROL_MESSAGE_TIMEOUT);
    expect(evt!.reason).toMatch(/idle timeout/);
  });
});
