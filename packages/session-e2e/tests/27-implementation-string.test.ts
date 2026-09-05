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
import { MOQTransport } from '@moq-web/core';
import { MOQTSession } from '@moq-web/session';

import { resolveProfile, type Profile } from '../lib/profile.js';
import chatStream from '../profiles/chat-stream.json';

const MOQT_VERSION = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_MOQT_VERSION ?? 'draft-18';
const isDraft18 = MOQT_VERSION === 'draft-18';

describe.skipIf(!isDraft18)('MOQT_IMPLEMENTATION opt-in (§13.8)', () => {
  let transport: MOQTransport | undefined;
  let session: MOQTSession | undefined;

  afterEach(async () => {
    try { await session?.close(); } catch { /* ignore */ }
    try { await transport?.close(); } catch { /* ignore */ }
    session = undefined;
    transport = undefined;
  });

  it('completes SETUP without MOQT_IMPLEMENTATION by default', async () => {
    const profile = resolveProfile(chatStream as Profile);
    transport = new MOQTransport();
    await transport.connect(profile.relayUrl);
    session = new MOQTSession(transport);

    if (profile.authToken && profile.auth?.scope !== 'per-request') {
      const tokenType =
        typeof profile.auth?.tokenType === 'number' ? profile.auth.tokenType : undefined;
      session.setAuthToken(profile.authToken, tokenType);
    }

    // No setImplementationString() call — default path.
    await session.setup();
    expect(session.isReady).toBe(true);
  });

  it('completes SETUP when the caller opts in with an implementation string', async () => {
    const profile = resolveProfile(chatStream as Profile);
    transport = new MOQTransport();
    await transport.connect(profile.relayUrl);
    session = new MOQTSession(transport);

    if (profile.authToken && profile.auth?.scope !== 'per-request') {
      const tokenType =
        typeof profile.auth?.tokenType === 'number' ? profile.auth.tokenType : undefined;
      session.setAuthToken(profile.authToken, tokenType);
    }

    session.setImplementationString('moq-web e2e-27');
    await session.setup();
    expect(session.isReady).toBe(true);
  });

  it('rejects setImplementationString() once setup() has started', async () => {
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
    expect(() => session!.setImplementationString('too-late')).toThrow(/after setup\(\)/);
  });
});
