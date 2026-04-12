// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Generic MOQT Session Types
 *
 * Type definitions for the generic MOQT session layer.
 * These types define the protocol-level abstractions without
 * any media-specific dependencies.
 */

import type { GroupOrder } from '@web-moq/core';

/**
 * Session state
 */
export type SessionState = 'none' | 'setup' | 'ready' | 'error';

/**
 * Session event types
 */
export type SessionEventType =
  | 'state-change'
  | 'object'
  | 'error'
  | 'publish-stats'
  | 'subscribe-stats'
  | 'subscribe-ok'
  | 'incoming-subscribe'
  | 'namespace-acknowledged'
  | 'incoming-publish'
  | 'fetch-object'
  | 'fetch-complete'
  | 'fetch-error'
  | 'incoming-fetch'
  | 'message-sent'
  | 'message-received';

/**
 * Options for subscribing to a track
 */
export interface SubscribeOptions {
  /** Subscriber priority (0-255, default 128) */
  priority?: number;
  /** Group ordering preference */
  groupOrder?: GroupOrder;
}

/**
 * Options for publishing to a track
 */
export interface PublishOptions {
  /** Publisher priority (0-255, default 128) */
  priority?: number;
  /** Group ordering */
  groupOrder?: GroupOrder;
  /** Delivery timeout in milliseconds */
  deliveryTimeout?: number;
  /** Delivery mode: 'stream' for reliable, 'datagram' for low-latency */
  deliveryMode?: 'stream' | 'datagram';
  /** Audio delivery mode when main mode is 'stream' (default: 'datagram' for low latency) */
  audioDeliveryMode?: 'datagram' | 'stream';
}

/**
 * Metadata for sending objects
 */
export interface ObjectMetadata {
  /** Group ID */
  groupId: number;
  /** Object ID within the group */
  objectId: number;
  /** Whether this is a keyframe (starts new GOP for streams) */
  isKeyframe?: boolean;
  /** Object type hint (for logging) */
  type?: string;
  /** Max cache duration in milliseconds - tells relay how long to cache this object */
  maxCacheDuration?: number;
}

/**
 * Received object event data
 */
export interface ReceivedObjectEvent {
  /** Subscription ID */
  subscriptionId: number;
  /** Track alias */
  trackAlias: bigint;
  /** Object payload */
  data: Uint8Array;
  /** Group ID */
  groupId: number;
  /** Object ID */
  objectId: number;
  /** Timestamp (microseconds) */
  timestamp: number;
}

/**
 * Active subscription info
 */
export interface SubscriptionInfo {
  subscriptionId: number;
  requestId: number;
  namespace: string[];
  trackName: string;
  trackAlias?: bigint;
  paused: boolean;
}

/**
 * Active publication info
 */
export interface PublicationInfo {
  trackAlias: bigint;
  namespace: string[];
  trackName: string;
  priority: number;
  deliveryMode: 'stream' | 'datagram';
  /** Audio delivery mode when main delivery mode is 'stream' */
  audioDeliveryMode?: 'datagram' | 'stream';
}

/**
 * Publish stats event data
 */
export interface PublishStatsEvent {
  trackAlias: string;
  type?: string;
  groupId: number;
  objectId: number;
  bytes: number;
}

/**
 * Subscribe stats event data
 */
export interface SubscribeStatsEvent {
  subscriptionId: number;
  groupId: number;
  objectId: number;
  bytes: number;
}

/**
 * Subscribe OK event data - emitted when SUBSCRIBE_OK is received
 */
export interface SubscribeOkEvent {
  /** Subscription ID */
  subscriptionId: number;
  /** Request ID from the subscribe */
  requestId: number;
  /** Track alias assigned by relay */
  trackAlias: bigint;
  /** Whether content exists for this track */
  contentExists: boolean;
  /** Largest group ID available (if content exists) */
  largestGroupId?: number;
  /** Largest object ID in largest group (if content exists) */
  largestObjectId?: number;
}

/**
 * Message log event - emitted when control messages are sent or received
 */
