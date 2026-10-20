// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * seekSubscription on draft-18/22 (draft-22 §9.5, draft-18 §10.9): the seek
 * is a REQUEST_UPDATE with a location filter on the subscription's request
 * stream, never a message on the control stream.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  MOQTransport,
  MessageTypeDraft18,
  LocationFilterTypeDraft22,
  SubscriptionFilterDraft18,
  type ControlMessageDraft18,
} from '@moq-web/core';

import { MOQTSession } from './session.js';

type Draft = 'draft-18' | 'draft-22';

const REQUEST_ID = 0n;
const SEEK_GROUP = 42;
const SEEK_OBJECT = 5;

interface Internals {
  codec: {
    encodeControlMessage: (m: unknown) => Uint8Array;
    decodeControlMessage: (b: Uint8Array) => [ControlMessageDraft18, number];
  };
  doSendControl: (b: Uint8Array) => Promise<void>;
  sendRequestAndWaitResponse: (b: Uint8Array, id: bigint, kind: string) => Promise<unknown>;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function subscribedSession(draft: Draft) {
  const transport = new MOQTransport({ draft });
  (transport as unknown as { close: typeof transport.close }).close = vi.fn().mockResolvedValue(undefined);
  const session = new MOQTSession(transport);
  (session as unknown as { _state: string })._state = 'ready';
  const internals = session as unknown as Internals;
  const sendControl = vi.fn().mockResolvedValue(undefined);
  internals.doSendControl = sendControl;

  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const written: Uint8Array[] = [];
  transport.createRequestStream = vi.fn().mockResolvedValue({
    readable: new ReadableStream<Uint8Array>({ start: (c) => { controller = c; } }),
    writable: new WritableStream<Uint8Array>({ write: (chunk) => { written.push(chunk); } }),
  });
  const send = (message: unknown) => controller.enqueue(internals.codec.encodeControlMessage(message));

  send({
    type: MessageTypeDraft18.SUBSCRIBE_OK,
    requestId: REQUEST_ID,
    trackAlias: 1n,
    largestLocation: { group: 0n, object: 0n },
  });
  const subscriptionId = await session.subscribe(['ns'], 't');
  await tick();

  return { session, internals, sendControl, written, send, subscriptionId };
}

describe.each(['draft-18', 'draft-22'] as const)('seekSubscription (%s)', (draft) => {
  it('sends a REQUEST_UPDATE with the start Location on the request stream', async () => {
    const { session, internals, sendControl, written, send, subscriptionId } = await subscribedSession(draft);
    const requestsBefore = written.length;

    const seeking = session.seekSubscription(subscriptionId, SEEK_GROUP, SEEK_OBJECT);
    await tick();
    send({ type: MessageTypeDraft18.REQUEST_OK, requestId: REQUEST_ID });
    await seeking;

    expect(sendControl).not.toHaveBeenCalled();
    expect(written).toHaveLength(requestsBefore + 1);
    const update = internals.codec.decodeControlMessage(written[requestsBefore])[0] as unknown as {
      type: number;
      forwardState: boolean;
      filter?: number;
      locationFilter?: { type: number; startLocation: { group: bigint; object: bigint } };
      startLocation?: { group: bigint; object: bigint };
    };
    expect(update.type).toBe(MessageTypeDraft18.REQUEST_UPDATE);
    expect(update.forwardState).toBe(true);

    if (draft === 'draft-22') {
      expect(update.locationFilter?.type).toBe(LocationFilterTypeDraft22.ABSOLUTE_START);
      expect(update.locationFilter?.startLocation).toEqual({ group: BigInt(SEEK_GROUP), object: BigInt(SEEK_OBJECT) });
      return;
    }
    expect(update.filter).toBe(SubscriptionFilterDraft18.ABSOLUTE_START);
    expect(update.startLocation).toEqual({ group: BigInt(SEEK_GROUP), object: BigInt(SEEK_OBJECT) });
  });
});
