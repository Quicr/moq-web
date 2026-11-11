// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import {
  Draft18BufferReader,
  MOQTVarInt,
  GroupOrder,
  TrackPropertyDraft18,
  decodeKeyValuePairsToEnd,
  repeatedKeys,
} from '@moq-web/core';

import type { TrackProperties } from './types.js';

/** Property types 0x4000-0x7FFF are Mandatory Track Properties (draft-22 §3.7) */
const MANDATORY_FIRST = 0x4000;
const MANDATORY_LAST = 0x7fff;

/** The largest value of DYNAMIC_GROUPS (draft-22 §10.6) */
const DYNAMIC_GROUPS_MAX = 1n;

/** What is wrong with the Track Properties of a PUBLISH, SUBSCRIBE_OK or FETCH_OK */
export enum TrackPropertyFault {
  /** A Mandatory Track Property we do not understand: the track is not processed (draft-22 §3.7) */
  UNSUPPORTED,
  /** A value out of range or Key-Value-Pairs that do not parse: PROTOCOL_VIOLATION (draft-22 §10.5, §10.6, §10.7) */
  INVALID,
  /** Draft-23 §8.4: a Property outside its scope or repeated: a Malformed Track (§12.1 items 8-9) */
  MALFORMED,
}

/** Where a Property may appear (draft-23 §16.8 Table 15) */
const enum Scope {
  TRACK = 1,
  OBJECT = 2,
  BOTH = 3,
}

/**
 * The Properties we support, with their scope. Each allows one instance
 * (draft-23 §8.4): none of their definitions permits more.
 */
const PROPERTY_SCOPES: ReadonlyMap<number, Scope> = new Map([
  [TrackPropertyDraft18.OBJECT_DELIVERY_TIMEOUT, Scope.BOTH],
  [TrackPropertyDraft18.MAX_CACHE_DURATION, Scope.TRACK],
  [TrackPropertyDraft18.SUBGROUP_DELIVERY_TIMEOUT, Scope.BOTH],
  [TrackPropertyDraft18.IMMUTABLE_PROPERTIES, Scope.BOTH],
  [TrackPropertyDraft18.DEFAULT_PUBLISHER_PRIORITY, Scope.TRACK],
  [TrackPropertyDraft18.DEFAULT_PUBLISHER_GROUP_ORDER, Scope.TRACK],
  [TrackPropertyDraft18.DYNAMIC_GROUPS, Scope.TRACK],
  [TrackPropertyDraft18.PRIOR_GROUP_ID_GAP, Scope.OBJECT],
  [TrackPropertyDraft18.PRIOR_OBJECT_ID_GAP, Scope.OBJECT],
]);

/** Malformed Track reasons for Object Properties (draft-22 §3.7; draft-23 §8.4, §10.7) */
export const MANDATORY_ON_OBJECT = 'Object has a Mandatory Track Property as an Object Property';
const UNPARSABLE_IMMUTABLE = 'Immutable Properties do not parse';

/** The Key-Value-Pairs inside Immutable Properties, if present. Throws if they do not parse. */
function immutableOf(raw: Map<number, Uint8Array>): Map<number, Uint8Array> | undefined {
  const nested = raw.get(TrackPropertyDraft18.IMMUTABLE_PROPERTIES);

  return nested && decodeKeyValuePairsToEnd(new Draft18BufferReader(nested, 0));
}

/**
 * Draft-23 §8.4, §10.7: a supported Property outside `scope`, more than one
 * instance of one (repeated in a list, or in both the mutable list and
 * Immutable Properties), or Immutable Properties nested in Immutable
 * Properties. Returns the reason, or undefined.
 */
function scopeFault(raw: Map<number, Uint8Array>, inner: Map<number, Uint8Array> | undefined, scope: Scope): string | undefined {
  if (inner?.has(TrackPropertyDraft18.IMMUTABLE_PROPERTIES)) {
    return 'Immutable Properties contain Immutable Properties';
  }

  for (const list of inner ? [raw, inner] : [raw]) {
    for (const key of list.keys()) {
      const allowed = PROPERTY_SCOPES.get(key);
      if (allowed !== undefined && (allowed & scope) === 0) {
        return `Property 0x${key.toString(16)} is outside its scope`;
      }
      if (allowed !== undefined && list === inner && raw.has(key)) {
        return `Property 0x${key.toString(16)} appears more than once`;
      }
    }
    for (const key of repeatedKeys(list) ?? []) {
      if (PROPERTY_SCOPES.has(key)) {
        return `Property 0x${key.toString(16)} appears more than once`;
      }
    }
  }

  return undefined;
}

/**
 * The properties of a track: those listed, then those inside Immutable
 * Properties, which holds Key-Value-Pairs of its own (draft-22 §10.7: "search
 * both"). Throws if the Immutable Properties do not parse.
 */
function effectiveProperties(raw: Map<number, Uint8Array>): Map<number, Uint8Array> {
  const nested = raw.get(TrackPropertyDraft18.IMMUTABLE_PROPERTIES);
  if (!nested) {
    return raw;
  }

  const all = new Map(raw);
  for (const [key, value] of decodeKeyValuePairsToEnd(new Draft18BufferReader(nested, 0))) {
    if (!all.has(key)) {
      all.set(key, value);
    }
  }

  return all;
}

/**
 * Check the Track Properties of a PUBLISH, SUBSCRIBE_OK or FETCH_OK. We
 * understand no Mandatory Track Property, so one makes the track unusable to
 * us; a value outside its range closes the session. Undefined means fine.
 */
