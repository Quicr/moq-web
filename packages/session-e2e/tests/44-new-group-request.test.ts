// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * NEW_GROUP_REQUEST end to end.
 *
 * The publisher declares DYNAMIC_GROUPS=1 and keeps sending Objects in group
 * 0, one every 100 ms. The subscriber, which must see DYNAMIC_GROUPS in its
 * SUBSCRIBE_OK, sends REQUEST_UPDATE with NEW_GROUP_REQUEST. The relay must
 * pass it to the publisher, which then starts group 1, and group 1 must reach
 * the subscriber within 3 s. Draft-22 and later.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { isDraft22, payloadOf, Received, Trace, waitUntil, within } from '../lib/flow.js';
import { record } from '../lib/record.js';
import { makeSession, type SessionHandle } from '../lib/session-factory.js';
import { resolveProfile, makeNamespace, type Profile } from '../lib/profile.js';
import chatStream from '../profiles/chat-stream.json';

describe.skipIf(!isDraft22)('NEW_GROUP_REQUEST', () => {
  let handles: SessionHandle[] = [];
  let stop: (() => void) | undefined;

  afterEach(async () => {
    stop?.();
    for (const h of handles) await h.close();
    handles = [];
  });

  it('reaches the publisher, which starts a new group that the subscriber receives', async ({ task }) => {
    const profile = resolveProfile(chatStream as Profile);
    const namespace = makeNamespace(profile, 'new-group');
    const trace = new Trace();
    record(task, {
      flow: [
        'Pub: PUBLISH ns/t (stream, DYNAMIC_GROUPS=1), then one Object every 100 ms in group 0',
        'Sub: SUBSCRIBE ns/t, filter Largest Object',
        'Relay → Sub: SUBSCRIBE_OK carrying DYNAMIC_GROUPS',
        'Sub: waits for 3 Objects, then REQUEST_UPDATE with NEW_GROUP_REQUEST',
        'Relay → Pub: NEW_GROUP_REQUEST; Pub moves to group 1',
        'Relay → Sub: group 1 Objects',
        'Check: DYNAMIC_GROUPS in SUBSCRIBE_OK, the update answered, the request reached Pub, and group 1 arrived within 3 s',
      ],
      expected: 'SUBSCRIBE_OK carries DYNAMIC_GROUPS; the publisher gets the NEW_GROUP_REQUEST; group 1 reaches the subscriber within 3 s of the request',
      inputs: { track: `${namespace.join('/')}/t`, dynamicGroups: true, sendEveryMs: 100 },
    });
    const pub = await makeSession(profile);
    const sub = await makeSession(profile);
    handles.push(pub, sub);
    trace.attach('Pub', pub.session);
    trace.attach('Sub', sub.session);

    const alias = await pub.session.publish(namespace, 't', { deliveryMode: 'stream', skipForwardWait: true, dynamicGroups: true });
    let group = 0;
    let object = 0;
    let requestSeenAt: number | undefined;
    pub.session.on('new-group-request', () => {
      requestSeenAt ??= Date.now();
      group++;
      object = 0;
    });
    const timer = setInterval(() => {
      void pub.session.sendObject(alias, payloadOf(group, object), { groupId: group, objectId: object++ }).catch(() => undefined);
    }, 100);
    stop = () => clearInterval(timer);

    const got = new Received();
    const ok = new Promise<{ requestId: bigint; dynamicGroups: boolean }>((resolve) => {
      sub.session.on('subscribe-ok', (evt) => resolve({ requestId: evt.requestId, dynamicGroups: evt.trackProperties?.dynamicGroups === true }));
    });
    await within(sub.session.subscribe(namespace, 't', { filterType: 'latest' }, got.onObject), 5_000, 'SUBSCRIBE');
    const { requestId, dynamicGroups } = await within(ok, 2_000, 'SUBSCRIBE_OK');
    await waitUntil(() => got.keys.length >= 3, 3_000);

    let sent = 'ok';
    const sentAt = Date.now();
    try {
      await within(sub.session.sendRequestUpdate(requestId, true, { newGroupRequest: true }), 5_000, 'REQUEST_UPDATE');
    } catch (err) {
      sent = (err as Error).message;
    }
    const arrived = await waitUntil(() => got.groups().some((g) => g >= 1), 3_000);
    const firstNewGroupAfterMs = arrived ? Date.now() - sentAt : undefined;
    stop();

    trace.tearingDown = true;
    trace.print(`dynamicGroups=${dynamicGroups} sent=${sent} publisherSaw=${requestSeenAt !== undefined} groups=${got.groups().join(',')}`);
    record(task, {
      observed: {
        dynamicGroupsInSubscribeOk: dynamicGroups,
        requestUpdate: sent,
        publisherGotRequest: requestSeenAt !== undefined,
        groupsReceived: got.groups(),
        newGroupAfterMs: firstNewGroupAfterMs ?? 'not within 3 s',
        trace: trace.lines,
      },
    });

    expect(dynamicGroups, 'DYNAMIC_GROUPS forwarded in SUBSCRIBE_OK').toBe(true);
    expect(sent).toBe('ok');
    expect(requestSeenAt, 'NEW_GROUP_REQUEST reached the publisher').toBeDefined();
    expect(arrived, 'group 1 reached the subscriber').toBe(true);
  });
});
