// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Unified Codec Adapter
 *
 * Provides adapters to convert between public API types and internal wire types.
 * This layer handles the mapping so application code never sees draft-specific types.
 */

import { IS_DRAFT_18, IS_DRAFT_16 } from '../version/constants.js';
import {
  Version,
  SubscriptionFilter,
  GroupOrder,
  NamespaceSubscribeMode,
  CodecCapabilities,
  type Location,
  type SubscribeRequest,
  type SubscribeResponse,
  type PublishRequest,
  type PublishResponse,
  type FetchRequest,
  type FetchResponse,
  type SubscribeNamespaceRequest,
  type PublishNamespaceRequest,
  type RequestError,
} from './types.js';

import type {
  WireSubscribe as WireSubscribeV14,
  WireSubscribeOk as WireSubscribeOkV14,
  WireSubscribeError as WireSubscribeErrorV14,
  WirePublish as WirePublishV14,
  WirePublishOk as WirePublishOkV14,
  WirePublishError as WirePublishErrorV14,
  WireFetch as WireFetchV14,
  WireFetchOk as WireFetchOkV14,
  WireFetchError as WireFetchErrorV14,
  WireSubscribeNamespace as WireSubscribeNamespaceV14,
  WirePublishNamespace as WirePublishNamespaceV14,
} from '../internal/wire-v14.js';

import type {
  WireSubscribe as WireSubscribeV18,
  WireSubscribeOk as WireSubscribeOkV18,
  WirePublish as WirePublishV18,
  WireFetch as WireFetchV18,
  WireFetchOk as WireFetchOkV18,
  WireRequestError as WireRequestErrorV18,
  WireSubscribeNamespace as WireSubscribeNamespaceV18,
  WirePublishNamespace as WirePublishNamespaceV18,
  WireSubscribeTracks as WireSubscribeTracksV18,
  WireLocation,
} from '../internal/wire-v18.js';

import { WireSubscribeNamespaceOptions, WireFilterType as WireFilterTypeV14 } from '../internal/wire-v14.js';

import { WireSubscriptionFilter as WireFilterTypeV18 } from '../internal/wire-v18.js';

// =============================================================================
// Codec Capabilities
// =============================================================================

/**
 * Build-time codec capabilities
 */
export const capabilities: CodecCapabilities = {
  perRequestStreams: IS_DRAFT_18,
  subscribeTracks: IS_DRAFT_18,
  moqtVarInt: IS_DRAFT_18,
  unifiedErrors: IS_DRAFT_16 || IS_DRAFT_18,
};

/**
 * Current protocol version
 */
export const currentVersion: Version = IS_DRAFT_18
  ? Version.DRAFT_18
  : IS_DRAFT_16
    ? Version.DRAFT_16
    : Version.DRAFT_14;

// =============================================================================
// Filter/GroupOrder Mapping
// =============================================================================

function filterToWireV14(filter: SubscriptionFilter): number {
  switch (filter) {
    case SubscriptionFilter.LATEST_GROUP:
      return WireFilterTypeV14.LATEST_GROUP;
    case SubscriptionFilter.LATEST_OBJECT:
      return WireFilterTypeV14.LATEST_OBJECT;
    case SubscriptionFilter.ABSOLUTE_START:
      return WireFilterTypeV14.ABSOLUTE_START;
    case SubscriptionFilter.ABSOLUTE_RANGE:
      return WireFilterTypeV14.ABSOLUTE_RANGE;
  }
}

export function filterFromWireV14(wire: number): SubscriptionFilter {
  switch (wire) {
    case WireFilterTypeV14.LATEST_GROUP:
      return SubscriptionFilter.LATEST_GROUP;
    case WireFilterTypeV14.LATEST_OBJECT:
      return SubscriptionFilter.LATEST_OBJECT;
    case WireFilterTypeV14.ABSOLUTE_START:
      return SubscriptionFilter.ABSOLUTE_START;
    case WireFilterTypeV14.ABSOLUTE_RANGE:
      return SubscriptionFilter.ABSOLUTE_RANGE;
    default:
      return SubscriptionFilter.LATEST_GROUP;
  }
}

function filterToWireV18(filter: SubscriptionFilter): number {
  switch (filter) {
    case SubscriptionFilter.LATEST_GROUP:
      return WireFilterTypeV18.LATEST_GROUP;
    case SubscriptionFilter.LATEST_OBJECT:
      return WireFilterTypeV18.LATEST_OBJECT;
    case SubscriptionFilter.ABSOLUTE_START:
      return WireFilterTypeV18.ABSOLUTE_START;
    case SubscriptionFilter.ABSOLUTE_RANGE:
      return WireFilterTypeV18.ABSOLUTE_RANGE;
  }
}

