// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * OBJECT_DATAGRAM routing (draft-18 / draft-22 §11.2.1).
 *
 * Type Flags 0x04 is ZERO_OBJECT_ID: Object ID omitted and equal to 0, with
 * an explicit priority. It is the first object of every group, so dropping
 * it loses one object per group.
 */

import { describe, expect, it } from 'vitest';
import { Draft18StreamCodec } from '@moq-web/core';

import { ObjectRouter } from './object-router.js';
import { SubscriptionManager, type InternalSubscription } from './subscription-manager.js';

const TRACK_ALIAS = 7n;

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

describe.each(['draft-18', 'draft-22'] as const)('ObjectRouter datagrams (%s)', (draft) => {
  it('delivers a ZERO_OBJECT_ID datagram (Type Flags 0x04) as object 0', () => {
    const subs = new SubscriptionManager();
    subs.add(makeSub());
    const router = new ObjectRouter(subs, undefined, draft);

    const delivered: Array<[bigint, bigint]> = [];
    router.setCallback((_sub, _data, groupId, objectId) => {
      delivered.push([groupId, objectId]);
    });

    const datagram = Draft18StreamCodec.encodeObjectDatagram({
      trackAlias: TRACK_ALIAS,
      groupId: 3n,
      objectId: 0n,
      publisherPriority: 128,
      payload: new Uint8Array([0xaa]),
    });
    expect(datagram[0]).toBe(0x04);

    router.handleDatagram(datagram);

    expect(delivered).toEqual([[3n, 0n]]);
  });
});
