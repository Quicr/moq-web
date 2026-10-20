// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Receiving PUBLISH_DONE (draft-22 §9.9, §3.1.3): objects may still be
 * inbound, so a subscriber keeps routing for the larger of the delivery
 * timeouts, then deletes the subscription and STOP_SENDINGs its streams.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  MOQTransport,
  MessageTypeDraft18,
  ObjectCodec,
  StreamResetErrorCodeDraft18,
} from '@moq-web/core';

import { MOQTSession } from './session.js';
import { ObjectRouter } from './object-router.js';
import { SubscriptionManager } from './subscription-manager.js';
import { streamResetReason } from './stream-reset-reason.js';

type Draft = 'draft-18' | 'draft-22';

const ALIAS = 7n;
const OTHER_ALIAS = 8n;
const DRAIN_MS = 30;
const WAIT_MS = 80;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A subgroup stream that stays open until cancelled */
function openSubgroupStream(alias: bigint, onCancel: (reason?: unknown) => void): ReadableStream<Uint8Array> {
  const [header] = ObjectCodec.encodeSubgroupHeader(
    { trackAlias: alias, groupId: 1, subgroupId: 0, publisherPriority: 128 },
    false,
  );
  let sent = false;

  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(header);
        return;
      }

      return new Promise<void>(() => {});
    },
    cancel: onCancel,
  });
}

describe.each(['draft-18', 'draft-22'] as const)('ObjectRouter subgroup streams (%s)', (draft) => {
  it('cancels the streams of one track alias and no other', async () => {
    const router = new ObjectRouter(new SubscriptionManager(), undefined, draft);
    const cancelled = vi.fn();
    const untouched = vi.fn();
    void router.handleIncomingStream(openSubgroupStream(ALIAS, cancelled));
    void router.handleIncomingStream(openSubgroupStream(OTHER_ALIAS, untouched));
    await wait(0);

    router.cancelSubgroupStreams(ALIAS);

    expect(cancelled).toHaveBeenCalledWith(streamResetReason(StreamResetErrorCodeDraft18.CANCELLED));
    expect(untouched).not.toHaveBeenCalled();
  });
});

describe.each(['draft-18', 'draft-22'] as const)('PUBLISH_DONE received (%s)', (draft) => {
  async function subscribed(options: { objectDeliveryTimeout?: number }, streamCount: bigint) {
    const transport = new MOQTransport({ draft: draft as Draft });
    (transport as unknown as { close: typeof transport.close }).close = vi.fn().mockResolvedValue(undefined);
    const session = new MOQTSession(transport);
    (session as unknown as { _state: string })._state = 'ready';
    const codec = (session as unknown as { codec: { encodeControlMessage: (m: unknown) => Uint8Array } }).codec;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    transport.createRequestStream = vi.fn().mockResolvedValue({
      readable: new ReadableStream<Uint8Array>({ start: (c) => { controller = c; } }),
      writable: new WritableStream<Uint8Array>(),
    });
    const send = (m: unknown) => controller.enqueue(codec.encodeControlMessage(m));
    send({
      type: MessageTypeDraft18.SUBSCRIBE_OK,
      requestId: 0n,
      trackAlias: ALIAS,
      largestLocation: { group: 0n, object: 0n },
    });
    const subscriptionId = await session.subscribe(['ns'], 't', options);
    const router = (session as unknown as { objectRouter: ObjectRouter }).objectRouter;
    const cancel = vi.spyOn(router, 'cancelSubgroupStreams');

    send({
      type: MessageTypeDraft18.PUBLISH_DONE,
      requestId: 0n,
      finalLocation: { group: 0n, object: 0n },
      statusCode: 2n,
      streamCount,
    });
    await wait(0);

    return { session, subscriptionId, cancel };
  }

  it('keeps the subscription for the delivery timeout, then deletes it and stops its streams', async () => {
    const { session, subscriptionId, cancel } = await subscribed({ objectDeliveryTimeout: DRAIN_MS }, 2n);

    expect(session.getSubscription(subscriptionId)).toBeDefined();
    expect(cancel).not.toHaveBeenCalled();
    await wait(WAIT_MS);

    expect(session.getSubscription(subscriptionId)).toBeUndefined();
    expect(cancel).toHaveBeenCalledWith(ALIAS);
  });

  it('deletes the subscription at once when no delivery timeout applies', async () => {
    const { session, subscriptionId } = await subscribed({}, 2n);

    expect(session.getSubscription(subscriptionId)).toBeUndefined();
  });

  it('deletes the subscription at once when the publisher opened no streams', async () => {
    const { session, subscriptionId } = await subscribed({ objectDeliveryTimeout: DRAIN_MS }, 0n);

    expect(session.getSubscription(subscriptionId)).toBeUndefined();
  });

  it('stops the streams of a subscription we cancel', async () => {
    const { session, subscriptionId, cancel } = await subscribed({ objectDeliveryTimeout: DRAIN_MS }, 2n);

    await session.unsubscribe(subscriptionId);

    expect(cancel).toHaveBeenCalledWith(ALIAS);
    expect(session.getSubscription(subscriptionId)).toBeUndefined();
  });
});
