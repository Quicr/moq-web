// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Data-plane protocol violations (d22 §6.4.1, §11.2.1, §11.3.1, §11.4.1;
 * d18 §3.4, §11.4.2, §11.4.4): the receiver MUST close the session.
 */

import { describe, expect, it } from 'vitest';
import {
  Draft18StreamCodec,
  DatagramTypeDraft18,
  FetchObjectEndOfRange,
  FetchSubgroupMode,
  MOQTVarInt,
  StreamTypeDraft18,
  type DraftVersion,
  type FetchObjectDraft18,
} from '@moq-web/core';

import { ObjectRouter } from './object-router.js';
import { SubscriptionManager, type InternalSubscription } from './subscription-manager.js';

const TRACK_ALIAS = 7n;
const REQUEST_ID = 7n;
const PRIORITY = 128;
const RESERVED_SUBGROUP_ID_MODE_TYPE = 0x16;
const UNKNOWN_STREAM_TYPE = 0x45;
const UNKNOWN_STATUS = 0x07;
// vi64 two-byte form of 0x102: the low byte alone looks like a valid datagram type
const WIDE_DATAGRAM_TYPE = [0x81, 0x02];
// vi64 two-byte (non-minimal) form of FETCH_HEADER
const WIDE_FETCH_TYPE = [0x80, StreamTypeDraft18.FETCH_HEADER];
const UNKNOWN_RANGE_FLAGS = [0x80, 0x90];

function makeRouter(draft: DraftVersion) {
  const subs = new SubscriptionManager();
  const sub: InternalSubscription = {
    subscriptionId: 1,
    requestId: 1n,
    namespace: ['ns'],
    trackName: 'track',
    trackAlias: TRACK_ALIAS,
    paused: false,
  };
  subs.add(sub);

  const router = new ObjectRouter(subs, undefined, draft);
  const violations: string[] = [];
  const delivered: Array<[bigint, bigint]> = [];
  const fetched: Array<[bigint, bigint]> = [];
  router.setViolationCallback((reason) => violations.push(reason));
  router.setCallback((_sub, _data, groupId, objectId) => delivered.push([groupId, objectId]));
  router.setFetchObjectCallback((_id, _data, groupId, objectId) => fetched.push([groupId, objectId]));

  return { router, violations, delivered, fetched };
}

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

function bytes(...parts: Array<Uint8Array | number[]>): Uint8Array {
  return new Uint8Array(parts.flatMap((part) => Array.from(part)));
}

function fetchObject(obj: FetchObjectDraft18, payload: number[] = []): Uint8Array {
  const withLength = obj.endOfRange === undefined ? { ...obj, payloadLength: BigInt(payload.length) } : obj;
  return bytes(Draft18StreamCodec.encodeFetchObject(withLength), payload);
}

function firstFetchObject(group: bigint, object: bigint): FetchObjectDraft18 {
  return {
    subgroupMode: FetchSubgroupMode.ZERO,
    groupIdDelta: group,
    objectIdDelta: object,
    publisherPriority: PRIORITY,
  };
}

function subgroupHeader(): Uint8Array {
  return Draft18StreamCodec.encodeSubgroupHeader({
    trackAlias: TRACK_ALIAS,
    groupId: 3n,
    subgroupId: 0n,
    publisherPriority: PRIORITY,
  });
}

