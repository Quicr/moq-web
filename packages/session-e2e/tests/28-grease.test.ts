// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Draft-18 §14 Grease — receiver tolerance against a live relay.
 *
 * §14 reserves values matching `0x7f * N + 0x9D` across seven registries and
 * mandates that receivers MUST ignore unknown values (or map unknown error
 * codes to INTERNAL_ERROR). The Setup Options registry is the easiest to
 * exercise end-to-end: we advertise a grease key on CLIENT_SETUP and expect
 * the relay to complete SERVER_SETUP anyway — proving both the relay and our
 * codec honour the "ignore unknown" rule.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { MOQTransport, isGreaseCode, type SetupExtensionValue, isDraftAtLeast, type DraftVersion } from '@moq-web/core';
import { MOQTSession } from '@moq-web/session';

import { record } from '../lib/record.js';
import { resolveProfile, type Profile } from '../lib/profile.js';
import chatStream from '../profiles/chat-stream.json';

const MOQT_VERSION = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_MOQT_VERSION ?? 'draft-18';
/** Draft-18 and later share these messages; draft-22 and draft-23 inherit them */
const isDraft18 = isDraftAtLeast(MOQT_VERSION as DraftVersion, 18);

// The base draft-18 §14 grease value 0x9d is odd (length-prefixed bytes).
// The next value 0x11c is even (varint). Send one of each so both codec
// branches see grease traffic.
const GREASE_ODD = 0x9d;
const GREASE_EVEN = 0x11c;

describe.skipIf(!isDraft18)('§14 grease: receiver tolerance', () => {
  let transport: MOQTransport | undefined;
  let session: MOQTSession | undefined;

  afterEach(async () => {
    try { await session?.close(); } catch { /* ignore */ }
    try { await transport?.close(); } catch { /* ignore */ }
    session = undefined;
    transport = undefined;
  });

  it('recognises the reserved codepoint pattern (sanity)', ({ task }) => {
    record(task, {
      flow: [
        'Local only: no relay traffic',
        `Check: isGreaseCode(0x${GREASE_ODD.toString(16)}) and isGreaseCode(0x${GREASE_EVEN.toString(16)}) are true`,
        'Check: isGreaseCode(0x40) is false',
      ],
      expected: 'The two grease codepoints match 0x7f * N + 0x9D and 0x40 does not',
      inputs: { greaseOdd: `0x${GREASE_ODD.toString(16)}`, greaseEven: `0x${GREASE_EVEN.toString(16)}`, other: '0x40' },
      observed: { greaseOdd: isGreaseCode(GREASE_ODD), greaseEven: isGreaseCode(GREASE_EVEN), other: isGreaseCode(0x40) },
    });
    expect(isGreaseCode(GREASE_ODD)).toBe(true);
    expect(isGreaseCode(GREASE_EVEN)).toBe(true);
    // Off-progression: must not be treated as grease.
    expect(isGreaseCode(0x40)).toBe(false);
  });

  it('relay completes SETUP when we advertise grease-key Setup Options', async ({ task }) => {
    const profile = resolveProfile(chatStream as Profile);
    transport = new MOQTransport();
    await transport.connect(profile.relayUrl);
    session = new MOQTSession(transport);

    if (profile.authToken && profile.auth?.scope !== 'per-request') {
      const tokenType =
        typeof profile.auth?.tokenType === 'number' ? profile.auth.tokenType : undefined;
      session.setAuthToken(profile.authToken, tokenType);
    }

    session.setClientExtensions(new Map<number, SetupExtensionValue>([
      [GREASE_ODD, { bytes: new TextEncoder().encode('grease-bytes-payload') }],
      [GREASE_EVEN, { varint: 0xdeadn }],
    ]));

    record(task, {
      flow: [
        'Client: open WebTransport to the relay',
        `Client: CLIENT_SETUP with grease Setup Options 0x${GREASE_ODD.toString(16)} (bytes) and 0x${GREASE_EVEN.toString(16)} (varint 0xdead)`,
        'Relay: must ignore the unknown options (§14)',
        'Relay → Client: SERVER_SETUP',
        'Check: the session is ready',
      ],
      expected: 'The relay ignores grease-key Setup Options and setup completes',
      inputs: { options: [`0x${GREASE_ODD.toString(16)} = bytes`, `0x${GREASE_EVEN.toString(16)} = varint 0xdead`] },
    });
    await session.setup();
    record(task, { observed: { ready: session.isReady } });
    // §14: relay MUST NOT close the session on unknown values.
    expect(session.isReady).toBe(true);
  });
});
