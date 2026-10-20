// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Object Status and END_OF_GROUP on the draft-18/22 data plane
 * (d22 §11.1.1, §11.2.1; d18 §11.2.1.1, §11.3.1).
 *
 * Status objects carry no payload: they must never reach the application
 * as empty Normal objects.
 */

import { describe, expect, it } from 'vitest';
import { Draft18StreamCodec, ObjectStatusDraft18 } from '@moq-web/core';

import { ObjectRouter } from './object-router.js';
import { SubscriptionManager, type InternalSubscription } from './subscription-manager.js';

const TRACK_ALIAS = 7n;
const GROUP_ID = 3;
const OBJECT_ID = 5;
const PRIORITY = 128;

interface Harness {
  router: ObjectRouter;
  delivered: Array<[number, number, number]>;
  endedGroups: number[];
}

function harness(draft: 'draft-18' | 'draft-22'): Harness {
  const subs = new SubscriptionManager();
  const endedGroups: number[] = [];
  const sub: InternalSubscription = {
    subscriptionId: 1,
    requestId: 1n,
    namespace: ['ns'],
    trackName: 'track',
    trackAlias: TRACK_ALIAS,
    paused: false,
    onEndOfGroup: (groupId) => endedGroups.push(groupId),
  };
  subs.add(sub);

  const router = new ObjectRouter(subs, undefined, draft);
  const delivered: Array<[number, number, number]> = [];
  router.setCallback((_sub, data, groupId, objectId) => {
    delivered.push([groupId, objectId, data.length]);
  });

  return { router, delivered, endedGroups };
}

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

function subgroupHeader(): Uint8Array {
  return Draft18StreamCodec.encodeSubgroupHeader({
    trackAlias: TRACK_ALIAS,
    groupId: BigInt(GROUP_ID),
    subgroupId: 0n,
    publisherPriority: PRIORITY,
  });
}

describe.each(['draft-18', 'draft-22'] as const)('Object Status on the data plane (%s)', (draft) => {
  it('does not deliver a STATUS datagram carrying End of Track', () => {
    const { router, delivered, endedGroups } = harness(draft);

    router.handleDatagram(
      Draft18StreamCodec.encodeObjectDatagram({
        trackAlias: TRACK_ALIAS,
        groupId: BigInt(GROUP_ID),
        objectId: BigInt(OBJECT_ID),
        publisherPriority: PRIORITY,
        objectStatus: ObjectStatusDraft18.END_OF_TRACK,
      }),
    );

    expect(delivered).toEqual([]);
    expect(endedGroups).toEqual([]);
  });

  it('signals the group end for a STATUS datagram carrying End of Group', () => {
    const { router, delivered, endedGroups } = harness(draft);

    router.handleDatagram(
      Draft18StreamCodec.encodeObjectDatagram({
        trackAlias: TRACK_ALIAS,
        groupId: BigInt(GROUP_ID),
        objectId: BigInt(OBJECT_ID),
        publisherPriority: PRIORITY,
        objectStatus: ObjectStatusDraft18.END_OF_GROUP,
      }),
    );

    expect(delivered).toEqual([]);
    expect(endedGroups).toEqual([GROUP_ID]);
  });

  it('delivers a datagram with END_OF_GROUP, then signals the group end', () => {
    const { router, delivered, endedGroups } = harness(draft);

    router.handleDatagram(
      Draft18StreamCodec.encodeObjectDatagram({
        trackAlias: TRACK_ALIAS,
        groupId: BigInt(GROUP_ID),
        objectId: BigInt(OBJECT_ID),
        publisherPriority: PRIORITY,
        endOfGroup: true,
        payload: new Uint8Array([0xaa]),
      }),
    );

    expect(delivered).toEqual([[GROUP_ID, OBJECT_ID, 1]]);
    expect(endedGroups).toEqual([GROUP_ID]);
  });

  it('does not deliver a stream End of Track object', async () => {
    const { router, delivered } = harness(draft);

    // Object ID Delta 0 | Payload Length 0 | Object Status End of Track
    const endOfTrack = new Uint8Array([0x00, 0x00, ObjectStatusDraft18.END_OF_TRACK]);
    await router.handleIncomingStream(streamOf(subgroupHeader(), endOfTrack));

    expect(delivered).toEqual([]);
  });

  it('signals the group end for a stream End of Group object', async () => {
    const { router, delivered, endedGroups } = harness(draft);

    const endOfGroup = new Uint8Array([0x00, 0x00, ObjectStatusDraft18.END_OF_GROUP]);
    await router.handleIncomingStream(streamOf(subgroupHeader(), endOfGroup));

    expect(delivered).toEqual([]);
    expect(endedGroups).toEqual([GROUP_ID]);
  });

  it('delivers a zero-length Normal object', async () => {
    const { router, delivered } = harness(draft);

    const empty = new Uint8Array([0x00, 0x00, ObjectStatusDraft18.NORMAL]);
    await router.handleIncomingStream(streamOf(subgroupHeader(), empty));

    expect(delivered).toEqual([[GROUP_ID, 0, 0]]);
  });
});
