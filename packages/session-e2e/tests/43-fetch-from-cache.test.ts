// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * FETCH from the relay's cache, in several shapes.
 *
 * A holder subscription keeps groups 0..4 (3 Objects each) in the relay's
 * cache. A second session then fetches:
 *
 * - whole groups 1..3;
 * - a partial range, 1/1 through 2/1 (the end is inclusive, draft-22 §9.11);
 * - groups 0..3 in descending group order: groups arrive 3, 2, 1, 0;
 * - groups 0..2 after the publisher has left: a relay may serve them from
 *   its cache or refuse with DOES_NOT_EXIST, but must not hang or send part;
 * - groups 3..6 while the track is at group 4: the response ends at the
 *   Largest Object, so 3..4 arrive and groups 5..6, published after the
 *   FETCH, do not (draft-23 §3.2).
 *
 * Every Object is checked byte for byte. Draft-22 and later.
 */

import { GroupOrder, RequestErrorCodeDraft18 } from '@moq-web/core';
import { afterEach, describe, expect, it } from 'vitest';

import { isDraft22, publishGroups, Received, requestErrorName, sleep, Trace, waitUntil } from '../lib/flow.js';
import { record } from '../lib/record.js';
import { makeSession, type SessionHandle } from '../lib/session-factory.js';
import { resolveProfile, makeNamespace, type Profile } from '../lib/profile.js';
import chatStream from '../profiles/chat-stream.json';

const PER_GROUP = 3;

interface Case {
  id: string;
  title: string;
  range: { startGroup: number; startObject: number; endGroup: number; endObject: number };
  wanted: string[];
  descending?: boolean;
  publisherLeaves?: boolean;
  /** Groups published after the FETCH is sent; they must not arrive on it */
  later?: number;
}

const whole = (from: number, to: number) =>
  Array.from({ length: (to - from + 1) * PER_GROUP }, (_, i) => `${from + Math.floor(i / PER_GROUP)}/${i % PER_GROUP}`);

const CASES: Case[] = [
  { id: 'whole', title: 'whole groups 1..3', range: { startGroup: 1, startObject: 0, endGroup: 3, endObject: 0 }, wanted: whole(1, 3) },
  { id: 'partial', title: 'partial range 1/1..2/1', range: { startGroup: 1, startObject: 1, endGroup: 2, endObject: 1 }, wanted: ['1/1', '1/2', '2/0', '2/1'] },
  { id: 'descending', title: 'groups 0..3 in descending order', range: { startGroup: 0, startObject: 0, endGroup: 3, endObject: 0 }, wanted: whole(0, 3), descending: true },
  { id: 'cache-only', title: 'groups 0..2 after the publisher left', range: { startGroup: 0, startObject: 0, endGroup: 2, endObject: 0 }, wanted: whole(0, 2), publisherLeaves: true },
  { id: 'live-edge', title: 'groups 3..6 across the live edge end at the Largest Object', range: { startGroup: 3, startObject: 0, endGroup: 6, endObject: 0 }, wanted: whole(3, 4), later: 2 },
];

describe.skipIf(!isDraft22)('FETCH from the relay cache', () => {
  let handles: SessionHandle[] = [];

  afterEach(async () => {
    for (const h of handles) await h.close();
    handles = [];
  });

  it.for(CASES)('$id: $title', async (c, { task }) => {
    const profile = resolveProfile(chatStream as Profile);
    const namespace = makeNamespace(profile, `fetch-${c.id}`);
    const trace = new Trace();
    record(task, {
      expected: `FETCH returns ${c.wanted.length} objects (${c.wanted[0]}..${c.wanted.at(-1)}), byte for byte${c.descending ? ', groups in descending order' : ''}${c.publisherLeaves ? '; or DOES_NOT_EXIST, if the relay dropped the track with its publisher' : ''}${c.later ? '; groups published after the FETCH do not arrive on it' : ''}`,
      inputs: {
        track: `${namespace.join('/')}/t`, cached: 'groups 0..4', objectsPerGroup: PER_GROUP, range: c.range,
        groupOrder: c.descending ? 'descending' : 'ascending', publisherLeaves: c.publisherLeaves === true, publishedAfter: c.later ? `groups 5..${4 + c.later}` : 'none',
      },
    });
    const pub = await makeSession(profile);
    const holder = await makeSession(profile);
    const sub = await makeSession(profile);
    handles.push(pub, holder, sub);
    trace.attach('Pub', pub.session);
    trace.attach('Sub', sub.session);
    const alias = await pub.session.publish(namespace, 't', { deliveryMode: 'stream', skipForwardWait: true, maxCacheDuration: 60_000 });
    await holder.session.subscribe(namespace, 't', { filterType: 'latest' }, () => undefined);
    await sleep(200);
    await publishGroups(pub.session, alias, { groups: 5, perGroup: PER_GROUP });
    await sleep(500);
    if (c.publisherLeaves) {
      trace.note('Pub', 'closing the publisher session');
      trace.expect('subscription-cancelled');
      await pub.close();
      await sleep(500);
    }

    const got = new Received();
    let fetchError = 'none';
    let fetchErrorCode: number | undefined;
    let largest = 'none';
    sub.session.on('fetch-error', (evt) => { fetchError = `${requestErrorName(evt.errorCode)} ${evt.reason}`; fetchErrorCode = evt.errorCode; });
    sub.session.on('fetch-complete', (evt) => { largest = `${evt.largestGroupId}/${evt.largestObjectId ?? '?'}`; });
    try {
      await sub.session.fetch(namespace, 't', c.range, c.descending ? { groupOrder: GroupOrder.DESCENDING } : {}, got.onObject);
    } catch (err) {
      fetchError = (err as Error).message;
    }
    if (c.later) {
      await sleep(300);
      await publishGroups(pub.session, alias, { groups: c.later, perGroup: PER_GROUP, first: 5 });
    }
    await waitUntil(() => c.wanted.every((k) => got.has(k)) || fetchError !== 'none', 8_000);
    await sleep(300);

    const missing = c.wanted.filter((k) => !got.has(k));
    const extra = got.keys.filter((k) => !c.wanted.includes(k));
    const order = got.groups();
    trace.tearingDown = true;
    trace.print(`${c.id} received=${got.keys.join(' ')} error=${fetchError}`);
    record(task, { observed: { fetchError, fetchOkLargest: largest, received: got.keys, groupOrder: order, missing, extra, corrupt: got.corrupt, trace: trace.lines } });

    if (c.publisherLeaves && fetchErrorCode === RequestErrorCodeDraft18.DOES_NOT_EXIST && got.keys.length === 0) {
      // The relay dropped the track with its publisher: allowed, and reported
      return;
    }
    expect(fetchError).toBe('none');
    expect(missing, 'objects that never arrived').toEqual([]);
    expect(extra, 'objects outside the range').toEqual([]);
    expect(got.corrupt).toEqual([]);
    if (c.descending) {
      expect(order, 'group arrival order').toEqual([...order].sort((a, b) => b - a));
    }
  });
});
