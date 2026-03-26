// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview MOQT Protocol Message Types and Interfaces (Draft 14)
 *
 * This module defines all control message types as specified in
 * draft-ietf-moq-transport-14. These messages are used for session setup,
 * track management, publishing, and subscription control.
 *
 * @see https://datatracker.ietf.org/doc/draft-ietf-moq-transport/14/
 *
 * @example
 * ```typescript
 * import { MessageType, ClientSetupMessage, SubscribeMessage, Version } from 'moqt-core';
 *
 * // Create a client setup message
 * const setup: ClientSetupMessage = {
 *   type: MessageType.CLIENT_SETUP,
 *   supportedVersions: [Version.DRAFT_14],
 *   parameters: new Map([
 *     [SetupParameter.PATH, '/moq'],
 *   ]),
 * };
 * ```
 */

/**
 * MOQT Protocol version identifiers
 *
 * @remarks
 * Version numbers follow the IETF draft numbering.
 * The library supports Draft 14, 15, and 16 of the MoQ Transport specification.
 */
export enum Version {
  /** Draft version 14 */
  DRAFT_14 = 0xff00000e,
  /** Draft version 15 */
  DRAFT_15 = 0xff00000f,
  /** Draft version 16 (final ALPN = 'moqt') */
  DRAFT_16 = 0xff000010,
}

/**
 * Object existence state (Draft-16)
 *
 * @remarks
 * Replaces the boolean `contentExists` field in SUBSCRIBE_OK with a tri-state enum.
 * In draft-14, this is a boolean (0 = false, 1 = true).
 * In draft-16, this is an enum (0 = unknown, 1 = exists, 2 = does not exist).
 */
export enum ObjectExistence {
  /** Existence not yet known (Draft-16 only) */
  UNKNOWN = 0,
  /** Objects exist for this track */
  EXISTS = 1,
  /** No objects exist for this track (Draft-16 only) */
  DOES_NOT_EXIST = 2,
}

/**
 * MOQT Control Message Types (Draft 14 / Draft 16)
 *
 * @remarks
 * These message type identifiers are used in the first byte of each
 * control message to identify its type. Values are assigned per the
 * MOQT Draft 14/16 specifications.
 *
 * Draft-16 renames some message types:
 * - SUBSCRIBE_UPDATE (0x02) → REQUEST_UPDATE
 * - SUBSCRIBE_ERROR (0x05) → REQUEST_ERROR (draft-16 only)
 * - PUBLISH_NAMESPACE_OK (0x07) → REQUEST_OK (draft-16 only)
 * - PUBLISH_NAMESPACE_ERROR (0x08) → NAMESPACE (draft-16 only)
 * - TRACK_STATUS_OK (0x0e) → NAMESPACE_DONE (draft-16 only)
 */
export enum MessageType {
  // Session Messages
  /** Client session setup */
  CLIENT_SETUP = 0x20,
  /** Server session setup response */
  SERVER_SETUP = 0x21,
  /** Graceful session termination */
  GOAWAY = 0x10,
  /** Maximum request ID announcement */
  MAX_REQUEST_ID = 0x15,
  /** Requests blocked notification */
  REQUESTS_BLOCKED = 0x1a,

  // Subscription Messages
  /**
   * Update an existing subscription (Draft-14)
   * In Draft-16, this becomes REQUEST_UPDATE
   */
  SUBSCRIBE_UPDATE = 0x02,
  /** Request to subscribe to a track */
  SUBSCRIBE = 0x03,
  /** Successful subscription response */
  SUBSCRIBE_OK = 0x04,
  /**
   * Subscription error response (Draft-14)
   * In Draft-16, this is overloaded as REQUEST_ERROR
   */
  SUBSCRIBE_ERROR = 0x05,
  /** Request to unsubscribe from a track */
  UNSUBSCRIBE = 0x0a,

  // Publish Messages
  /** Notification of publish completion */
  PUBLISH_DONE = 0x0b,
  /** Request to publish to a track */
  PUBLISH = 0x1d,
  /** Successful publish response */
  PUBLISH_OK = 0x1e,
  /** Publish error response */
  PUBLISH_ERROR = 0x1f,

  // Namespace Publishing Messages
  /** Publish availability of a track namespace */
  PUBLISH_NAMESPACE = 0x06,
  /**
   * Successful namespace publish response (Draft-14)
   * In Draft-16, this is overloaded as REQUEST_OK
   */
  PUBLISH_NAMESPACE_OK = 0x07,
  /**
   * Namespace publish error response (Draft-14)
   * In Draft-16, this is overloaded as NAMESPACE
   */
  PUBLISH_NAMESPACE_ERROR = 0x08,
  /** Namespace publishing done */
  PUBLISH_NAMESPACE_DONE = 0x09,
  /** Cancel namespace publishing */
  PUBLISH_NAMESPACE_CANCEL = 0x0c,

