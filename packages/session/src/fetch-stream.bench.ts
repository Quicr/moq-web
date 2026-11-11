// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview A FETCH stream of 100k small Objects through the router, in
 * whole and in 1 KiB chunks, under draft-22 and draft-23 ID rules. Time
 * should grow linearly with Objects and not depend on the chunk size.
 *
 * Run: `pnpm --filter @moq-web/session exec vitest bench --run src/fetch-stream.bench.ts`
 */

import { bench, describe } from 'vitest';
import {
  DataStreamType,
  Draft18StreamCodec,
  FetchSubgroupMode,
  MOQTVarInt,
  type DraftVersion,
} from '@moq-web/core';

import { ObjectRouter } from './object-router.js';
import { SubscriptionManager } from './subscription-manager.js';

const OBJECTS = 100_000;
const PAYLOAD = new Uint8Array(32);

/** 100 Groups of 1000 Objects: each Group starts with a Group ID Delta, the rest are implicit */
function fetchStream(): Uint8Array {
  const parts: Uint8Array[] = [MOQTVarInt.encode(BigInt(DataStreamType.FETCH_HEADER)), MOQTVarInt.encode(1n)];
  for (let i = 0; i < OBJECTS; i++) {
    const first = i === 0;
    const newGroup = i % 1000 === 0;
    parts.push(Draft18StreamCodec.encodeFetchObject({
      subgroupMode: first ? FetchSubgroupMode.ZERO : FetchSubgroupMode.PRIOR,
      ...(newGroup ? { groupIdDelta: 0n, objectIdDelta: 0n } : {}),
      ...(first ? { publisherPriority: 128 } : {}),
      payloadLength: BigInt(PAYLOAD.length),
    }));
    parts.push(PAYLOAD);
  }
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    bytes.set(p, offset);
    offset += p.length;
  }

  return bytes;
}

const STREAM = fetchStream();

async function decode(draft: DraftVersion, chunkSize: number): Promise<void> {
  const router = new ObjectRouter(new SubscriptionManager(), undefined, draft);
  let seen = 0;
  router.setFetchObjectCallback(() => {
    seen++;
  });
  let offset = 0;
  await router.handleIncomingStream(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= STREAM.length) {
        controller.close();
        return;
      }
      controller.enqueue(STREAM.subarray(offset, offset + chunkSize));
      offset += chunkSize;
    },
  }));
  if (seen !== OBJECTS) {
    throw new Error(`decoded ${seen} of ${OBJECTS} Objects`);
  }
}

describe(`FETCH stream, ${OBJECTS} Objects (${(STREAM.length / 1e6).toFixed(1)} MB)`, () => {
  for (const draft of ['draft-22', 'draft-23'] as const) {
    bench(`${draft}, one chunk`, () => decode(draft, STREAM.length), { iterations: 5 });
    bench(`${draft}, 1 KiB chunks`, () => decode(draft, 1024), { iterations: 5 });
  }
});
