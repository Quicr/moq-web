// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Session termination code (draft-18 §15.10.1).
 *
 * `session.close({ code, reason })` should pass the numeric SessionErrorCode
 * down to the underlying WebTransport `close({ closeCode })`. We drive both
 * the graceful NO_ERROR path and a synthetic PROTOCOL_VIOLATION path; the
 * relay is not required to echo anything back — this test just proves the
 * client plumbs the code through and the local state machine transitions.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { SessionErrorCodeDraft18 } from '@moq-web/core';

import { makeSession, type SessionHandle } from '../lib/session-factory.js';
import { resolveProfile, type Profile } from '../lib/profile.js';
import chatStream from '../profiles/chat-stream.json';
import chatDatagram from '../profiles/chat-datagram.json';

const MOQT_VERSION = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_MOQT_VERSION ?? 'draft-18';
const isDraft18 = MOQT_VERSION === 'draft-18';

describe.skipIf(!isDraft18).each([
  ['chat-stream', chatStream as Profile],
  ['chat-datagram', chatDatagram as Profile],
])('Session termination codes [%s]', (_label, raw) => {
  let handle: SessionHandle | undefined;

  afterEach(async () => {
    // Guard against double-close; the tests below already close explicitly.
    try { await handle?.close(); } catch { /* ignore */ }
    handle = undefined;
  });

  it('close({code: NO_ERROR}) leaves the session in state "none"', async () => {
    const profile = resolveProfile(raw);
    handle = await makeSession(profile);

    await handle.session.close({ code: SessionErrorCodeDraft18.NO_ERROR, reason: 'test done' });

    expect(handle.session.state).toBe('none');
  });

  it('close({code: PROTOCOL_VIOLATION}) plumbs the numeric code without throwing', async () => {
    const profile = resolveProfile(raw);
    handle = await makeSession(profile);

    // The relay may respond with a QUIC-level abort; we only assert that the
    // client-side call resolves and the state machine moves off "ready".
    await expect(
      handle.session.close({
        code: SessionErrorCodeDraft18.PROTOCOL_VIOLATION,
        reason: 'e2e-injected',
      }),
    ).resolves.toBeUndefined();
    expect(handle.session.state).toBe('none');
  });
});