export function filterFromWireV18(wire: number): SubscriptionFilter {
  switch (wire) {
    case WireFilterTypeV18.LATEST_GROUP:
      return SubscriptionFilter.LATEST_GROUP;
    case WireFilterTypeV18.LATEST_OBJECT:
      return SubscriptionFilter.LATEST_OBJECT;
    case WireFilterTypeV18.ABSOLUTE_START:
      return SubscriptionFilter.ABSOLUTE_START;
    case WireFilterTypeV18.ABSOLUTE_RANGE:
      return SubscriptionFilter.ABSOLUTE_RANGE;
    default:
      return SubscriptionFilter.LATEST_GROUP;
  }
}

function groupOrderToWire(order: GroupOrder): number {
  return order; // Same values in both versions
}

function groupOrderFromWire(wire: number): GroupOrder {
  switch (wire) {
    case 0:
      return GroupOrder.DEFAULT;
    case 1:
      return GroupOrder.ASCENDING;
    case 2:
      return GroupOrder.DESCENDING;
    default:
      return GroupOrder.DEFAULT;
  }
}

function locationToWire(loc: Location): WireLocation {
  return { group: loc.group, object: loc.object };
}

function locationFromWire(wire: WireLocation): Location {
  return { group: wire.group, object: wire.object };
}

function modeToWireOptionsV14(mode: NamespaceSubscribeMode): number {
  switch (mode) {
    case NamespaceSubscribeMode.DISCOVER:
      return WireSubscribeNamespaceOptions.NAMESPACE;
    case NamespaceSubscribeMode.SUBSCRIBE:
      return WireSubscribeNamespaceOptions.PUBLISH;
    case NamespaceSubscribeMode.BOTH:
      return WireSubscribeNamespaceOptions.BOTH;
  }
}

// =============================================================================
// Subscribe Adapters
// =============================================================================

/**
 * Convert SubscribeRequest to wire format
 */
export function subscribeRequestToWire(
  req: SubscribeRequest,
  requestId: bigint
): WireSubscribeV14 | WireSubscribeV18 {
  if (IS_DRAFT_18) {
    return subscribeRequestToWireV18(req, requestId);
  }
  return subscribeRequestToWireV14(req, Number(requestId));
}

function subscribeRequestToWireV14(req: SubscribeRequest, requestId: number): WireSubscribeV14 {
  const wire: WireSubscribeV14 = {
    type: 0x03,
    requestId,
    trackAlias: 0, // Will be assigned by server
    trackNamespace: req.trackNamespace,
    trackName: req.trackName,
    subscriberPriority: req.subscriberPriority ?? 128,
    groupOrder: groupOrderToWire(req.groupOrder ?? GroupOrder.DEFAULT),
    filterType: filterToWireV14(req.filter),
    parameters: req.parameters ?? new Map(),
  };

  if (req.startLocation) {
    wire.startGroup = Number(req.startLocation.group);
    wire.startObject = Number(req.startLocation.object);
  }

  if (req.endGroup !== undefined) {
    wire.endGroup = Number(req.endGroup);
  }

  return wire;
}

function subscribeRequestToWireV18(req: SubscribeRequest, requestId: bigint): WireSubscribeV18 {
  const wire: WireSubscribeV18 = {
    type: 0x03,
    requestId,
    trackNamespace: req.trackNamespace,
    trackName: req.trackName,
    forwardState: true,
    filter: filterToWireV18(req.filter),
    parameters: req.parameters ?? new Map(),
  };

  if (req.startLocation) {
    wire.startLocation = locationToWire(req.startLocation);
  }

  if (req.endGroup !== undefined) {
    wire.endGroupDelta = req.endGroup;
  }

  return wire;
}

/**
 * Convert wire response to SubscribeResponse
 */
export function subscribeResponseFromWire(
  wire: WireSubscribeOkV14 | WireSubscribeOkV18,
  trackAlias?: bigint
): SubscribeResponse {
  if ('largestLocation' in wire) {
    // V18
    return subscribeResponseFromWireV18(wire as WireSubscribeOkV18);
  }
  return subscribeResponseFromWireV14(wire as WireSubscribeOkV14, trackAlias);
}