export function trackPropertyFault(
  raw: Map<number, Uint8Array> | undefined,
  draft23 = false,
): TrackPropertyFault | undefined {
  if (!raw) {
    return undefined;
  }

  let properties: Map<number, Uint8Array>;
  try {
    properties = effectiveProperties(raw);
  } catch {
    return TrackPropertyFault.INVALID;
  }
  if (draft23 && scopeFault(raw, immutableOf(raw), Scope.TRACK) !== undefined) {
    return TrackPropertyFault.MALFORMED;
  }

  const groupOrder = properties.get(TrackPropertyDraft18.DEFAULT_PUBLISHER_GROUP_ORDER);
  const dynamicGroups = properties.get(TrackPropertyDraft18.DYNAMIC_GROUPS);
  const groupOrders: bigint[] = [BigInt(GroupOrder.ASCENDING), BigInt(GroupOrder.DESCENDING)];
  if (groupOrder && !groupOrders.includes(MOQTVarInt.decode(groupOrder)[0])) {
    return TrackPropertyFault.INVALID;
  }
  if (dynamicGroups && MOQTVarInt.decode(dynamicGroups)[0] > DYNAMIC_GROUPS_MAX) {
    return TrackPropertyFault.INVALID;
  }

  return [...properties.keys()].some(isMandatoryProperty) ? TrackPropertyFault.UNSUPPORTED : undefined;
}

/** Grease values follow 0x7f * N + 0x9D (draft-23 §13) */
const isGrease = (key: number): boolean => key >= 0x9d && (key - 0x9d) % 0x7f === 0;

/** Grease values in the range are not Mandatory Track Properties (draft-23 §3.7, #2037) */
const isMandatoryProperty = (key: number): boolean => key >= MANDATORY_FIRST && key <= MANDATORY_LAST && !isGrease(key);

function hasMandatoryKey(properties: Map<number, Uint8Array>): boolean {
  for (const key of properties.keys()) {
    if (isMandatoryProperty(key)) {
      return true;
    }
  }

  return false;
}

/**
 * What makes Object Properties a Malformed Track: a Mandatory Track Property,
 * which only has Track scope (draft-22 §3.7, §12.1); and from draft-23 a
 * Property outside its scope, repeated, or Immutable Properties that do not
 * parse or nest (§8.4, §10.7). Returns the reason, or undefined. Runs per
 * Object, so it decodes Immutable Properties once and copies nothing.
 */
export function objectPropertyFault(raw: Map<number, Uint8Array> | undefined, draft23 = false): string | undefined {
  if (!raw) {
    return undefined;
  }

  let inner: Map<number, Uint8Array> | undefined;
  try {
    inner = immutableOf(raw);
  } catch {
    return draft23 ? UNPARSABLE_IMMUTABLE : undefined;
  }
  if (hasMandatoryKey(raw) || (inner !== undefined && hasMandatoryKey(inner))) {
    return MANDATORY_ON_OBJECT;
  }

  return draft23 ? scopeFault(raw, inner, Scope.OBJECT) : undefined;
}

/**
 * Decode the `trackProperties` KVP map emitted on SUBSCRIBE_OK / PUBLISH /
 * FETCH_OK (draft-18 §12) into a typed `TrackProperties` struct.
 *
 * Values are stored in the map as re-encoded MOQT varint bytes for even keys
 * and raw length-prefixed bytes for odd keys (see draft-18 §1.4.3). All
 * draft-18 property IDs in §12 are even, so we decode them back to MOQT
 * varints here.
 *
 * Unknown keys are silently ignored per §15.8 — endpoints MUST skip unknown
 * property types. Check `trackPropertyFault` first: this does not reject a
 * Mandatory Track Property or an invalid value.
 */
export function parseTrackProperties(
  raw: Map<number, Uint8Array> | undefined,
): TrackProperties | undefined {
  if (!raw || raw.size === 0) return undefined;

  const props: TrackProperties = {};
  let properties: Map<number, Uint8Array>;
  try {
    properties = effectiveProperties(raw);
  } catch {
    // Immutable Properties that do not parse are trackPropertyFault's to report
    properties = raw;
  }

  const readVarIntNum = (bytes: Uint8Array): number => Number(MOQTVarInt.decode(bytes)[0]);

  for (const [key, value] of properties) {
    switch (key) {
      case TrackPropertyDraft18.SUBGROUP_DELIVERY_TIMEOUT:
        props.subgroupDeliveryTimeoutMs = readVarIntNum(value);
        break;
      case TrackPropertyDraft18.OBJECT_DELIVERY_TIMEOUT:
        props.objectDeliveryTimeoutMs = readVarIntNum(value);
        break;
      case TrackPropertyDraft18.MAX_CACHE_DURATION:
        props.maxCacheDurationMs = readVarIntNum(value);
        break;
      case TrackPropertyDraft18.DEFAULT_PUBLISHER_PRIORITY:
        props.defaultPublisherPriority = readVarIntNum(value);
        break;
      case TrackPropertyDraft18.DEFAULT_PUBLISHER_GROUP_ORDER: {
        const n = readVarIntNum(value);
        if (n === GroupOrder.ASCENDING || n === GroupOrder.DESCENDING) {
          props.defaultPublisherGroupOrder = n;
        }
        break;
      }
      case TrackPropertyDraft18.DYNAMIC_GROUPS:
        props.dynamicGroups = readVarIntNum(value) !== 0;
        break;
      default:
        // Unknown key — ignore per §15.8.
        break;
    }
  }

  return Object.keys(props).length === 0 ? undefined : props;
}