  // Namespace Subscription Messages
  /** Subscribe to a namespace for track discovery */
  SUBSCRIBE_NAMESPACE = 0x11,
  /** Successful namespace subscription response */
  SUBSCRIBE_NAMESPACE_OK = 0x12,
  /** Namespace subscription error */
  SUBSCRIBE_NAMESPACE_ERROR = 0x13,
  /** Unsubscribe from namespace */
  UNSUBSCRIBE_NAMESPACE = 0x14,

  // Fetch Messages
  /** Request to fetch historical objects */
  FETCH = 0x16,
  /** Cancel an in-progress fetch */
  FETCH_CANCEL = 0x17,
  /** Successful fetch response */
  FETCH_OK = 0x18,
  /** Fetch error response */
  FETCH_ERROR = 0x19,

  // Track Status Messages
  /** Request track status */
  TRACK_STATUS = 0x0d,
  /**
   * Track status response (Draft-14)
   * In Draft-16, wire value 0x0e is used for NAMESPACE_DONE
   */
  TRACK_STATUS_OK = 0x0e,
  /** Track status error */
  TRACK_STATUS_ERROR = 0x0f,
}

/**
 * Draft-16 Message Type Aliases (for documentation)
 *
 * These share wire values with draft-14 messages:
 * - REQUEST_UPDATE (0x02) = SUBSCRIBE_UPDATE
 * - REQUEST_ERROR (0x05) = SUBSCRIBE_ERROR
 * - REQUEST_OK (0x07) = PUBLISH_NAMESPACE_OK
 * - NAMESPACE (0x08) = PUBLISH_NAMESPACE_ERROR
 * - NAMESPACE_DONE (0x0e) = TRACK_STATUS_OK
 *
 * The actual wire format differs based on IS_DRAFT_16 at build time.
 */
export const MessageTypeDraft16 = {
  REQUEST_UPDATE: 0x02,
  REQUEST_ERROR: 0x05,
  REQUEST_OK: 0x07,
  NAMESPACE: 0x08,
  NAMESPACE_DONE: 0x0e,
} as const;

/**
 * Data Stream Types (Draft 14)
 *
 * @remarks
 * These type identifiers are used on data streams (separate from control messages).
 * They identify how objects are transmitted on unidirectional streams.
 */
export enum DataStreamType {
  /** Object with subgroup header */
  OBJECT_DATAGRAM = 0x01,
  /** Subgroup stream header (standard Draft 14) */
  SUBGROUP_HEADER = 0x04,
  /** Fetch stream header */
  FETCH_HEADER = 0x05,
  /**
   * LAPS-compatible stream header types
   * Subgroup ID is 0 (not serialized), no extensions
   */
  LAPS_SUBGROUP_0_NOT_END_NO_EXT = 0x10,
  /** LAPS: Subgroup ID is 0, not end of group, with extensions */
  LAPS_SUBGROUP_0_NOT_END_WITH_EXT = 0x11,
  /** LAPS: Subgroup ID from first object, not end of group, no extensions */
  LAPS_SUBGROUP_FIRST_OBJ_NOT_END_NO_EXT = 0x12,
}

/**
 * Setup parameter types for CLIENT_SETUP and SERVER_SETUP messages (Draft 14/16)
 *
 * @remarks
 * These parameters configure the session behavior and capabilities.
 * Note: ROLE parameter has been removed in Draft 14.
 */
export enum SetupParameter {
  /** Path for WebTransport connection */
  PATH = 0x01,
  /** Maximum request ID the endpoint will use */
  MAX_REQUEST_ID = 0x02,
  /**
   * Authorization token for session authentication
   * In Draft-16, this supports token aliasing
   */
  AUTHORIZATION_TOKEN = 0x03,
  /** Maximum size of authorization token cache */
  MAX_AUTH_TOKEN_CACHE_SIZE = 0x04,
  /** Authority (host) for the connection */
  AUTHORITY = 0x05,
  /** Endpoint ID (Draft-16) */
  ENDPOINT_ID = 0x06,
}

/**
 * Subscribe/Publish parameter types (Draft 14/16)
 *
 * @remarks
 * These parameters customize subscription and publish behavior.
 */
export enum RequestParameter {
  /** Requested delivery timeout */
  DELIVERY_TIMEOUT = 0x02,
  /** Authorization token for the request */
  AUTHORIZATION_TOKEN = 0x03,
  /** Expires parameter */
  EXPIRES = 0x06,
  /** Largest object parameter */
  LARGEST_OBJECT = 0x09,
  /** Forward parameter (Draft-16) */
  FORWARD = 0x10,
  /** Subscriber priority (Draft-16) */
  SUBSCRIBER_PRIORITY = 0x20,
  /** Subscription filter (Draft-16) */
  SUBSCRIPTION_FILTER = 0x21,
  /** Group order (Draft-16) */
  GROUP_ORDER = 0x22,
}

/**
 * Group ordering preferences for subscriptions
 *
 * @remarks
 * Controls how groups are delivered to the subscriber.
 */
export enum GroupOrder {
  /** Deliver groups in ascending order (oldest first) */
  ASCENDING = 0x01,
  /** Deliver groups in descending order (newest first) */
  DESCENDING = 0x02,
}

