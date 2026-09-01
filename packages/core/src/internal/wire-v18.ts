// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Internal Wire Types for Draft-18
 *
 * Type-level shapes consumed by `api/codec.ts` when converting between the
 * public API and the draft-18 wire encoding. Runtime encoding lives in
 * `encoding/draft18-message-codec.ts` and `encoding/draft18-stream-codec.ts`.
 */

/**
 * Subscription filter values (draft-18 §15.6.3)
 */
export const WireSubscriptionFilter = {
  LATEST_GROUP: 0x01,
  LATEST_OBJECT: 0x02,
  ABSOLUTE_START: 0x03,
  ABSOLUTE_RANGE: 0x04,
} as const;

/**
 * Location (group/object pair)
 */
export interface WireLocation {
  group: bigint;
  object: bigint;
}

// -----------------------------------------------------------------------------
// Subscribe Messages
// -----------------------------------------------------------------------------

export interface WireSubscribe {
  requestId: bigint;
  trackNamespace: string[];
  trackName: string;
  forwardState: boolean;
  filter: number;
  startLocation?: WireLocation;
  endGroupDelta?: bigint;
  parameters: Map<number, Uint8Array>;
}

export interface WireSubscribeOk {
  requestId: bigint;
  largestLocation: WireLocation;
  trackProperties: Map<number, Uint8Array>;
}

// -----------------------------------------------------------------------------
// Publish Messages
// -----------------------------------------------------------------------------

export interface WirePublish {
  requestId: bigint;
  trackAlias: bigint;
  trackNamespace: string[];
  trackName: string;
  forwardState: boolean;
  largestLocation: WireLocation;
  trackProperties: Map<number, Uint8Array>;
}

// -----------------------------------------------------------------------------
// Generic Request/Response Messages
// -----------------------------------------------------------------------------

export interface WireRequestError {
  requestId: bigint;
  errorCode: bigint;
  reasonPhrase: string;
}

// -----------------------------------------------------------------------------
// Fetch Messages
// -----------------------------------------------------------------------------

export interface WireFetch {
  requestId: bigint;
  joiningFlag: boolean;
  trackNamespace?: string[];
  trackName?: string;
  subscribeRequestId?: bigint;
  subscriberPriority: number;
  groupOrder: number;
  startLocation: WireLocation;
  endLocation: WireLocation;
  parameters: Map<number, Uint8Array>;
}

export interface WireFetchOk {
  requestId: bigint;
  endOfTrack: boolean;
  endLocation: WireLocation;
  trackProperties: Map<number, Uint8Array>;
}

// -----------------------------------------------------------------------------
// Namespace Messages
// -----------------------------------------------------------------------------

export interface WirePublishNamespace {
  requestId: bigint;
  trackNamespacePrefix: string[];
  parameters: Map<number, Uint8Array>;
}

export interface WireSubscribeNamespace {
  requestId: bigint;
  trackNamespacePrefix: string[];
  parameters: Map<number, Uint8Array>;
}

// -----------------------------------------------------------------------------
// Subscribe Tracks Message (d18 only)
// -----------------------------------------------------------------------------

export interface WireSubscribeTracks {
  requestId: bigint;
  trackNamespacePrefix: string[];
  trackNamePattern?: string;
  forwardState: boolean;
  filter: number;
  startLocation?: WireLocation;
  endGroupDelta?: bigint;
  parameters: Map<number, Uint8Array>;
}
