// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Internal Wire Types for Draft-18
 *
 * These types represent the exact wire format for draft-18.
 * They are NOT exported from the public API.
 *
 * Key differences from draft-14/16:
 * - MOQT varints (leading 1-bits) instead of QUIC varints
 * - Per-request bidirectional streams
 * - Delta-encoded parameters
 * - Setup via unidirectional stream pair (0x2F00)
 * - Explicit Location struct
 * - SUBSCRIBE_TRACKS message
 *
 * To retire draft-18 support: delete this file and wire-v18.test.ts
 */

// =============================================================================
// Wire Format Constants
// =============================================================================

/**
 * Message type wire values (draft-18)
 */
export const WireMessageType = {
  CLIENT_SETUP: 0x01,
  SERVER_SETUP: 0x02,
  SUBSCRIBE: 0x03,
  SUBSCRIBE_OK: 0x04,
  PUBLISH: 0x05,
  PUBLISH_DONE: 0x06,
  REQUEST_ERROR: 0x08,
  REQUEST_OK: 0x09,
  REQUEST_UPDATE: 0x0a,
  TRACK_STATUS: 0x0b,
  GOAWAY: 0x0c,
  FETCH: 0x0d,
  FETCH_OK: 0x0e,
  PUBLISH_NAMESPACE: 0x10,
  SUBSCRIBE_NAMESPACE: 0x11,
  NAMESPACE: 0x12,
  NAMESPACE_DONE: 0x13,
  SUBSCRIBE_TRACKS: 0x14,
  PUBLISH_BLOCKED: 0x15,
} as const;

export type WireMessageTypeValue = (typeof WireMessageType)[keyof typeof WireMessageType];

/**
 * Stream type for unidirectional streams
 */
export const WireStreamType = {
  SETUP: 0x2f00,
  SUBGROUP: 0x00, // 0b0XX0XXXX pattern
  FETCH: 0x05,
} as const;

/**
 * Setup option keys
 */
export const WireSetupOption = {
  ROLE: 0x00,
  PATH: 0x01,
  AUTHORITY: 0x02,
  MAX_AUTH_TOKEN_CACHE_SIZE: 0x03,
  AUTH_TOKEN: 0x04,
} as const;

/**
 * Role values
 */
export const WireRole = {
  PUBLISHER: 0x01,
  SUBSCRIBER: 0x02,
  PUBSUB: 0x03,
} as const;

/**
 * Subscription filter values
 */
export const WireSubscriptionFilter = {
  LATEST_GROUP: 0x01,
  LATEST_OBJECT: 0x02,
  ABSOLUTE_START: 0x03,
  ABSOLUTE_RANGE: 0x04,
} as const;

/**
 * Object status values
 */
export const WireObjectStatus = {
  NORMAL: 0x00,
  END_OF_GROUP: 0x01,
  END_OF_SUBGROUP: 0x02,
  END_OF_TRACK: 0x03,
  OBJECT_NOT_EXISTS: 0x04,
  GROUP_NOT_EXISTS: 0x05,
} as const;

/**
 * Group order values
 */
export const WireGroupOrder = {
  DEFAULT: 0x00,
  ASCENDING: 0x01,
  DESCENDING: 0x02,
} as const;

// =============================================================================
// Wire Message Types
// =============================================================================

/**
 * Base wire message
 */
export interface WireMessage {
  type: WireMessageTypeValue;
}

/**
 * Location (group/object pair)
 */
export interface WireLocation {
  group: bigint;
  object: bigint;
}

// -----------------------------------------------------------------------------
// Session Messages
// -----------------------------------------------------------------------------

export interface WireClientSetup extends WireMessage {
  type: typeof WireMessageType.CLIENT_SETUP;
  supportedVersions: number[];
  role?: number;
  path?: string;
  authority?: string;
  maxAuthTokenCacheSize?: bigint;
  authToken?: Uint8Array;
}

export interface WireServerSetup extends WireMessage {
  type: typeof WireMessageType.SERVER_SETUP;
  selectedVersion: number;
  role?: number;
  path?: string;
  authority?: string;
  maxAuthTokenCacheSize?: bigint;
}

export interface WireGoAway extends WireMessage {
  type: typeof WireMessageType.GOAWAY;
  newSessionUri?: string;
}

// -----------------------------------------------------------------------------
// Subscribe Messages
// -----------------------------------------------------------------------------

export interface WireSubscribe extends WireMessage {
  type: typeof WireMessageType.SUBSCRIBE;
  requestId: bigint;
  trackNamespace: string[];
  trackName: string;
  forwardState: boolean;
  filter: number;
  startLocation?: WireLocation;
  endGroupDelta?: bigint;
  parameters: Map<number, Uint8Array>; // Delta-encoded
}

export interface WireSubscribeOk extends WireMessage {
  type: typeof WireMessageType.SUBSCRIBE_OK;
  requestId: bigint;
  largestLocation: WireLocation;
  trackProperties: Map<number, Uint8Array>; // Delta-encoded
}

// -----------------------------------------------------------------------------
// Publish Messages
// -----------------------------------------------------------------------------

export interface WirePublish extends WireMessage {
  type: typeof WireMessageType.PUBLISH;
  requestId: bigint;
  trackAlias: bigint;
  trackNamespace: string[];
  trackName: string;
  forwardState: boolean;
  largestLocation: WireLocation;
  trackProperties: Map<number, Uint8Array>; // Delta-encoded
}

export interface WirePublishDone extends WireMessage {
  type: typeof WireMessageType.PUBLISH_DONE;
  requestId: bigint;
  finalLocation: WireLocation;
  reasonPhrase?: string;
}