/**
 * Filter types for subscriptions
 *
 * @remarks
 * Specifies what range of objects to receive.
 */
export enum FilterType {
  /** Receive only the latest group */
  LATEST_GROUP = 0x01,
  /** Receive only the latest object */
  LATEST_OBJECT = 0x02,
  /** Receive from an absolute start position */
  ABSOLUTE_START = 0x03,
  /** Receive within an absolute range */
  ABSOLUTE_RANGE = 0x04,
}

/**
 * Session termination error codes (Draft 14)
 *
 * @remarks
 * Used for GOAWAY and session-level error reporting.
 */
export enum SessionErrorCode {
  /** Session terminating without error */
  NO_ERROR = 0x00,
  /** Implementation-specific error occurred */
  INTERNAL_ERROR = 0x01,
  /** Client lacks authorization */
  UNAUTHORIZED = 0x02,
  /** Remote endpoint violated specification */
  PROTOCOL_VIOLATION = 0x03,
  /** Request ID invalid or previously used */
  INVALID_REQUEST_ID = 0x04,
  /** Track Alias already in use */
  DUPLICATE_TRACK_ALIAS = 0x05,
  /** Key-value pair formatting invalid */
  KEY_VALUE_FORMATTING_ERROR = 0x06,
  /** Request ID equals/exceeds maximum */
  TOO_MANY_REQUESTS = 0x07,
  /** PATH parameter unsupported */
  INVALID_PATH = 0x08,
  /** PATH parameter non-conformant */
  MALFORMED_PATH = 0x09,
  /** Session close timeout after GOAWAY */
  GOAWAY_TIMEOUT = 0x10,
  /** Control message response timeout */
  CONTROL_MESSAGE_TIMEOUT = 0x11,
  /** Data stream timeout */
  DATA_STREAM_TIMEOUT = 0x12,
  /** Auth token cache size limit exceeded */
  AUTH_TOKEN_CACHE_OVERFLOW = 0x13,
  /** Alias already registered */
  DUPLICATE_AUTH_TOKEN_ALIAS = 0x14,
  /** No supported version offered */
  VERSION_NEGOTIATION_FAILED = 0x15,
  /** Invalid token serialization */
  MALFORMED_AUTH_TOKEN = 0x16,
  /** Token alias not registered */
  UNKNOWN_AUTH_TOKEN_ALIAS = 0x17,
  /** Authorization token expired */
  EXPIRED_AUTH_TOKEN = 0x18,
  /** Authority invalid for server */
  INVALID_AUTHORITY = 0x19,
  /** Authority syntactically invalid */
  MALFORMED_AUTHORITY = 0x1a,
}

/**
 * Request error codes (Draft 14)
 *
 * @remarks
 * Returned in SUBSCRIBE_ERROR, PUBLISH_ERROR, FETCH_ERROR messages.
 */
export enum RequestErrorCode {
  /** Internal error */
  INTERNAL_ERROR = 0x00,
  /** Invalid range specified */
  INVALID_RANGE = 0x01,
  /** Retry with different track alias */
  RETRY_TRACK_ALIAS = 0x02,
  /** Track does not exist */
  TRACK_NOT_FOUND = 0x03,
  /** Not authorized */
  UNAUTHORIZED = 0x04,
  /** Request timed out */
  TIMEOUT = 0x05,
}

/**
 * Namespace error codes (Draft 14)
 *
 * @remarks
 * Returned in PUBLISH_NAMESPACE_ERROR and SUBSCRIBE_NAMESPACE_ERROR messages.
 */
export enum NamespaceErrorCode {
  /** Internal error */
  INTERNAL_ERROR = 0x00,
  /** Namespace not supported */
  NAMESPACE_NOT_SUPPORTED = 0x01,
  /** Not authorized */
  UNAUTHORIZED = 0x02,
}

/**
 * Track status codes
 *
 * @remarks
 * Indicates the current state of a track.
 */
export enum TrackStatusCode {
  /** Track is in progress (receiving new objects) */
  IN_PROGRESS = 0x00,
  /** Track does not exist */
  DOES_NOT_EXIST = 0x01,
  /** Track has not begun yet */
  NOT_YET_BEGUN = 0x02,
  /** Track has finished */
  FINISHED = 0x03,
}

/**
 * Object status codes (Draft 14/16)
 *
 * @remarks
 * Indicates the status of individual objects within a stream.
 */
export enum ObjectStatus {
  /** Normal object with payload */
  NORMAL = 0x00,
  /** Object does not exist */
  OBJECT_NOT_EXIST = 0x01,
  /** Group does not exist (Draft-16) */
  GROUP_NOT_EXIST = 0x02,
  /** No more objects in this group */
  END_OF_GROUP = 0x03,
  /** End of current subgroup (Draft-16) */
  END_OF_SUBGROUP = 0x04,
  /** End of the track (no more groups) */
  END_OF_TRACK = 0x05,
}

/**
 * Priority levels for object delivery
 *
 * @remarks
 * Higher priority objects are delivered first when there is congestion.
 * Per MOQT spec, there are 4 priority levels (0-3).
 */
