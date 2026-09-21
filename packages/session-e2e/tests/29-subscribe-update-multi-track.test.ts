// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * SUBSCRIBE_UPDATE (draft-16) / REQUEST_UPDATE (draft-18) per-request scope.
 *
 * Publisher publishes two tracks in the same session. Subscriber subscribes
 * to both and pauses one. The other track must keep flowing — pause is
 * scoped to a single subscription's requestId, not the whole session.
 *
 * This regresses a bug where the publisher-side handler routed forward=0
 * through `publicationManager.setAllForward(0)`, which flipped every
 * publication in the session regardless of which subscription paused.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { makeSession, type SessionHandle } from '../lib/session-factory.js';
import { resolveProfile, makeNamespace, type Profile } from '../lib/profile.js';
import { generateChat } from '../lib/chat-generator.js';
import chatStream from '../profiles/chat-stream.json';

describe('SUBSCRIBE_UPDATE per-request scope [chat-stream]', () => {
  let pub: SessionHandle | undefined;
  let sub: SessionHandle | undefined;

  afterEach(async () => {
    await pub?.close();
    await sub?.close();
    pub = undefined;
    sub = undefined;
  });

  it('pausing one subscription does not stall other publications in the same session', async () => {
    const profile = resolveProfile(chatStream as Profile);
    const track = profile.tracks[0];
    if (!track) throw new Error('profile has no tracks');

    // Two independent namespaces so each publish gets its own request/track.
    const nsA = makeNamespace(profile, 'multi-track-a');
    const nsB = makeNamespace(profile, 'multi-track-b');

    pub = await makeSession(profile);
    sub = await makeSession(profile);

    const aliasA = await pub.session.publish(nsA, track.name, {
      priority: track.priority,
      deliveryTimeout: track.deliveryTimeout,
      deliveryMode: track.delivery,
      skipForwardWait: true,
    });
    const aliasB = await pub.session.publish(nsB, track.name, {
      priority: track.priority,
      deliveryTimeout: track.deliveryTimeout,
      deliveryMode: track.delivery,
      skipForwardWait: true,
    });

    let receivedA = 0;
    let receivedB = 0;
    const subA = await sub.session.subscribe(nsA, track.name, {}, () => {
      receivedA++;
    });
    await sub.session.subscribe(nsB, track.name, {}, () => {
      receivedB++;
    });

    await new Promise((r) => setTimeout(r, 250));

    // Prime both tracks so they flow.
    const messages = Array.from(generateChat(track.payload));
    const first = Math.floor(messages.length / 3);
    for (const msg of messages.slice(0, first)) {
      await pub.session.sendObject(aliasA, msg.bytes, {
        groupId: msg.groupId,
        objectId: msg.objectId,
      });
      await pub.session.sendObject(aliasB, msg.bytes, {
        groupId: msg.groupId,
        objectId: msg.objectId,
      });
    }

    await new Promise((r) => setTimeout(r, 500));
    expect(receivedA).toBeGreaterThan(0);
    expect(receivedB).toBeGreaterThan(0);

    // Pause only subscription A.
    await sub.session.pauseSubscription(subA);
    await new Promise((r) => setTimeout(r, 250));

    const bBeforeSecondBatch = receivedB;

    // Send the next batch on both. A is paused so relay should drop / not
    // forward; B must continue to be delivered.
    for (const msg of messages.slice(first)) {
      await pub.session.sendObject(aliasA, msg.bytes, {
        groupId: msg.groupId,
        objectId: msg.objectId,
      });
      await pub.session.sendObject(aliasB, msg.bytes, {
        groupId: msg.groupId,
        objectId: msg.objectId,
      });
    }

    // Wait for B's new arrivals. If the pause narrowing regressed, B stops
    // right along with A and this test times out.
    const deadline = Date.now() + 5_000;
    while (receivedB <= bBeforeSecondBatch && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(
      receivedB,
      `track B stalled after pausing track A (was ${bBeforeSecondBatch}, still ${receivedB})`,
    ).toBeGreaterThan(bBeforeSecondBatch);
  });
});
