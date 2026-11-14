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

import { afterEach, describe, expect, it } from 'vitest';

import { isDraft22, publishGroups, Received, sleep, Trace, waitUntil, within } from '../lib/flow.js';
import { record } from '../lib/record.js';
import { makeSession, type SessionHandle } from '../lib/session-factory.js';
import { resolveProfile, makeNamespace, type Profile } from '../lib/profile.js';
import chatStream from '../profiles/chat-stream.json';

const PER_GROUP = 3;

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
      expected: 'Groups 2..6 arrive (2..4 from the fill, 5..6 live); groups 0..1 do not',
      inputs: { track: `${namespace.join('/')}/t`, cached: 'groups 0..4', fill: { lastGroups: 3 }, publishedAfter: 'groups 5..6', objectsPerGroup: PER_GROUP },
    });
    const got = new Received();
    await within(sub.session.subscribe(namespace, 't', { filterType: 'latest', fill: { lastGroups: 3 } }, got.onObject), 5_000, 'SUBSCRIBE');
    await sleep(300);
    await publishGroups(pub.session, alias, { groups: 2, perGroup: PER_GROUP, first: 5 });
    const wanted = groupKeys(2, 6);
    await waitUntil(() => wanted.every((k) => got.has(k)), 5_000);
    await sleep(300);

    const missing = wanted.filter((k) => !got.has(k));
    const tooEarly = got.keys.filter((k) => Number(k.split('/')[0]) < 2);
    trace.tearingDown = true;
    trace.print(`received=${got.keys.join(' ')}`);
    record(task, { observed: { received: got.keys, missing, tooEarly, corrupt: got.corrupt, unexpected: trace.unexpected, trace: trace.lines } });

    expect(missing, 'objects of groups 2..6 that never arrived').toEqual([]);
    expect(tooEarly, 'objects before group 2').toEqual([]);
    expect(got.corrupt).toEqual([]);
  });

  it('REQUEST_UPDATE fill of groups 1..2 delivers exactly those groups', async ({ task }) => {
    const trace = new Trace();
    const { namespace, sub } = await trackWithHistory('fill-update', trace);
    record(task, {
      expected: 'After REQUEST_UPDATE with fill startGroup 1, endGroup 2, the objects of groups 1 and 2 arrive, and no others',
      inputs: { track: `${namespace.join('/')}/t`, cached: 'groups 0..4', fill: { startGroup: 1, endGroup: 2 }, objectsPerGroup: PER_GROUP },
    });
    const got = new Received();
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

    const missing = wanted.filter((k) => !got.has(k));
    const extra = got.keys.filter((k) => !wanted.includes(k));
    trace.tearingDown = true;
    trace.print(`filled=${filled} received=${got.keys.join(' ')}`);
    record(task, { observed: { filled, received: got.keys, missing, extra, corrupt: got.corrupt, unexpected: trace.unexpected, trace: trace.lines } });

    expect(filled).toBe('ok');
    expect(missing, 'objects of groups 1..2 that never arrived').toEqual([]);
    expect(extra, 'objects outside groups 1..2').toEqual([]);
  });
});