function subscribeResponseFromWireV14(
  wire: WireSubscribeOkV14,
  _trackAlias?: bigint
): SubscribeResponse {
  const resp: SubscribeResponse = {
    requestId: BigInt(wire.requestId),
    contentExists: wire.contentExists !== 0,
    groupOrder: groupOrderFromWire(wire.groupOrder),
    expires: BigInt(wire.expires),
  };

  if (wire.contentExists !== 0 && wire.largestGroupId !== undefined) {
    resp.largestLocation = {
      group: BigInt(wire.largestGroupId),
      object: BigInt(wire.largestObjectId ?? 0),
    };
  }

  return resp;
}

function subscribeResponseFromWireV18(wire: WireSubscribeOkV18): SubscribeResponse {
  return {
    requestId: wire.requestId,
    contentExists: wire.largestLocation.group > 0n || wire.largestLocation.object > 0n,
    largestLocation: locationFromWire(wire.largestLocation),
    trackProperties: wire.trackProperties,
  };
}

// =============================================================================
// Publish Adapters
// =============================================================================

/**
 * Convert PublishRequest to wire format
 */
export function publishRequestToWire(
  req: PublishRequest,
  requestId: bigint,
  trackAlias: bigint
): WirePublishV14 | WirePublishV18 {
  if (IS_DRAFT_18) {
    return publishRequestToWireV18(req, requestId, trackAlias);
  }
  return publishRequestToWireV14(req, Number(requestId), Number(trackAlias));
}

function publishRequestToWireV14(
  req: PublishRequest,
  requestId: number,
  trackAlias: number
): WirePublishV14 {
  return {
    type: 0x1d,
    requestId,
    trackNamespace: req.trackNamespace,
    trackName: req.trackName,
    trackAlias,
    groupOrder: groupOrderToWire(req.groupOrder ?? GroupOrder.DEFAULT),
    contentExists: 0,
    forward: 1,
    parameters: req.trackProperties ?? new Map(),
  };
}

function publishRequestToWireV18(
  req: PublishRequest,
  requestId: bigint,
  trackAlias: bigint
): WirePublishV18 {
  return {
    type: 0x05,
    requestId,
    trackAlias,
    trackNamespace: req.trackNamespace,
    trackName: req.trackName,
    forwardState: true,
    largestLocation: { group: 0n, object: 0n },
    trackProperties: req.trackProperties ?? new Map(),
  };
}

/**
 * Convert wire response to PublishResponse
 */
export function publishResponseFromWire(
  wire: WirePublishOkV14,
  requestId: bigint,
  trackAlias: bigint
): PublishResponse {
  return {
    requestId,
    trackAlias: BigInt(wire.trackAlias ?? trackAlias),
  };
}

// =============================================================================
// Fetch Adapters
// =============================================================================

/**
 * Convert FetchRequest to wire format
 */
export function fetchRequestToWire(
  req: FetchRequest,
  requestId: bigint
): WireFetchV14 | WireFetchV18 {
  if (IS_DRAFT_18) {
    return fetchRequestToWireV18(req, requestId);
  }
  return fetchRequestToWireV14(req, Number(requestId));
}

function fetchRequestToWireV14(req: FetchRequest, requestId: number): WireFetchV14 {
  return {
    type: 0x16,
    requestId,
    trackNamespace: req.trackNamespace,
    trackName: req.trackName,
    subscriberPriority: req.subscriberPriority,
    groupOrder: groupOrderToWire(req.groupOrder),
    startGroup: Number(req.startLocation.group),
    startObject: Number(req.startLocation.object),
    endGroup: Number(req.endLocation.group),
    endObject: Number(req.endLocation.object),
    parameters: req.parameters ?? new Map(),
  };
}

function fetchRequestToWireV18(req: FetchRequest, requestId: bigint): WireFetchV18 {
  return {
    type: 0x0d,
    requestId,
    joiningFlag: false,
    trackNamespace: req.trackNamespace,
    trackName: req.trackName,
    subscriberPriority: req.subscriberPriority,
    groupOrder: groupOrderToWire(req.groupOrder),
    startLocation: locationToWire(req.startLocation),
    endLocation: locationToWire(req.endLocation),
    parameters: req.parameters ?? new Map(),
  };
}

/**
 * Convert wire response to FetchResponse
 */
export function fetchResponseFromWire(
  wire: WireFetchOkV14 | WireFetchOkV18,
  requestId: bigint
): FetchResponse {
  if ('endLocation' in wire) {
    // V18
    const w18 = wire as WireFetchOkV18;
    return {
      requestId: w18.requestId,
      endOfTrack: w18.endOfTrack,
      endLocation: locationFromWire(w18.endLocation),
      trackProperties: w18.trackProperties,
    };
  }

  // V14
  const w14 = wire as WireFetchOkV14;
  return {
    requestId,
    endOfTrack: false,
    endLocation: {
      group: BigInt(w14.largestGroupId),
      object: BigInt(w14.largestObjectId),
    },
  };
}

