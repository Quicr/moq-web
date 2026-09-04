// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Draft-18 §3.2 SETUP extension advertisement — end-to-end surface tests.
 *
 * Draft-18 says: peers MUST ignore unknown SETUP extensions. So we can safely
 * advertise a client extension with an unregistered key and verify the relay
 * still completes SERVER_SETUP.
 *
 * These tests don't rely on the relay advertising any specific extensions —
 * `peerExtensions` may be undefined depending on the relay build. We only
 * assert (a) the client can inject extensions without breaking the setup
 * round-trip, and (b) the getter is populated whenever the relay does send
 * some.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { MOQTransport, type SetupExtensionValue } from '@moq-web/core';
import { MOQTSession } from '@moq-web/session';

import { resolveProfile, type Profile } from '../lib/profile.js';
import chatStream from '../profiles/chat-stream.json';

const MOQT_VERSION = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_MOQT_VERSION ?? 'draft-18';
const isDraft18 = MOQT_VERSION === 'draft-18';

describe.skipIf(!isDraft18)('SETUP extension advertisement (§3.2)', () => {
  let transport: MOQTransport | undefined;
  let session: MOQTSession | undefined;

  afterEach(async () => {
    try { await session?.close(); } catch { /* ignore */ }
    try { await transport?.close(); } catch { /* ignore */ }
    session = undefined;
    transport = undefined;
  });

  it('completes SETUP round-trip with a client-advertised unknown extension', async () => {
    const profile = resolveProfile(chatStream as Profile);

    transport = new MOQTransport();
    await transport.connect(profile.relayUrl);
    session = new MOQTSession(transport);

    if (profile.authToken && profile.auth?.scope !== 'per-request') {
      const tokenType =
        typeof profile.auth?.tokenType === 'number' ? profile.auth.tokenType : undefined;
      session.setAuthToken(profile.authToken, tokenType);
    }

    // Draft-18 §3.2: unknown keys with even parity carry a varint value.
    // 0x40 (64) is well outside the reserved SetupOption range.
    session.setClientExtensions(new Map<number, SetupExtensionValue>([
      [0x40, { varint: 0x1234n }],
      [0x41, { bytes: new TextEncoder().encode('moq-web-e2e') }],
    ]));

    await session.setup();
    expect(session.isReady).toBe(true);
  });

  it('exposes peerExtensions after SERVER_SETUP (may be undefined if relay has none)', async () => {
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

    // The getter is defined either way. If the relay does advertise any
    // extensions, every value must satisfy the parity invariant.
    const peer = session.peerExtensions;
    if (peer !== undefined) {
      for (const [key, value] of peer) {
        const parityIsEven = key % 2 === 0;
        const isVarint = 'varint' in value;
        expect(isVarint).toBe(parityIsEven);
      }
    }
  });

  it('rejects setClientExtensions() after setup() has started', async () => {
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

    expect(() =>
      session!.setClientExtensions(new Map([[0x40, { varint: 1n }]])),
    ).toThrow(/after setup\(\)/);
  });
});
