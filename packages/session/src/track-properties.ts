// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { MOQTVarInt, GroupOrder, TrackPropertyDraft18 } from '@moq-web/core';

import type { TrackProperties } from './types.js';

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
 * property types.
 */
export function parseTrackProperties(
  raw: Map<number, Uint8Array> | undefined,
): TrackProperties | undefined {
  if (!raw || raw.size === 0) return undefined;

  const props: TrackProperties = {};

  const readVarIntNum = (bytes: Uint8Array): number => Number(MOQTVarInt.decode(bytes)[0]);
  const readVarIntBig = (bytes: Uint8Array): bigint => MOQTVarInt.decode(bytes)[0];

  for (const [key, value] of raw) {
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
      case TrackPropertyDraft18.IMMUTABLE_PROPERTIES:
        props.immutablePropertiesBitmap = readVarIntBig(value);
        break;
      default:
        // Unknown key — ignore per §15.8.
        break;
    }
  }

  return Object.keys(props).length === 0 ? undefined : props;
}
