// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * FETCH stream reassembly across transport chunks.
 *
 * A fetch object's header and payload can be split across reads at any byte.
 * The decoder must deliver identical objects however the stream is chunked,
 * including when a payload straddles a chunk that doesn't start the buffer.
 */

import { describe, expect, it } from 'vitest';
import {
  Draft18StreamCodec,
  DataStreamType,
  FetchSubgroupMode,
  MOQTVarInt,
} from '@moq-web/core';

import { ObjectRouter } from './object-router.js';
import { SubscriptionManager } from './subscription-manager.js';

const REQUEST_ID = 3n;
const PRIORITY = 128;
const OBJECT_COUNT = 3;
const PAYLOAD_SIZE = 8;

type Delivered = Array<{ objectId: number; payload: number[] }>;

function payloadFor(objectId: number): Uint8Array {
  return Uint8Array.from({ length: PAYLOAD_SIZE }, (_, i) => objectId * 16 + i);
}

/** FETCH_HEADER + Request ID + objects {0,0..2}, each with a distinct payload */
function fetchBytes(): Uint8Array {
  const parts: Uint8Array[] = [
    MOQTVarInt.encode(BigInt(DataStreamType.FETCH_HEADER)),
    MOQTVarInt.encode(REQUEST_ID),
  ];
  for (let objectId = 0; objectId < OBJECT_COUNT; objectId++) {
    // First object carries absolute IDs; later ones use "prior + 1"
    const header = objectId === 0
      ? { subgroupMode: FetchSubgroupMode.ZERO, groupIdDelta: 0n, objectIdDelta: 0n, publisherPriority: PRIORITY }
      : { subgroupMode: FetchSubgroupMode.PRIOR };
    parts.push(Draft18StreamCodec.encodeFetchObject({ ...header, payloadLength: BigInt(PAYLOAD_SIZE) }));
    parts.push(payloadFor(objectId));
  }

  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    bytes.set(p, offset);
    offset += p.length;
  }

  return bytes;
}

function chunked(bytes: Uint8Array, split: number): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, split));
      controller.enqueue(bytes.slice(split));
      controller.close();
    },
  });
}

describe.each(['draft-18', 'draft-22'] as const)('ObjectRouter FETCH chunking (%s)', (draft) => {
  it('delivers identical objects wherever the stream is split', async () => {
    const bytes = fetchBytes();
    const expected: Delivered = Array.from({ length: OBJECT_COUNT }, (_, objectId) => ({
      objectId,
      payload: Array.from(payloadFor(objectId)),
    }));

    for (let split = 1; split < bytes.length; split++) {
      const router = new ObjectRouter(new SubscriptionManager(), undefined, draft);
      const delivered: Delivered = [];
      router.setFetchObjectCallback((_id, data, _group, objectId) => {
        delivered.push({ objectId, payload: Array.from(data) });
      });

      await router.handleIncomingStream(chunked(bytes, split));

      expect(delivered, `split at byte ${split}`).toEqual(expected);
    }
  });
});
