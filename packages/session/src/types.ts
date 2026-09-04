// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Generic MOQT Session Types
 *
 * Type definitions for the generic MOQT session layer.
 * These types define the protocol-level abstractions without
 * any media-specific dependencies.
 */

import type { GroupOrder, FetchTypeDraft18 } from '@moq-web/core';

/**
 * Session state
 */
export type SessionState = 'none' | 'setup' | 'ready' | 'closing' | 'error';

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
  | 'request-ok'
  | 'incoming-subscribe'
  | 'namespace-acknowledged'
  | 'namespace-announced'
  | 'namespace-done'
  | 'incoming-publish'
  | 'forward-paused'
  | 'forward-resumed'
  | 'namespace-forward-paused'
  | 'namespace-forward-resumed'
  | 'goaway'
  | 'session-terminated'
  | 'session-migrating'
  | 'session-migrated'
  | 'publish-done'
  | 'publish-blocked'
  | 'delivery-timeout'
  | 'stream-reset'
  | 'new-group-request'
  | 'fetch-object'
  | 'fetch-complete'
  | 'fetch-stream-complete'
  | 'fetch-error'
  | 'incoming-fetch'
  | 'message-sent'
  | 'message-received'
  | 'forward-state-change';

/**
 * Fired when the underlying transport closes and carries a draft-18 §15.10.1
 * Session Termination Code from the peer. `remote` is true when the peer
 * initiated the close; local closes via `session.close({ code })` will not
 * re-emit this event.
 */
export interface SessionTerminatedEvent {
  /** Draft-18 SessionErrorCode value the peer supplied (0 = NO_ERROR). */
  code: number;
  /** Human-readable reason phrase from the peer (may be empty). */
  reason: string;
  /** True when the peer initiated the close. */
  remote: boolean;
}

/**
 * Fired when the session begins/completes a §3.6 migration triggered by
 * GOAWAY carrying `newSessionUri`. `session-migrating` fires immediately
 * before the current transport is torn down; `session-migrated` fires after
 * the new transport has re-run SETUP and reached the `ready` state.
 */
export interface SessionMigrationEvent {
  /** URI the client is migrating to (from GOAWAY.newSessionUri). */
  newSessionUri: string;
  /** URI the session was previously connected to (undefined on first connect). */
  oldSessionUri?: string;
}

/**
 * Per-request authorization token for SUBSCRIBE/PUBLISH/FETCH.
 * Used when per-action tokens are needed beyond the session-level token.
 */
export interface RequestAuthToken {
  /** Raw token bytes (COSE_Sign1 CBOR) */
  tokenBytes: Uint8Array;
  /** Token type identifier (default: 0x63346d = C4M) */
  tokenType?: number;
}

/**
 * Options for subscribing to a track
 */
export interface SubscribeOptions {
  /** Subscriber priority (0-255, default 128) */
  priority?: number;
  /** Group ordering preference */
  groupOrder?: GroupOrder;
  /**
   * SUBSCRIPTION_FILTER variant (§10.2.9 on draft-18, per-message field on draft-16).
   *
   * - `'latest'`         — live edge; maps to `NEXT_GROUP_START` on draft-18, `LATEST_GROUP` on draft-16 (default).
   * - `'absolute'`       — legacy alias for `'absolute-start'`.
   * - `'next-group'`     — draft-18 `NEXT_GROUP_START` (0x01), explicit.
   * - `'largest-object'` — draft-18 `LARGEST_OBJECT` (0x02); resume from the largest object seen.
   * - `'absolute-start'` — `ABSOLUTE_START` (0x03); requires `startGroup`+`startObject`.
   * - `'absolute-range'` — draft-18 `ABSOLUTE_RANGE` (0x04); requires `startGroup`+`startObject` and `endGroup` (delta from start).
   */
  filterType?: 'latest' | 'absolute' | 'next-group' | 'largest-object' | 'absolute-start' | 'absolute-range';
  /** Start group ID for absolute-start / absolute-range (default: 0). */
  startGroup?: number;
  /** Start object ID for absolute-start / absolute-range (default: 0). */
  startObject?: number;
  /** End group ID for absolute-range. Delta from startGroup: `endGroup - startGroup`. */
  endGroup?: number;
  /** Per-request authorization token */
  authToken?: RequestAuthToken;
  /**
   * Draft-18 §10.2 subscriber-side delivery timeouts (ms).
   *
   * - subgroupDeliveryTimeout — max time to fully deliver a subgroup
   * - objectDeliveryTimeout   — max time to deliver a single object
   * - fillTimeout             — max time to wait for a missing object
   * - rendezvousTimeout       — max time to wait before a new-subscriber cutover
   *
   * A value of 0 or `undefined` omits the parameter. Draft-16 ignores these.
   */
  subgroupDeliveryTimeout?: number;
  objectDeliveryTimeout?: number;
  fillTimeout?: number;
  rendezvousTimeout?: number;
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
  /** Max cache duration in ms — relay evicts objects after this time (default: no limit) */
  maxCacheDuration?: number;
  /** Delivery mode: 'stream' for reliable, 'datagram' for low-latency */
  deliveryMode?: 'stream' | 'datagram';
  /** Audio delivery mode when main mode is 'stream' (default: 'datagram' for low latency) */
  audioDeliveryMode?: 'datagram' | 'stream';
  /** Skip waiting for forward=1 (for fire-and-forget feedback tracks) */
  skipForwardWait?: boolean;
  /** Per-request authorization token */
  authToken?: RequestAuthToken;
  /**
   * Draft-18 §10.2.10 EXPIRES (ms) advertised on the REQUEST_OK reply we
   * emit when a subscriber lands on this track. `0` means "no expiration",
   * `undefined` omits the parameter.
   */
  expires?: number;
}

