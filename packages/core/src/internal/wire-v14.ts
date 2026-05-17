// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Internal Wire Types for Draft-14/15/16
 *
 * These types represent the exact wire format for draft-14/15/16.
 * They are NOT exported from the public API.
 *
 * To retire draft-14/16 support: delete this file and wire-v14.test.ts
 */

// =============================================================================
// Wire Format Constants
// =============================================================================

/**
 * Message type wire values (draft-14/16)
 */
export const WireMessageType = {
  CLIENT_SETUP: 0x20,
  SERVER_SETUP: 0x21,
  GOAWAY: 0x10,
  MAX_REQUEST_ID: 0x15,
  REQUESTS_BLOCKED: 0x1a,
  SUBSCRIBE_UPDATE: 0x02,
  SUBSCRIBE: 0x03,
  SUBSCRIBE_OK: 0x04,
  SUBSCRIBE_ERROR: 0x05,
  UNSUBSCRIBE: 0x0a,
  PUBLISH_DONE: 0x0b,
  PUBLISH: 0x1d,
  PUBLISH_OK: 0x1e,
  PUBLISH_ERROR: 0x1f,
  PUBLISH_NAMESPACE: 0x06,
  PUBLISH_NAMESPACE_OK: 0x07,
  PUBLISH_NAMESPACE_ERROR: 0x08,
  PUBLISH_NAMESPACE_DONE: 0x09,
  PUBLISH_NAMESPACE_CANCEL: 0x0c,
  SUBSCRIBE_NAMESPACE: 0x11,
  SUBSCRIBE_NAMESPACE_OK: 0x12,
  SUBSCRIBE_NAMESPACE_ERROR: 0x13,
  UNSUBSCRIBE_NAMESPACE: 0x14,
  FETCH: 0x16,
  FETCH_CANCEL: 0x17,
  FETCH_OK: 0x18,
  FETCH_ERROR: 0x19,
  TRACK_STATUS: 0x0d,
  TRACK_STATUS_OK: 0x0e,
  TRACK_STATUS_ERROR: 0x0f,
} as const;

export type WireMessageTypeValue = (typeof WireMessageType)[keyof typeof WireMessageType];

/**
 * Setup parameter keys
 */
export const WireSetupParameter = {
  ROLE: 0x00,
  PATH: 0x01,
  MAX_SUBSCRIBE_ID: 0x02,
  AUTHORIZATION_TOKEN: 0x03,
} as const;

/**
 * Request parameter keys
 */
export const WireRequestParameter = {
  AUTHORIZATION_TOKEN: 0x01,
  DELIVERY_TIMEOUT: 0x02,
  MAX_CACHE_DURATION: 0x03,
} as const;

/**
 * Filter type values
 */
export const WireFilterType = {
  LATEST_GROUP: 0x01,
  LATEST_OBJECT: 0x02,
  ABSOLUTE_START: 0x03,
  ABSOLUTE_RANGE: 0x04,
} as const;

/**
 * Group order values
 */
export const WireGroupOrder = {
  DEFAULT: 0x00,
  ASCENDING: 0x01,
  DESCENDING: 0x02,
} as const;

/**
 * Object status values
 */
export const WireObjectStatus = {
  NORMAL: 0x00,
  OBJECT_NOT_EXISTS: 0x01,
  GROUP_NOT_EXISTS: 0x02,
  END_OF_GROUP: 0x03,
  END_OF_TRACK: 0x04,
} as const;

/**
 * Subscribe namespace options (draft-16)
 */