export interface MessageLogEvent {
  /** Message type name (e.g., 'SUBSCRIBE', 'PUBLISH_OK') */
  messageType: string;
  /** Timestamp when message was processed */
  timestamp: number;
  /** Message size in bytes */
  bytes: number;
  /** Summary of message content for display */
  summary: string;
  /** Additional details (optional) */
  details?: Record<string, unknown>;
}

/**
 * Options for announcing a namespace (announce flow)
 */
export interface AnnounceOptions {
  /** Publisher priority (0-255, default 128) */
  priority?: number;
  /** Group ordering */
  groupOrder?: GroupOrder;
  /** Delivery timeout in milliseconds */
  deliveryTimeout?: number;
  /** Delivery mode: 'stream' for reliable, 'datagram' for low-latency */
  deliveryMode?: 'stream' | 'datagram';
  /** Audio delivery mode when main mode is 'stream' (default: 'datagram' for low latency) */
  audioDeliveryMode?: 'datagram' | 'stream';
}

/**
 * Announced namespace info
 */
export interface AnnouncedNamespaceInfo {
  /** Namespace tuple */
  namespace: string[];
  /** Namespace as string for display */
  namespaceStr: string;
  /** Active subscribers to this namespace */
  subscribers: Map<number, IncomingSubscriber>;
  /** Announce options */
  options: AnnounceOptions;
  /** Whether announce was acknowledged by relay */
  acknowledged: boolean;
}

/**
 * Incoming subscriber info (for announce flow)
 */
export interface IncomingSubscriber {
  /** Request ID from the subscriber */
  requestId: number;
  /** Full track name requested */
  fullTrackName: { namespace: string[]; trackName: string };
  /** Track alias assigned by publisher */
  trackAlias: bigint;
  /** Subscriber priority */
  subscriberPriority: number;
  /** Group order preference */
  groupOrder: GroupOrder;
  /** Whether subscription is active */
  active: boolean;
}

/**
 * Event fired when a subscriber requests a track (announce flow)
 */
export interface IncomingSubscribeEvent {
  /** Request ID */
  requestId: number;
  /** Namespace */
  namespace: string[];
  /** Track name */
  trackName: string;
  /** Track alias to use for publishing */
  trackAlias: bigint;
}

/**
 * Options for subscribing to a namespace
 */
export interface SubscribeNamespaceOptions {
  /** Subscriber priority (0-255, default 128) */
  priority?: number;
  /** Callback for received objects from tracks under this namespace */
  onObject?: (data: Uint8Array, groupId: number, objectId: number, timestamp: number) => void;
}

/**
 * Namespace subscription info
 */
export interface NamespaceSubscriptionInfo {
  /** Subscription ID */
  subscriptionId: number;
  /** Request ID */
  requestId: number;
  /** Namespace prefix */
  namespacePrefix: string[];
  /** Tracks discovered under this namespace */
  tracks: Map<string, IncomingPublishInfo>;
  /** Callback for received objects from tracks under this namespace */
  onObject?: (data: Uint8Array, groupId: number, objectId: number, timestamp: number) => void;
}

/**
 * Incoming publish info (from PUBLISH message)
 */
export interface IncomingPublishInfo {
  /** Request ID from publisher */
  requestId: number;
  /** Full namespace */
  namespace: string[];
  /** Track name */
  trackName: string;
  /** Track alias assigned by publisher */
  trackAlias: bigint;
  /** Group order */
  groupOrder: GroupOrder;
  /** Whether we've sent PUBLISH_OK */
  acknowledged: boolean;
}

/**
 * Event fired when a publisher announces a track (subscribe namespace flow)
 */
export interface IncomingPublishEvent {
  /** Namespace subscription ID that matched this publish */
  namespaceSubscriptionId: number;
  /** Internal subscription ID for this track (for object routing) */
  subscriptionId: number;
  /** Request ID from publisher */
  requestId: number;
  /** Namespace */
  namespace: string[];
  /** Track name */
  trackName: string;
  /** Track alias to use for receiving objects */
  trackAlias: bigint;
  /** Group order */
  groupOrder: GroupOrder;
}

