// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Track Properties travel from the publisher to every subscriber.
 *
 * The publisher's PUBLISH carries Track Properties: subgroup delivery
 * timeout, max cache duration, default publisher priority and group order,
 * and DYNAMIC_GROUPS. A subscriber must see the same values in its
 * SUBSCRIBE_OK, and a TRACK_STATUS must report them too (draft-22 §3.7).
 * Draft-22 and later.
 */

import { GroupOrder } from '@moq-web/core';
import type { TrackProperties } from '@moq-web/session';
import { afterEach, describe, expect, it } from 'vitest';

import { isDraft22, publishGroups, sleep, within } from '../lib/flow.js';
import { record } from '../lib/record.js';
import { makeSession, type SessionHandle } from '../lib/session-factory.js';
import { resolveProfile, makeNamespace, type Profile } from '../lib/profile.js';
import chatStream from '../profiles/chat-stream.json';

const SENT = {
  deliveryTimeout: 4_000,
  maxCacheDuration: 30_000,
  priority: 64,
  groupOrder: GroupOrder.DESCENDING,
  dynamicGroups: true,
};

/** The properties under test, as the receiving side decoded them */
function shown(p: TrackProperties | undefined) {
  return {
    subgroupDeliveryTimeoutMs: p?.subgroupDeliveryTimeoutMs,
    maxCacheDurationMs: p?.maxCacheDurationMs,
    defaultPublisherPriority: p?.defaultPublisherPriority,
    defaultPublisherGroupOrder: p?.defaultPublisherGroupOrder,
    dynamicGroups: p?.dynamicGroups,
  };
}

const WANTED = {
  subgroupDeliveryTimeoutMs: SENT.deliveryTimeout,
  maxCacheDurationMs: SENT.maxCacheDuration,
  defaultPublisherPriority: SENT.priority,
  defaultPublisherGroupOrder: SENT.groupOrder,
  dynamicGroups: SENT.dynamicGroups,
};

describe.skipIf(!isDraft22)('Track Properties', () => {
  let handles: SessionHandle[] = [];

  afterEach(async () => {
    for (const h of handles) await h.close();
    handles = [];
  });

  it("the publisher's Track Properties arrive in SUBSCRIBE_OK and TRACK_STATUS", async ({ task }) => {
    const profile = resolveProfile(chatStream as Profile);
    const namespace = makeNamespace(profile, 'track-props');
    record(task, {
      flow: [
        `Pub: PUBLISH ns/t with Track Properties: delivery timeout ${SENT.deliveryTimeout} ms, max cache ${SENT.maxCacheDuration} ms, priority ${SENT.priority}, group order descending, DYNAMIC_GROUPS`,
        'Sub: SUBSCRIBE ns/t, filter Largest Object',
        'Relay → Sub: SUBSCRIBE_OK with the Track Properties',
        'Pub: one Object, so the track has a Largest Object',
        'Sub: TRACK_STATUS ns/t; Relay → Sub: REQUEST_OK with the Track Properties (draft-22 §3.7)',
        'Check: both carry the same five values the PUBLISH sent',
      ],
      expected: 'SUBSCRIBE_OK and TRACK_STATUS both carry the five Track Properties the PUBLISH sent, with the same values',
      inputs: { track: `${namespace.join('/')}/t`, sent: { ...SENT, groupOrder: 'descending' } },
    });
    const pub = await makeSession(profile);
    const sub = await makeSession(profile);
    handles.push(pub, sub);
    const alias = await pub.session.publish(namespace, 't', { deliveryMode: 'stream', skipForwardWait: true, ...SENT });

    const ok = new Promise<TrackProperties | undefined>((resolve) => {
      sub.session.on('subscribe-ok', (evt) => resolve(evt.trackProperties));
    });
    await within(sub.session.subscribe(namespace, 't', { filterType: 'latest' }, () => undefined), 5_000, 'SUBSCRIBE');
    const inSubscribeOk = shown(await within(ok, 2_000, 'SUBSCRIBE_OK'));
    await sleep(200);
    await publishGroups(pub.session, alias, { groups: 1, perGroup: 1 });
    await sleep(300);

    let inTrackStatus: ReturnType<typeof shown> | string;
    try {
      inTrackStatus = shown((await within(sub.session.trackStatus(namespace, 't'), 5_000, 'TRACK_STATUS')).trackProperties);
    } catch (err) {
      inTrackStatus = (err as Error).message;
    }
    record(task, { observed: { inSubscribeOk, inTrackStatus } });

    expect(inSubscribeOk, 'SUBSCRIBE_OK Track Properties').toEqual(WANTED);
    expect(inTrackStatus, 'TRACK_STATUS Track Properties').toEqual(WANTED);
  });
});
