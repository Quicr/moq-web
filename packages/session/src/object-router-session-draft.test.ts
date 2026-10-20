// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * The router decodes the data plane with the session's draft, not the
 * build-time default. Values below 64 encode identically in QUIC varints
 * and vi64, so the IDs here are above that.
 */

import { describe, expect, it } from 'vitest';
import { Draft18StreamCodec } from '@moq-web/core';

import { ObjectRouter } from './object-router.js';
import { SubscriptionManager, type InternalSubscription } from './subscription-manager.js';

const TRACK_ALIAS = 300n;
const GROUP_ID = 200;
const OBJECT_ID = 0;
const PRIORITY = 128;

function makeSub(): InternalSubscription {
  return {
    subscriptionId: 1,
    requestId: 1n,
    namespace: ['ns'],
    trackName: 'track',
    trackAlias: TRACK_ALIAS,
    paused: false,
  };
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

describe.each(['draft-18', 'draft-22'] as const)('ObjectRouter session draft (%s)', (draft) => {
  it('decodes a subgroup stream with large IDs', async () => {
    const subs = new SubscriptionManager();
    subs.add(makeSub());
    const router = new ObjectRouter(subs, undefined, draft);
    const delivered: Array<[bigint, bigint]> = [];
    router.setCallback((_sub, _data, groupId, objectId) => {
      delivered.push([groupId, objectId]);
    });

    const header = Draft18StreamCodec.encodeSubgroupHeader({
      trackAlias: TRACK_ALIAS,
      groupId: BigInt(GROUP_ID),
      subgroupId: 0n,
      publisherPriority: PRIORITY,
    });
    // Object ID Delta 0 | Payload Length 1 | payload
    const object = new Uint8Array([0x00, 0x01, 0xaa]);
    await router.handleIncomingStream(streamOf(new Uint8Array([...header, ...object])));

    expect(delivered).toEqual([[BigInt(GROUP_ID), BigInt(OBJECT_ID)]]);
  });

  it('decodes a datagram with large IDs', () => {
    const subs = new SubscriptionManager();
    subs.add(makeSub());
    const router = new ObjectRouter(subs, undefined, draft);
    const delivered: Array<[bigint, bigint]> = [];
    router.setCallback((_sub, _data, groupId, objectId) => {
      delivered.push([groupId, objectId]);
    });

    router.handleDatagram(
      Draft18StreamCodec.encodeObjectDatagram({
        trackAlias: TRACK_ALIAS,
        groupId: BigInt(GROUP_ID),
        objectId: 1n,
        publisherPriority: PRIORITY,
        payload: new Uint8Array([0xaa]),
      }),
    );

    expect(delivered).toEqual([[BigInt(GROUP_ID), 1n]]);
  });
});
