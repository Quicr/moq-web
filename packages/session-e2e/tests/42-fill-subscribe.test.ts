// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Fill: a subscriber joining mid-track gets recent history and the live edge.
 *
 * Draft-22 replaced joining FETCH with FILL_PARAMETERS (§3.4): the relay
 * opens a fill stream with past groups next to the live subscription. A
 * holder subscription keeps groups 0..4 in the relay's cache, then:
 *
 * - SUBSCRIBE with fill of the last 3 groups gets 2..4 from the fill and
 *   the groups published afterwards (5, 6) live, and nothing before group 2.
 * - SUBSCRIBE with no fill, then REQUEST_UPDATE with fill of groups 1..2,
 *   gets exactly groups 1 and 2 from the fill.
 *
 * Draft-22 and later.
 */

import type { FillStreamEndedEvent } from '@moq-web/session';
import { afterEach, describe, it } from 'vitest';

import { failOn, groupShortfall, isDraft22, publishGroups, ranges, Received, sleep, Trace, waitUntil, within } from '../lib/flow.js';
import { record } from '../lib/record.js';
import { makeSession, type SessionHandle } from '../lib/session-factory.js';
import { resolveProfile, makeNamespace, type Profile } from '../lib/profile.js';
import chatStream from '../profiles/chat-stream.json';

const PER_GROUP = 3;

const groupOf = (key: string) => Number(key.split('/')[0]);

/** How the fill stream ended, for the failure message */
const fillEnding = (end: FillStreamEndedEvent | undefined) =>
  end === undefined ? 'the fill stream had not ended'
    : end.lastGroupId === undefined ? 'the fill stream ended with no Objects'
      : `the fill stream ended after group ${end.lastGroupId}`;

const groupKeys = (from: number, to: number) =>
  Array.from({ length: (to - from + 1) * PER_GROUP }, (_, i) => `${from + Math.floor(i / PER_GROUP)}/${i % PER_GROUP}`);

