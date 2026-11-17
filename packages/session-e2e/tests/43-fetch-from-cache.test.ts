// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * FETCH from the relay's cache, in several shapes.
 *
 * A holder subscription keeps groups 0..2 (3 Objects each) in the relay's
 * cache. The draft sets no cache size, so the track has only as many groups
 * as the smallest cache seen keeps (moxygen: 3 per track). A second session
 * then fetches:
 *
 * - whole groups 1..2;
 * - a partial range, 0/1 through 1/1 (the end is inclusive, draft-22 §9.11);
 * - groups 0..2 in descending group order: groups arrive 2, 1, 0;
 * - groups 0..2 after the publisher has left: a relay may serve them from
 *   its cache or refuse with DOES_NOT_EXIST, but must not hang or send part;
 * - groups 1..4 while the track is at group 2: the response ends at the
 *   Largest Object, so 1..2 arrive and groups 3..4, published after the
 *   FETCH, do not (draft-23 §3.2).
 *
 * Every Object is checked byte for byte. Draft-22 and later.
 */

import { GroupOrder, RequestErrorCodeDraft18 } from '@moq-web/core';
import { afterEach, describe, it } from 'vitest';

import { failOn, isDraft22, publishGroups, Received, requestErrorName, sleep, Trace, waitUntil } from '../lib/flow.js';
import { record } from '../lib/record.js';
import { makeSession, type SessionHandle } from '../lib/session-factory.js';
import { resolveProfile, makeNamespace, type Profile } from '../lib/profile.js';
import chatStream from '../profiles/chat-stream.json';

const PER_GROUP = 3;
/** Groups 0..2 are cached; a relay that keeps 3 groups per track holds them all */
const GROUPS = 3;

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

/** Objects as "group 3, 4/1" (a whole group named once), in group order */
function objectsText(keys: string[]): string {
  const byGroup = new Map<number, number[]>();
  for (const k of keys) {
    const [g, o] = k.split('/').map(Number) as [number, number];
    byGroup.set(g, [...(byGroup.get(g) ?? []), o]);
  }

  return [...byGroup].sort(([a], [b]) => a - b)
    .map(([g, os]) => (os.length === PER_GROUP ? `group ${g}` : os.sort((a, b) => a - b).map((o) => `${g}/${o}`).join(', ')))
    .join(', ');
}

const whole = (from: number, to: number) =>
  Array.from({ length: (to - from + 1) * PER_GROUP }, (_, i) => `${from + Math.floor(i / PER_GROUP)}/${i % PER_GROUP}`);

const CASES: Case[] = [
  { id: 'whole', title: 'whole groups 1..2', range: { startGroup: 1, startObject: 0, endGroup: 2, endObject: 0 }, wanted: whole(1, 2) },
  { id: 'partial', title: 'partial range 0/1..1/1', range: { startGroup: 0, startObject: 1, endGroup: 1, endObject: 1 }, wanted: ['0/1', '0/2', '1/0', '1/1'] },
  { id: 'descending', title: 'groups 0..2 in descending order', range: { startGroup: 0, startObject: 0, endGroup: 2, endObject: 0 }, wanted: whole(0, 2), descending: true },
  { id: 'cache-only', title: 'groups 0..2 after the publisher left', range: { startGroup: 0, startObject: 0, endGroup: 2, endObject: 0 }, wanted: whole(0, 2), publisherLeaves: true },
  { id: 'live-edge', title: 'groups 1..4 across the live edge end at the Largest Object', range: { startGroup: 1, startObject: 0, endGroup: 4, endObject: 0 }, wanted: whole(1, 2), later: 2 },
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
      flow: [
        'Pub: PUBLISH ns/t (stream, MAX_CACHE_DURATION 60 s)',
        'Holder: SUBSCRIBE ns/t so the relay keeps the track cached',
        `Pub: groups 0..${GROUPS - 1}, ${PER_GROUP} Objects each; waits 500 ms`,
        ...(c.publisherLeaves ? ['Pub: closes its session; the holder gets its subscription cancelled'] : []),
        `Sub: FETCH ns/t ${c.range.startGroup}/${c.range.startObject}..${c.range.endGroup}/${c.range.endObject}${c.descending ? ', group order descending' : ''}`,
        ...(c.later ? [`Pub: groups ${GROUPS}..${GROUPS - 1 + c.later} after the FETCH is sent; a FETCH ends at the Largest Object (draft-23 §3.2)`] : []),
        `Relay → Sub: FETCH_OK and a fetch stream with ${c.wanted[0]}..${c.wanted.at(-1)}${c.publisherLeaves ? ', or REQUEST_ERROR DOES_NOT_EXIST with no Objects (allowed)' : ''}`,
        `Check: no FETCH error, every wanted Object arrived byte for byte, none outside the range${c.descending ? ', groups in descending order' : ''}`,
      ],
      expected: `FETCH returns ${c.wanted.length} objects (${c.wanted[0]}..${c.wanted.at(-1)}), byte for byte${c.descending ? ', groups in descending order' : ''}${c.publisherLeaves ? '; or DOES_NOT_EXIST, if the relay dropped the track with its publisher' : ''}${c.later ? '; groups published after the FETCH do not arrive on it' : ''}`,
      inputs: {
        track: `${namespace.join('/')}/t`, cached: `groups 0..${GROUPS - 1}`, objectsPerGroup: PER_GROUP, range: c.range,
        groupOrder: c.descending ? 'descending' : 'ascending', publisherLeaves: c.publisherLeaves === true, publishedAfter: c.later ? `groups ${GROUPS}..${GROUPS - 1 + c.later}` : 'none',
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
    await publishGroups(pub.session, alias, { groups: GROUPS, perGroup: PER_GROUP });
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
      await publishGroups(pub.session, alias, { groups: c.later, perGroup: PER_GROUP, first: GROUPS });
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
    const r = c.range;
    const fetchText = `FETCH ${r.startGroup}/${r.startObject}..${r.endGroup}/${r.endObject}`;
    failOn([
      fetchError !== 'none' && `${fetchText}: the FETCH failed: ${fetchError}`,
      missing.length > 0 && (fetchError === 'none' || got.keys.length > 0)
        && `${fetchText}: expected ${c.wanted.length} Objects (${c.wanted[0]}..${c.wanted.at(-1)}), got ${c.wanted.length - missing.length}; missing ${objectsText(missing)}`,
      extra.length > 0 && `${fetchText}: Objects outside the range arrived: ${objectsText(extra)}${c.later ? ` (groups ${GROUPS} and later were published after the FETCH)` : ''}`,
      got.corrupt.length > 0 && `${fetchText}: Objects with the wrong payload: ${got.corrupt.join(', ')}`,
      c.descending === true && order.join() !== [...order].sort((a, b) => b - a).join()
        && `${fetchText} in descending group order: groups arrived as ${order.join(', ')}`,
    ]);
  });
});
