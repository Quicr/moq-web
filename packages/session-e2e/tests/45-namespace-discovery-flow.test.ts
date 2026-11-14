// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Discovery by namespace, then subscription by name: the whole flow.
 *
 * 1. Sub sends SUBSCRIBE_NAMESPACE for a prefix.
 * 2. Pub sends PUBLISH_NAMESPACE for prefix/pub and PUBLISH for its track,
 *    and sends an Object every 100 ms. It also announces a sibling whose
 *    last field only starts with the prefix's (…/<id>x/pub): namespaces
 *    match field by field, so Sub must not see it.
 * 3. Sub gets NAMESPACE for prefix/pub, SUBSCRIBEs to the track by name and
 *    receives Objects.
 * 4. A late subscriber, Late, sends SUBSCRIBE_NAMESPACE afterwards and gets
 *    NAMESPACE for the namespace that already exists.
 * 5. Pub ends the track: Sub gets PUBLISH_DONE.
 * 6. Pub cancels the announcement: Sub and Late get NAMESPACE_DONE.
 *
 * Draft-22 and later.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { isDraft22, payloadOf, publishDoneName, Received, sleep, Trace, waitUntil, within } from '../lib/flow.js';
import { record } from '../lib/record.js';
import { makeSession, type SessionHandle } from '../lib/session-factory.js';
import { resolveProfile, makeNamespace, type Profile } from '../lib/profile.js';
import chatStream from '../profiles/chat-stream.json';

describe.skipIf(!isDraft22)('Namespace discovery flow', () => {
  let handles: SessionHandle[] = [];
  let stop: (() => void) | undefined;

  afterEach(async () => {
    stop?.();
    for (const h of handles) await h.close();
    handles = [];
  });

  it('SUBSCRIBE_NAMESPACE → PUBLISH_NAMESPACE → SUBSCRIBE → PUBLISH_DONE → NAMESPACE_DONE', async ({ task }) => {
    const profile = resolveProfile(chatStream as Profile);
    const prefix = makeNamespace(profile, 'ns-flow');
    const namespace = [...prefix, 'pub'];
    const sibling = [...prefix.slice(0, -1), `${prefix.at(-1)}x`, 'pub'];
    const trace = new Trace();
    record(task, {
      flow: [
        'Sub: SUBSCRIBE_NAMESPACE prefix',
        'Pub: PUBLISH_NAMESPACE prefix/pub and the sibling …x/pub (matches field by field, so not under prefix)',
        'Pub: PUBLISH prefix/pub/t, then one Object every 100 ms',
        'Relay → Sub: NAMESPACE prefix/pub; Sub SUBSCRIBEs to t by name and receives Objects',
        'Late: SUBSCRIBE_NAMESPACE prefix after the fact; gets NAMESPACE prefix/pub',
        'Pub: stops and ends t; Relay → Sub: PUBLISH_DONE',
        'Pub: cancels PUBLISH_NAMESPACE; Relay → Sub and Late: NAMESPACE_DONE',
        'Check: every step happened within 5 s, neither saw the sibling, and no unexpected errors',
      ],
      expected: 'Each step in order: NAMESPACE to Sub (not for the sibling), Objects on SUBSCRIBE, NAMESPACE to the late subscriber, PUBLISH_DONE after the track ends, NAMESPACE_DONE to both after the cancel',
      inputs: { prefix: prefix.join('/'), namespace: namespace.join('/'), sibling: sibling.join('/'), track: 't' },
    });
    const pub = await makeSession(profile);
    const sub = await makeSession(profile);
    const late = await makeSession(profile);
    handles.push(pub, sub, late);
    trace.attach('Pub', pub.session);
    trace.attach('Sub', sub.session);
    trace.attach('Late', late.session);

    const nsOf = (s: SessionHandle) => {
      const seen = { announced: [] as string[], done: [] as string[] };
      s.session.on('namespace-announced', (evt) => seen.announced.push(evt.namespace.join('/')));
      s.session.on('namespace-done', (evt) => seen.done.push(evt.namespace.join('/')));
      return seen;
    };
    const subNs = nsOf(sub);
    const lateNs = nsOf(late);
    const full = namespace.join('/');
    const steps: Record<string, boolean | string> = {};

    // 1
    await sub.session.subscribeNamespace(prefix);
    await sleep(300);
    // 2
    await within(pub.session.announceNamespace(namespace, { deliveryMode: 'stream' }), 5_000, 'PUBLISH_NAMESPACE');
    await within(pub.session.announceNamespace(sibling, { deliveryMode: 'stream' }), 5_000, 'PUBLISH_NAMESPACE sibling');
    const alias = await within(pub.session.publish(namespace, 't', { deliveryMode: 'stream', skipForwardWait: true }), 5_000, 'PUBLISH');
    let group = 0;
    const timer = setInterval(() => {
      const g = group++;
      void pub.session.sendObject(alias, payloadOf(g, 0), { groupId: g, objectId: 0 }).catch(() => undefined);
    }, 100);
    stop = () => clearInterval(timer);
    // 3
    steps.namespaceToSub = await waitUntil(() => subNs.announced.includes(full), 5_000);
    const got = new Received();
    const subscriptionId = await within(sub.session.subscribe(namespace, 't', { filterType: 'latest' }, got.onObject), 5_000, 'SUBSCRIBE');
    steps.objectsToSub = await waitUntil(() => got.keys.length >= 3, 3_000);
    // 4
    await late.session.subscribeNamespace(prefix);
    steps.namespaceToLate = await waitUntil(() => lateNs.announced.includes(full), 5_000);
    // 5
    let done = 'none';
    sub.session.on('publish-done', (evt) => {
      if (evt.subscriptionId === undefined || evt.subscriptionId === subscriptionId) done = publishDoneName(evt.statusCode);
    });
    stop();
    await pub.session.unpublish(alias);
    steps.publishDoneToSub = await waitUntil(() => done !== 'none', 5_000);
    // 6
    await pub.session.cancelAnnounce(namespace);
    steps.namespaceDoneToSub = await waitUntil(() => subNs.done.includes(full), 5_000);
    steps.namespaceDoneToLate = await waitUntil(() => lateNs.done.includes(full), 5_000);
    steps.siblingSeen = subNs.announced.includes(sibling.join('/')) || lateNs.announced.includes(sibling.join('/'));

    trace.tearingDown = true;
    trace.print(`steps=${JSON.stringify(steps)}`);
    record(task, { observed: { ...steps, publishDone: done, objects: got.keys.length, subNamespaces: subNs, lateNamespaces: lateNs, unexpected: trace.unexpected, trace: trace.lines } });

    expect(steps.namespaceToSub, '3: NAMESPACE to Sub').toBe(true);
    expect(steps.objectsToSub, '3: Objects on the SUBSCRIBE').toBe(true);
    expect(steps.namespaceToLate, '4: NAMESPACE to the late subscriber').toBe(true);
    expect(steps.publishDoneToSub, '5: PUBLISH_DONE to Sub').toBe(true);
    expect(steps.namespaceDoneToSub, '6: NAMESPACE_DONE to Sub').toBe(true);
    expect(steps.namespaceDoneToLate, '6: NAMESPACE_DONE to the late subscriber').toBe(true);
    expect(steps.siblingSeen, 'the sibling namespace matched the prefix').toBe(false);
    expect(trace.unexpected).toEqual([]);
  });
});
