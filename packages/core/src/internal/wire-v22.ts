// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Internal Wire Types for Draft-22
 *
 * Draft-22 shares most wire types with draft-18. This module re-exports
 * shared types and adds draft-22 specific additions.
 */

// Re-export all draft-18 wire types as the base
export {
  WireSubscriptionFilter,
  type WireLocation,
  type WireSubscribe,
  type WireSubscribeOk,
  type WirePublish,
  type WireRequestError,
  type WireFetch,
  type WireFetchOk,
  type WirePublishNamespace,
  type WireSubscribeNamespace,
  type WireSubscribeTracks,
} from './wire-v18.js';

/**
 * Draft-22 Location Filter types (replaces SubscriptionFilter in d22)
 */
export const WireLocationFilter = {
  NONE: 0x00,
  RELATIVE_START: 0x01,
  ABSOLUTE_START: 0x02,
  ABSOLUTE_START_GROUP_END: 0x03,
  ABSOLUTE_RANGE: 0x04,
  NEXT_OBJECT: 0x05,
} as const;

/**
 * Draft-22 PUBLISH_SKIPPED wire type (replaces PUBLISH_BLOCKED)
 */
export interface WirePublishSkipped {
  trackNamespaceSuffix: string[];
  trackName: string;
}

/**
 * Draft-22 PUBLISH_STATE_NOTIFY wire type
 */
export interface WirePublishStateNotify {
  parameters: Map<number, Uint8Array>;
}