// =============================================================================
// Namespace Adapters
// =============================================================================

/**
 * Convert SubscribeNamespaceRequest to wire format(s)
 *
 * In v14/16: Single SUBSCRIBE_NAMESPACE with options
 * In v18: SUBSCRIBE_NAMESPACE + optional SUBSCRIBE_TRACKS
 */
export function subscribeNamespaceRequestToWire(
  req: SubscribeNamespaceRequest,
  requestId: bigint
): {
  namespaceWire: WireSubscribeNamespaceV14 | WireSubscribeNamespaceV18;
  tracksWire?: WireSubscribeTracksV18;
} {
  const mode = req.mode ?? NamespaceSubscribeMode.DISCOVER;

  if (IS_DRAFT_18) {
    return subscribeNamespaceRequestToWireV18(req, requestId, mode);
  }
  return {
    namespaceWire: subscribeNamespaceRequestToWireV14(req, Number(requestId), mode),
  };
}

function subscribeNamespaceRequestToWireV14(
  req: SubscribeNamespaceRequest,
  requestId: number,
  mode: NamespaceSubscribeMode
): WireSubscribeNamespaceV14 {
  return {
    type: 0x11,
    requestId,
    namespacePrefix: req.trackNamespacePrefix,
    subscribeOptions: modeToWireOptionsV14(mode),
    parameters: req.parameters ?? new Map(),
  };
}

function subscribeNamespaceRequestToWireV18(
  req: SubscribeNamespaceRequest,
  requestId: bigint,
  mode: NamespaceSubscribeMode
): {
  namespaceWire: WireSubscribeNamespaceV18;
  tracksWire?: WireSubscribeTracksV18;
} {
  const namespaceWire: WireSubscribeNamespaceV18 = {
    type: 0x11,
    requestId,
    trackNamespacePrefix: req.trackNamespacePrefix,
    parameters: req.parameters ?? new Map(),
  };

  // In v18, if mode is SUBSCRIBE or BOTH, we also need SUBSCRIBE_TRACKS
  if (mode === NamespaceSubscribeMode.SUBSCRIBE || mode === NamespaceSubscribeMode.BOTH) {
    const tracksWire: WireSubscribeTracksV18 = {
      type: 0x14,
      requestId: requestId + 1n, // Use next request ID
      trackNamespacePrefix: req.trackNamespacePrefix,
      trackNamePattern: req.trackNamePattern,
      forwardState: true,
      filter: filterToWireV18(req.filter ?? SubscriptionFilter.LATEST_GROUP),
      parameters: req.parameters ?? new Map(),
    };

    if (req.startLocation) {
      tracksWire.startLocation = locationToWire(req.startLocation);
    }
    if (req.endGroup !== undefined) {
      tracksWire.endGroupDelta = req.endGroup;
    }

    return { namespaceWire, tracksWire };
  }

  return { namespaceWire };
}

/**
 * Convert PublishNamespaceRequest to wire format
 */
export function publishNamespaceRequestToWire(
  req: PublishNamespaceRequest,
  requestId: bigint
): WirePublishNamespaceV14 | WirePublishNamespaceV18 {
  if (IS_DRAFT_18) {
    return {
      type: 0x10,
      requestId,
      trackNamespacePrefix: req.trackNamespacePrefix,
      parameters: req.parameters ?? new Map(),
    };
  }

  return {
    type: 0x06,
    requestId: Number(requestId),
    namespace: req.trackNamespacePrefix,
    parameters: req.parameters ?? new Map(),
  };
}

// =============================================================================
// Error Adapters
// =============================================================================

/**
 * Convert wire error to RequestError
 */
export function errorFromWire(
  wire: WireSubscribeErrorV14 | WirePublishErrorV14 | WireFetchErrorV14 | WireRequestErrorV18
): RequestError {
  if ('errorCode' in wire && typeof wire.errorCode === 'bigint') {
    // V18
    const w18 = wire as WireRequestErrorV18;
    return {
      requestId: w18.requestId,
      errorCode: Number(w18.errorCode),
      reasonPhrase: w18.reasonPhrase,
    };
  }

  // V14
  const w14 = wire as WireSubscribeErrorV14;
  return {
    requestId: BigInt(w14.requestId),
    errorCode: w14.errorCode,
    reasonPhrase: w14.reasonPhrase,
  };
}
