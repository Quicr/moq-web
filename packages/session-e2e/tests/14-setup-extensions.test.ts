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
import { MOQTransport, type SetupExtensionValue, isDraftAtLeast, type DraftVersion } from '@moq-web/core';
import { MOQTSession } from '@moq-web/session';

import { record } from '../lib/record.js';
import { resolveProfile, type Profile } from '../lib/profile.js';
import chatStream from '../profiles/chat-stream.json';

const MOQT_VERSION = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_MOQT_VERSION ?? 'draft-18';
/** Draft-18 and later share these messages; draft-22 and draft-23 inherit them */
const isDraft18 = isDraftAtLeast(MOQT_VERSION as DraftVersion, 18);

describe.skipIf(!isDraft18)('SETUP extension advertisement (§3.2)', () => {
  let transport: MOQTransport | undefined;
  let session: MOQTSession | undefined;

  afterEach(async () => {
    try { await session?.close(); } catch { /* ignore */ }
    try { await transport?.close(); } catch { /* ignore */ }
    session = undefined;
    transport = undefined;
  });

  it('completes SETUP round-trip with a client-advertised unknown extension', async ({ task }) => {
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

    record(task, {
      expected: 'The relay ignores the unknown SETUP extensions and setup completes',
      inputs: { extensions: ['0x40 = varint 0x1234', "0x41 = bytes 'moq-web-e2e'"] },
    });
    await session.setup();
    record(task, { observed: { ready: session.isReady } });
    expect(session.isReady).toBe(true);
  });

  it('exposes peerExtensions after SERVER_SETUP (may be undefined if relay has none)', async ({ task }) => {
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
    record(task, {
      expected: 'Every extension the relay advertises has a varint value for an even key and bytes for an odd key',
      observed: {
        peerExtensions: peer === undefined ? 'none' : [...peer].map(([key, value]) => `0x${key.toString(16)} ${'varint' in value ? 'varint' : 'bytes'}`),
      },
    });
    if (peer !== undefined) {
      for (const [key, value] of peer) {
        const parityIsEven = key % 2 === 0;
        const isVarint = 'varint' in value;
        expect(isVarint).toBe(parityIsEven);
      }
    }
  });

  it('rejects setClientExtensions() after setup() has started', async ({ task }) => {
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

    record(task, { expected: 'setClientExtensions() throws once setup() has run' });
    let thrown: unknown;
    try {
      session.setClientExtensions(new Map([[0x40, { varint: 1n }]]));
    } catch (err) {
      thrown = err;
    }
    record(task, { observed: { error: thrown ?? 'none thrown' } });
    expect(() =>
      session!.setClientExtensions(new Map([[0x40, { varint: 1n }]])),
    ).toThrow(/after setup\(\)/);
  });
});
