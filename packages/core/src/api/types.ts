// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Unified MOQT Public API Types
 *
 * Version-agnostic types for the public API. These types abstract away
 * wire-format differences between draft versions. Application code should
 * use these types exclusively.
 *
 * Wire-level types are internal and located in src/internal/.
 */

// =============================================================================
// Core Primitive Types
// =============================================================================

/**
 * Track namespace as an array of path segments
 * @example ['conference', 'room-1', 'participant-42']
 */
export type TrackNamespace = string[];

/**
 * Location within a track (group/object pair)
 */
export interface Location {
  group: bigint;
  object: bigint;
}

/**
 * Full track identifier
 */
export interface FullTrackName {
  namespace: TrackNamespace;
  name: string;
}

/**
 * Generic key-value properties map
 */
export type Properties = Map<number, Uint8Array>;

// =============================================================================
// Enums
// =============================================================================

/**
 * Protocol version identifiers
 */
export enum Version {
  DRAFT_14 = 0xff00000e,
  DRAFT_15 = 0xff00000f,
  DRAFT_16 = 0xff000010,
  DRAFT_17 = 0xff000011,
  DRAFT_18 = 0xff000012,
}

/**
 * Subscription filter type
 */
export enum SubscriptionFilter {
  /** Start from the latest group */
  LATEST_GROUP = 1,
  /** Start from the latest object */
  LATEST_OBJECT = 2,
  /** Start from an absolute position */
  ABSOLUTE_START = 3,
  /** Fetch a range of objects */
  ABSOLUTE_RANGE = 4,
}

/**
 * Group ordering preference
 */
export enum GroupOrder {
  /** Publisher's default ordering */
  DEFAULT = 0,
  /** Ascending group order (oldest first) */
  ASCENDING = 1,
  /** Descending group order (newest first) */
  DESCENDING = 2,
}

/**
 * Object delivery status
 */
export enum ObjectStatus {
  /** Normal object with payload */
  NORMAL = 0,
  /** Object does not exist */
  OBJECT_NOT_EXISTS = 1,
  /** Group does not exist */
  GROUP_NOT_EXISTS = 2,
  /** End of group marker */
  END_OF_GROUP = 3,
  /** End of track marker */
  END_OF_TRACK = 4,
}

/**
 * Connection role (primarily d18+)
 */
export enum Role {
  PUBLISHER = 1,
  SUBSCRIBER = 2,
  PUBSUB = 3,
}

/**
 * Namespace subscription mode
 *
 * Controls what is received from a namespace subscription:
 * - DISCOVER: Only receive namespace/track announcements
 * - SUBSCRIBE: Only receive track data (auto-subscribe to matching tracks)
 * - BOTH: Receive both announcements and track data
 *
 * Wire mapping:
 * - d14/16: Maps to SubscribeNamespaceOptions (NAMESPACE=0, PUBLISH=1, BOTH=2)
 * - d18: DISCOVER uses SUBSCRIBE_NAMESPACE; SUBSCRIBE/BOTH also opens SUBSCRIBE_TRACKS
 */
export enum NamespaceSubscribeMode {
  /** Discover track/namespace names only */
  DISCOVER = 'discover',
  /** Auto-subscribe to track data only */
  SUBSCRIBE = 'subscribe',
  /** Both discover and subscribe */
  BOTH = 'both',
}

// =============================================================================
// Session Setup Types
// =============================================================================

/**
 * Options for establishing a session
 */
export interface SessionOptions {
  /** Server URL (WebTransport endpoint) */
  url: string;
  /** Connection role */
  role?: Role;
  /** Path parameter for session */
  path?: string;
  /** Authority parameter */
  authority?: string;
  /** Authentication token */
  authToken?: Uint8Array;
}

/**
 * Session state
 */
export type SessionState = 'connecting' | 'connected' | 'closing' | 'closed';

// =============================================================================
// Subscribe Flow Types
// =============================================================================

/**
 * Request to subscribe to a track
 */
export interface SubscribeRequest {
  /** Track namespace */
  trackNamespace: TrackNamespace;
  /** Track name within the namespace */
  trackName: string;
  /** Subscription filter type */
  filter: SubscriptionFilter;
  /** Start location (for ABSOLUTE_START and ABSOLUTE_RANGE filters) */
  startLocation?: Location;
  /** End group (for ABSOLUTE_RANGE filter) */
  endGroup?: bigint;
  /** Subscriber priority (0-255, higher = more important) */
  subscriberPriority?: number;
  /** Preferred group ordering */
  groupOrder?: GroupOrder;
  /** Additional parameters */
  parameters?: Properties;
}

/**
 * Successful subscription response
 */
export interface SubscribeResponse {
  /** Request ID assigned to this subscription */
  requestId: bigint;
  /** Whether content exists for this track */
  contentExists: boolean;
  /** Largest location available (if content exists) */
  largestLocation?: Location;
  /** Actual group order being used */
  groupOrder?: GroupOrder;
  /** Subscription expiry time */
  expires?: bigint;
  /** Track properties from publisher */
  trackProperties?: Properties;
}