export enum Priority {
  /** Highest priority (e.g., keyframes) */
  HIGH = 0,
  /** Above normal priority */
  MEDIUM_HIGH = 1,
  /** Below normal priority */
  MEDIUM_LOW = 2,
  /** Lowest priority (e.g., enhancement layers) */
  LOW = 3,
}

/**
 * Delivery mode for objects
 *
 * @remarks
 * Determines whether objects are sent reliably via streams
 * or best-effort via datagrams.
 */
export enum DeliveryMode {
  /** Reliable, ordered delivery via QUIC streams */
  STREAM = 'stream',
  /** Best-effort, low-latency delivery via datagrams */
  DATAGRAM = 'datagram',
}

// ============================================================================
// Message Interfaces
// ============================================================================

/**
 * Base interface for all MOQT messages
 */
export interface MOQTMessage {
  /** Message type identifier */
  type: MessageType;
}

/**
 * Client setup message sent at the beginning of a session
 *
 * @remarks
 * The client sends this message immediately after establishing
 * the WebTransport connection to negotiate protocol version
 * and session parameters.
 */
export interface ClientSetupMessage extends MOQTMessage {
  type: MessageType.CLIENT_SETUP;
  /** List of protocol versions supported by the client */
  supportedVersions: Version[];
  /** Session setup parameters */
  parameters: Map<SetupParameter, number | string>;
}

/**
 * Server setup message sent in response to CLIENT_SETUP
 *
 * @remarks
 * The server selects a protocol version from the client's
 * supported list and confirms session parameters.
 */
export interface ServerSetupMessage extends MOQTMessage {
  type: MessageType.SERVER_SETUP;
  /** Selected protocol version */
  selectedVersion: Version;
  /** Session setup parameters */
  parameters: Map<SetupParameter, number | string>;
}

/**
 * Track namespace tuple
 *
 * @remarks
 * Namespaces are hierarchical tuples that identify a category of tracks.
 *
 * @example
 * ```typescript
 * // Conference media namespace
 * const namespace: TrackNamespace = ['conference', 'room-123', 'media'];
 *
 * // Chat namespace
 * const chatNs: TrackNamespace = ['conference', 'room-123', 'chat'];
 * ```
 */
export type TrackNamespace = string[];

/**
 * Full track identifier combining namespace and name
 *
 * @remarks
 * Uniquely identifies a track within the MOQT session.
 */
export interface FullTrackName {
  /** Hierarchical namespace */
  namespace: TrackNamespace;
  /** Track name within the namespace */
  trackName: string;
}

/**
 * Subscribe message to request track data (Draft 14)
 *
 * @remarks
 * Sent by a subscriber to request objects from a specific track.
 * The relay or publisher responds with SUBSCRIBE_OK or SUBSCRIBE_ERROR.
 */
export interface SubscribeMessage extends MOQTMessage {
  type: MessageType.SUBSCRIBE;
  /** Request ID (unique per endpoint, clients use even, servers use odd) */
  requestId: number;
  /**
   * Track alias for efficient reference
   * NOTE: In Draft-14, trackAlias is NOT sent in SUBSCRIBE message.
   * It's assigned by the relay/publisher in SUBSCRIBE_OK response.
   * This field is kept for internal tracking purposes only.
   */
  trackAlias?: number | bigint;
  /** Full track identifier */
  fullTrackName: FullTrackName;
  /** Priority for subscription (0-255) */
  subscriberPriority: number;
  /** Requested group ordering */
  groupOrder: GroupOrder;
  /**
   * Forward flag (Draft-14)
   * 0 = Wait for content, 1 = Forward immediately if no content
   */
  forward?: number;
  /** Filter type for object selection */
  filterType: FilterType;
  /** Start group ID (for ABSOLUTE_START/ABSOLUTE_RANGE) */
  startGroup?: number;
  /** Start object ID (for ABSOLUTE_START/ABSOLUTE_RANGE) */
  startObject?: number;
  /** End group ID (for ABSOLUTE_RANGE) */
  endGroup?: number;
  /** Optional subscription parameters */
  parameters?: Map<RequestParameter, Uint8Array>;
}

/**
 * Subscribe update message (Draft 14)
 *
 * @remarks
 * Updates an existing subscription's parameters.
 */
export interface SubscribeUpdateMessage extends MOQTMessage {
  type: MessageType.SUBSCRIBE_UPDATE;
  /** Request ID of this update */
  requestId: number;
  /** Request ID of the subscription being updated */
  subscriptionRequestId: number;
  /** Start location (group and object) */
  startLocation: { groupId: number; objectId: number };
  /** End group ID */
  endGroup: number;
  /** Subscriber priority (0-255) */
  subscriberPriority: number;
  /** Forward flag */
  forward: number;
  /** Optional parameters */
  parameters?: Map<RequestParameter, Uint8Array>;
}

/**
 * Successful subscription response (Draft 14/16)
 */
