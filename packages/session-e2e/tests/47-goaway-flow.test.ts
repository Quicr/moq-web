// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * GOAWAY drains a session without breaking what is in flight.
 *
 * GOAWAY does not affect subscription state (draft-23 §9.2): delivery goes
 * on until the sender ends its requests and closes. A client cannot make the
 * relay send GOAWAY, so both flows send it from a client, mid-delivery:
 *
 * - Subscriber sends GOAWAY: Objects keep arriving for 2 s after it, then
 *   the subscriber unsubscribes and closes with no error from the relay.
 * - Publisher sends GOAWAY: the subscriber keeps receiving for 2 s, then
 *   the publisher ends the track and the subscriber gets PUBLISH_DONE, its
 *   own session untouched.
 *
 * Draft-22 and later.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { isDraft22, payloadOf, publishDoneName, Received, sleep, Trace, waitUntil, within } from '../lib/flow.js';
import { record } from '../lib/record.js';
import { makeSession, type SessionHandle } from '../lib/session-factory.js';
import { resolveProfile, makeNamespace, type Profile } from '../lib/profile.js';
import chatStream from '../profiles/chat-stream.json';

const DRAIN_MS = 2_000;

describe.skipIf(!isDraft22)('GOAWAY flows', () => {
  let handles: SessionHandle[] = [];
  let stop: (() => void) | undefined;

  afterEach(async () => {
    stop?.();
    for (const h of handles) await h.close();
    handles = [];
  });

  /** A track sending one Object every 100 ms, and a subscriber receiving it */
  async function flowing(label: string, trace: Trace) {
    const profile = resolveProfile(chatStream as Profile);
    const namespace = makeNamespace(profile, label);
    const pub = await makeSession(profile);
    const sub = await makeSession(profile);
    handles.push(pub, sub);
    trace.attach('Pub', pub.session);
    trace.attach('Sub', sub.session);
    const alias = await pub.session.publish(namespace, 't', { deliveryMode: 'stream', skipForwardWait: true });
    const got = new Received();
    const subscriptionId = await within(sub.session.subscribe(namespace, 't', { filterType: 'latest' }, got.onObject), 5_000, 'SUBSCRIBE');
    let g = 0;
    const timer = setInterval(() => {
      const group = g++;
      void pub.session.sendObject(alias, payloadOf(group, 0), { groupId: group, objectId: 0 }).catch(() => undefined);
    }, 100);
    stop = () => clearInterval(timer);
    await waitUntil(() => got.keys.length >= 3, 3_000);

    return { namespace, pub, sub, alias, got, subscriptionId };
  }

  it('subscriber GOAWAY: delivery continues, then it unsubscribes and closes cleanly', async ({ task }) => {
    const trace = new Trace();
    const { namespace, sub, got, subscriptionId } = await flowing('goaway-sub', trace);
    record(task, {
      flow: [
        'Pub: PUBLISH ns/t, one Object (new group) every 100 ms',
        'Sub: SUBSCRIBE ns/t, filter Largest Object; waits for 3 Objects',
        'Sub: GOAWAY to the relay',
        `Sub: keeps receiving for ${DRAIN_MS / 1000} s; GOAWAY leaves subscriptions intact (draft-23 §9.2)`,
        'Sub: UNSUBSCRIBE, then closes its session',
        `Check: at least 10 Objects arrived during the ${DRAIN_MS / 1000} s, and no unexpected error or close code`,
      ],
      expected: `Objects keep arriving for ${DRAIN_MS / 1000} s after the subscriber's GOAWAY; it then unsubscribes and closes with no error event`,
      inputs: { track: `${namespace.join('/')}/t`, sendEveryMs: 100, drainMs: DRAIN_MS },
    });
    const before = got.keys.length;
    trace.note('Sub', 'GOAWAY');
    await sub.session.goAway();
    const stateAfter = sub.session.state;
    await sleep(DRAIN_MS);
    const during = got.keys.length - before;
    await sub.session.unsubscribe(subscriptionId);
    trace.tearingDown = true;
    await sub.close();

    trace.print(`objects after GOAWAY=${during} state=${stateAfter}`);
    record(task, { observed: { objectsAfterGoaway: during, stateAfterGoaway: stateAfter, unexpected: trace.unexpected, trace: trace.lines } });

    expect(during, `Objects in the ${DRAIN_MS / 1000} s after GOAWAY`).toBeGreaterThanOrEqual(10);
    expect(trace.unexpected).toEqual([]);
  });

  it('publisher GOAWAY: the subscriber keeps receiving, then gets PUBLISH_DONE', async ({ task }) => {
    const trace = new Trace();
    const { namespace, pub, sub, alias, got, subscriptionId } = await flowing('goaway-pub', trace);
    record(task, {
      flow: [
        'Pub: PUBLISH ns/t, one Object (new group) every 100 ms',
        'Sub: SUBSCRIBE ns/t, filter Largest Object; waits for 3 Objects',
        'Pub: GOAWAY to the relay',
        `Pub: keeps sending for ${DRAIN_MS / 1000} s, then stops and ends the track`,
        'Relay → Sub: PUBLISH_DONE',
        `Check: at least 10 Objects in the ${DRAIN_MS / 1000} s, PUBLISH_DONE within 5 s, Sub's session still ready, no unexpected errors`,
      ],
      expected: `The subscriber receives Objects for ${DRAIN_MS / 1000} s after the publisher's GOAWAY, then PUBLISH_DONE when the publisher ends the track; its session stays ready`,
      inputs: { track: `${namespace.join('/')}/t`, sendEveryMs: 100, drainMs: DRAIN_MS },
    });
    let done = 'none';
    sub.session.on('publish-done', (evt) => {
      if (evt.subscriptionId === undefined || evt.subscriptionId === subscriptionId) done = publishDoneName(evt.statusCode);
    });
    const before = got.keys.length;
    trace.note('Pub', 'GOAWAY');
    await pub.session.goAway();
    await sleep(DRAIN_MS);
    const during = got.keys.length - before;
    stop?.();
    await pub.session.unpublish(alias);
    const gotDone = await waitUntil(() => done !== 'none', 5_000);

    trace.tearingDown = true;
    trace.print(`objects after GOAWAY=${during} publishDone=${done} subState=${sub.session.state}`);
    record(task, { observed: { objectsAfterGoaway: during, publishDone: done, subscriberState: sub.session.state, unexpected: trace.unexpected, trace: trace.lines } });

    expect(during, `Objects in the ${DRAIN_MS / 1000} s after GOAWAY`).toBeGreaterThanOrEqual(10);
    expect(gotDone, 'PUBLISH_DONE after the publisher ended the track').toBe(true);
    expect(sub.session.state).toBe('ready');
    expect(trace.unexpected).toEqual([]);
  });
});