/**
 * Options for updating an active subscription
 */
export interface SubscribeUpdateOptions {
  /** New subscriber priority */
  subscriberPriority?: number;
  /** New start location */
  startLocation?: Location;
  /** New end group */
  endGroup?: bigint;
}

/**
 * Active subscription handle
 */
export interface Subscription {
  /** Request ID for this subscription */
  readonly requestId: bigint;
  /** Full track name */
  readonly track: FullTrackName;
  /** Current subscription response info */
  readonly response: SubscribeResponse;

  /** Update subscription parameters */
  update(options: SubscribeUpdateOptions): Promise<void>;

  /** End the subscription */
  unsubscribe(): Promise<void>;

  /** Async iterator for incoming objects */
  readonly objects: AsyncIterable<MOQTObject>;
}

// =============================================================================
// Publish Flow Types
// =============================================================================

/**
 * Request to publish to a track
 */
export interface PublishRequest {
  /** Track namespace */
  trackNamespace: TrackNamespace;
  /** Track name within the namespace */
  trackName: string;
  /** Track alias (optional, auto-generated if not provided) */
  trackAlias?: bigint;
  /** Publisher priority */
  subscriberPriority?: number;
  /** Group ordering */
  groupOrder?: GroupOrder;
  /** Track properties */
  trackProperties?: Properties;
}

/**
 * Successful publish response
 */
export interface PublishResponse {
  /** Request ID assigned to this publication */
  requestId: bigint;
  /** Track alias being used */
  trackAlias: bigint;
  /** Publication expiry time */
  expires?: bigint;
}

/**
 * Outgoing object to publish
 */
export interface OutgoingObject {
  /** Group ID */
  groupId: bigint;
  /** Subgroup ID */
  subgroupId: bigint;
  /** Object ID within the subgroup */
  objectId: bigint;
  /** Publisher priority (0-255) */
  priority?: number;
  /** Object status */
  status?: ObjectStatus;
  /** Object payload */
  payload: Uint8Array;
}

/**
 * Active publication handle
 */
export interface Publication {
  /** Request ID for this publication */
  readonly requestId: bigint;
  /** Track alias assigned */
  readonly trackAlias: bigint;
  /** Full track name */
  readonly track: FullTrackName;
  /** Publication response info */
  readonly response: PublishResponse;

  /** Send an object */
  sendObject(object: OutgoingObject): Promise<void>;

  /** Signal publish completion */
  done(reason?: string): Promise<void>;
}

// =============================================================================
// Fetch Flow Types
// =============================================================================

/**
 * Request to fetch historical objects
 */
export interface FetchRequest {
  /** Track namespace */
  trackNamespace: TrackNamespace;
  /** Track name */
  trackName: string;
  /** Subscriber priority */
  subscriberPriority: number;
  /** Group ordering preference */
  groupOrder: GroupOrder;
  /** Start location (inclusive) */
  startLocation: Location;
  /** End location (exclusive) */
  endLocation: Location;
  /** Additional parameters */
  parameters?: Properties;
}

/**
 * Successful fetch response
 */
export interface FetchResponse {
  /** Request ID for this fetch */
  requestId: bigint;
  /** Whether end of track was reached */
  endOfTrack: boolean;
  /** Actual end location */
  endLocation: Location;
  /** Track properties */
  trackProperties?: Properties;
}

/**
 * Active fetch handle
 */
export interface Fetch {
  /** Request ID for this fetch */
  readonly requestId: bigint;
  /** Fetch response info */
  readonly response: FetchResponse;

  /** Cancel the fetch */
  cancel(): Promise<void>;

  /** Async iterator for fetched objects */
  readonly objects: AsyncIterable<MOQTObject>;
}

// =============================================================================
// Namespace Operations Types
// =============================================================================

/**
 * Request to subscribe to namespace announcements
 */
export interface SubscribeNamespaceRequest {
  /** Namespace prefix to subscribe to */
  trackNamespacePrefix: TrackNamespace;

  /**
   * Subscription mode (default: DISCOVER)
   * - DISCOVER: Only receive namespace/track announcements
   * - SUBSCRIBE: Auto-subscribe to track data
   * - BOTH: Receive both announcements and data
   */
  mode?: NamespaceSubscribeMode;

  /** Track name pattern filter (for SUBSCRIBE/BOTH modes, d18 only) */
  trackNamePattern?: string;

  /** Subscription filter (for SUBSCRIBE/BOTH modes) */
  filter?: SubscriptionFilter;

  /** Start location (for SUBSCRIBE/BOTH modes) */
  startLocation?: Location;

  /** End group delta (for SUBSCRIBE/BOTH modes) */
  endGroup?: bigint;

  /** Additional parameters */
  parameters?: Properties;
}

/**
 * An announced namespace or track
 */