describe.each(['draft-18', 'draft-22'] as const)('data-plane violations (%s)', (draft) => {
  it('closes on an unknown stream type, not reading 0x45 as FETCH', async () => {
    const { router, violations, fetched } = makeRouter(draft);

    await router.handleIncomingStream(
      streamOf(bytes([UNKNOWN_STREAM_TYPE], MOQTVarInt.encode(REQUEST_ID), fetchObject(firstFetchObject(1n, 0n), [1]))),
    );

    expect(violations).toHaveLength(1);
    expect(fetched).toEqual([]);
  });

  it('reads a non-minimal FETCH_HEADER type as FETCH', async () => {
    const { router, violations, fetched } = makeRouter(draft);

    await router.handleIncomingStream(
      streamOf(bytes(WIDE_FETCH_TYPE, MOQTVarInt.encode(REQUEST_ID), fetchObject(firstFetchObject(1n, 0n), [1]))),
    );

    expect(violations).toEqual([]);
    expect(fetched).toEqual([[1n, 0n]]);
  });

  it('closes on a reserved SUBGROUP_ID_MODE', async () => {
    const { router, violations } = makeRouter(draft);
    const header = subgroupHeader();
    header[0] = RESERVED_SUBGROUP_ID_MODE_TYPE;

    await router.handleIncomingStream(streamOf(header));

    expect(violations).toHaveLength(1);
  });

  it('closes on an invalid object status', async () => {
    const { router, violations, delivered } = makeRouter(draft);

    // Object ID Delta 0 | Payload Length 0 | unknown Object Status
    await router.handleIncomingStream(streamOf(bytes(subgroupHeader(), [0x00, 0x00, UNKNOWN_STATUS])));

    expect(violations).toHaveLength(1);
    expect(delivered).toEqual([]);
  });

  it('closes on a datagram whose wide Type only looks valid in its low byte', () => {
    const { router, violations, delivered } = makeRouter(draft);

    router.handleDatagram(bytes(WIDE_DATAGRAM_TYPE, [Number(TRACK_ALIAS), 3, 0xaa]));

    expect(violations).toHaveLength(1);
    expect(delivered).toEqual([]);
  });

  it('ignores a padding datagram', () => {
    const { router, violations, delivered } = makeRouter(draft);

    router.handleDatagram(bytes(MOQTVarInt.encode(BigInt(DatagramTypeDraft18.PADDING)), [0, 0, 0]));

    expect(violations).toEqual([]);
    expect(delivered).toEqual([]);
  });

  it('drains a padding stream, even with its type split across reads', async () => {
    const { router, violations } = makeRouter(draft);
    const type = MOQTVarInt.encode(BigInt(StreamTypeDraft18.PADDING));

    await router.handleIncomingStream(streamOf(type.subarray(0, 2), bytes(type.subarray(2), [0, 0, 0])));

    expect(violations).toEqual([]);
  });

  it('closes when the first fetch object references the prior object', async () => {
    const { router, violations, fetched } = makeRouter(draft);
    const first: FetchObjectDraft18 = { ...firstFetchObject(1n, 0n), subgroupMode: FetchSubgroupMode.PRIOR };

    await router.handleIncomingStream(
      streamOf(bytes([StreamTypeDraft18.FETCH_HEADER], MOQTVarInt.encode(REQUEST_ID), fetchObject(first, [1]))),
    );

    expect(violations).toHaveLength(1);
    expect(fetched).toEqual([]);
  });

  it('closes on an unknown range indicator', async () => {
    const { router, violations } = makeRouter(draft);

    await router.handleIncomingStream(
      streamOf(bytes([StreamTypeDraft18.FETCH_HEADER], MOQTVarInt.encode(REQUEST_ID), UNKNOWN_RANGE_FLAGS, [0, 0])),
    );

    expect(violations).toHaveLength(1);
  });
});

describe('End of Timed-Out Range', () => {
  const timedOut: FetchObjectDraft18 = {
    subgroupMode: FetchSubgroupMode.ZERO,
    endOfRange: FetchObjectEndOfRange.TIMED_OUT,
    groupIdDelta: 2n,
    objectIdDelta: 0n,
  };
  const stream = () =>
    streamOf(bytes([StreamTypeDraft18.FETCH_HEADER], MOQTVarInt.encode(REQUEST_ID), fetchObject(timedOut)));

  it('is a violation in draft-18, which does not define 0x20C', async () => {
    const { router, violations } = makeRouter('draft-18');

    await router.handleIncomingStream(stream());

    expect(violations).toHaveLength(1);
  });

  it('is accepted in draft-22', async () => {
    const { router, violations } = makeRouter('draft-22');

    await router.handleIncomingStream(stream());

    expect(violations).toEqual([]);
  });
});
