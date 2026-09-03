// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * UNSUBSCRIBE round-trip.
 *
 * Subscribe to a live track, receive some objects, unsubscribe, and
 * confirm no further deliveries arrive after a settle period.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { makeSession, type SessionHandle } from '../lib/session-factory.js';
import { resolveProfile, makeNamespace, type Profile } from '../lib/profile.js';
import { generateChat } from '../lib/chat-generator.js';
import chatStream from '../profiles/chat-stream.json';
import chatDatagram from '../profiles/chat-datagram.json';

describe.each([
  ['chat-stream', chatStream as Profile],
  ['chat-datagram', chatDatagram as Profile],
])('UNSUBSCRIBE [%s]', (label, raw) => {
  let pub: SessionHandle | undefined;
  let sub: SessionHandle | undefined;

  afterEach(async () => {
    await pub?.close();
    await sub?.close();
    pub = undefined;
    sub = undefined;
  });

  it('objects stop arriving after unsubscribe', async () => {
    const profile = resolveProfile(raw);
    const track = profile.tracks[0];
    if (!track) throw new Error('profile has no tracks');

    const namespace = makeNamespace(profile, `unsub-${label}`);

    pub = await makeSession(profile);
    sub = await makeSession(profile);

    const trackAlias = await pub.session.publish(namespace, track.name, {
      priority: track.priority,
      deliveryTimeout: track.deliveryTimeout,
      deliveryMode: track.delivery,
      skipForwardWait: true,
    });

    let received = 0;
    const subscriptionId = await sub.session.subscribe(namespace, track.name, {}, () => {
      received++;
    });

    await new Promise((r) => setTimeout(r, 250));

    const messages = Array.from(generateChat(track.payload));
    const half = Math.floor(messages.length / 2);

    for (const msg of messages.slice(0, half)) {
      await pub.session.sendObject(trackAlias, msg.bytes, {
        groupId: msg.groupId,
        objectId: msg.objectId,
      });
    }

    await new Promise((r) => setTimeout(r, 500));
    expect(received).toBeGreaterThan(0);

    await sub.session.unsubscribe(subscriptionId);

    // Allow any in-flight objects to drain, then take a measurement.
    await new Promise((r) => setTimeout(r, 500));
    const settledCount = received;

    for (const msg of messages.slice(half)) {
      await pub.session.sendObject(trackAlias, msg.bytes, {
        groupId: msg.groupId,
        objectId: msg.objectId,
      });
    }

    await new Promise((r) => setTimeout(r, 1_000));
    expect(received).toBe(settledCount);
  });
});
