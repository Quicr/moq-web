// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * CLIENT_SETUP <-> SERVER_SETUP round-trip against a live relay.
 *
 * Both profiles are exercised because the setup path is identical for
 * stream vs datagram tracks — this test just proves auth + version
 * negotiation work end-to-end.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { makeSession, type SessionHandle } from '../lib/session-factory.js';
import { resolveProfile, type Profile } from '../lib/profile.js';
import chatStream from '../profiles/chat-stream.json';
import chatDatagram from '../profiles/chat-datagram.json';

describe.each([
  ['chat-stream', chatStream as Profile],
  ['chat-datagram', chatDatagram as Profile],
])('CLIENT_SETUP round-trip [%s]', (_label, raw) => {
  let handle: SessionHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  it('connects, runs setup, reaches ready state', async () => {
    const profile = resolveProfile(raw);
    handle = await makeSession(profile);
    // `setup()` resolves only after SERVER_SETUP is received.
    // If we got here, the round-trip completed.
    expect(handle.session).toBeDefined();
  });
});