export interface SubscribeOkMessage extends MOQTMessage {
  type: MessageType.SUBSCRIBE_OK;
  /** Request ID from the request */
  requestId: number;
  /** Track alias assigned by relay */
  trackAlias: number | bigint;
  /** Expiration time in milliseconds */
  expires: number;
  /** Group ordering confirmation */
  groupOrder: GroupOrder;
  /**
   * Content existence status
   * Draft-14: boolean (true/false)
   * Draft-16: ObjectExistence enum (UNKNOWN/EXISTS/DOES_NOT_EXIST)
   */
  contentExists: boolean | ObjectExistence;
  /** Largest group ID (if content exists) */
  largestGroupId?: number;
  /** Largest object ID in largest group (if content exists) */
  largestObjectId?: number;
}

/**
 * Subscription error response (Draft 14)
 */
export interface SubscribeErrorMessage extends MOQTMessage {
  type: MessageType.SUBSCRIBE_ERROR;
  /** Request ID from the request */
  requestId: number;
  /** Error code */
  errorCode: RequestErrorCode;
  /** Human-readable error reason */
  reasonPhrase: string;
  /** Track alias for retry */
  trackAlias: number | bigint;
}

/**
 * Unsubscribe message to cancel a subscription (Draft 14)
 */
export interface UnsubscribeMessage extends MOQTMessage {
  type: MessageType.UNSUBSCRIBE;
  /** Request ID to cancel */
  requestId: number;
}

/**
 * Publish done message (Draft 14)
 *
 * @remarks
 * Sent when publishing to a track is complete.
 */
export interface PublishDoneMessage extends MOQTMessage {
  type: MessageType.PUBLISH_DONE;
  /** Request ID */
  requestId: number;
  /** Status code */
  statusCode: RequestErrorCode;
  /** Status reason */
  reasonPhrase: string;
  /** Whether content was delivered */
  contentExists: boolean;
  /** Final group ID (if content exists) */
  finalGroupId?: number;
  /** Final object ID (if content exists) */
  finalObjectId?: number;
}

/**
 * Publish message to request publishing to a track (Draft 14)
 *
 * @remarks
 * Sent by a publisher to request permission to publish to a track.
 */
export interface PublishMessage extends MOQTMessage {
  type: MessageType.PUBLISH;
  /** Request ID */
  requestId: number;
  /** Full track identifier */
  fullTrackName: FullTrackName;
  /** Track alias for efficient reference */
  trackAlias: number | bigint;
  /** Group order: ASCENDING (0x1) or DESCENDING (0x2) */
  groupOrder: GroupOrder;
  /** Whether content exists (has any objects been published) */
  contentExists: boolean;
  /** Largest location (if contentExists is true) */
  largestLocation?: { groupId: number; objectId: number };
  /** Forward flag: 0 = wait, 1 = start immediately */
  forward: number;
  /** Optional parameters */
  parameters?: Map<RequestParameter, Uint8Array>;
}

/**
 * Successful publish response (Draft 14)
 */
export interface PublishOkMessage extends MOQTMessage {
  type: MessageType.PUBLISH_OK;
  /** Request ID from the request */
  requestId: number;
  /** Track alias assigned by relay (may differ from proposed) */
  trackAlias?: number;
  /** Forward flag */
  forward: number;
  /** Subscriber priority */
  subscriberPriority: number;
  /** Group ordering */
  groupOrder: GroupOrder;
  /** Filter type */
  filterType: number;
  /** Start location (optional, based on filter type) */
  startLocation?: { groupId: number; objectId: number };
  /** End group (optional, based on filter type) */
  endGroup?: number;
  /** Parameters (Draft-16) */
  parameters?: Map<RequestParameter, Uint8Array>;
}

/**
 * Publish error response (Draft 14)
 */
export interface PublishErrorMessage extends MOQTMessage {
  type: MessageType.PUBLISH_ERROR;
  /** Request ID from the request */
  requestId: number;
  /** Error code */
  errorCode: RequestErrorCode;
  /** Human-readable error reason */
  reasonPhrase: string;
  /** Track alias for retry */
  trackAlias: number | bigint;
}

/**
 * Publish namespace message to declare namespace availability (Draft 14/16)
 *
 * @remarks
 * Publishers send this to notify relays and subscribers that
 * a track namespace is available for subscription.
 * (Renamed from ANNOUNCE in earlier drafts)
 *
 * Draft-16 adds a Request ID field at the beginning.
 */
export interface PublishNamespaceMessage extends MOQTMessage {
  type: MessageType.PUBLISH_NAMESPACE;
  /** Request ID (Draft-16 only) */
  requestId?: number;
  /** Track namespace being published */
  namespace: TrackNamespace;
  /** Optional authorization info */
  parameters?: Map<number, Uint8Array>;
}

/**
 * Successful namespace publish response (Draft 14/16)
 *
 * Draft-14: Contains namespace
 * Draft-16: Contains requestId and expires (REQUEST_OK format)
 */
export interface PublishNamespaceOkMessage extends MOQTMessage {
  type: MessageType.PUBLISH_NAMESPACE_OK;
  /** Request ID (Draft-16 only) */
  requestId?: number;
  /** Expires value (Draft-16 only) */
  expires?: number;
  /** Namespace from the request (Draft-14 only) */
  namespace?: TrackNamespace;
}

