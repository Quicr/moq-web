// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * An Object with a Mandatory Track Property (type 0x4000-0x7FFF) among its
 * Object Properties is malformed (d22 §3.7, §12.1): the subscriber cancels
 * the subscription or fetch and the Object is not delivered. It is a Track
 * that is malformed, not the session, so nothing closes.
 */

import { describe, expect, it } from 'vitest';
import {
  Draft18StreamCodec,
  FetchSubgroupMode,
  MOQTVarInt,
  StreamTypeDraft18,
  type DraftVersion,
} from '@moq-web/core';

import { ObjectRouter } from './object-router.js';
import { SubscriptionManager } from './subscription-manager.js';

const TRACK_ALIAS = 7n;
const REQUEST_ID = 9n;
const PRIORITY = 128;
const MANDATORY = 0x4000;
const OBJECT_PROPERTY = 0x0e;
const enc = (n: number): Uint8Array => MOQTVarInt.encode(BigInt(n));
const mandatory = new Map([[MANDATORY, enc(1)]]);
const ordinary = new Map([[OBJECT_PROPERTY, enc(1)]]);

function makeRouter(draft: DraftVersion) {
  const subs = new SubscriptionManager();
  subs.add({ subscriptionId: 1, requestId: 1n, namespace: ['ns'], trackName: 't', trackAlias: TRACK_ALIAS, paused: false });
  const router = new ObjectRouter(subs, undefined, draft);
  const malformed: Array<{ trackAlias?: bigint | number; fetchRequestId?: bigint }> = [];
  const violations: string[] = [];
  const delivered: Array<[number, number]> = [];
  const fetched: Array<[number, number]> = [];
  router.setMalformedTrackCallback((target) => malformed.push(target));
  router.setViolationCallback((reason) => violations.push(reason));
  router.setCallback((_sub, _data, groupId, objectId) => delivered.push([groupId, objectId]));
  router.setFetchObjectCallback((_id, _data, groupId, objectId) => fetched.push([groupId, objectId]));

  return { router, malformed, violations, delivered, fetched };
}

const bytes = (...parts: Array<Uint8Array | number[]>): Uint8Array => new Uint8Array(parts.flatMap((p) => Array.from(p)));

function streamOf(chunk: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(chunk);
      controller.close();
    },
  });
}

function subgroupStream(properties: Map<number, Uint8Array>): Uint8Array {
  const header = Draft18StreamCodec.encodeSubgroupHeader({
    trackAlias: TRACK_ALIAS,
    groupId: 3n,
    subgroupId: 0n,
    publisherPriority: PRIORITY,
    hasProperties: true,
  });
  const object = Draft18StreamCodec.encodeObjectHeader({ objectIdDelta: 0n, objectProperties: properties, payloadLength: 1n }, true);

  return bytes(header, object, [0xaa]);
}

function fetchStream(properties: Map<number, Uint8Array>): Uint8Array {
  const object = Draft18StreamCodec.encodeFetchObject({
    subgroupMode: FetchSubgroupMode.ZERO,
    groupIdDelta: 1n,
    objectIdDelta: 0n,
    publisherPriority: PRIORITY,
    objectProperties: properties,
    payloadLength: 1n,
  });

  return bytes([StreamTypeDraft18.FETCH_HEADER], MOQTVarInt.encode(REQUEST_ID), object, [0xaa]);
}

function datagram(properties: Map<number, Uint8Array>): Uint8Array {
  return Draft18StreamCodec.encodeObjectDatagram({
    trackAlias: TRACK_ALIAS,
    groupId: 3n,
    objectId: 1n,
    publisherPriority: PRIORITY,
    objectProperties: properties,
    payload: new Uint8Array([0xaa]),
  });
}

describe.each(['draft-18', 'draft-22'] as const)('Mandatory Track Property on an Object (%s)', (draft) => {
  it('cancels the subscription of a subgroup stream and delivers nothing', async () => {
    const { router, malformed, violations, delivered } = makeRouter(draft);

    await router.handleIncomingStream(streamOf(subgroupStream(mandatory)));

    expect(malformed).toEqual([{ trackAlias: TRACK_ALIAS }]);
    expect(violations).toEqual([]);
    expect(delivered).toEqual([]);
  });

  it('cancels the subscription of a datagram', () => {
    const { router, malformed, violations, delivered } = makeRouter(draft);

    router.handleDatagram(datagram(mandatory));

    expect(malformed).toEqual([{ trackAlias: TRACK_ALIAS }]);
    expect(violations).toEqual([]);
    expect(delivered).toEqual([]);
  });

  it('cancels the fetch', async () => {
    const { router, malformed, violations, fetched } = makeRouter(draft);

    await router.handleIncomingStream(streamOf(fetchStream(mandatory)));

    expect(malformed).toEqual([{ fetchRequestId: REQUEST_ID }]);
    expect(violations).toEqual([]);
    expect(fetched).toEqual([]);
  });

  it('delivers Objects whose properties are not Mandatory', async () => {
    const { router, malformed, delivered, fetched } = makeRouter(draft);

    await router.handleIncomingStream(streamOf(subgroupStream(ordinary)));
    router.handleDatagram(datagram(ordinary));
    await router.handleIncomingStream(streamOf(fetchStream(ordinary)));

    expect(malformed).toEqual([]);
    expect(delivered).toEqual([[3, 0], [3, 1]]);
    expect(fetched).toEqual([[1, 0]]);
  });
});
