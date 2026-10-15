// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Delivery timeouts are enforced by the sender (d22 §5.2); a subscriber only
 * advertises them as parameters. The router must not cancel a healthy stream
 * because objects arrive further apart than a requested timeout.
 */

import { describe, expect, it, vi } from 'vitest';
import { Draft18StreamCodec } from '@moq-web/core';

import { ObjectRouter } from './object-router.js';
import { SubscriptionManager, type InternalSubscription } from './subscription-manager.js';

const TRACK_ALIAS = 7n;
const GROUP_ID = 3;
const TIMEOUT_MS = 20;
const GAP_MS = 80;

/** Object ID Delta 0 | Payload Length 1 | payload */
const NEXT_OBJECT = new Uint8Array([0x00, 0x01, 0xbb]);
const FIRST_OBJECT = new Uint8Array([0x00, 0x01, 0xaa]);

describe.each(['draft-18', 'draft-22'] as const)('subscriber delivery timeouts (%s)', (draft) => {
  it('keeps reading a subgroup whose objects arrive slower than the requested timeouts', async () => {
    const subs = new SubscriptionManager();
    const sub: InternalSubscription = {
      subscriptionId: 1,
      requestId: 1n,
      namespace: ['ns'],
      trackName: 'track',
      trackAlias: TRACK_ALIAS,
      paused: false,
      subgroupDeliveryTimeoutMs: TIMEOUT_MS,
      objectDeliveryTimeoutMs: TIMEOUT_MS,
    };
    subs.add(sub);
    const router = new ObjectRouter(subs, undefined, draft);
    const delivered: number[] = [];
    router.setCallback((_sub, _data, _groupId, objectId) => {
      delivered.push(objectId);
    });

    const header = Draft18StreamCodec.encodeSubgroupHeader({
      trackAlias: TRACK_ALIAS,
      groupId: BigInt(GROUP_ID),
      subgroupId: 0n,
      publisherPriority: 128,
    });
    const cancelled = vi.fn();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
      cancel: cancelled,
    });

    const done = router.handleIncomingStream(stream);
    controller.enqueue(new Uint8Array([...header, ...FIRST_OBJECT]));
    await new Promise((resolve) => setTimeout(resolve, GAP_MS));
    controller.enqueue(NEXT_OBJECT);
    controller.close();
    await done;

    expect(delivered).toEqual([0, 1]);
    expect(cancelled).not.toHaveBeenCalled();
  });
});
