// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * The router reports every FETCH data stream that ends, with the Request ID
 * from its FETCH_HEADER, so owners of per-stream state (fill fetch streams,
 * draft-22 §3.4) can drop it.
 */

import { describe, expect, it } from 'vitest';
import { DataStreamType, MOQTVarInt } from '@moq-web/core';

import { ObjectRouter } from './object-router.js';
import { SubscriptionManager } from './subscription-manager.js';

const REQUEST_ID = 11n;

function header(): Uint8Array {
  return new Uint8Array([
    ...MOQTVarInt.encode(BigInt(DataStreamType.FETCH_HEADER)),
    ...MOQTVarInt.encode(REQUEST_ID),
  ]);
}

function makeRouter(): { router: ObjectRouter; closed: bigint[] } {
  const router = new ObjectRouter(new SubscriptionManager(), undefined, 'draft-22');
  const closed: bigint[] = [];
  router.setFetchStreamCloseCallback((requestId) => closed.push(requestId));

  return { router, closed };
}

describe('ObjectRouter fetch stream close callback', () => {
  it('fires when a stream with no objects ends', async () => {
    const { router, closed } = makeRouter();

    await router.handleIncomingStream(new ReadableStream({
      start(controller) {
        controller.enqueue(header());
        controller.close();
      },
    }));

    expect(closed).toEqual([REQUEST_ID]);
  });

  it('fires when the stream is reset', async () => {
    const { router, closed } = makeRouter();

    await router.handleIncomingStream(new ReadableStream({
      start(controller) {
        controller.enqueue(header());
        // After the header has been read: an error right away would drop it.
        setTimeout(() => controller.error(new Error('reset')), 0);
      },
    }));

    expect(closed).toEqual([REQUEST_ID]);
  });

  it('fires when the stream is cancelled before it arrives', async () => {
    const { router, closed } = makeRouter();
    router.cancelFetchStream(REQUEST_ID);

    await router.handleIncomingStream(new ReadableStream({
      start(controller) {
        controller.enqueue(header());
      },
    }));

    expect(closed).toEqual([REQUEST_ID]);
  });
});