// ============================================================================
// FETCH / DVR Types
// ============================================================================

/**
 * Options for fetching historical objects
 */
export interface FetchOptions {
  /** Subscriber priority (0-255, default 128) */
  priority?: number;
  /** Group ordering preference */
  groupOrder?: GroupOrder;
}

/**
 * Range specification for FETCH request
 */
export interface FetchRange {
  /** Start group ID */
  startGroup: number;
  /** Start object ID within start group */
  startObject: number;
  /** End group ID */
  endGroup: number;
  /** End object ID within end group (0 = end of group) */
  endObject: number;
}

/**
 * Active fetch info
 */
export interface FetchInfo {
  /** Fetch request ID */
  requestId: number;
  /** Namespace */
  namespace: string[];
  /** Track name */
  trackName: string;
  /** Requested range */
  range: FetchRange;
  /** Whether fetch completed */
  completed: boolean;
  /** Largest group ID available (from FETCH_OK) */
  largestGroupId?: number;
  /** Largest object ID in largest group (from FETCH_OK) */
  largestObjectId?: number;
  /** Whether end of track is known */
  endOfTrack?: boolean;
}

/**
 * Event fired when fetch receives objects
 */
export interface FetchObjectEvent {
  /** Fetch request ID */
  requestId: number;
  /** Object payload */
  data: Uint8Array;
  /** Group ID */
  groupId: number;
  /** Object ID */
  objectId: number;
}

/**
 * Event fired when fetch completes successfully
 */
export interface FetchCompleteEvent {
  /** Fetch request ID */
  requestId: number;
  /** Largest group ID available */
  largestGroupId: number;
  /** Largest object ID in largest group */
  largestObjectId: number;
  /** Whether this is the end of the track */
  endOfTrack: boolean;
}

/**
 * Event fired when fetch fails
 */
export interface FetchErrorEvent {
  /** Fetch request ID */
  requestId: number;
  /** Error code */
  errorCode: number;
  /** Error reason */
  reason: string;
}

// ============================================================================
// VOD Publishing Types
// ============================================================================

/**
 * VOD (Video on Demand) content metadata
 */
export interface VODMetadata {
  /** Total duration in milliseconds */
  duration: number;
  /** Total number of groups */
  totalGroups: number;
  /** Frames per second (for time-to-group mapping) */
  framerate?: number;
  /** GOP duration in milliseconds (for time-to-group mapping) */
  gopDuration?: number;
  /** Timescale (ticks per second, default 1000) */
  timescale?: number;
}

/**
 * Options for publishing VOD content
 */
export interface VODPublishOptions extends PublishOptions {
  /** VOD metadata */
  metadata: VODMetadata;
  /** Callback to fetch object data by group/object ID */
  getObject: (groupId: number, objectId: number) => Promise<Uint8Array | null>;
  /** Callback to check if object is a keyframe */
  isKeyframe?: (groupId: number, objectId: number) => boolean;
  /** Number of objects per group (if uniform) */
  objectsPerGroup?: number;
  /** Max cache duration in milliseconds - tells relay how long to cache content (default: 60000ms = 1 minute) */
  maxCacheDuration?: number;
}

/**
 * VOD track info
 */
export interface VODTrackInfo {
  /** Track alias */
  trackAlias: bigint;
  /** Namespace */
  namespace: string[];
  /** Track name */
  trackName: string;
  /** VOD metadata */
  metadata: VODMetadata;
  /** Active fetch requests being served */
  activeFetches: Map<number, FetchRange>;
}

/**
 * Event fired when a subscriber sends a FETCH request (VOD publisher receives this)
 */
export interface IncomingFetchEvent {
  /** Request ID from the fetch */
  requestId: number;
  /** Namespace */
  namespace: string[];
  /** Track name */
  trackName: string;
  /** Requested range */
  range: FetchRange;
  /** Subscriber priority */
  priority: number;
  /** Group order preference */
  groupOrder: GroupOrder;
}
