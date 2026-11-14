// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Draft-18 §13.8 — Fingerprinting mitigation for MOQT_IMPLEMENTATION.
 *
 * The client omits the MOQT_IMPLEMENTATION SetupOption by default. Callers can
 * opt in via `setImplementationString()` before `setup()`. We drive both paths
 * against a live relay and assert the session completes CLIENT_SETUP <->
 * SERVER_SETUP either way — the relay MUST ignore MOQT_IMPLEMENTATION and only
 * fail if the value violates encoding constraints.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { MOQTransport, isDraftAtLeast, type DraftVersion } from '@moq-web/core';
import { MOQTSession } from '@moq-web/session';

import { record } from '../lib/record.js';
import { resolveProfile, type Profile } from '../lib/profile.js';
import chatStream from '../profiles/chat-stream.json';

const MOQT_VERSION = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_MOQT_VERSION ?? 'draft-18';
/** Draft-18 and later share these messages; draft-22 and draft-23 inherit them */
const isDraft18 = isDraftAtLeast(MOQT_VERSION as DraftVersion, 18);

describe.skipIf(!isDraft18)('MOQT_IMPLEMENTATION opt-in (§13.8)', () => {
  let transport: MOQTransport | undefined;
  let session: MOQTSession | undefined;

  afterEach(async () => {
    try { await session?.close(); } catch { /* ignore */ }
    try { await transport?.close(); } catch { /* ignore */ }
    session = undefined;
    transport = undefined;
  });

  it('completes SETUP without MOQT_IMPLEMENTATION by default', async ({ task }) => {
    const profile = resolveProfile(chatStream as Profile);
    transport = new MOQTransport();
    await transport.connect(profile.relayUrl);
    session = new MOQTSession(transport);

    if (profile.authToken && profile.auth?.scope !== 'per-request') {
      const tokenType =
        typeof profile.auth?.tokenType === 'number' ? profile.auth.tokenType : undefined;
      session.setAuthToken(profile.authToken, tokenType);
    }

    record(task, {
      flow: [
        'Client: open WebTransport to the relay',
        'Client: CLIENT_SETUP with no MOQT_IMPLEMENTATION option (the default, §13.8)',
        'Relay → Client: SERVER_SETUP',
        'Check: the session is ready',
      ],
      expected: 'Setup without MOQT_IMPLEMENTATION completes',
      inputs: { implementation: 'none' },
    });
    // No setImplementationString() call — default path.
    await session.setup();
    record(task, { observed: { ready: session.isReady } });
    expect(session.isReady).toBe(true);
  });

  it('completes SETUP when the caller opts in with an implementation string', async ({ task }) => {
    const profile = resolveProfile(chatStream as Profile);
    transport = new MOQTransport();
    await transport.connect(profile.relayUrl);
    session = new MOQTSession(transport);

    if (profile.authToken && profile.auth?.scope !== 'per-request') {
      const tokenType =
        typeof profile.auth?.tokenType === 'number' ? profile.auth.tokenType : undefined;
      session.setAuthToken(profile.authToken, tokenType);
    }

    record(task, {
      flow: [
        'Client: open WebTransport to the relay',
        "Client: setImplementationString('moq-web e2e-27')",
        'Client: CLIENT_SETUP carrying MOQT_IMPLEMENTATION = "moq-web e2e-27"',
        'Relay → Client: SERVER_SETUP; the relay must ignore the option',
        'Check: the session is ready',
      ],
      expected: 'Setup carrying a MOQT_IMPLEMENTATION string completes; the relay ignores it',
      inputs: { implementation: 'moq-web e2e-27' },
    });
    session.setImplementationString('moq-web e2e-27');
    await session.setup();
    record(task, { observed: { ready: session.isReady } });
    expect(session.isReady).toBe(true);
  });

  it('rejects setImplementationString() once setup() has started', async ({ task }) => {
    const profile = resolveProfile(chatStream as Profile);
    transport = new MOQTransport();
    await transport.connect(profile.relayUrl);
    session = new MOQTSession(transport);

    if (profile.authToken && profile.auth?.scope !== 'per-request') {
      const tokenType =
        typeof profile.auth?.tokenType === 'number' ? profile.auth.tokenType : undefined;
      session.setAuthToken(profile.authToken, tokenType);
    }

    await session.setup();
    record(task, {
      flow: [
        'Client: open WebTransport to the relay',
        'Client: CLIENT_SETUP → Relay: SERVER_SETUP (session ready)',
        "Client: setImplementationString('too-late') after setup",
        'Check: the call throws "after setup()"; nothing is sent',
      ],
      expected: 'setImplementationString() throws once setup() has run',
      inputs: { implementation: 'too-late' },
    });
    let thrown: unknown;
    try {
      session.setImplementationString('too-late');
    } catch (err) {
      thrown = err;
    }
    record(task, { observed: { error: thrown ?? 'none thrown' } });
    expect(() => session!.setImplementationString('too-late')).toThrow(/after setup\(\)/);
  });
});
