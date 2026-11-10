// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Draft-23 §11.4 FETCH stream decoding in the router: Object ID Delta + 2
 * (#2006), delta-coded End of Range (#2031), End of Group / End of Track
 * (#2013), End of Gone Range (#2022), and the violation kind each fault is
 * reported with (§12.2).
 */

import { describe, expect, it } from 'vitest';
import {
  Draft18StreamCodec,
  DataStreamType,
  FetchObjectEndOfRange,
  FetchObjectMarker,
  FetchSubgroupMode,
  GroupOrder,
  MOQTVarInt,
  type DraftVersion,
  type FetchObjectDraft18,
  type Violation,
} from '@moq-web/core';

import { ObjectRouter } from './object-router.js';
import { SubscriptionManager } from './subscription-manager.js';

const REQUEST_ID = 7n;

const first = (group: bigint, object: bigint): FetchObjectDraft18 => ({
  subgroupMode: FetchSubgroupMode.ZERO,
  groupIdDelta: group,
  objectIdDelta: object,
  publisherPriority: 128,
});
const next = (fields: Partial<FetchObjectDraft18> = {}): FetchObjectDraft18 => ({ subgroupMode: FetchSubgroupMode.PRIOR, ...fields });
const range = (endOfRange: FetchObjectEndOfRange, g: bigint, o: bigint): FetchObjectDraft18 => ({
  subgroupMode: FetchSubgroupMode.ZERO,
  endOfRange,
  groupIdDelta: g,
  objectIdDelta: o,
});
const marker = (m: FetchObjectMarker): FetchObjectDraft18 => ({ subgroupMode: FetchSubgroupMode.ZERO, marker: m });

const isIndicator = (o: FetchObjectDraft18): boolean => o.endOfRange !== undefined || o.marker !== undefined;

function streamBytes(objects: FetchObjectDraft18[], truncateBy = 0): Uint8Array {
  const parts: Uint8Array[] = [
    MOQTVarInt.encode(BigInt(DataStreamType.FETCH_HEADER)),
    MOQTVarInt.encode(REQUEST_ID),
  ];
  for (const obj of objects) {
    parts.push(Draft18StreamCodec.encodeFetchObject(isIndicator(obj) ? obj : { ...obj, payloadLength: 2n }));
    if (!isIndicator(obj)) {
      parts.push(new Uint8Array([0xaa, 0xbb]));
    }
  }
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    bytes.set(p, offset);
    offset += p.length;
  }
  return bytes.subarray(0, bytes.length - truncateBy);
}

interface Result {
  seen: Array<[number, number]>;
  violations: Violation[];
  endOfTrack?: boolean;
}

async function run(
  draft: DraftVersion,
  objects: FetchObjectDraft18[],
  { order, chunk, truncateBy }: { order?: GroupOrder; chunk?: number; truncateBy?: number } = {},
): Promise<Result> {
  const router = new ObjectRouter(new SubscriptionManager(), undefined, draft);
  const result: Result = { seen: [], violations: [] };
  router.setFetchObjectCallback((_id, _data, group, object) => result.seen.push([group, object]));
  router.setViolationCallback((_reason, violation) => result.violations.push(violation));
  router.setFetchStreamCloseCallback((_id, _last, endOfTrack) => {
    result.endOfTrack = endOfTrack;
  });
  if (order !== undefined) {
    router.setFetchGroupOrder(REQUEST_ID, order);
  }

  const bytes = streamBytes(objects, truncateBy);
  const size = chunk ?? bytes.length;
  let offset = 0;
  await router.handleIncomingStream(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
    },
  }));
  return result;
}

