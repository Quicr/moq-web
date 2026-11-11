// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * GOAWAY graceful shutdown (draft-18 only).
 *
 * The client issues GOAWAY; the session transitions to 'closing' locally.
 * This is a lightweight surface test — we don't require the relay to echo
 * anything back, just that the client encoder produces a wire-valid GOAWAY
 * and drives its own state machine forward.
 */

import { isDraftAtLeast, type DraftVersion } from '@moq-web/core';
import { afterEach, describe, expect, it } from 'vitest';

import { record } from '../lib/record.js';
import { makeSession, type SessionHandle } from '../lib/session-factory.js';
import { resolveProfile, type Profile } from '../lib/profile.js';
import chatStream from '../profiles/chat-stream.json';
import chatDatagram from '../profiles/chat-datagram.json';

const MOQT_VERSION = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_MOQT_VERSION ?? 'draft-18';
/** Draft-18 and later share these messages; draft-22 and draft-23 inherit them */
const isDraft18 = isDraftAtLeast(MOQT_VERSION as DraftVersion, 18);

describe.skipIf(!isDraft18).each([
  ['chat-stream', chatStream as Profile],
  ['chat-datagram', chatDatagram as Profile],
])('GOAWAY [%s]', (_label, raw) => {
  let handle: SessionHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  it('client-initiated goAway moves session to closing state', async ({ task }) => {
    const profile = resolveProfile(raw);
    handle = await makeSession(profile);

    record(task, { expected: 'Sending GOAWAY moves the session to closing', inputs: { newSessionUri: 'none' } });
    await handle.session.goAway();

    record(task, { observed: { state: handle.session.state } });
    expect(handle.session.state).toBe('closing');
  });
});