/**
 * Metadata for sending objects
 */
export interface ObjectMetadata {
  /** Group ID */
  groupId: number;
  /** Object ID within the group */
  objectId: number;
  /** Signals the start of a new group (closes previous group's stream, opens new one) */
  newGroup?: boolean;
  /** Whether this object is a keyframe */
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
 * Result of a draft-18 §10.14 TRACK_STATUS query.
 *
 * `latestGroup` / `latestObject` come from the peer's LARGEST_OBJECT parameter
 * (§10.2.9). Both are `undefined` when the peer has not produced any objects
 * yet (or has chosen to omit the parameter). `expiresMs` is the optional
 * EXPIRES parameter (§10.2.10).
 */
export interface TrackStatusResult {
  requestId: number;
  expiresMs?: number;
  latestGroup?: bigint;
  latestObject?: bigint;
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
 * Track properties advertised by a publisher in SUBSCRIBE_OK / PUBLISH /
 * FETCH_OK (draft-18 §12). Keys omitted from the map were not sent.
 */
export interface TrackProperties {
  /** §12.1 — per-subgroup delivery timeout (ms) */
  subgroupDeliveryTimeoutMs?: number;
  /** §12.2 — per-object delivery timeout (ms) */
  objectDeliveryTimeoutMs?: number;
  /** §12.3 — how long a relay may cache an object (ms) */
  maxCacheDurationMs?: number;
  /** §12.4 — default publisher priority when object omits its own */
  defaultPublisherPriority?: number;
  /** §12.5 — default publisher group order */
  defaultPublisherGroupOrder?: GroupOrder;
  /** §12.6 — dynamic-groups flag (false = static, true = dynamic) */
  dynamicGroups?: boolean;
  /** §12.7 — immutable-properties bitmap (raw varint) */
  immutablePropertiesBitmap?: bigint;
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
  /** Draft-18 track properties (§12) — undefined on draft-16 sessions */
  trackProperties?: TrackProperties;
}

/**
 * Draft-18 PUBLISH_DONE event (§10.11). Fired on the subscriber side
 * when the publisher signals no more objects will arrive on a subscribed
 * track. Includes the final location and optional status/reason phrase
 * from `PublishDoneErrorCodeDraft18`.
 */
export interface PublishDoneEvent {
  /** Request ID the publisher was serving */
  requestId: number;
  /** Local subscription ID if we still know it */
  subscriptionId?: number;
  /** §10.11 final Location — last group/object the publisher intends to emit */
  finalGroupId: number;
  finalObjectId: number;
  /** Optional `PublishDoneErrorCodeDraft18` status */
  statusCode?: number;
  /** Optional human-readable reason */
  reasonPhrase?: string;
  /** Number of subgroup/fetch streams the publisher opened for this request */
  streamCount?: number;
}

/**
 * Draft-18 PUBLISH_BLOCKED event (§10.20). Fired when the publisher
 * cannot continue delivery due to flow control. Consumers can use this
 * to slow down producers or drop non-critical objects.
 */
export interface PublishBlockedEvent {
  /** Track alias that is blocked */
  trackAlias: bigint;
}

/**
 * Draft-18 §8 delivery-timeout event. Fired when a subscriber-side or
 * publisher-side delivery deadline elapses. The peer receives a
 * `DELIVERY_TIMEOUT` (§15.10.4) stream reset; consumers can use this
 * event to surface the drop in the UI or reset an application decoder.
 */
export interface DeliveryTimeoutEvent {
  /** Which side of the pipeline observed the timeout. */
  side: 'subscriber' | 'publisher';
  /** Which class of deadline expired. */
  reason: 'subgroup' | 'object' | 'fill' | 'rendezvous';
  /** §15.10.4 stream reset code conveyed to the peer. */
  resetCode: number;
  /** Track alias whose stream was affected. */
  trackAlias?: bigint;
  /** Subscription that owned the subgroup (subscriber-side only). */
  subscriptionId?: number;
  /** Group / subgroup / object that missed its deadline. */
  groupId?: number;
  subgroupId?: number;
  objectId?: number;
}

/**
 * Draft-18 §10.2.13 NEW_GROUP_REQUEST — fired on the publisher side when the
 * subscriber's REQUEST_UPDATE carries NEW_GROUP_REQUEST. The app is expected
 * to decide whether to cut a fresh group (typically by publishing a keyframe
 * with `metadata.newGroup: true`). `value` is the raw varint payload — non-zero
 * means "please cut a new group"; some peers use it as a monotonic counter.
 */
export interface NewGroupRequestEvent {
  /** Request ID of the subscription being updated. */
  requestId: number;
  /** Raw §10.2.13 parameter value (varint). Non-zero = request active. */
  value: number;
  /** Whether forward=1 accompanied the request (resume + new group is common). */
  forwardState: boolean;
}

/**
 * Draft-18 §11.4.3 subgroup-stream reset event. Fired when a subgroup stream
 * is torn down abnormally — either locally (publisher aborts its writer via
 * `session.resetPublicationStream`) or remotely (peer's RESET_STREAM surfaces
 * as a WebTransportError with `streamErrorCode` on the subscriber's reader).
 * §8 delivery-timeout resets are surfaced through `delivery-timeout` instead
 * so consumers can distinguish deadline-driven from application-driven drops.
 */
export interface StreamResetEvent {
  /** Which side of the pipeline observed the reset. */
  side: 'publisher' | 'subscriber';
  /** §15.10.4 stream-reset code (StreamResetErrorCodeDraft18 numeric value). */
  code: number;
  /** Human-readable reason string, when available. */
  reason?: string;
  /** Track alias whose stream was affected. */
  trackAlias?: bigint;
  /** Subscription that owned the stream (subscriber-side only). */
  subscriptionId?: number;
  /** Group / subgroup identifiers, when known at reset time. */
  groupId?: number;
  subgroupId?: number;
}

/**
 * Draft-18 REQUEST_OK event - emitted for every accepted request that
 * responds with REQUEST_OK (PUBLISH, PUBLISH_NAMESPACE, FETCH,
 * SUBSCRIBE_NAMESPACE, TRACK_STATUS). `expires` is the optional §10.2.10
 * lifetime hint in milliseconds; 0 means "no expiration" and undefined
 * means the responder did not send the parameter.
 */
export interface RequestOkEvent {
  /** Request ID from the request stream */
  requestId: number;
  /**
   * Kind of request that was accepted, so consumers can filter without
   * having to correlate requestId ↔ request kind themselves.
   */
  requestKind: 'publish' | 'publish-namespace' | 'fetch' | 'subscribe-namespace' | 'track-status';
  /**
   * §10.2.10 EXPIRES parameter (ms). Undefined when the responder omitted
   * the parameter, 0 when the responder explicitly signals no expiration.
   */
  expiresMs?: number;
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
  /**
   * Draft-18 §10.2.10 EXPIRES (ms) — advertised on outbound REQUEST_OK /
   * SUBSCRIBE_OK when a subscriber lands on a track we announced. `0` means
   * "no expiration"; `undefined` omits the parameter entirely.
   */
  expires?: number;
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
  /**
   * Draft-18 §10.2.10 EXPIRES (ms) advertised on the REQUEST_OK we send when
   * accepting an incoming PUBLISH under this namespace. `0` = no expiration,
   * `undefined` omits the parameter.
   */
  expires?: number;
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
  /** §10.2.10 EXPIRES (ms) to advertise on REQUEST_OK for incoming PUBLISH matches. */
  expires?: number;
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
 * Fired when the peer sends a NAMESPACE message on a SUBSCRIBE_NAMESPACE
 * response stream (draft-18 §7.4). The peer is announcing that `namespace`
 * matches the prefix we subscribed to; individual tracks under it still need
 * to be resolved via SUBSCRIBE (or arrive as PUBLISH bidi streams).
 */
export interface NamespaceAnnouncedEvent {
  namespaceSubscriptionId: number;
  namespace: string[];
}

/**
 * Fired when the peer sends NAMESPACE_DONE, signalling that the previously
 * announced namespace is no longer available under the subscribed prefix.
 */
export interface NamespaceDoneEvent {
  namespaceSubscriptionId: number;
  namespace: string[];
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
  /**
   * Draft-18 §10.12: FETCH type discriminator.
   *
   * - STANDALONE (0x1): default; fetch a range within a namespace/trackName
   * - JOINING_RELATIVE (0x2): join an existing subscription; groups relative to current
   * - JOINING_ABSOLUTE (0x3): join an existing subscription; groups absolute
   *
   * For joining fetches, `subscribeRequestId` MUST be provided and identifies
   * the target subscription. `joiningStart` is the group offset (relative) or
   * group id (absolute). namespace/trackName/range are ignored on the wire.
   */
  fetchType?: FetchTypeDraft18;
  /** Draft-18 joining fetch: target subscribe request id */
  subscribeRequestId?: bigint;
  /** Draft-18 joining fetch: group offset (relative) or group id (absolute) */
  joiningStart?: bigint;
  /**
   * Draft-18 §10.2 subscriber-side delivery timeouts (ms). See
   * [[SubscribeOptions]] for semantics; ignored for draft-16.
   */
  subgroupDeliveryTimeout?: number;
  objectDeliveryTimeout?: number;
  fillTimeout?: number;
  rendezvousTimeout?: number;
  /** Per-request authorization token (draft-18 §10.2.2). */
  authToken?: RequestAuthToken;
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
 * Event fired when FETCH data stream completes (all objects received)
 * This fires after all data has been received, unlike fetch-complete which
 * fires on FETCH_OK (before data arrives).
 */
export interface FetchStreamCompleteEvent {
  /** Fetch request ID */
  requestId: number;
  /** Last group ID received on this stream */
  lastGroupId: number;
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
  /**
   * Fetch-only mode: if true, don't auto-stream via SUBSCRIBE.
   * Content will only be delivered in response to FETCH requests.
   * This provides smoother VOD playback as subscriber controls pacing.
   * Default: false (auto-stream enabled for backward compatibility)
   */
  fetchOnly?: boolean;
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

// ============================================================================
// Forward State Types
// ============================================================================

/**
 * Event fired when forward state changes for a publication
 *
 * Forward state indicates whether subscribers exist:
 * - forward=0: No subscribers, should pause sending
 * - forward=1: Subscribers exist, can send objects
 *
 * This is used for both live/interactive and VOD flows:
 * - Live: Pause/resume capture devices
 * - VOD: Pause/resume auto-streaming with position tracking
 */
export interface ForwardStateChangeEvent {
  /** Track alias */
  trackAlias: bigint;
  /** New forward state (0 = paused/no subscribers, 1 = active/can send) */
  forward: number;
}

/**
 * Draft-18 REQUEST_UPDATE variants (§10.9). REQUEST_UPDATE reuses the same
 * wire format for both subscription-scoped (§10.9.1) and namespace-scoped
 * (§10.9.2) updates; the variant is determined by looking up the target
 * requestId's original request kind.
 */
export type RequestUpdateVariant =
  | 'subscribe'
  | 'subscribe-namespace'
  | 'publish'
  | 'publish-namespace'
  | 'fetch'
  | 'unknown';

/**
 * Fired when the peer sends REQUEST_UPDATE targeting a namespace subscription
 * (§10.9.2). Consumers can pause/resume forwarding for a whole namespace
 * subscription rather than a single track.
 */
export interface NamespaceForwardEvent {
  /** Request ID of the original SUBSCRIBE_NAMESPACE (§10.9.2) */
  namespaceRequestId: number;
}
