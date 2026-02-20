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
  | 'incoming-subscribe'
  | 'namespace-acknowledged';

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