export const WireSubscribeNamespaceOptions = {
  PUBLISH: 0x00,
  NAMESPACE: 0x01,
  BOTH: 0x02,
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

// -----------------------------------------------------------------------------
// Session Messages
// -----------------------------------------------------------------------------

export interface WireClientSetup extends WireMessage {
  type: typeof WireMessageType.CLIENT_SETUP;
  supportedVersions: number[];
  parameters: Map<number, number | string>;
}

export interface WireServerSetup extends WireMessage {
  type: typeof WireMessageType.SERVER_SETUP;
  selectedVersion: number;
  parameters: Map<number, number | string>;
}

export interface WireGoAway extends WireMessage {
  type: typeof WireMessageType.GOAWAY;
  newSessionUri: string;
}

export interface WireMaxRequestId extends WireMessage {
  type: typeof WireMessageType.MAX_REQUEST_ID;
  requestId: number;
}

export interface WireRequestsBlocked extends WireMessage {
  type: typeof WireMessageType.REQUESTS_BLOCKED;
  requestId: number;
}

// -----------------------------------------------------------------------------
// Subscribe Messages
// -----------------------------------------------------------------------------

export interface WireSubscribe extends WireMessage {
  type: typeof WireMessageType.SUBSCRIBE;
  requestId: number;
  trackAlias: number;
  trackNamespace: string[];
  trackName: string;
  subscriberPriority: number;
  groupOrder: number;
  filterType: number;
  startGroup?: number;
  startObject?: number;
  endGroup?: number;
  parameters: Map<number, Uint8Array>;
}

export interface WireSubscribeOk extends WireMessage {
  type: typeof WireMessageType.SUBSCRIBE_OK;
  requestId: number;
  trackAlias: number;
  expires: number;
  groupOrder: number;
  contentExists: number; // 0 or 1 for d14, 0/1/2 for d16
  largestGroupId?: number;
  largestObjectId?: number;
}

export interface WireSubscribeError extends WireMessage {
  type: typeof WireMessageType.SUBSCRIBE_ERROR;
  requestId: number;
  errorCode: number;
  reasonPhrase: string;
  trackAlias: number;
}

export interface WireSubscribeUpdate extends WireMessage {
  type: typeof WireMessageType.SUBSCRIBE_UPDATE;
  requestId: number;
  subscriptionRequestId: number;
  startGroup: number;
  startObject: number;
  endGroup: number;
  subscriberPriority: number;
  forward: number;
  parameters: Map<number, Uint8Array>;
}

export interface WireUnsubscribe extends WireMessage {
  type: typeof WireMessageType.UNSUBSCRIBE;
  requestId: number;
}

// -----------------------------------------------------------------------------
// Publish Messages
// -----------------------------------------------------------------------------

export interface WirePublish extends WireMessage {
  type: typeof WireMessageType.PUBLISH;
  requestId: number;
  trackNamespace: string[];
  trackName: string;
  trackAlias: number;
  groupOrder: number;
  contentExists: number;
  largestGroupId?: number;
  largestObjectId?: number;
  forward: number;
  parameters: Map<number, Uint8Array>;
}

export interface WirePublishOk extends WireMessage {
  type: typeof WireMessageType.PUBLISH_OK;
  requestId: number;
  trackAlias?: number;
  forward: number;
  subscriberPriority: number;
  groupOrder: number;
  filterType: number;
  startGroup?: number;
  startObject?: number;
  endGroup?: number;
  parameters?: Map<number, Uint8Array>;
}

export interface WirePublishError extends WireMessage {
  type: typeof WireMessageType.PUBLISH_ERROR;
  requestId: number;
  errorCode: number;
  reasonPhrase: string;
  trackAlias: number;
}

export interface WirePublishDone extends WireMessage {
  type: typeof WireMessageType.PUBLISH_DONE;
  requestId: number;
  statusCode: number;
  reasonPhrase: string;
  contentExists: number;
  finalGroupId?: number;
  finalObjectId?: number;
}

// -----------------------------------------------------------------------------
// Namespace Messages
// -----------------------------------------------------------------------------

export interface WirePublishNamespace extends WireMessage {
  type: typeof WireMessageType.PUBLISH_NAMESPACE;
  requestId?: number; // d16 only
  namespace: string[];
  parameters: Map<number, Uint8Array>;
}

export interface WirePublishNamespaceOk extends WireMessage {
  type: typeof WireMessageType.PUBLISH_NAMESPACE_OK;
  requestId?: number; // d16 only
  expires?: number; // d16 only
  namespace?: string[]; // d14 only
}

export interface WirePublishNamespaceError extends WireMessage {
  type: typeof WireMessageType.PUBLISH_NAMESPACE_ERROR;
  namespace: string[];
  errorCode: number;
  reasonPhrase: string;
}

export interface WirePublishNamespaceDone extends WireMessage {
  type: typeof WireMessageType.PUBLISH_NAMESPACE_DONE;
  namespace: string[];
}

export interface WirePublishNamespaceCancel extends WireMessage {
  type: typeof WireMessageType.PUBLISH_NAMESPACE_CANCEL;
  namespace: string[];
}

export interface WireSubscribeNamespace extends WireMessage {
  type: typeof WireMessageType.SUBSCRIBE_NAMESPACE;
  requestId?: number; // d16 only
  namespacePrefix: string[];
  subscribeOptions?: number; // d16 only: 0=PUBLISH, 1=NAMESPACE, 2=BOTH
  parameters: Map<number, Uint8Array>;
}

export interface WireSubscribeNamespaceOk extends WireMessage {
  type: typeof WireMessageType.SUBSCRIBE_NAMESPACE_OK;
  requestId?: number; // d16 only
  namespacePrefix?: string[]; // d14 only
}

export interface WireSubscribeNamespaceError extends WireMessage {
  type: typeof WireMessageType.SUBSCRIBE_NAMESPACE_ERROR;
  requestId?: number; // d16 only
  namespacePrefix?: string[]; // d14 only
  errorCode: number;
  reasonPhrase: string;
}

export interface WireUnsubscribeNamespace extends WireMessage {
  type: typeof WireMessageType.UNSUBSCRIBE_NAMESPACE;
  namespacePrefix: string[];
}

// -----------------------------------------------------------------------------
// Fetch Messages
// -----------------------------------------------------------------------------

export interface WireFetch extends WireMessage {
  type: typeof WireMessageType.FETCH;
  requestId: number;
  trackNamespace: string[];
  trackName: string;
  subscriberPriority: number;
  groupOrder: number;
  startGroup: number;
  startObject: number;
  endGroup: number;
  endObject: number;
  parameters: Map<number, Uint8Array>;
}

export interface WireFetchOk extends WireMessage {
  type: typeof WireMessageType.FETCH_OK;
  requestId: number;
  groupOrder: number;
  largestGroupId: number;
  largestObjectId: number;
  parameters?: Map<number, Uint8Array>;
}

export interface WireFetchError extends WireMessage {
  type: typeof WireMessageType.FETCH_ERROR;
  requestId: number;
  errorCode: number;
  reasonPhrase: string;
}

export interface WireFetchCancel extends WireMessage {
  type: typeof WireMessageType.FETCH_CANCEL;
  requestId: number;
}

// -----------------------------------------------------------------------------
// Track Status Messages
// -----------------------------------------------------------------------------

export interface WireTrackStatus extends WireMessage {
  type: typeof WireMessageType.TRACK_STATUS;
  requestId: number;
  trackNamespace: string[];
  trackName: string;
}

export interface WireTrackStatusOk extends WireMessage {
  type: typeof WireMessageType.TRACK_STATUS_OK;
  requestId: number;
  statusCode: number;
  largestGroupId: number;
  largestObjectId: number;
}

export interface WireTrackStatusError extends WireMessage {
  type: typeof WireMessageType.TRACK_STATUS_ERROR;
  requestId: number;
  errorCode: number;
  reasonPhrase: string;
}

// -----------------------------------------------------------------------------
// Object Headers (for streams/datagrams)
// -----------------------------------------------------------------------------

export interface WireSubgroupHeader {
  trackAlias: number;
  groupId: number;
  subgroupId: number;
  publisherPriority: number;
}

export interface WireObjectHeader {
  trackAlias: number;
  groupId: number;
  subgroupId: number;
  objectId: number;
  publisherPriority: number;
  objectStatus: number;
  payloadLength?: number;
}

export interface WireFetchHeader {
  requestId: number;
}

// =============================================================================
// Union Type
// =============================================================================

export type WireControlMessage =
  | WireClientSetup
  | WireServerSetup
  | WireGoAway
  | WireMaxRequestId
  | WireRequestsBlocked
  | WireSubscribe
  | WireSubscribeOk
  | WireSubscribeError
  | WireSubscribeUpdate
  | WireUnsubscribe
  | WirePublish
  | WirePublishOk
  | WirePublishError
  | WirePublishDone
  | WirePublishNamespace
  | WirePublishNamespaceOk
  | WirePublishNamespaceError
  | WirePublishNamespaceDone
  | WirePublishNamespaceCancel
  | WireSubscribeNamespace
  | WireSubscribeNamespaceOk
  | WireSubscribeNamespaceError
  | WireUnsubscribeNamespace
  | WireFetch
  | WireFetchOk
  | WireFetchError
  | WireFetchCancel
  | WireTrackStatus
  | WireTrackStatusOk
  | WireTrackStatusError;
