// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * End-to-end pub/sub against a live relay.
 *
 * Session A publishes a chat track under a unique namespace.
 * Session B subscribes to the same track.
 * Every object B receives must byte-match what A sent and arrive in order.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { makeSession, type SessionHandle } from '../lib/session-factory.js';
import { resolveProfile, makeNamespace, type Profile } from '../lib/profile.js';
import { generateChat, expectedMessage } from '../lib/chat-generator.js';
import { assertMonotonic, bytesEqual, collectObjects } from '../lib/verify.js';
import chatStream from '../profiles/chat-stream.json';
import chatDatagram from '../profiles/chat-datagram.json';

describe.each([
  ['chat-stream', chatStream as Profile],
  ['chat-datagram', chatDatagram as Profile],
])('SUBSCRIBE round-trip [%s]', (label, raw) => {
  let pub: SessionHandle | undefined;
  let sub: SessionHandle | undefined;

  afterEach(async () => {
    await pub?.close();
    await sub?.close();
    pub = undefined;
    sub = undefined;
  });

  it('subscriber receives every published object byte-exactly, in order', async () => {
    const profile = resolveProfile(raw);
    const track = profile.tracks[0];
    if (!track) throw new Error('profile has no tracks');

    const namespace = makeNamespace(profile, `subscribe-${label}`);

    pub = await makeSession(profile);
    sub = await makeSession(profile);

    // Publisher announces the track first.
    const trackAlias = await pub.session.publish(namespace, track.name, {
      priority: track.priority,
      deliveryTimeout: track.deliveryTimeout,
      deliveryMode: track.delivery,
    });

    const total = track.payload.messages;
    const collector = collectObjects(total, 20_000);

    await sub.session.subscribe(namespace, track.name, {}, collector.onObject);

    // Give the relay a beat to wire up the subscription before publishing.
    await new Promise((r) => setTimeout(r, 250));

    for (const msg of generateChat(track.payload)) {
      await pub.session.sendObject(trackAlias, msg.bytes, {
        groupId: msg.groupId,
        objectId: msg.objectId,
      });
    }

    const received = await collector.done;

    expect(received).toHaveLength(total);
    assertMonotonic(received);

    for (const o of received) {
      const expected = expectedMessage(track.payload, o.groupId, o.objectId);
      expect(
        bytesEqual(o.bytes, expected),
        `mismatch at (${o.groupId},${o.objectId})`,
      ).toBe(true);
    }
  });
});