/**
 * Namespace publish error response (Draft 14)
 */
export interface PublishNamespaceErrorMessage extends MOQTMessage {
  type: MessageType.PUBLISH_NAMESPACE_ERROR;
  /** Namespace from the request */
  namespace: TrackNamespace;
  /** Error code */
  errorCode: NamespaceErrorCode;
  /** Human-readable error reason */
  reasonPhrase: string;
}

/**
 * Publish namespace done message (Draft 14)
 *
 * @remarks
 * Sent when a namespace is no longer being published.
 * (Renamed from UNANNOUNCE in earlier drafts)
 */
export interface PublishNamespaceDoneMessage extends MOQTMessage {
  type: MessageType.PUBLISH_NAMESPACE_DONE;
  /** Namespace no longer being published */
  namespace: TrackNamespace;
}

/**
 * Cancel namespace publishing message (Draft 14)
 */
export interface PublishNamespaceCancelMessage extends MOQTMessage {
  type: MessageType.PUBLISH_NAMESPACE_CANCEL;
  /** Namespace to cancel */
  namespace: TrackNamespace;
}

/**
 * Subscribe to a namespace for track discovery (Draft 14)
 *
 * @remarks
 * Used to discover available tracks within a namespace.
 * The relay will forward PUBLISH_NAMESPACE messages for matching tracks.
 */
/**
 * Subscribe Options for SUBSCRIBE_NAMESPACE (Draft 16)
 */
export enum SubscribeNamespaceOptions {
  /** Request PUBLISH messages only */
  PUBLISH = 0x00,
  /** Request NAMESPACE messages only */
  NAMESPACE = 0x01,
  /** Request both PUBLISH and NAMESPACE messages */
  BOTH = 0x02,
}

export interface SubscribeNamespaceMessage extends MOQTMessage {
  type: MessageType.SUBSCRIBE_NAMESPACE;
  /** Request ID for correlating responses (draft-16 only) */
  requestId?: number;
  /** Namespace prefix to subscribe to */
  namespacePrefix: TrackNamespace;
  /** Subscribe options - what to receive (draft-16 only, default PUBLISH) */
  subscribeOptions?: SubscribeNamespaceOptions;
  /** Optional parameters */
  parameters?: Map<number, Uint8Array>;
}

/**
 * Successful namespace subscription response (Draft 14/16)
 */
export interface SubscribeNamespaceOkMessage extends MOQTMessage {
  type: MessageType.SUBSCRIBE_NAMESPACE_OK;
  /** Request ID from the SUBSCRIBE_NAMESPACE (draft-16) */
  requestId?: number;
  /** Namespace prefix from the request (draft-14) */
  namespacePrefix?: TrackNamespace;
}

/**
 * Namespace subscription error response (Draft 14/16)
 */
export interface SubscribeNamespaceErrorMessage extends MOQTMessage {
  type: MessageType.SUBSCRIBE_NAMESPACE_ERROR;
  /** Request ID from the SUBSCRIBE_NAMESPACE (draft-16) */
  requestId?: number;
  /** Namespace prefix from the request (draft-14) */
  namespacePrefix?: TrackNamespace;
  /** Error code */
  errorCode: NamespaceErrorCode;
  /** Human-readable error reason */
  reasonPhrase: string;
}

/**
 * Unsubscribe from namespace (Draft 14)
 */
export interface UnsubscribeNamespaceMessage extends MOQTMessage {
  type: MessageType.UNSUBSCRIBE_NAMESPACE;
  /** Namespace prefix to unsubscribe from */
  namespacePrefix: TrackNamespace;
}

/**
 * Fetch message to request historical objects (Draft 14)
 *
 * @remarks
 * Similar to SUBSCRIBE but for retrieving past objects
 * rather than receiving live updates.
 */
export interface FetchMessage extends MOQTMessage {
  type: MessageType.FETCH;
  /** Request ID for the fetch */
  requestId: number;
  /** Full track identifier */
  fullTrackName: FullTrackName;
  /** Priority for fetch delivery */
  subscriberPriority: number;
  /** Group ordering preference */
  groupOrder: GroupOrder;
  /** Start group ID */
  startGroup: number;
  /** Start object ID */
  startObject: number;
  /** End group ID */
  endGroup: number;
  /** End object ID (0 = end of group) */
  endObject: number;
  /** Optional parameters */
  parameters?: Map<RequestParameter, Uint8Array>;
}

/**
 * Successful fetch response (Draft 14)
 */
export interface FetchOkMessage extends MOQTMessage {
  type: MessageType.FETCH_OK;
  /** Request ID from the request */
  requestId: number;
  /** Group ordering confirmation */
  groupOrder: GroupOrder;
  /** Whether end of track is known */
  endOfTrack: boolean;
  /** Largest group ID */
  largestGroupId: number;
  /** Largest object ID in largest group */
  largestObjectId: number;
}

/**
 * Fetch error response (Draft 14)
 */
