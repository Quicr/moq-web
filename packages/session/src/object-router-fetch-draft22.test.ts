// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Draft-22 §11.4.1.1 FETCH stream decoding.
 *
 * Group ID Delta / Object ID Delta are true deltas relative to the prior
 * object (draft-18 treats them as absolute values; that behaviour is pinned
 * by the regression test at the bottom).
 */

import { describe, expect, it } from 'vitest';
import {
  Draft18StreamCodec,
  DataStreamType,
  FetchObjectEndOfRange,
  FetchSubgroupMode,
  GroupOrder,
  MOQTVarInt,
  type DraftVersion,
  type FetchObjectDraft18,
} from '@moq-web/core';

import { ObjectRouter } from './object-router.js';
import { SubscriptionManager } from './subscription-manager.js';

const REQUEST_ID = 7n;
const PRIORITY = 128;

type Seen = Array<[number, number]>;

/** First object: absolute Group ID / Object ID, explicit priority. */
function first(group: bigint, object: bigint): FetchObjectDraft18 {
  return {
    subgroupMode: FetchSubgroupMode.ZERO,
    groupIdDelta: group,
    objectIdDelta: object,
    publisherPriority: PRIORITY,
  };
}

function next(fields: Partial<FetchObjectDraft18>): FetchObjectDraft18 {
  return { subgroupMode: FetchSubgroupMode.PRIOR, ...fields };
}

/** FETCH_HEADER + Request ID followed by each object (header + 1-byte payload). */
function fetchStream(objects: FetchObjectDraft18[]): ReadableStream<Uint8Array> {
  const parts: Uint8Array[] = [
    MOQTVarInt.encode(BigInt(DataStreamType.FETCH_HEADER)),
    MOQTVarInt.encode(REQUEST_ID),
  ];
  for (const obj of objects) {
    const withPayload = obj.endOfRange === undefined ? { ...obj, payloadLength: 1n } : obj;
    parts.push(Draft18StreamCodec.encodeFetchObject(withPayload));
    if (obj.endOfRange === undefined) {
      parts.push(new Uint8Array([0xaa]));
    }
  }

  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    bytes.set(p, offset);
    offset += p.length;
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function run(
  draft: DraftVersion,
  objects: FetchObjectDraft18[],
  order?: GroupOrder,
): Promise<Seen> {
  const router = new ObjectRouter(new SubscriptionManager(), undefined, draft);
  const seen: Seen = [];
  router.setFetchObjectCallback((_id, _data, group, object) => {
    seen.push([group, object]);
  });
  if (order !== undefined) {
    router.setFetchGroupOrder(REQUEST_ID, order);
  }

  await router.handleIncomingStream(fetchStream(objects));
  return seen;
}

describe('ObjectRouter draft-22 FETCH stream deltas (§11.4.1.1)', () => {
  it('ascending: Group ID Delta is prior + delta + 1', async () => {
    const seen = await run('draft-22', [
      first(5n, 0n),
      next({ groupIdDelta: 0n, objectIdDelta: 0n }), // group 6
      next({ groupIdDelta: 2n, objectIdDelta: 4n }), // group 9
    ]);

    expect(seen).toEqual([[5, 0], [6, 0], [9, 4]]);
  });

  it('defaults to ascending when no group order was registered', async () => {
    const seen = await run('draft-22', [
      first(1n, 0n),
      next({ groupIdDelta: 0n, objectIdDelta: 0n }),
    ]);

    expect(seen).toEqual([[1, 0], [2, 0]]);
  });

  it('descending: Group ID Delta is prior - (delta + 1)', async () => {
    const seen = await run(
      'draft-22',
      [
        first(10n, 3n),
        next({ groupIdDelta: 0n, objectIdDelta: 0n }), // group 9
        next({ groupIdDelta: 3n, objectIdDelta: 1n }), // group 5
      ],
      GroupOrder.DESCENDING,
    );

    expect(seen).toEqual([[10, 3], [9, 0], [5, 1]]);
  });

  it('descending: a computed Group ID below 0 stops decoding', async () => {
    const seen = await run(
      'draft-22',
      [
        first(1n, 0n),
        next({ groupIdDelta: 1n, objectIdDelta: 0n }), // 1 - 2 < 0
        next({ groupIdDelta: 0n, objectIdDelta: 0n }),
      ],
      GroupOrder.DESCENDING,
    );

    expect(seen).toEqual([[1, 0]]);
  });

  it('Object ID Delta without Group ID Delta is prior + delta', async () => {
    const seen = await run('draft-22', [
      first(3n, 2n),
      next({ objectIdDelta: 5n }), // 7
      next({}), // 8 (prior + 1)
      next({ objectIdDelta: 0n }), // 8 (prior + 0)
    ]);

    expect(seen).toEqual([[3, 2], [3, 7], [3, 8], [3, 8]]);
  });

  it('End of Range sets the prior Group/Object ID for the next object', async () => {
    const seen = await run('draft-22', [
      first(2n, 0n),
      { subgroupMode: FetchSubgroupMode.ZERO, endOfRange: FetchObjectEndOfRange.NON_EXISTENT, groupIdDelta: 4n, objectIdDelta: 9n },
      next({ groupIdDelta: 0n, objectIdDelta: 0n }), // group 4 + 0 + 1
      { subgroupMode: FetchSubgroupMode.ZERO, endOfRange: FetchObjectEndOfRange.TIMED_OUT, groupIdDelta: 6n, objectIdDelta: 3n },
      next({ objectIdDelta: 2n }), // same group 6, object 3 + 2
    ]);

    expect(seen).toEqual([[2, 0], [5, 0], [6, 5]]);
  });

  it('does not deliver an ID above 2^53-1 rounded onto its neighbour', async () => {
    const router = new ObjectRouter(new SubscriptionManager(), undefined, 'draft-22');
    const seen: Seen = [];
    router.setFetchObjectCallback((_id, _data, group, object) => {
      seen.push([group, object]);
    });

    await router.handleIncomingStream(fetchStream([first((1n << 60n) + 1n, 0n)])).catch(() => undefined);

    expect(seen).toEqual([]);
  });

  it('clears the registered group order when the stream ends', async () => {
    const router = new ObjectRouter(new SubscriptionManager(), undefined, 'draft-22');
    const seen: Seen = [];
    router.setFetchObjectCallback((_id, _data, group, object) => {
      seen.push([group, object]);
    });
    router.setFetchGroupOrder(REQUEST_ID, GroupOrder.DESCENDING);

    await router.handleIncomingStream(fetchStream([first(9n, 0n)]));
    await router.handleIncomingStream(fetchStream([first(9n, 0n), next({ groupIdDelta: 0n, objectIdDelta: 0n })]));

    // Second stream sees the ascending default, not the stale DESCENDING entry.
    expect(seen).toEqual([[9, 0], [9, 0], [10, 0]]);
  });
});

describe('ObjectRouter draft-18 FETCH stream (regression)', () => {
  it('still treats Group/Object ID Delta as absolute values', async () => {
    const seen = await run('draft-18', [
      first(5n, 0n),
      next({ groupIdDelta: 9n, objectIdDelta: 4n }),
      next({ objectIdDelta: 8n }),
      next({}),
    ]);

    expect(seen).toEqual([[5, 0], [9, 4], [9, 8], [9, 9]]);
  });
});