export interface WirePublishBlocked extends WireMessage {
  type: typeof WireMessageType.PUBLISH_BLOCKED;
  trackAlias: bigint;
}

// -----------------------------------------------------------------------------
// Generic Request/Response Messages
// -----------------------------------------------------------------------------

export interface WireRequestOk extends WireMessage {
  type: typeof WireMessageType.REQUEST_OK;
  requestId: bigint;
  expires?: bigint;
}

export interface WireRequestError extends WireMessage {
  type: typeof WireMessageType.REQUEST_ERROR;
  requestId: bigint;
  errorCode: bigint;
  reasonPhrase: string;
}

export interface WireRequestUpdate extends WireMessage {
  type: typeof WireMessageType.REQUEST_UPDATE;
  requestId: bigint;
  forwardState: boolean;
  parameters: Map<number, Uint8Array>; // Delta-encoded
}

// -----------------------------------------------------------------------------
// Fetch Messages
// -----------------------------------------------------------------------------

export interface WireFetch extends WireMessage {
  type: typeof WireMessageType.FETCH;
  requestId: bigint;
  joiningFlag: boolean;
  trackNamespace?: string[];
  trackName?: string;
  subscribeRequestId?: bigint;
  subscriberPriority: number;
  groupOrder: number;
  startLocation: WireLocation;
  endLocation: WireLocation;
  parameters: Map<number, Uint8Array>; // Delta-encoded
}

export interface WireFetchOk extends WireMessage {
  type: typeof WireMessageType.FETCH_OK;
  requestId: bigint;
  endOfTrack: boolean;
  endLocation: WireLocation;
  trackProperties: Map<number, Uint8Array>; // Delta-encoded
}

// -----------------------------------------------------------------------------
// Track Status Messages
// -----------------------------------------------------------------------------

export interface WireTrackStatus extends WireMessage {
  type: typeof WireMessageType.TRACK_STATUS;
  requestId: bigint;
  trackNamespace: string[];
  trackName: string;
}

// -----------------------------------------------------------------------------
// Namespace Messages
// -----------------------------------------------------------------------------

export interface WirePublishNamespace extends WireMessage {
  type: typeof WireMessageType.PUBLISH_NAMESPACE;
  requestId: bigint;
  trackNamespacePrefix: string[];
  parameters: Map<number, Uint8Array>; // Delta-encoded
}

export interface WireSubscribeNamespace extends WireMessage {
  type: typeof WireMessageType.SUBSCRIBE_NAMESPACE;
  requestId: bigint;
  trackNamespacePrefix: string[];
  parameters: Map<number, Uint8Array>; // Delta-encoded
}

export interface WireNamespace extends WireMessage {
  type: typeof WireMessageType.NAMESPACE;
  trackNamespace: string[];
  trackNamespaceParameters: Map<number, Uint8Array>; // Delta-encoded
}

export interface WireNamespaceDone extends WireMessage {
  type: typeof WireMessageType.NAMESPACE_DONE;
  finalNamespace: string[];
}

// -----------------------------------------------------------------------------
// Subscribe Tracks Message (d18 only)
// -----------------------------------------------------------------------------

export interface WireSubscribeTracks extends WireMessage {
  type: typeof WireMessageType.SUBSCRIBE_TRACKS;
  requestId: bigint;
  trackNamespacePrefix: string[];
  trackNamePattern?: string;
  forwardState: boolean;
  filter: number;
  startLocation?: WireLocation;
  endGroupDelta?: bigint;
  parameters: Map<number, Uint8Array>; // Delta-encoded
}

// -----------------------------------------------------------------------------
// Object Headers (for streams/datagrams)
// -----------------------------------------------------------------------------

/**
 * Subgroup header flags (0b0XX1XXXX pattern)
 */
export const SubgroupFlags = {
  HAS_FIRST_OBJECT: 0b00010000,
  HAS_PRIORITY: 0b00100000,
  HAS_PROPERTIES: 0b01000000,
} as const;

export interface WireSubgroupHeader {
  streamType: number; // 0b0XX0XXXX or 0b0XX1XXXX
  trackAlias: bigint;
  groupId: bigint;
  subgroupId: bigint;
  publisherPriority?: number;
  firstObject?: bigint;
}

export interface WireObjectHeader {
  objectIdDelta: bigint;
  objectProperties?: Map<number, Uint8Array>;
  payloadLength: bigint;
}

export interface WireObjectDatagram {
  trackAlias: bigint;
  groupId: bigint;
  objectId: bigint;
  publisherPriority: number;
  objectProperties?: Map<number, Uint8Array>;
  payload: Uint8Array;
}

export interface WireFetchObject {
  endOfFetch: boolean;
  groupId: bigint;
  subgroupId: bigint;
  objectId: bigint;
  publisherPriority: number;
  objectProperties?: Map<number, Uint8Array>;
  payloadLength: bigint;
}

// =============================================================================
// Union Type
// =============================================================================

export type WireControlMessage =
  | WireClientSetup
  | WireServerSetup
  | WireGoAway
  | WireSubscribe
  | WireSubscribeOk
  | WirePublish
  | WirePublishDone
  | WirePublishBlocked
  | WireRequestOk
  | WireRequestError
  | WireRequestUpdate
  | WireFetch
  | WireFetchOk
  | WireTrackStatus
  | WirePublishNamespace
  | WireSubscribeNamespace
  | WireNamespace
  | WireNamespaceDone
  | WireSubscribeTracks;