export interface FetchErrorMessage extends MOQTMessage {
  type: MessageType.FETCH_ERROR;
  /** Request ID from the request */
  requestId: number;
  /** Error code */
  errorCode: RequestErrorCode;
  /** Human-readable error reason */
  reasonPhrase: string;
}

/**
 * Cancel an in-progress fetch (Draft 14)
 */
export interface FetchCancelMessage extends MOQTMessage {
  type: MessageType.FETCH_CANCEL;
  /** Request ID to cancel */
  requestId: number;
}

/**
 * Graceful session termination message (Draft 14)
 *
 * @remarks
 * Sent to notify the peer that the session is ending.
 * The peer should complete current operations and close.
 */
export interface GoAwayMessage extends MOQTMessage {
  type: MessageType.GOAWAY;
  /** New URI for reconnection (optional) */
  newSessionUri?: string;
}

/**
 * Maximum request ID message (Draft 14)
 *
 * @remarks
 * Sent to communicate the maximum request ID that can be used.
 */
export interface MaxRequestIdMessage extends MOQTMessage {
  type: MessageType.MAX_REQUEST_ID;
  /** Maximum request ID allowed */
  maxRequestId: number;
}

/**
 * Requests blocked message (Draft 14)
 *
 * @remarks
 * Sent when requests are blocked due to reaching max request ID.
 */
export interface RequestsBlockedMessage extends MOQTMessage {
  type: MessageType.REQUESTS_BLOCKED;
  /** The request ID that is blocked */
  blockedRequestId: number;
}

/**
 * Track status request message (Draft 14)
 */
export interface TrackStatusMessage extends MOQTMessage {
  type: MessageType.TRACK_STATUS;
  /** Request ID */
  requestId: number;
  /** Full track identifier */
  fullTrackName: FullTrackName;
  /** Optional parameters */
  parameters?: Map<RequestParameter, Uint8Array>;
}

/**
 * Track status OK response (Draft 14)
 */
export interface TrackStatusOkMessage extends MOQTMessage {
  type: MessageType.TRACK_STATUS_OK;
  /** Request ID from the request */
  requestId: number;
  /** Track status code */
  statusCode: TrackStatusCode;
  /** Last group ID (if in progress or finished) */
  lastGroupId?: number;
  /** Last object ID (if in progress or finished) */
  lastObjectId?: number;
}

/**
 * Track status error response (Draft 14)
 */
export interface TrackStatusErrorMessage extends MOQTMessage {
  type: MessageType.TRACK_STATUS_ERROR;
  /** Request ID from the request */
  requestId: number;
  /** Error code */
  errorCode: RequestErrorCode;
  /** Human-readable error reason */
  reasonPhrase: string;
}

// ============================================================================
// Draft-16 Specific Message Types
// ============================================================================

/**
 * Request update message (Draft-16)
 *
 * @remarks
 * Renamed from SUBSCRIBE_UPDATE in draft-14. Updates an existing request.
 * Uses same wire format value (0x02) as SUBSCRIBE_UPDATE.
 */
export interface RequestUpdateMessage extends MOQTMessage {
  type: typeof MessageTypeDraft16.REQUEST_UPDATE;
  /** Request ID of this update */
  requestId: number;
  /** Request ID of the subscription being updated */
  subscriptionRequestId: number;
  /** Start location (group and object) */
  startLocation: { groupId: number; objectId: number };
  /** End group ID */
  endGroup: number;
  /** Subscriber priority (0-255) */
  subscriberPriority: number;
  /** Forward flag */
  forward: number;
  /** Optional parameters */
  parameters?: Map<RequestParameter, Uint8Array>;
}

/**
 * Generic request OK response (Draft-16)
 *
 * @remarks
 * Consolidated success response for various request types.
 * Uses same wire format value (0x07) as PUBLISH_NAMESPACE_OK.
 */
export interface RequestOkMessage extends MOQTMessage {
  type: typeof MessageTypeDraft16.REQUEST_OK;
  /** Request ID from the request */
  requestId: number;
}

/**
 * Generic request error response (Draft-16)
 *
 * @remarks
 * Consolidated error response for various request types.
 * Uses same wire format value (0x05) as SUBSCRIBE_ERROR.
 */
export interface RequestErrorMessage extends MOQTMessage {
  type: typeof MessageTypeDraft16.REQUEST_ERROR;
  /** Request ID from the request */
  requestId: number;
  /** Error code */
  errorCode: RequestErrorCode;
  /** Human-readable error reason */
  reasonPhrase: string;
}

/**
 * Namespace announcement message (Draft-16)
 *
 * @remarks
 * Announces a namespace. Different from PUBLISH_NAMESPACE.
 * Uses same wire format value (0x08) as PUBLISH_NAMESPACE_ERROR.
 */
export interface NamespaceMessage extends MOQTMessage {
  type: typeof MessageTypeDraft16.NAMESPACE;
  /** Namespace being announced */
  namespace: TrackNamespace;
  /** Optional parameters */
  parameters?: Map<number, Uint8Array>;
}

/**
 * Namespace announcement done message (Draft-16)
 *
 * @remarks
 * Indicates namespace announcement is complete.
 * Uses same wire format value (0x0e) as TRACK_STATUS_OK.
 */
