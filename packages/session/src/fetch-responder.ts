// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Publisher-side Standalone FETCH (draft-18 §10.12.3, §10.13,
 * §11.4.4; draft-22 §3.2, §9.12, §11.4.1; draft-23 §3.2, §11.4.1)
 *
 * Pure helpers for serving a FETCH from a publication's `fetchHandler`: the
 * range handed to the handler, the End Location the response reports, and the
 * Fetch Object encoding with its delta rules.
 */

import { Draft18StreamCodec, FetchSubgroupMode, type FetchIdRules, type FetchObjectDraft18, type Location } from '@moq-web/core';
import type { LocationRange } from './location-filter.js';
import { narrowBigIntToNumber } from './session-helpers.js';
import type { FetchedObject, PublicationFetchRequest } from './types.js';

/** An inclusive end Location; `object` undefined means the whole group. */
export type FetchEnd = { group: bigint; object?: bigint };

/**
 * Draft-18 FETCH_OK End Location (§10.13): the requested one, unless the
 * request extends beyond the Largest Object; then {Largest.Group,
 * Largest.Object + 1}. End Locations are exclusive, and Object 0 means the
 * whole group.
 */
export function fetchEndLocation(requested: Location, largest: Location): Location {
  const beyond =
    requested.group > largest.group ||
    (requested.group === largest.group && (requested.object === 0n || requested.object > largest.object + 1n));
  return beyond ? { group: largest.group, object: largest.object + 1n } : requested;
}

/** A draft-18 End Location (exclusive, Object 0 = whole group) as an inclusive end. */
export function inclusiveEnd(end: Location): FetchEnd {
  return end.object === 0n ? { group: end.group } : { group: end.group, object: end.object - 1n };
}

/**
 * Draft-22/23 (§3.2): a FETCH covers its Location Filter, by default {0, 0}
 * to the Largest Object, and nothing past the Largest Object. Returns the
 * inclusive end of the response, and whether the Largest Object lies in the
 * requested range (draft-23 then sends LARGEST_OBJECT in FETCH_OK).
 */
export function fetchEndDraft22(range: LocationRange, largest: Location): { end: FetchEnd; largestInRange: boolean } {
  const requested = range.end;
  const reachesLargest =
    requested === undefined ||
    requested.group > largest.group ||
    (requested.group === largest.group && (requested.object === undefined || requested.object >= largest.object));
  return reachesLargest ? { end: largest, largestInRange: true } : { end: requested, largestInRange: false };
}

/** The request a `fetchHandler` is called with. */
export function fetchRequest(
  requestId: bigint,
  namespace: string[],
  trackName: string,
  start: Location,
  end: FetchEnd,
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
    end: end.object === undefined ? { group: endGroup } : { group: endGroup, object: narrowBigIntToNumber(end.object, 'FETCH.endObject') },
  };
}

/**
 * Draft-22 FETCH_OK End Location (§9.12) is inclusive and names an Object.
 * For a range that ends with a whole group, that is the last Object served in
 * it, or the Start Location when none is: what lies after it does not exist.
 */
export function inclusiveEndLocation(end: FetchEnd, start: Location, served: FetchedObject[]): Location {
  if (end.object !== undefined) {
    return { group: end.group, object: end.object };
  }
  let last = end.group === start.group ? start.object : 0n;
  for (const o of served) {
    if (BigInt(o.groupId) === end.group && BigInt(o.objectId) > last) last = BigInt(o.objectId);
  }
  return { group: end.group, object: last };
}

/**
 * The handler's objects that fall in `request`, once each, in the requested
 * group order; objects in a group are always in Object ID order.
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
 * Encode one Fetch Object and its payload. The first object carries its
 * absolute Group ID, Object ID and Publisher Priority, since it cannot refer
 * to a prior object. Later objects carry a Group ID Delta only when the group
 * changes (gap minus one, in the stream's group order), and an Object ID
 * Delta only when the Object ID is not the prior one plus one. Within a group
 * that delta is added to the prior Object ID, plus 2 in draft-23 (#2006).
 */
export function encodeFetchedObject(
  object: FetchedObject,
  prior: FetchedObject | undefined,
  priority: number,
  descending: boolean,
  rules: FetchIdRules = 'draft-18',
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
    header.objectIdDelta = BigInt(object.objectId - prior.objectId - (rules === 'draft-23' ? 2 : 0));
  }

  const head = Draft18StreamCodec.encodeFetchObject(header);
  const bytes = new Uint8Array(head.byteLength + object.data.byteLength);
  bytes.set(head, 0);
  bytes.set(object.data, head.byteLength);
  return bytes;
}
