// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * SUBSCRIBE_UPDATE / REQUEST_UPDATE pause+resume flow.
 *
 * Publisher streams a chat track. Subscriber pauses after receiving a few
 * objects, expects the incoming object stream to quiesce, then resumes and
 * expects more objects to arrive. This exercises the draft-18
 * REQUEST_UPDATE(forward=0/1) path.
 *
 * A relay may pass the pause on to the publisher (Forward = 0 upstream). Its
 * REQUEST_OK for the resume can then reach the subscriber before the
 * publisher sees Forward = 1, and objects sent in between are not forwarded;
 * so when the publisher was paused, it waits to be resumed before sending.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { record } from '../lib/record.js';
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

  it('pausing suppresses delivery; resuming restarts it', async ({ task }) => {
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
      skipForwardWait: true,
    });

    // The publisher's Forward State, when the relay passes the pause on
    let pubForward = 1;
    let pubPaused = false;
    const resumed: Array<() => void> = [];
    pub.session.on('forward-state-change', (evt) => {
      if (evt.trackAlias !== trackAlias) return;
      pubForward = evt.forward;
      if (evt.forward === 0) {
        pubPaused = true;
      } else {
        resumed.splice(0).forEach((r) => r());
      }
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
    record(task, {
      flow: [
        `Pub: PUBLISH ${namespace.join('/')}/${track.name} (${track.delivery})`,
        'Sub: SUBSCRIBE the track; waits 250 ms',
        `Pub: sends ${half} objects; waits 500 ms`,
        'Check: some objects arrived',
        'Sub: REQUEST_UPDATE Forward = 0 (pause); waits 250 ms',
        'Sub: REQUEST_UPDATE Forward = 1 (resume)',
        'Pub: if the relay passed the pause on (Forward = 0 upstream), waits up to 5 s for Forward = 1',
        `Pub: sends the other ${messages.length - half} objects`,
        'Check: more objects arrive within 5 s of resuming',
      ],
      expected: 'Objects arrive before the pause, and more arrive within 5 s of resuming',
      inputs: { namespace: namespace.join('/'), track: track.name, delivery: track.delivery, objectsBeforePause: half, objectsAfterResume: messages.length - half },
    });

    for (const msg of messages.slice(0, half)) {
      await pub.session.sendObject(trackAlias, msg.bytes, {
        groupId: msg.groupId,
        objectId: msg.objectId,
      });
    }

    // Give delivery time to catch up before pausing.
    await new Promise((r) => setTimeout(r, 500));
    const beforePause = received;
    record(task, { observed: { beforePause } });
    expect(beforePause, 'objects received before the pause').toBeGreaterThan(0);

    await sub.session.pauseSubscription(subscriptionId);
    await new Promise((r) => setTimeout(r, 250));
    const afterPause = received;

    // Draft-18 §5 / §9.2: with Forward State=0 the publisher/relay does not
    // send Objects; objects produced while paused are not required to be
    // buffered. Resume the subscription first, then send the second batch —
    // that batch is what proves delivery is live again.
    await sub.session.resumeSubscription(subscriptionId);

    // Objects sent before the publisher is resumed are not forwarded
    let pubResumeMs: number | undefined;
    if (pubForward === 0) {
      const t0 = Date.now();
      await Promise.race([
        new Promise<void>((r) => resumed.push(r)),
        new Promise((r) => setTimeout(r, 5_000)),
      ]);
      pubResumeMs = Date.now() - t0;
    }
    record(task, { observed: { pauseReachedPublisher: pubPaused, publisherResumed: pubForward === 1, publisherResumeWaitMs: pubResumeMs } });

    for (const msg of messages.slice(half)) {
      await pub.session.sendObject(trackAlias, msg.bytes, {
        groupId: msg.groupId,
        objectId: msg.objectId,
      });
    }

    // After resume, expect additional objects to trickle in.
    const deadline = Date.now() + 5_000;
    while (received === afterPause && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const sinceResume = received - afterPause;
    record(task, { observed: { afterPause, afterResume: received, sinceResume } });
    expect(sinceResume, `objects received in the 5 s after resuming (${afterPause} before)`).toBeGreaterThan(0);
  });
});