describe.skipIf(!isDraft22)('Fill with SUBSCRIBE', () => {
  let handles: SessionHandle[] = [];

  afterEach(async () => {
    for (const h of handles) await h.close();
    handles = [];
  });

  /** A publisher with groups 0..4 sent, kept in the relay's cache by a holder subscription */
  async function trackWithHistory(label: string, trace: Trace) {
    const profile = resolveProfile(chatStream as Profile);
    const namespace = makeNamespace(profile, label);
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

    return { profile, namespace, pub, sub, alias };
  }

  it('fill of the last 3 groups delivers 2..4 from the cache, then 5..6 live', async ({ task }) => {
    const trace = new Trace();
    const { namespace, pub, sub, alias } = await trackWithHistory('fill-last', trace);
    record(task, {
      flow: [
        'Pub: PUBLISH ns/t (stream, MAX_CACHE_DURATION 60 s)',
        'Holder: SUBSCRIBE ns/t so the relay keeps the track cached',
        `Pub: groups 0..4, ${PER_GROUP} Objects each; waits 500 ms`,
        'Sub: SUBSCRIBE ns/t, filter Largest Object, FILL_PARAMETERS last 3 groups (§3.4)',
        'Relay → Sub: SUBSCRIBE_OK, a fill stream with groups 2..4, and the live subscription',
        `Pub: groups 5..6, ${PER_GROUP} Objects each`,
        'Check: every Object of groups 2..6 arrived, none before group 2, all byte for byte',
      ],
      expected: 'Groups 2..6 arrive (2..4 from the fill, 5..6 live); groups 0..1 do not',
      inputs: { track: `${namespace.join('/')}/t`, cached: 'groups 0..4', fill: { lastGroups: 3 }, publishedAfter: 'groups 5..6', objectsPerGroup: PER_GROUP },
    });
    const got = new Received();
    let fillEnd: FillStreamEndedEvent | undefined;
    sub.session.on('fill-stream-ended', (evt) => { fillEnd = evt; });
    await within(sub.session.subscribe(namespace, 't', { filterType: 'latest', fill: { lastGroups: 3 } }, got.onObject), 5_000, 'SUBSCRIBE');
    await sleep(300);
    await publishGroups(pub.session, alias, { groups: 2, perGroup: PER_GROUP, first: 5 });
    const wanted = groupKeys(2, 6);
    await waitUntil(() => wanted.every((k) => got.has(k)), 5_000);
    await sleep(300);

    const fromFill = groupShortfall('Fill (groups from the cache)', got, 2, 4, PER_GROUP);
    const live = groupShortfall('Live (groups published after SUBSCRIBE)', got, 5, 6, PER_GROUP);
    const tooEarly = got.keys.filter((k) => groupOf(k) < 2);
    trace.tearingDown = true;
    trace.print(`received=${got.keys.join(' ')}`);
    record(task, {
      observed: {
        fill: fromFill ?? 'groups 2–4 complete', fillStream: fillEnding(fillEnd), live: live ?? 'groups 5–6 complete',
        received: got.keys, tooEarly, corrupt: got.corrupt, unexpected: trace.unexpected, trace: trace.lines,
      },
    });

    failOn([
      fromFill && `${fromFill} (${fillEnding(fillEnd)})`,
      live,
      tooEarly.length > 0 && `Groups before the fill arrived: ${ranges(tooEarly.map(groupOf))}`,
      got.corrupt.length > 0 && `Objects with the wrong payload: ${got.corrupt.join(', ')}`,
    ]);
  });

  it('REQUEST_UPDATE fill of groups 1..2 delivers exactly those groups', async ({ task }) => {
    const trace = new Trace();
    const { namespace, sub } = await trackWithHistory('fill-update', trace);
    record(task, {
      flow: [
        'Pub: PUBLISH ns/t (stream, MAX_CACHE_DURATION 60 s)',
        'Holder: SUBSCRIBE ns/t so the relay keeps the track cached',
        `Pub: groups 0..4, ${PER_GROUP} Objects each; waits 500 ms`,
        'Sub: SUBSCRIBE ns/t, filter Largest Object, no fill',
        'Sub: REQUEST_UPDATE with FILL_PARAMETERS startGroup 1, endGroup 2',
        'Relay → Sub: REQUEST_UPDATE_OK and a fill stream with groups 1..2',
        'Check: the update was answered, every Object of groups 1 and 2 arrived, and nothing else',
      ],
      expected: 'After REQUEST_UPDATE with fill startGroup 1, endGroup 2, the objects of groups 1 and 2 arrive, and no others',
      inputs: { track: `${namespace.join('/')}/t`, cached: 'groups 0..4', fill: { startGroup: 1, endGroup: 2 }, objectsPerGroup: PER_GROUP },
    });
    const got = new Received();
    let fillEnd: FillStreamEndedEvent | undefined;
    sub.session.on('fill-stream-ended', (evt) => { fillEnd = evt; });
    const subscriptionId = await within(sub.session.subscribe(namespace, 't', { filterType: 'latest' }, got.onObject), 5_000, 'SUBSCRIBE');
    await sleep(300);
    let filled = 'ok';
    try {
      await within(sub.session.requestFill(subscriptionId, { startGroup: 1, endGroup: 2 }), 5_000, 'REQUEST_UPDATE fill');
    } catch (err) {
      filled = (err as Error).message;
    }
    const wanted = groupKeys(1, 2);
    await waitUntil(() => wanted.every((k) => got.has(k)), 5_000);
    await sleep(300);

    const fromFill = groupShortfall('Fill after the accepted REQUEST_UPDATE', got, 1, 2, PER_GROUP);
    const extra = got.keys.filter((k) => !wanted.includes(k));
    trace.tearingDown = true;
    trace.print(`filled=${filled} received=${got.keys.join(' ')}`);
    record(task, {
      observed: {
        requestUpdate: filled, fill: fromFill ?? 'groups 1–2 complete', fillStream: fillEnding(fillEnd),
        received: got.keys, extra, corrupt: got.corrupt, unexpected: trace.unexpected, trace: trace.lines,
      },
    });

    failOn(filled !== 'ok'
      ? [`The relay refused the REQUEST_UPDATE fill: ${filled}`]
      : [
        fromFill && `${fromFill} (${fillEnding(fillEnd)})`,
        extra.length > 0 && `Groups outside 1–2 arrived: ${ranges(extra.map(groupOf))}`,
        got.corrupt.length > 0 && `Objects with the wrong payload: ${got.corrupt.join(', ')}`,
      ]);
  });
});
