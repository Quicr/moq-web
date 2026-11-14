// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * SUBSCRIBE_TRACKS and PUBLISH: the whole flow.
 *
 * 1. Sub sends SUBSCRIBE_TRACKS for a prefix. Pub sends SUBSCRIBE_TRACKS for
 *    the same prefix too: a relay excludes a subscriber's own tracks
 *    (draft-22 §6.1), so Pub must never get its own PUBLISH back.
 * 2. Pub publishes tracks a, b and c under prefix/pub and sends Objects on
 *    each: Sub gets a PUBLISH for each, and their Objects.
 * 3. Pub ends track a: Sub gets PUBLISH_DONE for it.
 * 4. Sub cancels its SUBSCRIBE_TRACKS, then Pub publishes track d: the relay
 *    must not send Sub a PUBLISH for d (draft-22 §6.1).
 *
 * Draft-22 and later.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { isDraft22, payloadOf, publishDoneName, sleep, Trace, waitUntil, within } from '../lib/flow.js';
import { record } from '../lib/record.js';
import { makeSession, type SessionHandle } from '../lib/session-factory.js';
import { resolveProfile, makeNamespace, type Profile } from '../lib/profile.js';
import chatStream from '../profiles/chat-stream.json';

const TRACKS = ['a', 'b', 'c'];

describe.skipIf(!isDraft22)('SUBSCRIBE_TRACKS flow', () => {
  let handles: SessionHandle[] = [];
  let stop: (() => void) | undefined;

  afterEach(async () => {
    stop?.();
    for (const h of handles) await h.close();
    handles = [];
  });

  it('forwards each track and its Objects, PUBLISH_DONE, no echo, and nothing after the cancel', async ({ task }) => {
    const profile = resolveProfile(chatStream as Profile);
    const prefix = makeNamespace(profile, 'tracks-flow');
    const namespace = [...prefix, 'pub'];
    const trace = new Trace();
    record(task, {
      flow: [
        'Sub: SUBSCRIBE_TRACKS prefix; Pub: SUBSCRIBE_TRACKS prefix too (to catch an echo)',
        `Pub: PUBLISH prefix/pub/${TRACKS.join(', ')}, then one Object per track every 100 ms`,
        `Relay → Sub: a PUBLISH for each of ${TRACKS.join(', ')}, then their Objects`,
        'Pub: ends track a; Relay → Sub: PUBLISH_DONE for a',
        'Sub: cancels its SUBSCRIBE_TRACKS; Pub: PUBLISH prefix/pub/d; waits 2 s',
        `Check: a PUBLISH and Objects for each of ${TRACKS.join(', ')}, and PUBLISH_DONE for a`,
        'Check: no PUBLISH for d after the cancel, and Pub never got its own tracks (draft-22 §6.1)',
      ],
      expected: 'Sub gets a PUBLISH and Objects for a, b and c, PUBLISH_DONE for a, and no PUBLISH for d after cancelling; Pub never gets its own tracks back',
      inputs: { prefix: prefix.join('/'), namespace: namespace.join('/'), tracks: TRACKS, afterCancel: 'd' },
    });
    const pub = await makeSession(profile);
    const sub = await makeSession(profile);
    handles.push(pub, sub);
    trace.attach('Pub', pub.session);
    trace.attach('Sub', sub.session);

    const forwarded = new Map<string, number>();
    sub.session.on('incoming-publish', (evt) => {
      if (evt.namespace.join('/') === namespace.join('/')) forwarded.set(evt.trackName, evt.subscriptionId);
    });
    const echoed: string[] = [];
    pub.session.on('incoming-publish', (evt) => echoed.push(`${evt.namespace.join('/')}/${evt.trackName}`));
    // Each track sends its own group range, so its Objects are told apart by group
    const groupBase = (i: number) => i * 1000;
    const objectsPerTrack = new Map<string, number>();
    const onObject = (_d: Uint8Array, groupId: number) => {
      const track = TRACKS[Math.floor(groupId / 1000)] ?? 'other';
      objectsPerTrack.set(track, (objectsPerTrack.get(track) ?? 0) + 1);
    };

    // 1
    const tracksId = await within(sub.session.subscribeTracks(prefix, onObject), 5_000, 'Sub SUBSCRIBE_TRACKS');
    await within(pub.session.subscribeTracks(prefix), 5_000, 'Pub SUBSCRIBE_TRACKS');
    await sleep(300);
    // 2
    const aliases = new Map<string, bigint>();
    for (const t of TRACKS) {
      aliases.set(t, await within(pub.session.publish(namespace, t, { deliveryMode: 'stream', skipForwardWait: true }), 5_000, `PUBLISH ${t}`));
    }
    let n = 0;
    const timer = setInterval(() => {
      const g = n++;
      TRACKS.forEach((t, i) => {
        void pub.session.sendObject(aliases.get(t)!, payloadOf(groupBase(i) + g, 0), { groupId: groupBase(i) + g, objectId: 0 }).catch(() => undefined);
      });
    }, 100);
    stop = () => clearInterval(timer);
    const allForwarded = await waitUntil(() => TRACKS.every((t) => forwarded.has(t)), 5_000);
    const allFlowing = await waitUntil(() => TRACKS.every((t) => (objectsPerTrack.get(t) ?? 0) >= 2), 5_000);
    // 3
    let doneForA = 'none';
    sub.session.on('publish-done', (evt) => {
      if (evt.subscriptionId === forwarded.get('a')) doneForA = publishDoneName(evt.statusCode);
    });
    await pub.session.unpublish(aliases.get('a')!);
    const gotDone = await waitUntil(() => doneForA !== 'none', 5_000);
    // 4
    stop();
    await sub.session.unsubscribeNamespace(tracksId);
    await sleep(500);
    await within(pub.session.publish(namespace, 'd', { deliveryMode: 'stream', skipForwardWait: true }), 5_000, 'PUBLISH d');
    await sleep(2_000);

    trace.tearingDown = true;
    trace.print(`forwarded=${[...forwarded.keys()].join(',')} objects=${JSON.stringify(Object.fromEntries(objectsPerTrack))} done=${doneForA} echoed=${echoed.length}`);
    record(task, {
      observed: {
        forwarded: [...forwarded.keys()],
        objectsPerTrack: Object.fromEntries(objectsPerTrack),
        publishDoneForA: doneForA,
        forwardedAfterCancel: forwarded.has('d'),
        echoedToPublisher: echoed,
        unexpected: trace.unexpected,
        trace: trace.lines,
      },
    });

    expect(allForwarded, 'a PUBLISH for each of a, b, c').toBe(true);
    expect(allFlowing, 'Objects on each of a, b, c').toBe(true);
    expect(gotDone, 'PUBLISH_DONE for a').toBe(true);
    expect(forwarded.has('d'), 'PUBLISH for d after the cancel').toBe(false);
    expect(echoed, "the publisher's own tracks sent back to it").toEqual([]);
    expect(trace.unexpected).toEqual([]);
  });
});