export interface AnnouncedNamespace {
  /** The announced namespace */
  namespace: TrackNamespace;
  /** Track name (if announcing a specific track) */
  trackName?: string;
  /** Namespace/track properties */
  properties?: Properties;
}

/**
 * Object received from auto-subscribed track
 */
export interface TrackObject {
  /** Source track */
  track: FullTrackName;
  /** The object data */
  object: MOQTObject;
}

/**
 * Namespace subscription handle
 */
export interface NamespaceSubscription {
  /** Request ID for this subscription */
  readonly requestId: bigint;
  /** Subscribed prefix */
  readonly prefix: TrackNamespace;
  /** Subscription mode */
  readonly mode: NamespaceSubscribeMode;

  /** Unsubscribe from namespace */
  unsubscribe(): Promise<void>;

  /**
   * Async iterator for discovered namespaces/tracks
   * (available in DISCOVER and BOTH modes)
   */
  readonly namespaces: AsyncIterable<AnnouncedNamespace>;

  /**
   * Async iterator for track data objects
   * (available in SUBSCRIBE and BOTH modes, undefined otherwise)
   */
  readonly objects?: AsyncIterable<TrackObject>;
}

/**
 * Request to publish namespace availability
 */
export interface PublishNamespaceRequest {
  /** Namespace prefix to publish */
  trackNamespacePrefix: TrackNamespace;
  /** Additional parameters */
  parameters?: Properties;
}

/**
 * Namespace publication handle
 */
export interface NamespacePublication {
  /** Request ID for this publication */
  readonly requestId: bigint;
  /** Published prefix */
  readonly prefix: TrackNamespace;

  /** Announce a namespace within the prefix */
  announce(namespace: TrackNamespace, properties?: Properties): Promise<void>;

  /** Signal namespace publication is done */
  done(finalNamespace: TrackNamespace): Promise<void>;

  /** Cancel namespace publication */
  cancel(): Promise<void>;
}

// =============================================================================
// Object Types
// =============================================================================

/**
 * MOQT object (received)
 */
export interface MOQTObject {
  /** Track alias */
  trackAlias: bigint;
  /** Group ID */
  groupId: bigint;
  /** Subgroup ID */
  subgroupId: bigint;
  /** Object ID */
  objectId: bigint;
  /** Publisher priority */
  publisherPriority: number;
  /** Object status */
  status: ObjectStatus;
  /** Object payload */
  payload: Uint8Array;
}

// =============================================================================
// Error Types
// =============================================================================

/**
 * Generic request error
 */
export interface RequestError {
  /** Request ID that failed */
  requestId: bigint;
  /** Error code */
  errorCode: number;
  /** Human-readable error description */
  reasonPhrase: string;
}

/**
 * Generic request acknowledgement
 */
export interface RequestOk {
  /** Request ID acknowledged */
  requestId: bigint;
  /** Expiry time */
  expires?: bigint;
}

// =============================================================================
// Codec Capabilities
// =============================================================================

/**
 * Protocol codec capabilities (for feature detection)
 */
export interface CodecCapabilities {
  /** Uses per-request bidirectional streams (d18) */
  perRequestStreams: boolean;
  /** Has SUBSCRIBE_TRACKS support (d18) */
  subscribeTracks: boolean;
  /** Uses MOQT varints vs QUIC varints (d18) */
  moqtVarInt: boolean;
  /** Has unified REQUEST_ERROR (d16+) */
  unifiedErrors: boolean;
}

// =============================================================================
// Session Interface
// =============================================================================

/**
 * Event handler types
 */
export type SessionErrorHandler = (error: RequestError) => void;
export type SessionGoAwayHandler = (newUri?: string) => void;
export type SessionCloseHandler = () => void;

/**
 * MOQT Session interface
 */
export interface ISession {
  /** Current session state */
  readonly state: SessionState;
  /** Negotiated protocol version */
  readonly version: Version;
  /** Codec capabilities */
  readonly capabilities: CodecCapabilities;

  // Track Operations
  subscribe(request: SubscribeRequest): Promise<Subscription>;
  publish(request: PublishRequest): Promise<Publication>;
  fetch(request: FetchRequest): Promise<Fetch>;

  // Namespace Operations
  subscribeNamespace(request: SubscribeNamespaceRequest): Promise<NamespaceSubscription>;
  publishNamespace(request: PublishNamespaceRequest): Promise<NamespacePublication>;

  // Session Lifecycle
  goAway(newSessionUri?: string): Promise<void>;
  close(): Promise<void>;

  // Events
  on(event: 'error', handler: SessionErrorHandler): void;
  on(event: 'goaway', handler: SessionGoAwayHandler): void;
  on(event: 'close', handler: SessionCloseHandler): void;

  off(event: 'error', handler: SessionErrorHandler): void;
  off(event: 'goaway', handler: SessionGoAwayHandler): void;
  off(event: 'close', handler: SessionCloseHandler): void;
}
