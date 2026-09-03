// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * PUBLISH round-trip against a live relay.
 *
 * `session.publish()` sends PUBLISH on a per-request bidi stream (draft-18)
 * and resolves with the assigned track alias after REQUEST_OK. If the
 * relay rejects the request the promise rejects. A resolved bigint alias
 * proves the exchange succeeded.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { makeSession, type SessionHandle } from '../lib/session-factory.js';
import { resolveProfile, makeNamespace, type Profile } from '../lib/profile.js';
import chatStream from '../profiles/chat-stream.json';
import chatDatagram from '../profiles/chat-datagram.json';

describe.each([
  ['chat-stream', chatStream as Profile],
  ['chat-datagram', chatDatagram as Profile],
])('PUBLISH round-trip [%s]', (label, raw) => {
  let handle: SessionHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  it('relay accepts publish and assigns a track alias', async () => {
    const profile = resolveProfile(raw);
    const track = profile.tracks[0];
    if (!track) throw new Error('profile has no tracks');

    const namespace = makeNamespace(profile, `publish-${label}`);
    handle = await makeSession(profile);

    const trackAlias = await handle.session.publish(namespace, track.name, {
      priority: track.priority,
      deliveryTimeout: track.deliveryTimeout,
      deliveryMode: track.delivery,
      // Draft-16 relays return PUBLISH_OK with forward=0 until a subscriber
      // exists. This test has no subscriber, so skip the forward wait.
      skipForwardWait: true,
    });

    expect(typeof trackAlias).toBe('bigint');
    expect(trackAlias >= 0n).toBe(true);
  });
});