describe('ObjectRouter FETCH stream (draft-23)', () => {
  it('Object ID Delta within a Group adds 2; absent adds 1', async () => {
    const { seen, violations } = await run('draft-23', [first(5n, 0n), next(), next({ objectIdDelta: 0n }), next({ objectIdDelta: 3n })]);
    expect(violations).toEqual([]);
    expect(seen).toEqual([[5, 0], [5, 1], [5, 3], [5, 8]]);
  });

  it('the same deltas decode as draft-22 rules on a draft-22 session', async () => {
    const { seen } = await run('draft-22', [first(5n, 0n), next(), next({ objectIdDelta: 0n }), next({ objectIdDelta: 3n })]);
    expect(seen).toEqual([[5, 0], [5, 1], [5, 1], [5, 4]]);
  });

  it('decodes End of Range deltas and continues after them', async () => {
    const { seen, violations } = await run('draft-23', [
      first(1n, 0n),
      range(FetchObjectEndOfRange.NON_EXISTENT, 0n, 2n), // 1/0 + 2 + 1 = 1/3
      next({ objectIdDelta: 0n }), // 1/3 + 0 + 2 = 1/5
      range(FetchObjectEndOfRange.GONE, 2n, 4n), // group 3, object 4
      next({ groupIdDelta: 0n, objectIdDelta: 0n }), // group 4, object 0
    ]);
    expect(violations).toEqual([]);
    expect(seen).toEqual([[1, 0], [1, 5], [4, 0]]);
  });

  it('decodes descending Groups', async () => {
    const { seen } = await run('draft-23', [first(9n, 0n), next({ groupIdDelta: 1n, objectIdDelta: 0n })], { order: GroupOrder.DESCENDING });
    expect(seen).toEqual([[9, 0], [7, 0]]);
  });

  it('reports End of Track on stream close', async () => {
    const result = await run('draft-23', [first(1n, 0n), marker(FetchObjectMarker.END_OF_GROUP), next({ groupIdDelta: 0n, objectIdDelta: 0n }), marker(FetchObjectMarker.END_OF_TRACK)]);
    expect(result.violations).toEqual([]);
    expect(result.seen).toEqual([[1, 0], [2, 0]]);
    expect(result.endOfTrack).toBe(true);
  });

  it('leaves endOfTrack unset without the marker', async () => {
    expect((await run('draft-23', [first(1n, 0n)])).endOfTrack).toBeUndefined();
  });

  it('an Object after End of Track is MALFORMED_OBJECT', async () => {
    const { violations } = await run('draft-23', [first(1n, 0n), marker(FetchObjectMarker.END_OF_TRACK), next({ groupIdDelta: 0n, objectIdDelta: 0n })]);
    expect(violations).toEqual(['malformed-object']);
  });

  it('continuing in a Group after End of Group overflows (DELTA_ENCODING_OVERFLOW)', async () => {
    const { violations } = await run('draft-23', [first(1n, 0n), marker(FetchObjectMarker.END_OF_GROUP), next()]);
    expect(violations).toEqual(['delta-overflow']);
  });

  it('a first Object that references a prior one is MALFORMED_OBJECT', async () => {
    const { violations } = await run('draft-23', [next({ objectIdDelta: 0n, publisherPriority: 1 })]);
    expect(violations).toEqual(['malformed-object']);
  });

  it.each(['draft-18', 'draft-22'] as const)('Gone and End of Group/Track are not defined in %s', async (draft) => {
    for (const entry of [range(FetchObjectEndOfRange.GONE, 1n, 0n), marker(FetchObjectMarker.END_OF_GROUP), marker(FetchObjectMarker.END_OF_TRACK)]) {
      const { violations } = await run(draft, [first(1n, 0n), entry]);
      expect(violations).toEqual(['malformed-object']);
    }
  });

  it('decodes a large payload split into many chunks', async () => {
    const objects = Array.from({ length: 50 }, (_, i) => (i === 0 ? first(0n, 0n) : next()));
    const { seen, violations } = await run('draft-23', objects, { chunk: 3 });
    expect(violations).toEqual([]);
    expect(seen).toHaveLength(50);
    expect(seen[49]).toEqual([0, 49]);
  });

  it('a stream that ends inside an Object is TRUNCATED_OBJECT in draft-23, only logged before', async () => {
    expect((await run('draft-23', [first(1n, 0n)], { truncateBy: 1 })).violations).toEqual(['truncated-object']);
    expect((await run('draft-22', [first(1n, 0n)], { truncateBy: 1 })).violations).toEqual([]);
  });
});
