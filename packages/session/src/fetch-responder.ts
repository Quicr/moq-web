// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Publisher-side Standalone FETCH (draft-18 §10.12.3, §10.13, §11.4.4)
 *
 * Pure helpers for serving a FETCH from a publication's `fetchHandler`: the
 * FETCH_OK End Location, the inclusive range handed to the handler, and the
 * Fetch Object encoding with its delta rules.
 */

import { Draft18StreamCodec, FetchSubgroupMode, type FetchObjectDraft18, type Location } from '@moq-web/core';
import { narrowBigIntToNumber } from './session-helpers.js';
import type { FetchedObject, PublicationFetchRequest } from './types.js';

/**
 * FETCH_OK End Location (§10.13): the requested one, unless the request
 * extends beyond the Largest Object; then {Largest.Group, Largest.Object + 1}.
 * End Locations are exclusive, and Object 0 means the whole group.
 */
export function fetchEndLocation(requested: Location, largest: Location): Location {
  const beyond =
    requested.group > largest.group ||
    (requested.group === largest.group && (requested.object === 0n || requested.object > largest.object + 1n));
  return beyond ? { group: largest.group, object: largest.object + 1n } : requested;
}

/** The inclusive range a `fetchHandler` is called with. */
export function fetchRequestRange(
  requestId: bigint,
  namespace: string[],
  trackName: string,
  start: Location,
  end: Location,
): PublicationFetchRequest {
  const endGroup = narrowBigIntToNumber(end.group, 'FETCH.endGroup');
  return {
    requestId,
    namespace,
    trackName,
    start: {
      group: narrowBigIntToNumber(start.group, 'FETCH.startGroup'),
      object: narrowBigIntToNumber(start.object, 'FETCH.startObject'),
    },
    end: end.object === 0n ? { group: endGroup } : { group: endGroup, object: narrowBigIntToNumber(end.object - 1n, 'FETCH.endObject') },
  };
}

/**
 * The handler's objects that fall in `request`, once each, in the requested
 * group order; objects in a group are always in Object ID order (§10.12.3).
 */
export function orderFetchedObjects(objects: FetchedObject[], request: PublicationFetchRequest, descending: boolean): FetchedObject[] {
  const { start, end } = request;
  const seen = new Set<string>();
  return objects
    .filter(o => {
      const afterStart = o.groupId > start.group || (o.groupId === start.group && o.objectId >= start.object);
      const beforeEnd = o.groupId < end.group || (o.groupId === end.group && (end.object === undefined || o.objectId <= end.object));
      const key = `${o.groupId}/${o.objectId}`;
      if (!afterStart || !beforeEnd || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => (descending ? b.groupId - a.groupId : a.groupId - b.groupId) || a.objectId - b.objectId);
}

/**
 * Encode one Fetch Object and its payload (§11.4.4). The first object carries
 * its absolute Group ID, Object ID and Publisher Priority, since it cannot refer
 * to a prior object. Later objects carry a Group ID Delta only when the group
 * changes (gap minus one, in the stream's group order), and an Object ID Delta
 * only when the Object ID is not the prior one plus one.
 */
export function encodeFetchedObject(
  object: FetchedObject,
  prior: FetchedObject | undefined,
  priority: number,
  descending: boolean,
): Uint8Array {
  const header: FetchObjectDraft18 = {
    subgroupMode: FetchSubgroupMode.ZERO,
    payloadLength: BigInt(object.data.byteLength),
  };
  if (!prior) {
    header.groupIdDelta = BigInt(object.groupId);
    header.objectIdDelta = BigInt(object.objectId);
    header.publisherPriority = priority;
  } else if (object.groupId !== prior.groupId) {
    const gap = descending ? prior.groupId - object.groupId : object.groupId - prior.groupId;
    header.groupIdDelta = BigInt(gap - 1);
    header.objectIdDelta = BigInt(object.objectId);
  } else if (object.objectId !== prior.objectId + 1) {
    header.objectIdDelta = BigInt(object.objectId - prior.objectId);
  }

  const head = Draft18StreamCodec.encodeFetchObject(header);
  const bytes = new Uint8Array(head.byteLength + object.data.byteLength);
  bytes.set(head, 0);
  bytes.set(object.data, head.byteLength);
  return bytes;
}
