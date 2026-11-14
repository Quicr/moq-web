// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * PUBLISH_NAMESPACE lifecycle, as a namespace subscriber sees it.
 *
 * A publisher announces a namespace, cancels it, and announces it again. A
 * session with SUBSCRIBE_NAMESPACE on the parent prefix must see NAMESPACE,
 * then NAMESPACE_DONE after the cancel, then NAMESPACE again. The relay
 * cancelling an announcement on its own cannot be triggered from a client,
 * so this covers the cancel our side sends and the relay's fan-out of it.
 * Draft-22 and later.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { isDraft22, sleep, Trace, waitUntil, within } from '../lib/flow.js';
import { record } from '../lib/record.js';
import { makeSession, type SessionHandle } from '../lib/session-factory.js';
import { resolveProfile, makeNamespace, type Profile } from '../lib/profile.js';
import chatStream from '../profiles/chat-stream.json';

describe.skipIf(!isDraft22)('PUBLISH_NAMESPACE lifecycle', () => {
  let handles: SessionHandle[] = [];

  afterEach(async () => {
    for (const h of handles) await h.close();
    handles = [];
  });

  it('subscriber sees NAMESPACE, NAMESPACE_DONE after the cancel, and NAMESPACE again on re-announce', async ({ task }) => {
    const profile = resolveProfile(chatStream as Profile);
    const prefix = makeNamespace(profile, 'pubns-life');
    const namespace = [...prefix, 'pub'];
    const trace = new Trace();
    record(task, {
      expected: 'Namespace events for the announced namespace, in order: announced, done, announced',
      inputs: { prefix: prefix.join('/'), namespace: namespace.join('/') },
    });
    const pub = await makeSession(profile);
    const sub = await makeSession(profile);
    handles.push(pub, sub);
    trace.attach('Pub', pub.session);
    trace.attach('Sub', sub.session);

    const events: string[] = [];
    const mine = (ns: string[]) => ns.join('/') === namespace.join('/') || ns.join('/') === 'pub';
    sub.session.on('namespace-announced', (evt) => { if (mine(evt.namespace)) events.push('announced'); });
    sub.session.on('namespace-done', (evt) => { if (mine(evt.namespace)) events.push('done'); });

    await sub.session.subscribeNamespace(prefix);
    await sleep(300);

    await within(pub.session.announceNamespace(namespace, { deliveryMode: 'stream' }), 5_000, 'PUBLISH_NAMESPACE');
    const announced = await waitUntil(() => events.length >= 1, 5_000);
    await pub.session.cancelAnnounce(namespace);
    const done = await waitUntil(() => events.length >= 2, 5_000);
    await within(pub.session.announceNamespace(namespace, { deliveryMode: 'stream' }), 5_000, 'second PUBLISH_NAMESPACE');
    const again = await waitUntil(() => events.length >= 3, 5_000);

    trace.tearingDown = true;
    trace.print(`events=${events.join(',')}`);
    record(task, { observed: { events, announced, done, again, unexpected: trace.unexpected, trace: trace.lines } });

    expect(events.slice(0, 3)).toEqual(['announced', 'done', 'announced']);
    expect(trace.unexpected).toEqual([]);
  });
});
