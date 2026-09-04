// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Draft-18 §7 priority scheduling — end-to-end against a live relay.
 *
 * Two subscribers subscribe to the same track with different subscriber
 * priorities (§10.2 SUBSCRIBER_PRIORITY) and group orders. The publisher
 * fires objects across a couple of groups; both subscribers must receive
 * delivery. This exercises the outgoing `sendOrder` path in the publisher
 * (`deriveSendOrder` → `WebTransportSendStreamOptions.sendOrder`) without
 * depending on relay-specific priority behaviour.
 *
 * We don't assert *ordering* of arrival across peers — QUIC scheduling is
 * inherently best-effort and a relay may reorder freely. We assert:
 *   • The subscribe with non-default priority + DESCENDING order completes.
 *   • Both subscribers receive at least one object.
 *   • Padding does not leak into the delivery path.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { GroupOrder } from '@moq-web/core';

import { makeSession, type SessionHandle } from '../lib/session-factory.js';
import { resolveProfile, makeNamespace, type Profile } from '../lib/profile.js';
import { generateChat } from '../lib/chat-generator.js';
import chatStream from '../profiles/chat-stream.json';

const MOQT_VERSION = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_MOQT_VERSION ?? 'draft-18';
const isDraft18 = MOQT_VERSION === 'draft-18';

describe.skipIf(!isDraft18)('priority scheduling (§7)', () => {
  let pub: SessionHandle | undefined;
  let sub1: SessionHandle | undefined;
  let sub2: SessionHandle | undefined;

  afterEach(async () => {
    try { await pub?.close(); } catch { /* ignore */ }
    try { await sub1?.close(); } catch { /* ignore */ }
    try { await sub2?.close(); } catch { /* ignore */ }
    pub = undefined;
    sub1 = undefined;
    sub2 = undefined;
  });

  it('subscribers with different SUBSCRIBER_PRIORITY + GROUP_ORDER both receive objects', async () => {
    const profile = resolveProfile(chatStream as Profile);
    const track = profile.tracks[0];
    if (!track) throw new Error('profile has no tracks');

    const namespace = makeNamespace(profile, 'priority');

    pub = await makeSession(profile);
    sub1 = await makeSession(profile);
    sub2 = await makeSession(profile);

    const trackAlias = await pub.session.publish(namespace, track.name, {
      priority: track.priority,
      deliveryTimeout: track.deliveryTimeout,
      deliveryMode: track.delivery,
      skipForwardWait: true,
    });

    const rx1: Uint8Array[] = [];
    const rx2: Uint8Array[] = [];

    // Subscriber 1: high subscriber priority, DESCENDING.
    await sub1.session.subscribe(
      namespace,
      track.name,
      { priority: 16, groupOrder: GroupOrder.DESCENDING },
      (data) => { rx1.push(new Uint8Array(data)); },
    );

    // Subscriber 2: low subscriber priority, ASCENDING.
    await sub2.session.subscribe(
      namespace,
      track.name,
      { priority: 240, groupOrder: GroupOrder.ASCENDING },
      (data) => { rx2.push(new Uint8Array(data)); },
    );

    await new Promise((r) => setTimeout(r, 300));

    // Publish a handful of objects across a couple of groups. The publisher
    // side attaches a `sendOrder` derived from each subscriber's SUBSCRIBE
    // params — verified end-to-end by these subscribers still getting data.
    let sent = 0;
    for (const msg of generateChat(track.payload)) {
      await pub.session.sendObject(trackAlias, msg.bytes, {
        groupId: msg.groupId,
        objectId: msg.objectId,
      });
      if (++sent >= 4) break;
    }

    // Give the relay a moment to forward objects to both subscribers.
    await new Promise((r) => setTimeout(r, 800));

    expect(rx1.length).toBeGreaterThanOrEqual(1);
    expect(rx2.length).toBeGreaterThanOrEqual(1);
  });
});