export interface NamespaceDoneMessage extends MOQTMessage {
  type: typeof MessageTypeDraft16.NAMESPACE_DONE;
  /** Namespace that is done */
  namespace: TrackNamespace;
  /** Status code */
  statusCode: NamespaceErrorCode;
  /** Reason phrase */
  reasonPhrase: string;
}

/**
 * Authorization token with alias support (Draft-16)
 *
 * @remarks
 * Draft-16 adds token aliasing for caching. The aliasType determines
 * how the token is transmitted:
 * - 0: Full token (no alias)
 * - 1: Define new alias for this token
 * - 2: Use existing alias (only tokenAlias is transmitted)
 */
export interface AuthorizationToken {
  /** Alias type: 0 = no alias, 1 = define alias, 2 = use alias */
  aliasType: number;
  /** Token alias for caching (if aliasType > 0) */
  tokenAlias?: number;
  /** Token type identifier (if aliasType < 2) */
  tokenType?: number;
  /** Actual token bytes (if aliasType < 2) */
  tokenValue?: Uint8Array;
}

// ============================================================================
// Object Message Types
// ============================================================================

/**
 * Object header for datagram delivery (Draft 14)
 *
 * @remarks
 * Contains metadata for a single MOQT object (frame) sent via datagram.
 */
export interface ObjectHeader {
  /** Track alias for efficient reference */
  trackAlias: number | bigint;
  /** Group ID (typically increments at keyframes) */
  groupId: number;
  /** Subgroup ID within the group */
  subgroupId: number;
  /** Object ID within the subgroup */
  objectId: number;
  /** Publisher priority for this object */
  publisherPriority: number;
  /** Object status */
  objectStatus: ObjectStatus;
}

/**
 * Subgroup header for stream-based delivery (Draft 14)
 *
 * @remarks
 * In Draft 14, subgroups replace track/group-based streaming.
 */
export interface SubgroupHeader {
  /** Track alias */
  trackAlias: number | bigint;
  /** Group ID */
  groupId: number;
  /** Subgroup ID */
  subgroupId: number;
  /** Publisher priority */
  publisherPriority: number;
}

/**
 * Fetch header for fetch stream (Draft 14)
 */
export interface FetchHeader {
  /** Request ID */
  requestId: number;
}

/**
 * Complete object with header and payload
 *
 * @remarks
 * Represents a single media frame or data unit transmitted via MOQT.
 */
export interface MOQTObject {
  /** Object metadata */
  header: ObjectHeader;
  /** Object payload (encoded media frame) */
  payload: Uint8Array;
  /** Payload length (for validation) */
  payloadLength: number;
}

// ============================================================================
// Union Types
// ============================================================================

/**
 * Union of all control message types (Draft 14/16)
 *
 * Note: Draft-16 messages that share wire values with draft-14 messages
 * (REQUEST_UPDATE, REQUEST_ERROR, REQUEST_OK, NAMESPACE, NAMESPACE_DONE)
 * are handled by the same encoder/decoder with IS_DRAFT_16 conditional logic.
 */
export type ControlMessage =
  // Session messages
  | ClientSetupMessage
  | ServerSetupMessage
  | GoAwayMessage
  | MaxRequestIdMessage
  | RequestsBlockedMessage
  // Subscribe messages
  | SubscribeMessage
  | SubscribeUpdateMessage
  | SubscribeOkMessage
  | SubscribeErrorMessage
  | UnsubscribeMessage
  // Publish messages
  | PublishDoneMessage
  | PublishMessage
  | PublishOkMessage
  | PublishErrorMessage
  // Namespace publish messages
  | PublishNamespaceMessage
  | PublishNamespaceOkMessage
  | PublishNamespaceErrorMessage
  | PublishNamespaceDoneMessage
  | PublishNamespaceCancelMessage
  // Namespace subscribe messages
  | SubscribeNamespaceMessage
  | SubscribeNamespaceOkMessage
  | SubscribeNamespaceErrorMessage
  | UnsubscribeNamespaceMessage
  // Fetch messages
  | FetchMessage
  | FetchOkMessage
  | FetchErrorMessage
  | FetchCancelMessage
  // Track status messages
  | TrackStatusMessage
  | TrackStatusOkMessage
  | TrackStatusErrorMessage;

/**
 * Type guard to check if a message is a control message (Draft 14)
 *
 * @param message - Message to check
 * @returns True if the message is a control message
 */
export function isControlMessage(message: MOQTMessage): message is ControlMessage {
  // All message types defined in MessageType enum are control messages
  return Object.values(MessageType).includes(message.type);
}

/**
 * Type guard to check if a message is a setup message (Draft 14)
 *
 * @param message - Message to check
 * @returns True if the message is CLIENT_SETUP or SERVER_SETUP
 */
export function isSetupMessage(
  message: MOQTMessage
): message is ClientSetupMessage | ServerSetupMessage {
  return message.type === MessageType.CLIENT_SETUP ||
    message.type === MessageType.SERVER_SETUP;
}
