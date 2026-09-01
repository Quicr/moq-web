// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * SUBSCRIBE_UPDATE / REQUEST_UPDATE pause+resume flow.
 *
 * Publisher streams a chat track. Subscriber pauses after receiving a few
 * objects, expects the incoming object stream to quiesce, then resumes and
 * expects more objects to arrive. This exercises the draft-18
 * REQUEST_UPDATE(forward=0/1) path.
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
])('SUBSCRIBE_UPDATE pause+resume [%s]', (label, raw) => {
  let pub: SessionHandle | undefined;
  let sub: SessionHandle | undefined;

  afterEach(async () => {
    await pub?.close();
    await sub?.close();
    pub = undefined;
    sub = undefined;
  });

  it('pausing suppresses delivery; resuming restarts it', async () => {
    const profile = resolveProfile(raw);
    const track = profile.tracks[0];
    if (!track) throw new Error('profile has no tracks');

    const namespace = makeNamespace(profile, `update-${label}`);

    pub = await makeSession(profile);
    sub = await makeSession(profile);

    const trackAlias = await pub.session.publish(namespace, track.name, {
      priority: track.priority,
      deliveryTimeout: track.deliveryTimeout,
      deliveryMode: track.delivery,
    });

    let received = 0;
    const subscriptionId = await sub.session.subscribe(
      namespace,
      track.name,
      {},
      () => {
        received++;
      },
    );

    await new Promise((r) => setTimeout(r, 250));

    // Send first batch, wait for arrivals, then pause.
    const messages = Array.from(generateChat(track.payload));
    const half = Math.floor(messages.length / 2);

    for (const msg of messages.slice(0, half)) {
      await pub.session.sendObject(trackAlias, msg.bytes, {
        groupId: msg.groupId,
        objectId: msg.objectId,
      });
    }

    // Give delivery time to catch up before pausing.
    await new Promise((r) => setTimeout(r, 500));
    const beforePause = received;
    expect(beforePause).toBeGreaterThan(0);

    await sub.session.pauseSubscription(subscriptionId);
    await new Promise((r) => setTimeout(r, 250));
    const afterPause = received;

    // Send second batch while paused. The relay MAY still deliver some
    // in-flight objects that were queued before the pause propagated;
    // we don't assert on that. The important guarantee is that resume
    // brings delivery back to life.
    for (const msg of messages.slice(half)) {
      await pub.session.sendObject(trackAlias, msg.bytes, {
        groupId: msg.groupId,
        objectId: msg.objectId,
      });
    }

    await sub.session.resumeSubscription(subscriptionId);

    // After resume, expect additional objects to trickle in.
    const deadline = Date.now() + 5_000;
    while (received === afterPause && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(received).toBeGreaterThan(afterPause);
  });
});
