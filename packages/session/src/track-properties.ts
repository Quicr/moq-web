// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { Draft18BufferReader, MOQTVarInt, GroupOrder, TrackPropertyDraft18, decodeKeyValuePairsToEnd } from '@moq-web/core';

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
export function trackPropertyFault(raw: Map<number, Uint8Array> | undefined): TrackPropertyFault | undefined {
  if (!raw) {
    return undefined;
  }

  let properties: Map<number, Uint8Array>;
  try {
    properties = effectiveProperties(raw);
  } catch {
    return TrackPropertyFault.INVALID;
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

  const isMandatory = (key: number) => key >= MANDATORY_FIRST && key <= MANDATORY_LAST;

  return [...properties.keys()].some(isMandatory) ? TrackPropertyFault.UNSUPPORTED : undefined;
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
      case TrackPropertyDraft18.PRIOR_GROUP_ID_GAP:
        props.priorGroupIdGap = readVarIntNum(value);
        break;
      case TrackPropertyDraft18.PRIOR_OBJECT_ID_GAP:
        props.priorObjectIdGap = readVarIntNum(value);
        break;
      default:
        // Unknown key — ignore per §15.8.
        break;
    }
  }

  return Object.keys(props).length === 0 ? undefined : props;
}
