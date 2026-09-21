// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Generic MOQT Session (Draft 14/16)
 *
 * Protocol-level MOQT session implementation without media-specific dependencies.
 * Handles session setup, subscribing, publishing, and object routing.
 *
 * Supports two modes:
 * - Main thread: Pass a MOQTransport instance (existing behavior)
 * - Worker mode: Pass a config with worker for off-main-thread transport
 *
 * Draft-16 changes:
 * - Request IDs: Client uses even (0, 2, 4, ...), server uses odd (1, 3, 5, ...)
 * - Version negotiation via ALPN (no version list in CLIENT_SETUP)
 */

import {
  MOQTransport,
  MessageCodec,
  MessageType,
  MessageTypeDraft18,
  Version,
  GroupOrder,
  FetchTypeDraft18,
  FilterType,
  ObjectStatus,
  RequestParameter,
  RequestParameterDraft18,
  RequestErrorCode,
  RequestErrorCodeDraft18,
  PublishDoneErrorCodeDraft18,
  SessionErrorCodeDraft18,
  StreamResetErrorCodeDraft18,
  normalizeSessionErrorCode,
  StreamTypeDraft18,
  DatagramTypeDraft18,
  TrackPropertyDraft18,
  MOQTVarInt,
  SetupParameter,
  SubscriptionFilterDraft18,
  ObjectExtension,
  BufferWriter,
  Logger,
  ConnectionStateMachine,
  type ConnectionState,
  InMemoryMetricsSink,
  type MetricsSink,
  alpnProtocolFor,
  DEFAULT_DRAFT,
  versionEnumFor,
  getProtocolCodecForVersion,
  type DraftVersion,
  DataStreamType,
  type ClientSetupMessage,
  type ServerSetupMessage,
  type ClientSetupMessageDraft18,
  type ServerSetupMessageDraft18,
  type PublishMessage,
  type PublishMessageDraft18,
  type PublishOkMessage,
  type PublishErrorMessage,
  type SubscribeMessage,
  type SubscribeMessageDraft18,
  type SubscribeOkMessage,
  type SubscribeErrorMessage,
  type SubscribeUpdateMessage,
  type SubscribeOkMessageDraft18,
  type RequestErrorMessageDraft18,
  type RequestOkMessageDraft18,
  type RequestUpdateMessageDraft18,
  type FetchMessageDraft18,
  type FetchOkMessageDraft18 as _FetchOkMessageDraft18,
  type GoAwayMessageDraft18,
  type TrackStatusMessageDraft18,
  type PublishDoneMessageDraft18,
  type PublishNamespaceMessageDraft18,
  type SubscribeNamespaceMessageDraft18,
  type SubscribeTracksMessageDraft18,
  type PublishBlockedMessageDraft18,
  type NamespaceMessageDraft18,
  type NamespaceDoneMessageDraft18,
  type PublishNamespaceMessage,
  type PublishNamespaceOkMessage,
  type SubscribeNamespaceOkMessage,
  type SubscribeNamespaceErrorMessage,
  type PublishDoneMessage,
  type MOQTMessage,
  type ControlMessage,
  type ControlMessageDraft18,
  type Location,
  type ObjectHeader,
  type IProtocolCodec,
  type FetchMessage,
  type FetchOkMessage,
  type FetchErrorMessage,
  type FetchCancelMessage,
  type TrackStatusMessage,
  type TrackStatusOkMessage,
  type TrackStatusErrorMessage,
} from '@moq-web/core';
import { base64urlDecode, coseSign1Encode, C4M_TOKEN_TYPE } from '@moq-web/cat';
import { SubscriptionManager, type InternalSubscription } from './subscription-manager.js';
import { PublicationManager, type InternalPublication } from './publication-manager.js';
import { ObjectRouter } from './object-router.js';
import { DeliveryTimeoutTracker, type DeliveryTimeoutReason } from './delivery-timeout.js';
import { TransportWorkerClient } from './workers/index.js';
import {
  JitteredExponentialBackoff,
  type ReconnectPolicy,
} from './reconnect-policy.js';
import { parseTrackProperties } from './track-properties.js';
import { parseSubscriberSchedulingParams, computeSendOrder } from './priority.js';
import type {
  SessionState,
  SessionEventType,
  SubscribeOptions,
  PublishOptions,
  AnnounceOptions,
  ObjectMetadata,
  ReceivedObjectEvent,
  PublishStatsEvent,
  SubscribeStatsEvent,
  SubscribeOkEvent,
  SubscribeErrorEvent,
  NamespaceErrorEvent,
  RequestOkEvent,
  PublishDoneEvent,
  PublishBlockedEvent,
  DeliveryTimeoutEvent,
  StreamResetEvent,
  NewGroupRequestEvent,
  MessageLogEvent,
  SubscriptionInfo,
  PublicationInfo,
  AnnouncedNamespaceInfo,
  IncomingSubscriber,
  IncomingSubscribeEvent,
  SubscribeNamespaceOptions,
  NamespaceSubscriptionInfo,
  IncomingPublishInfo,
  IncomingPublishEvent,
  NamespaceAnnouncedEvent,
  NamespaceDoneEvent,
  RequestAuthToken,
  FetchOptions,
  FetchRange,
  FetchInfo,
  FetchObjectEvent,
  FetchCompleteEvent,
  FetchStreamCompleteEvent,
  FetchErrorEvent,
  VODPublishOptions,
  VODTrackInfo,
  IncomingFetchEvent,
  ForwardStateChangeEvent,
  NamespaceForwardEvent,
  RequestUpdateVariant,
  SessionTerminatedEvent,
  SessionMigrationEvent,
  TrackStatusResult,
} from './types.js';

const log = Logger.create('moqt:session');

/**
 * Wave 2 Track F: narrow a wire 62-bit varint (bigint) down to `number` where
 * downstream state deliberately uses `number` (e.g. FetchRange, object plane
 * group/object arithmetic). Throws if the value exceeds `2^53-1`; callers must
 * be sites where the media pipeline arithmetic cannot handle bigint.
 */
function narrowBigIntToNumber(value: bigint, field: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(
      `${field}=${value.toString()} exceeds Number.MAX_SAFE_INTEGER; ` +
      `session cannot represent this value in the bounded-number plane.`
    );
  }
  return Number(value);
}

/**
 * Draft-18 §10.2 subscriber-side delivery timeouts on SUBSCRIBE/FETCH.
 * Each is an even-key MOQT varint; a value of 0 or undefined omits it.
 */
function addDeliveryTimeoutParams(
  parameters: Map<number, Uint8Array>,
  options?: {
    subgroupDeliveryTimeout?: number;
    objectDeliveryTimeout?: number;
    fillTimeout?: number;
    rendezvousTimeout?: number;
  },
): void {
  if (!options) return;
  const set = (key: number, ms: number | undefined) => {
    if (!ms || ms <= 0) return;
    parameters.set(key, MOQTVarInt.encode(BigInt(ms)));
  };
  set(RequestParameterDraft18.SUBGROUP_DELIVERY_TIMEOUT, options.subgroupDeliveryTimeout);
  set(RequestParameterDraft18.OBJECT_DELIVERY_TIMEOUT, options.objectDeliveryTimeout);
  set(RequestParameterDraft18.FILL_TIMEOUT, options.fillTimeout);
  set(RequestParameterDraft18.RENDEZVOUS_TIMEOUT, options.rendezvousTimeout);
}

/**
 * Draft-18 §10.2.9 SUBSCRIPTION_FILTER mapping.
 *
 * Translates the string-form `SubscribeOptions.filterType` (plus its start/end
 * hints) into a `SubscriptionFilterDraft18` variant with the ranges the
 * SUBSCRIBE codec expects. Unknown / omitted values default to
 * `NEXT_GROUP_START`, matching draft-18's default filter and the pre-change
 * session behaviour.
 *
 * `endGroup` is captured in `SubscribeOptions` as an absolute group ID and
 * translated to `endGroupDelta` here — the delta is how the wire carries the
 * range terminator (draft-18 §10.2.9).
 */
function mapSubscribeFilter(options: {
  filterType?: 'latest' | 'absolute' | 'next-group' | 'largest-object' | 'absolute-start' | 'absolute-range';
  startGroup?: number;
  startObject?: number;
  endGroup?: number;
} | undefined): {
  filter: SubscriptionFilterDraft18;
  startLocation?: Location;
  endGroupDelta?: bigint;
} {
  const startGroup = BigInt(options?.startGroup ?? 0);
  const startObject = BigInt(options?.startObject ?? 0);
  const kind = options?.filterType;

  switch (kind) {
    case 'largest-object':
      return { filter: SubscriptionFilterDraft18.LARGEST_OBJECT };
    case 'absolute':
    case 'absolute-start':
      return {
        filter: SubscriptionFilterDraft18.ABSOLUTE_START,
        startLocation: { group: startGroup, object: startObject },
      };
    case 'absolute-range': {
      const endGroup = BigInt(options?.endGroup ?? options?.startGroup ?? 0);
      const delta = endGroup >= startGroup ? endGroup - startGroup : 0n;
      return {
        filter: SubscriptionFilterDraft18.ABSOLUTE_RANGE,
        startLocation: { group: startGroup, object: startObject },
        endGroupDelta: delta,
      };
    }
    case 'latest':
    case 'next-group':
    case undefined:
    default:
      return { filter: SubscriptionFilterDraft18.NEXT_GROUP_START };
  }
}

/**
 * Draft-18 §3.2.1 — a Track Namespace whose first tuple field begins with
 * '.' (0x2e) is reserved. The single-period namespace (`["."]`) is a hard
 * reject; other reserved namespaces are pass-through to the application but
 * MUST NOT be originated by this endpoint without an IANA-registered
 * definition, so this client refuses to send outbound requests under any of
 * them by default.
 *
 * Throws if `namespace` (or namespace prefix) starts with a '.'-prefixed
 * field. Called from every outbound namespace-bearing API.
 */
function assertNotReservedNamespace(namespace: string[], action: string): void {
  const first = namespace[0];
  if (first === undefined || first.length === 0 || first.charCodeAt(0) !== 0x2e) return;
  throw new Error(
    `Draft-18 §3.2.1: refusing to ${action} under reserved namespace ` +
      `starting with '.': ${JSON.stringify(namespace)}`,
  );
}

/**
 * Draft-18 §10.2.14 TRACK_NAMESPACE_PREFIX serializer.
 *
 * Encodes a namespace tuple `["a","b"]` the same way the wire codec does —
 * varint tuple-length, then each element as a length-prefixed UTF-8 string —
 * so a peer that decodes the parameter value can reconstruct the tuple.
 */
function encodeTrackNamespaceBytes(namespace: string[]): Uint8Array {
  const writer = new BufferWriter();
  writer.writeVarInt(BigInt(namespace.length));
  const encoder = new TextEncoder();
  for (const field of namespace) {
    const bytes = encoder.encode(field);
    writer.writeVarInt(BigInt(bytes.length));
    writer.writeBytes(bytes);
  }
  return writer.toUint8Array();
}

/**
 * Draft-18 §10.2.14 TRACK_NAMESPACE_PREFIX parser — inverse of
 * `encodeTrackNamespaceBytes()`. Returns the decoded tuple or `undefined`
 * if the bytes cannot be parsed (malformed parameter is best-effort ignored).
 */
function decodeTrackNamespaceBytes(bytes: Uint8Array): string[] | undefined {
  try {
    const [count, offset0] = MOQTVarInt.decode(bytes);
    let offset = offset0;
    const out: string[] = [];
    const decoder = new TextDecoder();
    for (let i = 0; i < Number(count); i++) {
      const [len, next] = MOQTVarInt.decode(bytes.subarray(offset));
      offset += next;
      const l = Number(len);
      out.push(decoder.decode(bytes.subarray(offset, offset + l)));
      offset += l;
    }
    return out;
  } catch {
    return undefined;
  }
}

/**
 * Draft-18 §12 publisher-side track properties advertised on PUBLISH.
 * Each key is an even-key MOQT varint; 0/undefined omits it.
 */
function buildTrackProperties(options?: {
  subgroupDeliveryTimeout?: number;
  objectDeliveryTimeout?: number;
  maxCacheDuration?: number;
  priority?: number;
  groupOrder?: number;
  priorGroupIdGap?: number;
  priorObjectIdGap?: number;
}): Map<number, Uint8Array> | undefined {
  if (!options) return undefined;
  const props = new Map<number, Uint8Array>();
  const setMs = (key: number, ms: number | undefined) => {
    if (!ms || ms <= 0) return;
    props.set(key, MOQTVarInt.encode(BigInt(ms)));
  };
  const setNonNegative = (key: number, n: number | undefined) => {
    if (n === undefined || n < 0) return;
    props.set(key, MOQTVarInt.encode(BigInt(Math.floor(n))));
  };
  setMs(TrackPropertyDraft18.SUBGROUP_DELIVERY_TIMEOUT, options.subgroupDeliveryTimeout);
  setMs(TrackPropertyDraft18.OBJECT_DELIVERY_TIMEOUT, options.objectDeliveryTimeout);
  setMs(TrackPropertyDraft18.MAX_CACHE_DURATION, options.maxCacheDuration);
  if (options.priority !== undefined) {
    props.set(TrackPropertyDraft18.DEFAULT_PUBLISHER_PRIORITY, MOQTVarInt.encode(BigInt(options.priority)));
  }
  if (options.groupOrder !== undefined) {
    props.set(TrackPropertyDraft18.DEFAULT_PUBLISHER_GROUP_ORDER, MOQTVarInt.encode(BigInt(options.groupOrder)));
  }
  setNonNegative(TrackPropertyDraft18.PRIOR_GROUP_ID_GAP, options.priorGroupIdGap);
  setNonNegative(TrackPropertyDraft18.PRIOR_OBJECT_ID_GAP, options.priorObjectIdGap);
  return props.size > 0 ? props : undefined;
}

/**
 * Long-lived per-request bidi stream (draft-18 §3.3, §10.9).
 *
 * Each MOQT request (SUBSCRIBE, PUBLISH, FETCH, TRACK_STATUS, SUBSCRIBE_TRACKS,
 * PUBLISH_NAMESPACE, SUBSCRIBE_NAMESPACE, ...) travels on its own bidirectional
 * stream. The initiating peer sends the request as the first message; the
 * responder replies with REQUEST_OK/REQUEST_ERROR (or the request-specific
 * response). Follow-up REQUEST_UPDATE messages MUST be sent on the same stream
 * (§10.9), so the writer stays open for the lifetime of the request.
 */
class Draft18RequestStream {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly writeFn: (data: Uint8Array, closeAfter?: boolean) => void | Promise<void>;
  private readonly closeFn: () => void | Promise<void>;
  private readonly codec: IProtocolCodec;
  private pending: Uint8Array = new Uint8Array(0);
  private eof = false;

  constructor(
    codec: IProtocolCodec,
    readable: ReadableStream<Uint8Array>,
    writeFn: (data: Uint8Array, closeAfter?: boolean) => void | Promise<void>,
    closeFn: () => void | Promise<void>,
  ) {
    this.codec = codec;
    this.reader = readable.getReader();
    this.writeFn = writeFn;
    this.closeFn = closeFn;
  }

  async write(data: Uint8Array): Promise<void> {
    await this.writeFn(data, false);
  }

  /**
   * Read the next complete control message from this stream. Buffers any
   * bytes that arrive after the message so subsequent reads see them.
   */
  async readMessage(): Promise<ControlMessageDraft18> {
    for (;;) {
      // Try decoding what we already buffered first.
      if (this.pending.length > 0) {
        try {
          const [message, bytesRead] = this.codec.decodeControlMessage(this.pending);
          this.pending = this.pending.subarray(bytesRead);
          return message as ControlMessageDraft18;
        } catch (err) {
          const msg = (err as Error).message ?? '';
          if (!msg.includes('Incomplete') && !msg.includes('buffer')) {
            throw err;
          }
          // fall through and read more
        }
      }

      if (this.eof) {
        throw new Error('Request stream closed before a full control message was received');
      }

      const { value, done } = await this.reader.read();
      if (done) {
        this.eof = true;
        continue;
      }
      if (value && value.length > 0) {
        if (this.pending.length === 0) {
          this.pending = value;
        } else {
          const merged = new Uint8Array(this.pending.length + value.length);
          merged.set(this.pending, 0);
          merged.set(value, this.pending.length);
          this.pending = merged;
        }
      }
    }
  }

  async close(): Promise<void> {
    try { this.reader.releaseLock(); } catch { /* ignore */ }
    try { await this.closeFn(); } catch { /* ignore */ }
  }
}

/**
 * Configuration for MOQTSession when using worker mode
 */
export interface MOQTSessionConfig {
  /** Worker instance for transport operations */
  worker: Worker;
  /**
   * MOQT draft version this session will speak. Defaults to
   * `DEFAULT_DRAFT` (draft-16 unless overridden at build time). Pass
   * explicitly whenever your relay fleet mixes drafts.
   */
  draft?: DraftVersion;
  /** Server certificate hashes for self-signed certs */
  serverCertificateHashes?: ArrayBuffer[];
  /** Connection timeout in ms */
  connectionTimeout?: number;
  /** Maximum datagram size in bytes (default: 1200) */
  maxDatagramSize?: number;
  /** Enable debug logging in worker */
  debug?: boolean;
  /**
   * When true, and the peer sends GOAWAY with a non-empty `newSessionUri`
   * (draft-18 §3.6), the session will automatically close the current
   * transport and reconnect to that URI, replaying CLIENT_SETUP with the
   * same auth token. Only applicable to worker mode where the session owns
   * the transport lifecycle. Defaults to false.
   */
  autoMigrate?: boolean;
  /**
   * Optional metrics sink. When omitted the session uses an
   * `InMemoryMetricsSink` so `getDiagnostics()` still returns useful
   * counter totals. Pass `NoopMetricsSink` to disable metrics entirely, or
   * pass a custom implementation to forward to OpenTelemetry / Prometheus
   * / etc.
   */
  metrics?: MetricsSink;
  /**
   * Optional {@link ReconnectPolicy} used by the auto-migrate loop when
   * `autoMigrate` is enabled. When omitted the session constructs a
   * `JitteredExponentialBackoff` (500ms base, 2× growth, 30s cap, ±25%
   * jitter, 8 attempts). Callers can inject a deterministic policy for
   * tests or a tuned policy for edge deployments.
   */
  reconnectPolicy?: ReconnectPolicy;
  /**
   * Optional pre-assigned session ID. If omitted the session generates a
   * random 16-hex-char identifier at construct time. Useful for propagating
   * a request-scoped correlation ID from an outer application.
   */
  sessionId?: string;
}

/**
 * Snapshot returned by `session.getDiagnostics()`. Intentionally
 * JSON-serializable so consumers can post it to a debug endpoint or dump it
 * into a bug report without further coercion.
 */
export interface SessionDiagnostics {
  /** Per-instance identifier assigned at construct time. */
  sessionId: string;
  /** Coarse-grained session state (`none`, `setup`, `ready`, ...). */
  state: SessionState;
  /**
   * `ConnectionStateMachine` state, updated in lockstep with `state`. Split
   * out because the state machine tracks a slightly different vocabulary
   * (`connecting`, `setup_sent`, `connected`, ...).
   */
  connectionState: ConnectionState;
  /** Milliseconds since the session was constructed. */
  uptimeMs: number;
  /**
   * Number of successful `migrate()` invocations (proxy for reconnects
   * until Track B wires the shared `ReconnectPolicy`).
   */
  reconnectAttempts: number;
  /** Counter totals from the `MetricsSink` (empty when a Noop sink is in use). */
  metrics: Record<string, number>;
  /**
   * Reason string from the most recent session close, if any. Cleared on
   * successful migration/reconnect.
   */
  lastCloseReason?: string;
  /**
   * Numeric session termination code from the most recent peer close
   * (undefined for local closes).
   */
  lastCloseCode?: number;
  /** URL currently connected to (worker mode only). */
  currentUrl?: string;
  /** URI cached from the most recent GOAWAY, if not yet migrated. */
  pendingMigrationUri?: string;
}

/**
 * Generic MOQT Session
 *
 * Provides protocol-level MOQT operations without media pipeline dependencies.
 * Use this directly for non-media use cases, or wrap with MediaSession for
 * media streaming.
 *
 * Supports two modes:
 * - Main thread: Pass a MOQTransport instance
 * - Worker mode: Pass a config with worker for off-main-thread transport
 *
 * @example
 * ```typescript
 * // Main thread mode (existing behavior)
 * const transport = new MOQTransport();
 * await transport.connect('https://relay.example.com/moq');
 * const session = new MOQTSession(transport);
 *
 * // Worker mode (new)
 * const worker = new Worker(new URL('@moq-web/session/worker', import.meta.url));
 * const session = new MOQTSession({ worker });
 * await session.connect('https://relay.example.com/moq');
 * ```
 */
export class MOQTSession {
  /** Underlying transport (main thread mode) */
  private transport?: MOQTransport;
  /** Transport worker client (worker mode) */
  private transportWorker?: TransportWorkerClient;
  /** Worker mode config */
  private workerConfig?: MOQTSessionConfig;
  /** Whether using worker mode */
  private readonly useWorker: boolean;
  /**
   * Per-instance identifier. Bound to every logger created from
   * `this.sessionLog`, propagated to metrics attributes, and surfaced via
   * `getDiagnostics()`. Generated at construct time when the caller did not
   * pass one via `MOQTSessionConfig`.
   */
  readonly sessionId: string;
  /**
   * Session-scoped logger with `sessionId` bound. Prefer this over the
   * module-level `log` inside new code paths so operators can correlate
   * multi-session workloads via a single field.
   */
  private readonly sessionLog: Logger;
  /**
   * §15.10.1 connection state machine, kept in lockstep with `_state`. Every
   * transition to a new session state routes through this so illegal state
   * transitions are caught centrally and counted via
   * `moq.session.illegal_state_transition`.
   */
  private readonly stateMachine = new ConnectionStateMachine();
  /**
   * Metrics sink. Defaults to `InMemoryMetricsSink` so
   * `getDiagnostics().metrics` remains useful without external wiring.
   * Consumers pass `metrics: new NoopMetricsSink()` to disable.
   */
  private readonly metrics: MetricsSink;
  /**
   * Reconnect policy consumed by {@link autoMigrateWithBackoff}. Optional;
   * when unset the auto-migrate loop constructs a
   * `JitteredExponentialBackoff` with the historical defaults (500 ms base,
   * 2× growth, 30 s cap, ±25 % jitter, 8 attempts). Wave 2 Track E.
   */
  private readonly _reconnectPolicy?: ReconnectPolicy;
  /** `performance.now()` (or `Date.now()`) at construction, for uptimeMs. */
  private readonly _createdAtMs: number;
  /** Number of times `migrate()` completed a full close+setup cycle. */
  private _reconnectAttempts = 0;
  /** Reason phrase from the most recent close (peer or local). */
  private _lastCloseReason?: string;
  /** Session termination code from the most recent peer close. */
  private _lastCloseCode?: number;
  /** Current session state */
  private _state: SessionState = 'none';
  /** Event handlers */
  private handlers = new Map<SessionEventType, Set<(data: unknown) => void>>();
  /** Subscription manager */
  private subscriptionManager = new SubscriptionManager();
  /** Publication manager */
  private publicationManager = new PublicationManager();
  /** Object router */
  private objectRouter: ObjectRouter;
  /**
   * §8 publisher-side delivery-timeout tracker. Arms per-subgroup deadlines
   * when a stream opens (via `sendObjectViaStream` / `sendObjectWithGOP`);
   * on expiry the stream is aborted with §15.10.4 DELIVERY_TIMEOUT and the
   * session emits a `delivery-timeout` event.
   */
  private publisherDeliveryTimeouts = new DeliveryTimeoutTracker((key, reason, resetCode) => {
    this.handlePublisherTimeoutExpiry(key, reason, resetCode);
  });
  /**
   * Per-alias delivery-timeout config captured at publish() time so
   * `sendObjectViaStream` / `sendObjectWithGOP` know when to arm timers.
   */
  private publisherTimeoutConfig = new Map<string, { subgroupDeliveryTimeoutMs?: number }>();
  /** Transport event cleanup handlers */
  private transportCleanup: Array<() => void> = [];

  /**
   * Draft-18 §13.6.1 idle-connection state.
   *
   * §13.6.1 defers idle handling to the underlying QUIC transport, but a
   * client "with long-lived subscriptions might want to send periodic PING
   * frames to keep the QUIC connection alive". WebTransport doesn't expose
   * PING, so we approximate it by sending a §11.5 padding datagram, and we
   * offer a mirror-image application-idle timer that closes the session
   * with §15.10.3 CONTROL_MESSAGE_TIMEOUT if neither side has spoken for
   * `idleTimeoutMs`.
   *
   * Both cadences are opt-in via `configureIdle()`. When disabled the
   * whole subsystem is dormant (no interval timer running).
   */
  private idleConfig: { idleTimeoutMs?: number; keepaliveIntervalMs?: number } = {};
  /** Monotonic ms of the last outbound send (control or datagram). */
  private lastOutboundActivityMs = 0;
  /** Monotonic ms of the last inbound frame (control or datagram). */
  private lastInboundActivityMs = 0;
  /** Interval handle for the idle/keepalive tick. */
  private idleTimer?: ReturnType<typeof setInterval>;
  /** Test-only hook so unit tests can observe the idle-close path. */
  private idleClosePending = false;
  /** Message buffer for incomplete control messages */
  private controlBuffer = new Uint8Array(0);
  /** Offset into controlBuffer where unprocessed data starts */
  private controlBufferOffset = 0;
  /**
   * MOQT draft version this session is speaking. Derived from the passed
   * transport (main-thread mode) or explicitly from config (worker mode);
   * falls back to `DEFAULT_DRAFT`.
   */
  private readonly _draft: DraftVersion;
  /**
   * Next request ID for subscribing/publishing
   * Draft-14: Start at 1, increment by 1
   * Draft-16+: Clients use even IDs (0, 2, 4, ...), servers use odd (1, 3, 5, ...)
   */
  private nextRequestId: number;
  /** Protocol codec for version-specific encoding/decoding */
  private readonly codec: IProtocolCodec;
  /** Temporary message handler for setup */
  private onMessage?: (message: MOQTMessage) => void;
  /** Active video GOP streams by track alias (for GOP batching) */
  private activeVideoStreams = new Map<string, {
    writer?: WritableStreamDefaultWriter<Uint8Array>;
    streamId?: number;
    groupId: number;
    objectCount: number;
    previousObjectId: number; // For delta encoding in draft-16
    hasExtensions: boolean; // Whether subgroup header has extensions bit set
    maxCacheDuration?: number; // Max cache duration in ms (from first keyframe)
  }>();
  /** Announced namespaces (for announce flow) */
  private announcedNamespaces = new Map<string, AnnouncedNamespaceInfo>();
  /** Request ID to namespace mapping (for draft-16 PUBLISH_NAMESPACE_OK) */
  private announceRequestIdToNamespace = new Map<bigint, string>();
  /** Next track alias for incoming subscriptions (announce flow) */
  private nextIncomingTrackAlias = BigInt(1000);
  /**
   * Draft-18 §10.9: map from a peer-initiated requestId to the kind of request
   * we accepted, so we can route a later REQUEST_UPDATE on the same request to
   * the correct variant (§10.9.1 subscription vs §10.9.2 namespace-scoped).
   * Populated when we send REQUEST_OK / SUBSCRIBE_OK on the incoming bidi
   * stream; drained when the request ends (unsubscribe, PUBLISH_DONE, etc.).
   */
  /** Peer-supplied request IDs are 62-bit varints; key by bigint to preserve precision. */
  private incomingRequestKinds = new Map<bigint, RequestUpdateVariant>();
  /** Namespace subscriptions (for subscribe namespace flow) */
  private namespaceSubscriptions = new Map<number, NamespaceSubscriptionInfo>();
  /** Request ID to namespace subscription mapping */
  /** Maps 62-bit varint request IDs to locally-generated subscription IDs. */
  private namespaceSubscriptionByRequestId = new Map<bigint, number>();
  /** Stream ID to subscription ID mapping for worker mode bidi streams */
  private namespaceSubscriptionStreams = new Map<number, number>();
  /** Our own namespace prefix for filtering out self-publishes */
  private ownNamespacePrefix: string | null = null;
  /** Authorization token for CLIENT_SETUP */
  private authToken: string | null = null;
  /** Token type for AUTHORIZATION_TOKEN parameter (default: C4M = 0x63346d) */
  private authTokenType: number = C4M_TOKEN_TYPE;
  /**
   * Last URL passed to `connect()` (worker mode) — used as the fallback
   * `oldSessionUri` on migration, and as the target of `migrate()` when no
   * explicit `newSessionUri` is provided.
   */
  private _lastConnectUrl?: string;
  /**
   * Last `newSessionUri` we observed on an incoming GOAWAY. Cached so callers
   * that don't set `autoMigrate` can still call `session.migrate()` with no
   * argument after handling the `goaway` event.
   */
  private _pendingMigrationUri?: string;
  /** True while a §3.6 migration is in-flight; suppresses redundant terminate events. */
  private _migrating = false;
  /**
   * Draft-18 §3.2 extensions to advertise on outgoing CLIENT_SETUP. Callers
   * populate this via `setClientExtensions()` before `setup()`; the map is
   * passed through to the codec verbatim, which enforces key-parity and
   * rejects collisions with reserved SetupOption values.
   */
  private _clientExtensions?: Map<number, import('@moq-web/core').SetupExtensionValue>;
  /**
   * Draft-18 §3.2 extensions the peer advertised in SERVER_SETUP. Populated
   * once by `handleSetupMessage()` after the peer's SETUP is decoded; callers
   * inspect via the `peerExtensions` getter.
   */
  private _peerExtensions?: Map<number, import('@moq-web/core').SetupExtensionValue>;
  /**
   * Draft-18 §13.8: implementation identifier the client advertises in the
   * MOQT_IMPLEMENTATION SetupOption. `undefined` (the default) means we do
   * NOT advertise, per §13.8 which cautions against unconditional
   * fingerprintable identifiers. Callers can opt in with
   * `setImplementationString(...)` before `setup()`.
   */
  private _implementationString?: string;
  // @ts-expect-error Reserved for token alias caching support (aliasType 1/2)
  private tokenAliasCache = new Map<number, { tokenType: number; tokenValue: Uint8Array }>();
  // @ts-expect-error Reserved for token alias caching support
  private nextTokenAlias = 0;
  // @ts-expect-error Reserved for token alias caching support
  private maxAuthTokenCacheSize = 0;

  // ============================================================================
  // B3 SEC: Per-session Resource Limits
  // ============================================================================
  // Bound how much state a single peer can force us to hold. Every entry point
  // that would allocate a new subscription, publication (track), or transport
  // stream first calls `enforceResourceLimit()`. Excess triggers a
  // PROTOCOL_VIOLATION session close via the normal `close({...})` pattern —
  // no new state-machine paths introduced.
  /** Max concurrent subscriptions (client-initiated + peer-initiated). */
  private readonly maxSubscriptions = 4096;
  /** Max concurrent tracks we publish. */
  private readonly maxTracks = 4096;
  /**
   * Max concurrent open transport streams tracked at the session layer
   * (outbound uni streams we opened for object delivery + active per-request
   * bidi streams). Approximates "streams a peer can force us to hold open".
   */
  private readonly maxOpenStreams = 8192;
  /**
   * Running count of streams we've opened via `doCreateStream` that have not
   * yet been observed as closed/aborted. Peer-initiated inbound streams are
   * accepted by the transport layer directly and are subject to the QUIC-level
   * cap (see MAX_STREAMS); we don't double-count them here.
   */
  private openStreamCount = 0;
  /**
   * Latched once a resource cap has fired so we don't try to close twice or
   * report the same violation to the app N times.
   */
  private resourceCapTripped = false;

  // ============================================================================
  // FETCH / DVR State
  // ============================================================================

  /** Active fetch requests (we are the fetcher/subscriber). Keyed by 62-bit varint request ID. */
  private activeFetches = new Map<bigint, FetchInfo>();
  /** Request ID to fetch stream mapping for receiving fetch data. Keyed by 62-bit varint request ID. */
  private fetchStreamBuffers = new Map<bigint, Uint8Array[]>();

  // ============================================================================
  // Track Status State (for live edge tracking)
  // ============================================================================

  /** Pending TRACK_STATUS request callbacks. Keyed by 62-bit varint request ID. */
  private trackStatusCallbacks = new Map<bigint, {
    resolve: (status: TrackStatusOkMessage) => void;
    reject: (error: Error) => void;
  }>();

  // ============================================================================
  // VOD Publishing State
  // ============================================================================

  /** VOD tracks we are publishing */
  private vodTracks = new Map<string, VODTrackInfo>();
  /** Pending fetch responses we need to send (VOD publisher serving fetches). Keyed by 62-bit varint request ID. */
  private pendingFetchResponses = new Map<bigint, {
    trackAlias: bigint;
    range: FetchRange;
    getObject: (groupId: number, objectId: number) => Promise<Uint8Array | null>;
    isKeyframe?: (groupId: number, objectId: number) => boolean;
    objectsPerGroup?: number;
  }>();

  /**
   * Create a new MOQTSession
   *
   * @param transportOrConfig - Either a connected MOQTransport instance or a config with worker
   *
   * @example
   * ```typescript
   * // Main thread mode
   * const session = new MOQTSession(transport);
   *
   * // Worker mode
   * const session = new MOQTSession({ worker: myWorker });
   * ```
   */
  constructor(transportOrConfig: MOQTransport | MOQTSessionConfig) {
    // Assign identifiers, metrics, and observability plumbing first so any
    // downstream initialization can already emit against them.
    const configSessionId =
      transportOrConfig instanceof MOQTransport ? undefined : transportOrConfig.sessionId;
    this.sessionId = configSessionId ?? generateSessionId();
    this.metrics =
      transportOrConfig instanceof MOQTransport
        ? new InMemoryMetricsSink()
        : (transportOrConfig.metrics ?? new InMemoryMetricsSink());
    this._reconnectPolicy =
      transportOrConfig instanceof MOQTransport
        ? undefined
        : transportOrConfig.reconnectPolicy;
    this.sessionLog = Logger.create('moqt:session', { sessionId: this.sessionId });
    this._createdAtMs = typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();

    if (transportOrConfig instanceof MOQTransport) {
      // Main thread mode - existing behavior
      this.transport = transportOrConfig;
      this.useWorker = false;
      this._draft = transportOrConfig.draft;
      // Capture the URL the caller connected the transport to, so migration
      // (§3.6) can surface it as `oldSessionUri` on migration events.
      this._lastConnectUrl = transportOrConfig.url;
      // Register the transport `'closed'` handler up-front (not from within
      // `setup()`), so a peer-close can surface a typed session-terminated
      // event even if it arrives after our own teardown started.
      const closedCleanup = transportOrConfig.on('closed', (info) => {
        this.handleTransportClosed(info);
      });
      this.transportCleanup.push(closedCleanup);
    } else {
      // Worker mode - transport runs in worker. Pass the session's metrics
      // sink through so worker-side `moq.transport.*` counters land in
      // `getDiagnostics().metrics`.
      this.workerConfig = transportOrConfig;
      this.transportWorker = new TransportWorkerClient(transportOrConfig.worker, this.metrics);
      this.useWorker = true;
      this._draft = transportOrConfig.draft ?? DEFAULT_DRAFT;
    }

    // Bind codec and request-ID scheme to the resolved draft.
    this.codec = getProtocolCodecForVersion(versionEnumFor(this._draft) as Version);
    // Draft-14: 1-based. Draft-16+: clients use even IDs starting at 0.
    this.nextRequestId = this._draft === 'draft-16' || this._draft === 'draft-17' || this._draft === 'draft-18'
      ? 0
      : 1;

    this.objectRouter = new ObjectRouter(this.subscriptionManager, (sub, data, groupId, objectId, timestamp) => {
      this.emit('object', {
        subscriptionId: sub.subscriptionId,
        trackAlias: sub.trackAlias ?? BigInt(0),
        data,
        groupId,
        objectId,
        timestamp,
      } as ReceivedObjectEvent);

      // Emit subscribe stats for UI updates
      this.emit('subscribe-stats', {
        subscriptionId: sub.subscriptionId,
        groupId,
        objectId,
        bytes: data.byteLength,
      } as SubscribeStatsEvent);
    }, this._draft, this.metrics);

    // §8: surface subscriber-side delivery deadline expiries to consumers.
    this.objectRouter.setDeliveryTimeoutCallback((sub, reason, resetCode, detail) => {
      log.warn('Delivery timeout expired (subscriber)', {
        subscriptionId: sub.subscriptionId,
        trackAlias: sub.trackAlias?.toString(),
        reason,
        resetCode,
        ...detail,
      });
      this.emit('delivery-timeout', {
        side: 'subscriber',
        reason,
        resetCode,
        trackAlias: sub.trackAlias,
        subscriptionId: sub.subscriptionId,
        groupId: detail.groupId,
        subgroupId: detail.subgroupId,
        objectId: detail.objectId,
      } as DeliveryTimeoutEvent);
    });

    // Draft-18 §11.4.3: surface peer-initiated subgroup stream resets. We
    // only fire this for aborts where WebTransport gave us a numeric
    // streamErrorCode; §8 delivery-timeouts flow through the callback above.
    this.objectRouter.setStreamResetCallback((sub, code, reason, detail) => {
      log.warn('Incoming subgroup stream reset by peer', {
        subscriptionId: sub?.subscriptionId,
        trackAlias: sub?.trackAlias?.toString() ?? detail.trackAlias?.toString(),
        code,
        reason,
        ...detail,
      });
      const evt: StreamResetEvent = {
        side: 'subscriber',
        code,
        reason,
      };
      if (sub?.trackAlias !== undefined) evt.trackAlias = sub.trackAlias;
      else if (detail.trackAlias !== undefined) evt.trackAlias = detail.trackAlias;
      if (sub?.subscriptionId !== undefined) evt.subscriptionId = sub.subscriptionId;
      if (detail.groupId !== undefined) evt.groupId = detail.groupId;
      if (detail.subgroupId !== undefined) evt.subgroupId = detail.subgroupId;
      this.emit('stream-reset', evt);
    });

    // Set up FETCH object callback to emit fetch-object events
    this.objectRouter.setFetchObjectCallback((requestId, data, groupId, objectId) => {
      // OPS-hi 1: per-object hot-path — demoted from .info to .trace.
      log.trace('FETCH object received', { requestId, groupId, objectId, dataSize: data.length });
      this.emit('fetch-object', {
        requestId,
        data,
        groupId,
        objectId,
      } as FetchObjectEvent);
    });

    // Set up FETCH end-of-group callback - fires when FETCH stream completes
    this.objectRouter.setFetchEndOfGroupCallback((requestId, groupId) => {
      log.info('FETCH stream complete (all data received)', { requestId, lastGroupId: groupId });
      this.emit('fetch-stream-complete', {
        requestId,
        lastGroupId: groupId,
      });
    });

    // Set up forward state change listener to emit events for MediaSession
    this.publicationManager.onForwardStateChange((trackAlias, forward) => {
      this.emit('forward-state-change', { trackAlias, forward });
    });

    log.debug('MOQTSession created', {
      isDraft18: this.isDraft18,
      isDraft16: this.isDraft16,
      version: Version[this.codec.version],
      useWorker: this.useWorker,
    });
  }

  /**
   * Set authorization token to include in CLIENT_SETUP.
   * Must be called before setup().
   */
  setAuthToken(token: string, tokenType?: number): void {
    this.authToken = token;
    if (tokenType !== undefined) this.authTokenType = tokenType;
  }

  /**
   * Encode a token string to raw bytes based on token type.
   * Handles C4M (base64url COSE_Sign1 or legacy dot-separated), other base64url types, and raw strings.
   */
  private encodeTokenBytes(token: string, tokenType: number): Uint8Array {
    if (tokenType === C4M_TOKEN_TYPE) {
      if (token.includes('.')) {
        return dotTokenToCoseSign1Bytes(token);
      }
      return base64urlDecode(token);
    }
    if (tokenType === 0x0002 || tokenType === 0xda7a) {
      return base64urlDecode(token);
    }
    return new TextEncoder().encode(token);
  }

  /**
   * Encode a per-request auth token for SUBSCRIBE/PUBLISH/FETCH parameters.
   */
  private encodeRequestAuthToken(authToken: RequestAuthToken): Uint8Array {
    const tokenType = authToken.tokenType ?? C4M_TOKEN_TYPE;
    return MessageCodec.encodeAuthorizationToken({
      aliasType: 3, // USE_VALUE
      tokenType,
      tokenValue: authToken.tokenBytes,
    });
  }

  /**
   * Connect to relay (worker mode only)
   *
   * In main thread mode, the transport is already connected.
   * In worker mode, this establishes the WebTransport connection via the worker.
   *
   * @param url - WebTransport URL (required for worker mode)
   */
  async connect(url: string): Promise<void> {
    if (!this.useWorker) {
      throw new Error('connect() is only for worker mode. For main thread mode, connect the transport before creating the session.');
    }

    if (!this.transportWorker || !this.workerConfig) {
      throw new Error('Worker not initialized');
    }

    log.info('Connecting via worker', { url });

    await this.transportWorker.connect({
      url,
      draft: this._draft,
      serverCertificateHashes: this.workerConfig.serverCertificateHashes,
      connectionTimeout: this.workerConfig.connectionTimeout,
      debug: this.workerConfig.debug,
    });

    // Remember the URL so §3.6 migration can fall back to the previous URI
    // and so `migrate()` can find its target when GOAWAY.newSessionUri is empty.
    this._lastConnectUrl = url;

    log.info('Connected via worker');
  }

  /**
   * Get next request ID (handles draft-14/16/18 parity rules)
   * Draft-14: Increment by 1 (1, 2, 3, ...)
   * Draft-16+: Clients use even, increment by 2 (0, 2, 4, ...)
   */
  private getNextRequestId(): number {
    const id = this.nextRequestId;
    this.nextRequestId += (this.isDraft16 || this.isDraft18) ? 2 : 1;
    return id;
  }

  // ===== Transport Abstraction Methods =====
  // These methods abstract transport operations for both main thread and worker modes

  /**
   * Send data on control stream (works in both modes)
   */
  private async doSendControl(data: Uint8Array): Promise<void> {
    this.markOutboundActivity();
    if (this.useWorker) {
      this.transportWorker!.sendControl(data);
    } else {
      await this.transport!.sendControl(data);
    }
  }

  /**
   * Send datagram (works in both modes)
   */
  private async doSendDatagram(data: Uint8Array): Promise<void> {
    this.markOutboundActivity();
    if (this.useWorker) {
      this.transportWorker!.sendDatagram(data);
    } else {
      await this.transport!.sendDatagram(data);
    }
  }

  /**
   * Create unidirectional stream (works in both modes)
   * @returns Writer for main thread mode, streamId for worker mode
   */
  /**
   * Draft-18 §7 — derive a WebTransport `sendOrder` for outgoing subgroup
   * streams by combining the publisher priority with the subscriber-side
   * hints cached on the publication (from SUBSCRIBE §10.2 or REQUEST_UPDATE
   * §10.9.1). Returns `undefined` when the session is not running draft-18
   * so callers can skip the option entirely on older sessions.
   */
  private deriveSendOrder(
    trackAlias: bigint,
    publisherPriority: number | undefined,
    groupId: number,
  ): number | undefined {
    if (!this.isDraft18) return undefined;
    const pub = this.publicationManager.get(trackAlias);
    const subP = pub?.subscriberPriority ?? 128;
    const go = pub?.subscriberGroupOrder ?? GroupOrder.ASCENDING;
    const pubP = publisherPriority ?? pub?.priority ?? 128;
    return computeSendOrder(subP, pubP, go, groupId);
  }

  private async doCreateStream(
    opts?: { sendOrder?: number }
  ): Promise<{ writer?: WritableStreamDefaultWriter<Uint8Array>; streamId?: number }> {
    // B3 SEC: gate outbound stream creation. Prevents unbounded stream
    // allocation from a runaway loop (or a peer that induces us to open one
    // publisher stream per SUBSCRIBE).
    this.enforceResourceLimit('streams', this.openStreamCount, this.maxOpenStreams);
    this.openStreamCount++;
    try {
      if (this.useWorker) {
        // The worker path does not yet plumb sendOrder — main-thread streams get
        // §7 priority scheduling today; worker streams inherit the browser default.
        const streamId = await this.transportWorker!.createStream();
        return { streamId };
      } else {
        const stream = await this.transport!.createUnidirectionalStream(opts);
        const writer = stream.getWriter();
        return { writer };
      }
    } catch (err) {
      // Rollback the counter increment if the underlying transport rejected
      // the create — we never actually held a stream open.
      this.openStreamCount = Math.max(0, this.openStreamCount - 1);
      throw err;
    }
  }

  /** B3 SEC: decrement the open-stream counter. Called from doCloseStream and
   * from close paths (video GOP close, publication cleanup) that end a stream
   * without going through doCloseStream. Idempotent-ish: floors at zero. */
  private decrementOpenStreamCount(): void {
    this.openStreamCount = Math.max(0, this.openStreamCount - 1);
  }

  /**
   * Write to stream (works in both modes)
   */
  private async doWriteStream(
    streamInfo: { writer?: WritableStreamDefaultWriter<Uint8Array>; streamId?: number },
    data: Uint8Array,
    close = false
  ): Promise<void> {
    if (this.useWorker && streamInfo.streamId !== undefined) {
      this.transportWorker!.writeStream(streamInfo.streamId, data, close);
    } else if (streamInfo.writer) {
      await streamInfo.writer.write(data);
      if (close) {
        await streamInfo.writer.close();
      }
    }
  }

  /**
   * Close stream (works in both modes)
   */
  private async doCloseStream(
    streamInfo: { writer?: WritableStreamDefaultWriter<Uint8Array>; streamId?: number }
  ): Promise<void> {
    try {
      if (this.useWorker && streamInfo.streamId !== undefined) {
        this.transportWorker!.closeStream(streamInfo.streamId);
      } else if (streamInfo.writer) {
        await streamInfo.writer.close();
      }
    } finally {
      // B3 SEC: pair with doCreateStream increment.
      this.decrementOpenStreamCount();
    }
  }

  /**
   * Set up handlers for main thread transport mode
   */
  private setupTransportHandlers(): void {
    if (!this.transport) return;

    if (this.isDraft18) {
      // Draft-18: Setup messages come on separate setup stream event
      const setupCleanup = this.transport.on('setup-message', (data) => {
        this.handleSetupMessage(data);
      });
      this.transportCleanup.push(setupCleanup);

      // Incoming bidi streams for server-initiated requests
      const bidiCleanup = this.transport.on('incoming-bidi-stream', (stream) => {
        log.info('Received incoming-bidi-stream event from transport');
        this.handleIncomingBidiStream(stream);
      });
      this.transportCleanup.push(bidiCleanup);
    } else {
      // Draft-14/16: Control messages come on control stream
      const controlCleanup = this.transport.on('control-message', (data) => {
        this.handleControlMessage(data);
      });
      this.transportCleanup.push(controlCleanup);
    }

    // Set up datagram handler
    const datagramCleanup = this.transport.on('datagram', (data) => {
      this.markInboundActivity();
      this.objectRouter.handleDatagram(data);
    });
    this.transportCleanup.push(datagramCleanup);

    // Set up unidirectional stream handler
    const streamCleanup = this.transport.on('unidirectional-stream', (stream) => {
      log.info('Received unidirectional-stream event from transport');
      this.objectRouter.handleIncomingStream(stream);
    });
    this.transportCleanup.push(streamCleanup);
    log.info('Unidirectional stream handler registered');

    // Set up error handler
    const errorCleanup = this.transport.on('error', (err) => {
      log.error('Transport error', err);
      this.handleError(err);
    });
    this.transportCleanup.push(errorCleanup);
    // NOTE: the `'closed'` handler is registered in the constructor so that
    // peer-close events are surfaced even before `setup()` runs.
  }

  /**
   * Set up handlers for worker transport mode
   */
  private setupWorkerHandlers(): void {
    if (!this.transportWorker) return;

    if (this.isDraft18) {
      // Draft-18: Setup messages come on dedicated setup stream
      this.transportWorker.on('setup-message', ({ data }) => {
        this.handleSetupMessage(data);
      });

      // Draft-18: Incoming bidi streams for server-initiated requests
      this.transportWorker.on('incoming-bidi-stream', ({ streamId }) => {
        log.info('Received incoming-bidi-stream from worker', { streamId });
        this.handleWorkerIncomingBidiStream(streamId);
      });
    } else {
      // Draft-14/16: Control messages from worker
      this.transportWorker.on('control-message', ({ data }) => {
        this.handleControlMessage(data);
      });
    }

    // Datagrams from worker
    this.transportWorker.on('datagram', ({ data }) => {
      this.markInboundActivity();
      this.objectRouter.handleDatagram(data);
    });

    // Incoming streams from worker - need to handle differently
    // Worker sends stream data as events, not as ReadableStream
    this.transportWorker.on('incoming-stream', ({ streamId }) => {
      log.info('Received incoming-stream event from worker', { streamId });
      this.handleWorkerIncomingStream(streamId);
    });

    // Stream data from worker
    this.transportWorker.on('stream-data', ({ streamId, data }) => {
      this.handleWorkerStreamData(streamId, data);
    });

    // Bidi stream data (for SUBSCRIBE_NAMESPACE responses)
    this.transportWorker.on('bidi-stream-data', ({ streamId, data }) => {
      this.handleWorkerBidiStreamData(streamId, data);
    });

    // Stream closed
    this.transportWorker.on('stream-closed', ({ streamId }) => {
      this.handleWorkerStreamClosed(streamId);
    });

    // Error handler
    this.transportWorker.on('error', ({ message }) => {
      console.error('[MOQT] Worker transport error:', message);
      log.error('Worker transport error', { message });
      this.handleError(new Error(message));
    });

    // Disconnection handler.
    // Worker surfaces the WebTransport close info (closeCode, reason, remote)
    // so we can emit a draft-18 §15.10.1 typed session-terminated event when
    // the peer initiated the close. We only escalate to `handleError` when the
    // close was remote AND carried a non-zero SessionErrorCode.
    this.transportWorker.on('disconnected', ({ reason, closeCode, remote }) => {
      console.warn('[MOQT] Worker transport disconnected:', reason, 'code:', closeCode, 'remote:', remote);
      log.warn('Worker transport disconnected', { reason, closeCode, remote });
      this.handleTransportClosed({
        closeCode: closeCode ?? 0,
        reason: reason ?? '',
        remote: remote ?? false,
      });
    });

    log.info('Worker event handlers registered');
  }

  // Worker stream handling - accumulates stream data and processes when complete
  private workerStreamBuffers = new Map<number, Uint8Array[]>();

  /**
   * Handle new incoming stream from worker
   */
  private handleWorkerIncomingStream(streamId: number): void {
    // Initialize buffer for this stream
    this.workerStreamBuffers.set(streamId, []);
  }

  /**
   * Handle stream data chunk from worker
   */
  private handleWorkerStreamData(streamId: number, data: Uint8Array): void {
    const buffer = this.workerStreamBuffers.get(streamId);
    if (buffer) {
      buffer.push(data);
      // Process incrementally - create a ReadableStream-like interface for objectRouter
      this.processWorkerStreamData(streamId);
    }
  }

  /**
   * Handle stream closed from worker
   */
  private handleWorkerStreamClosed(streamId: number): void {
    this.workerStreamBuffers.delete(streamId);
    // Close the ReadableStream controller so object-router gets done=true
    const reader = this.workerStreamReaders.get(streamId);
    if (reader) {
      try { reader.controller.close(); } catch { /* already closed */ }
    }
    this.workerStreamReaders.delete(streamId);
    this.bidiStreamChunks.delete(streamId);
    // Close any pending incoming bidi stream readable controller
    const controller = this.incomingBidiControllers.get(streamId);
    if (controller) {
      try { controller.close(); } catch { /* already closed */ }
      this.incomingBidiControllers.delete(streamId);
    }
  }

  /** Controllers for bidi streams (incoming and outgoing request streams) */
  private incomingBidiControllers = new Map<number, ReadableStreamDefaultController<Uint8Array>>();

  /**
   * Long-lived per-request bidi stream (draft-18 §3.3, §10.9). Keys are the
   * 62-bit varint request ID; kept as bigint so peer-supplied values above
   * `Number.MAX_SAFE_INTEGER` (2^53-1) index correctly.
   */
  private activeRequestStreams = new Map<bigint, Draft18RequestStream>();

  /**
   * Open a new per-request bidi stream, write the initial request bytes, and
   * return a handle that supports sending more messages (e.g. REQUEST_UPDATE)
   * and reading successive response messages on the same stream.
   */
  private async openRequestStream(
    requestId: bigint,
    initialEncoded: Uint8Array
  ): Promise<Draft18RequestStream> {
    const existing = this.activeRequestStreams.get(requestId);
    if (existing) {
      throw new Error(`Request stream already open for requestId=${requestId.toString()}`);
    }

    let stream: Draft18RequestStream;
    if (this.useWorker && this.transportWorker) {
      const streamId = await this.transportWorker.createBidiStream();
      const readable = new ReadableStream<Uint8Array>({
        start: (controller) => {
          this.incomingBidiControllers.set(streamId, controller);
        },
      });
      const worker = this.transportWorker;
      stream = new Draft18RequestStream(
        this.codec,
        readable,
        (data, closeAfter) => {
          worker.writeStream(streamId, data, closeAfter);
        },
        () => {
          try { worker.closeStream(streamId); } catch { /* ignore */ }
          this.incomingBidiControllers.delete(streamId);
        }
      );
    } else if (this.transport) {
      const { readable, writable } = await this.transport.createRequestStream();
      const writer = writable.getWriter();
      stream = new Draft18RequestStream(
        this.codec,
        readable,
        async (data, closeAfter) => {
          await writer.write(data);
          if (closeAfter) {
            await writer.close();
          }
        },
        async () => {
          try { await writer.close(); } catch { /* already closed */ }
          try { writer.releaseLock(); } catch { /* ignore */ }
        }
      );
    } else {
      throw new Error('No transport available');
    }

    this.activeRequestStreams.set(requestId, stream);
    await stream.write(initialEncoded);
    return stream;
  }

  /**
   * Close and forget a per-request bidi stream.
   */
  private async closeRequestStream(requestId: bigint): Promise<void> {
    const stream = this.activeRequestStreams.get(requestId);
    if (!stream) return;
    this.activeRequestStreams.delete(requestId);
    await stream.close();
  }

  /**
   * Send an initial request on a new bidi stream and wait for its first
   * response message. The stream is registered under `requestId` and stays
   * open so REQUEST_UPDATE can be sent on it later; call
   * `closeRequestStream(requestId)` when the request is terminated.
   */
  private async sendRequestAndWaitResponse(
    encoded: Uint8Array,
    requestId: bigint
  ): Promise<ControlMessageDraft18> {
    const stream = await this.openRequestStream(requestId, encoded);
    try {
      return await stream.readMessage();
    } catch (err) {
      // Failed to read the first response — the stream is unusable, drop it.
      await this.closeRequestStream(requestId);
      throw err;
    }
  }

  /**
   * Handle incoming bidi stream from worker (draft-18 server-initiated requests)
   */
  private handleWorkerIncomingBidiStream(streamId: number): void {
    // Create a ReadableStream that receives data from bidi-stream-data events
    const readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.incomingBidiControllers.set(streamId, controller);
      },
    });

    // Create a WritableStream that sends data back via worker
    const writable = new WritableStream<Uint8Array>({
      write: (chunk) => {
        this.transportWorker!.writeStream(streamId, chunk);
      },
      close: () => {
        this.transportWorker!.writeStream(streamId, new Uint8Array(0), true);
      },
    });

    this.handleIncomingBidiStream({ readable, writable });
  }

  /** Chunked buffers for bidi stream data - avoids copying on each receive */
  private bidiStreamChunks = new Map<number, { chunks: Uint8Array[]; totalLength: number; offset: number }>();

  /**
   * Handle bidi stream data from worker (SUBSCRIBE_NAMESPACE responses)
   * Optimized to minimize buffer copies
   */
  private handleWorkerBidiStreamData(streamId: number, data: Uint8Array): void {
    // Find which subscription this stream belongs to
    let subscriptionId: number | undefined;
    for (const [subId, sId] of this.namespaceSubscriptionStreams) {
      if (sId === streamId) {
        subscriptionId = subId;
        break;
      }
    }

    if (subscriptionId === undefined) {
      // Check if it's an incoming bidi stream (draft-18 server-initiated)
      const controller = this.incomingBidiControllers.get(streamId);
      if (controller) {
        try { controller.enqueue(data); } catch { /* stream closed */ }
        return;
      }
      log.warn('Received bidi stream data for unknown stream', { streamId });
      return;
    }

    // Get or create chunk buffer - accumulate chunks without copying
    let state = this.bidiStreamChunks.get(streamId);
    if (!state) {
      state = { chunks: [], totalLength: 0, offset: 0 };
      this.bidiStreamChunks.set(streamId, state);
    }

    state.chunks.push(data);
    state.totalLength += data.length;

    // Try to decode messages
    this.processBidiStreamChunks(streamId, subscriptionId, state);
  }

  /**
   * Process accumulated chunks - only concatenates when needed for decoding
   */
  private processBidiStreamChunks(
    streamId: number,
    subscriptionId: number,
    state: { chunks: Uint8Array[]; totalLength: number; offset: number }
  ): void {
    const availableBytes = state.totalLength - state.offset;
    if (availableBytes === 0) return;

    // Concatenate chunks only when we need to decode (lazy concatenation)
    let buffer: Uint8Array;
    if (state.chunks.length === 1 && state.offset === 0) {
      // Single chunk, no offset - use directly without copy
      buffer = state.chunks[0];
    } else {
      // Multiple chunks or partial consumption - concatenate remaining
      buffer = new Uint8Array(availableBytes);
      let writeOffset = 0;
      let skipBytes = state.offset;

      for (const chunk of state.chunks) {
        if (skipBytes >= chunk.length) {
          skipBytes -= chunk.length;
          continue;
        }
        const source = skipBytes > 0 ? chunk.subarray(skipBytes) : chunk;
        buffer.set(source, writeOffset);
        writeOffset += source.length;
        skipBytes = 0;
      }
    }

    // Try to decode messages
    let consumed = 0;
    while (consumed < buffer.length) {
      try {
        const view = buffer.subarray(consumed);
        const [message, bytesRead] = this.codec.decodeControlMessage(view, 0, this.metrics);
        consumed += bytesRead;

        const msgTypeName = MessageType[message.type] ?? `unknown(${message.type})`;
        console.warn('[MOQT-DIAG] Bidi stream message (worker)', { type: msgTypeName, subscriptionId, streamId });
        log.info('Received message on namespace subscription stream (worker)', {
          type: msgTypeName,
          subscriptionId,
          streamId,
        });

        this.routeMessage(message as ControlMessage);
      } catch (err) {
        if ((err as Error).message?.includes('Incomplete') ||
            (err as Error).message?.includes('buffer')) {
          break;
        }
        log.error('Error decoding bidi stream message', { error: (err as Error).message });
        break;
      }
    }

    // Update offset - compact if we've consumed significant data
    state.offset += consumed;
    if (state.offset > 4096) {
      // Compact: remove fully consumed chunks
      const remaining = state.totalLength - state.offset;
      if (remaining === 0) {
        state.chunks = [];
        state.totalLength = 0;
        state.offset = 0;
      } else {
        // Keep only unconsumed data
        const newBuffer = buffer.subarray(consumed);
        state.chunks = [new Uint8Array(newBuffer)];
        state.totalLength = newBuffer.length;
        state.offset = 0;
      }
    }
  }

  // Track readable streams created for worker streams
  private workerStreamReaders = new Map<number, {
    controller: ReadableStreamDefaultController<Uint8Array>;
    stream: ReadableStream<Uint8Array>;
  }>();

  /**
   * Process worker stream data - creates a ReadableStream for the objectRouter
   */
  private processWorkerStreamData(streamId: number): void {
    // If we haven't created a stream yet, create one
    if (!this.workerStreamReaders.has(streamId)) {
      let controller: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
      });
      this.workerStreamReaders.set(streamId, { controller: controller!, stream });

      // Pass to objectRouter
      this.objectRouter.handleIncomingStream(stream);
    }

    // Enqueue buffered data
    const buffer = this.workerStreamBuffers.get(streamId);
    const reader = this.workerStreamReaders.get(streamId);
    if (buffer && reader) {
      while (buffer.length > 0) {
        const chunk = buffer.shift()!;
        reader.controller.enqueue(chunk);
      }
    }
  }

  /**
   * MOQT draft version this session is speaking.
   */
  get draft(): DraftVersion {
    return this._draft;
  }

  /** True when this session is speaking draft-18 (per-request bidi streams, MOQT varints, ...). */
  private get isDraft18(): boolean {
    return this._draft === 'draft-18';
  }

  /** True when this session is speaking draft-16 or draft-17. */
  private get isDraft16(): boolean {
    return this._draft === 'draft-16' || this._draft === 'draft-17';
  }

  /**
   * Get current session state
   */
  get state(): SessionState {
    return this._state;
  }

  /**
   * Check if session is ready
   */
  get isReady(): boolean {
    return this._state === 'ready';
  }

  /**
   * Get maximum datagram size
   * In worker mode, defaults to 1200 (can be configured)
   */
  get maxDatagramSize(): number {
    if (this.useWorker) {
      return this.workerConfig?.maxDatagramSize ?? 1200;
    }
    return this.transport?.maxDatagramSize ?? 1200;
  }

  /**
   * Draft-18 §3.2: register extension KVPs to advertise in CLIENT_SETUP.
   *
   * Must be called before `setup()`. Keys must not collide with the reserved
   * SetupOption values (PATH, AUTHORIZATION_TOKEN, MAX_AUTH_TOKEN_CACHE_SIZE,
   * AUTHORITY, MOQT_IMPLEMENTATION) — the codec rejects those. Even keys carry
   * `{ varint }`; odd keys carry `{ bytes }`. Pass `undefined` to clear.
   */
  setClientExtensions(
    extensions: Map<number, import('@moq-web/core').SetupExtensionValue> | undefined,
  ): void {
    if (this._state !== 'none') {
      throw new Error(`Cannot set client extensions after setup() (state=${this._state})`);
    }
    this._clientExtensions = extensions;
  }

  /**
   * Draft-18 §3.2: extensions the peer advertised in SERVER_SETUP.
   *
   * `undefined` until SERVER_SETUP has been received; empty map is normalized
   * to `undefined` by the codec when no unknown KVPs were present.
   */
  get peerExtensions(): ReadonlyMap<number, import('@moq-web/core').SetupExtensionValue> | undefined {
    return this._peerExtensions;
  }

  /**
   * Draft-18 §13.8: opt in to sending the MOQT_IMPLEMENTATION SetupOption.
   *
   * §13.8 cautions endpoints against always advertising an implementation
   * identifier because it enables passive fingerprinting. By default this
   * client omits the field; call this before `setup()` with a string to
   * advertise it, or with `undefined` to explicitly disable (also the
   * default). Must be called before `setup()` — the value is read once when
   * CLIENT_SETUP is encoded.
   */
  setImplementationString(value: string | undefined): void {
    if (this._state !== 'none') {
      throw new Error(`Cannot set implementation string after setup() (state=${this._state})`);
    }
    if (value !== undefined && value.length === 0) {
      throw new Error('Implementation string must be non-empty (or undefined to disable)');
    }
    this._implementationString = value;
  }

  /**
   * Draft-18 §13.6.1 — configure application-level idle handling.
   *
   * MOQT itself defers idle timeouts to QUIC's `max_idle_timeout` (RFC 9000
   * §10.2), which WebTransport doesn't expose. This client offers two knobs
   * that approximate the spec's recommendation ("might want to send periodic
   * PING frames to keep the QUIC connection alive"):
   *
   *   - `keepaliveIntervalMs` — if the outbound side has been silent for
   *     this many ms while the session is in `ready`, emit a §11.5 padding
   *     datagram to reset the peer's idle timer. Omit or set to 0 to
   *     disable.
   *   - `idleTimeoutMs` — if *no* activity in either direction has been
   *     seen for this many ms, close the session with §15.10.3
   *     `CONTROL_MESSAGE_TIMEOUT`. Omit or set to 0 to disable.
   *
   * May be called before or after `setup()`. Calling it while `ready` will
   * reconfigure the running timer.
   */
  configureIdle(config: { idleTimeoutMs?: number; keepaliveIntervalMs?: number }): void {
    this.idleConfig = {
      idleTimeoutMs: config.idleTimeoutMs && config.idleTimeoutMs > 0 ? config.idleTimeoutMs : undefined,
      keepaliveIntervalMs: config.keepaliveIntervalMs && config.keepaliveIntervalMs > 0
        ? config.keepaliveIntervalMs
        : undefined,
    };
    if (this._state === 'ready') {
      // Reset baselines so a reconfigure doesn't accidentally trip
      // thresholds against a very old activity timestamp, then restart.
      this.lastOutboundActivityMs = this.now();
      this.lastInboundActivityMs = this.now();
      this.stopIdleTimer();
      this.startIdleTimer();
    }
  }

  private now(): number {
    return typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();
  }

  private markOutboundActivity(): void {
    if (this.idleConfig.idleTimeoutMs || this.idleConfig.keepaliveIntervalMs) {
      this.lastOutboundActivityMs = this.now();
    }
  }

  private markInboundActivity(): void {
    if (this.idleConfig.idleTimeoutMs || this.idleConfig.keepaliveIntervalMs) {
      this.lastInboundActivityMs = this.now();
    }
  }

  private startIdleTimer(): void {
    if (this.idleTimer !== undefined) return;
    const { idleTimeoutMs, keepaliveIntervalMs } = this.idleConfig;
    if (!idleTimeoutMs && !keepaliveIntervalMs) return;
    // Tick at a granularity that catches the tightest threshold reasonably
    // fast without polling too aggressively.
    const tick = Math.max(50, Math.min(idleTimeoutMs ?? Infinity, keepaliveIntervalMs ?? Infinity) / 4);
    const started = this.now();
    if (this.lastOutboundActivityMs === 0) this.lastOutboundActivityMs = started;
    if (this.lastInboundActivityMs === 0) this.lastInboundActivityMs = started;
    this.idleTimer = setInterval(() => { this.onIdleTick(); }, tick);
  }

  private stopIdleTimer(): void {
    if (this.idleTimer !== undefined) {
      clearInterval(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  private onIdleTick(): void {
    if (this._state !== 'ready') return;
    const now = this.now();
    const { idleTimeoutMs, keepaliveIntervalMs } = this.idleConfig;

    if (keepaliveIntervalMs && !this.idleClosePending) {
      const sinceOutbound = now - this.lastOutboundActivityMs;
      if (sinceOutbound >= keepaliveIntervalMs) {
        // §11.5 padding datagram — a single byte payload is enough to reset
        // the peer's QUIC idle timer. Fire-and-forget; `sendPaddingDatagram`
        // calls `markOutboundActivity()` for us via `doSendDatagram()`.
        this.sendPaddingDatagram(1).catch((err: unknown) => {
          log.warn('Idle keepalive padding datagram failed', { err: String(err) });
        });
      }
    }

    if (idleTimeoutMs && !this.idleClosePending) {
      const sinceActivity = Math.min(
        now - this.lastOutboundActivityMs,
        now - this.lastInboundActivityMs,
      );
      if (sinceActivity >= idleTimeoutMs) {
        this.idleClosePending = true;
        const sinceMs = Math.round(sinceActivity);
        log.warn('Draft-18 §13.6.1 idle timeout — closing session', {
          idleTimeoutMs,
          sinceLastActivityMs: sinceMs,
        });
        // Surface it as a local session-terminated event so UIs can react —
        // handleTransportClosed suppresses events for local closes, but the
        // idle path is a policy decision by *this* endpoint that consumers
        // should see explicitly.
        this.emit('session-terminated', {
          code: SessionErrorCodeDraft18.CONTROL_MESSAGE_TIMEOUT,
          reason: `idle timeout (${sinceMs}ms > ${idleTimeoutMs}ms)`,
          remote: false,
        } as SessionTerminatedEvent);
        // CONTROL_MESSAGE_TIMEOUT (§15.10.3 / SessionErrorCodeDraft18 0x11)
        // is the closest spec code for "the peer stopped talking to us."
        this.close({
          code: SessionErrorCodeDraft18.CONTROL_MESSAGE_TIMEOUT,
          reason: 'idle timeout',
        }).catch(() => {/* best effort */});
      }
    }
  }

  /**
   * Set up the MOQT session
   *
   * Sends CLIENT_SETUP and waits for SERVER_SETUP
   */
  async setup(): Promise<void> {
    if (this._state !== 'none') {
      throw new Error(`Cannot setup: session is ${this._state}`);
    }

    log.info('Setting up MOQT session', { useWorker: this.useWorker, isDraft18: this.isDraft18 });
    this.setState('setup');

    // Set up event handlers based on mode
    if (this.useWorker) {
      this.setupWorkerHandlers();
    } else {
      this.setupTransportHandlers();
    }

    if (this.isDraft18) {
      // Draft-18: Single SETUP message with no version/role (negotiated via ALPN)
      // On the setup stream, message type is implicit (stream type = 0x2F00)
      // Wire format: Length (16-bit) | Setup Options
      let setupAuthToken: Uint8Array | undefined;
      if (this.authToken) {
        const tokenBytes = this.encodeTokenBytes(this.authToken, this.authTokenType);
        setupAuthToken = MessageCodec.encodeAuthorizationToken({
          aliasType: 3, // USE_VALUE — inline, no caching
          tokenType: this.authTokenType,
          tokenValue: tokenBytes,
        });
      }
      // §13.8: MOQT_IMPLEMENTATION aids interoperability debugging but also
      // enables passive fingerprinting. The spec cautions against always
      // advertising it, so this client omits it by default and only sends
      // when the caller has explicitly opted in via
      // `setImplementationString()`.
      const clientSetup: ClientSetupMessageDraft18 = {
        type: MessageTypeDraft18.CLIENT_SETUP,
        moqtImplementation: this._implementationString,
        extensions: this._clientExtensions,
        authToken: setupAuthToken,
      };

      const setupBytes = this.codec.encodeSetupStream(clientSetup);

      const hexBytes = Array.from(setupBytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
      log.info('SETUP bytes (draft-18)', {
        length: setupBytes.length,
        hex: hexBytes,
        alpnProtocol: alpnProtocolFor(this._draft),
      });

      await this.doSendControl(setupBytes);
      log.info('Sent SETUP (draft-18)');

      // Draft-18: Setup can happen in parallel, but wait for server's SETUP
      // to confirm session establishment
      await this.waitForServerSetupDraft18();
    } else {
      // Draft-14/16: Use MessageCodec and send on control stream
      const setupParams = new Map<SetupParameter, number | string | Uint8Array>();
      setupParams.set(SetupParameter.MAX_REQUEST_ID, 1000);
      if (this.authToken) {
        const tokenBytes = this.encodeTokenBytes(this.authToken, this.authTokenType);
        const authTokenData = MessageCodec.encodeAuthorizationToken({
          aliasType: 3, // USE_VALUE — inline token, no caching
          tokenType: this.authTokenType,
          tokenValue: tokenBytes,
        });
        setupParams.set(SetupParameter.AUTHORIZATION_TOKEN, authTokenData);
      }

      const clientSetup: ClientSetupMessage = {
        type: MessageType.CLIENT_SETUP,
        supportedVersions: [Version.DRAFT_16],
        parameters: setupParams,
      };

      const setupBytes = this.codec.encodeControlMessage(clientSetup);

      const hexBytes = Array.from(setupBytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
      log.info('CLIENT_SETUP bytes', {
        length: setupBytes.length,
        hex: hexBytes,
        isDraft16: this.isDraft16,
        alpnProtocol: alpnProtocolFor(this._draft),
      });

      await this.doSendControl(setupBytes);
      log.info('Sent CLIENT_SETUP');
      this.emitMessageSent('CLIENT_SETUP', setupBytes.length, 'draft-16', { isDraft16: this.isDraft16 });

      // Wait for SERVER_SETUP
      await this.waitForServerSetup();
    }
    log.info('MOQT session ready');
  }

  // ============================================================================
  // Draft-18 Protocol Operations
  // ============================================================================

  /**
   * Send GOAWAY to signal graceful session termination (draft-18)
   *
   * @param newSessionUri Optional URI for the client to migrate to (must be zero-length when sent by client, spec §10.4)
   * @param timeoutMs Grace period in milliseconds before the sender enforces closure (spec §10.4)
   */
  async goAway(newSessionUri?: string, timeoutMs: bigint = 0n): Promise<void> {
    if (!this.isDraft18) {
      log.warn('goAway only supported in draft-18');
      return;
    }

    const goAwayMessage: GoAwayMessageDraft18 = {
      type: MessageTypeDraft18.GOAWAY,
      newSessionUri,
      timeout: timeoutMs,
    };

    const bytes = this.codec.encodeControlMessage(goAwayMessage);
    await this.doSendControl(bytes);
    this.setState('closing');
    log.info('Sent GOAWAY', { newSessionUri, timeoutMs: timeoutMs.toString() });
  }

  /**
   * Query track status (draft-18 §10.14).
   *
   * Returns the peer's REQUEST_OK response, surfacing the largest (group,
   * object) tuple the publisher has produced when the LARGEST_OBJECT
   * parameter (§10.2.9) is present. `latestGroup` / `latestObject` are
   * `undefined` when the publisher has not sent any objects yet (or omitted
   * the parameter). Throws on REQUEST_ERROR.
   *
   * @param namespace - Track namespace
   * @param trackName - Track name
   */
  async trackStatus(
    namespace: string[],
    trackName: string,
  ): Promise<TrackStatusResult> {
    if (!this.isDraft18) {
      throw new Error('trackStatus() requires draft-18');
    }
    if (!this.isReady) {
      throw new Error('Session not ready');
    }
    assertNotReservedNamespace(namespace, 'request TRACK_STATUS');

    // Widen the locally-generated counter to bigint immediately so it flows
    // through wire encode, state, and response events without truncation.
    const requestId = BigInt(this.getNextRequestId());

    const trackStatusMessage: TrackStatusMessageDraft18 = {
      type: MessageTypeDraft18.TRACK_STATUS,
      requestId,
      trackNamespace: namespace,
      trackName,
    };

    const encoded = this.codec.encodeControlMessage(trackStatusMessage);
    log.info('Sent TRACK_STATUS (draft-18)', {
      requestId: requestId.toString(),
      namespace: namespace.join('/'),
      trackName,
    });

    try {
      const response = await this.sendRequestAndWaitResponse(encoded, requestId);

      if (response.type === MessageTypeDraft18.REQUEST_ERROR) {
        const error = response as RequestErrorMessageDraft18;
        throw new Error(`TRACK_STATUS failed: ${error.reasonPhrase} (code ${error.errorCode})`);
      }

      const ok = response as RequestOkMessageDraft18;
      const expiresMs = ok.expires !== undefined ? Number(ok.expires) : undefined;
      this.emit('request-ok', {
        requestId,
        requestKind: 'track-status',
        expiresMs,
      } as RequestOkEvent);
      const result: TrackStatusResult = {
        requestId,
        expiresMs,
        latestGroup: ok.largestLocation?.group,
        latestObject: ok.largestLocation?.object,
      };
      log.info('TRACK_STATUS response received (draft-18)', {
        requestId: requestId.toString(),
        expiresMs,
        latestGroup: result.latestGroup?.toString(),
        latestObject: result.latestObject?.toString(),
      });
      return result;
    } finally {
      await this.closeRequestStream(requestId);
    }
  }

  /**
   * Subscribe to tracks matching a namespace prefix (draft-18 §10.19).
   *
   * @param namespacePrefix - Namespace prefix to match
   * @param onObject        - Callback for objects on matching tracks
   * @param options.forwardState        Whether the peer should forward objects (default `true`).
   * @param options.filter              SUBSCRIPTION_FILTER variant (default `NEXT_GROUP_START`).
   * @param options.startLocation       Absolute start (required for `ABSOLUTE_START` / `ABSOLUTE_RANGE`).
   * @param options.endGroupDelta       End-group delta (required for `ABSOLUTE_RANGE`).
   * @param options.namespacePrefixParam §10.2.14 TRACK_NAMESPACE_PREFIX request parameter —
   *                                    optional narrower prefix carried inside the params map;
   *                                    supplements the top-level `namespacePrefix`.
   * @param options.parameters          Additional raw KVP request parameters (§10.2).
   */
  async subscribeTracks(
    namespacePrefix: string[],
    onObject?: (data: Uint8Array, groupId: number, objectId: number, timestamp: number) => void,
    options?: {
      forwardState?: boolean;
      filter?: SubscriptionFilterDraft18;
      startLocation?: { group: bigint; object: bigint };
      endGroupDelta?: bigint;
      namespacePrefixParam?: string[];
      parameters?: Map<number, Uint8Array>;
    }
  ): Promise<number> {
    if (!this.isDraft18) {
      throw new Error('subscribeTracks() requires draft-18');
    }
    if (!this.isReady) {
      throw new Error('Session not ready');
    }
    assertNotReservedNamespace(namespacePrefix, 'SUBSCRIBE_TRACKS under');
    if (options?.namespacePrefixParam) {
      assertNotReservedNamespace(options.namespacePrefixParam, 'SUBSCRIBE_TRACKS under');
    }

    // Local counter is small; widen for wire encode and state.
    const subscriptionId = this.getNextRequestId();
    const requestId = BigInt(subscriptionId);

    // §10.2.14 TRACK_NAMESPACE_PREFIX — encoded as a namespace tuple (count |
    // per-element length-prefixed UTF-8), then packed as the parameter value.
    // Combine with any caller-supplied `parameters` map so both survive.
    let mergedParameters = options?.parameters;
    if (options?.namespacePrefixParam) {
      const encoded = encodeTrackNamespaceBytes(options.namespacePrefixParam);
      mergedParameters = new Map(mergedParameters ?? []);
      mergedParameters.set(RequestParameterDraft18.TRACK_NAMESPACE_PREFIX, encoded);
    }

    const subscribeTracksMessage: SubscribeTracksMessageDraft18 = {
      type: MessageTypeDraft18.SUBSCRIBE_TRACKS,
      requestId,
      trackNamespacePrefix: namespacePrefix,
      forwardState: options?.forwardState ?? true,
      filter: options?.filter ?? SubscriptionFilterDraft18.NEXT_GROUP_START,
      startLocation: options?.startLocation,
      endGroupDelta: options?.endGroupDelta,
      parameters: mergedParameters,
    };

    const encoded = this.codec.encodeControlMessage(subscribeTracksMessage);
    log.info('Sent SUBSCRIBE_TRACKS (draft-18)', {
      requestId: requestId.toString(),
      prefix: namespacePrefix.join('/'),
    });

    const response = await this.sendRequestAndWaitResponse(encoded, requestId);

    if (response.type === MessageTypeDraft18.REQUEST_ERROR) {
      const error = response as RequestErrorMessageDraft18;
      await this.closeRequestStream(requestId);
      throw new Error(`SUBSCRIBE_TRACKS failed: ${error.reasonPhrase} (code ${error.errorCode})`);
    }

    // Store the namespace subscription for incoming PUBLISH messages
    const subscription: NamespaceSubscriptionInfo = {
      subscriptionId,
      requestId,
      namespacePrefix,
      tracks: new Map(),
      onObject,
    };
    this.namespaceSubscriptions.set(subscriptionId, subscription);
    this.namespaceSubscriptionByRequestId.set(requestId, subscriptionId);

    log.info('SUBSCRIBE_TRACKS accepted (draft-18)', { requestId: requestId.toString() });
    return subscriptionId;
  }

  /**
   * Send REQUEST_UPDATE to change forward state on a subscription (draft-18)
   *
   * @param existingRequestId - Request ID of the subscription being updated
   * @param forwardState - New forward state (true = send objects, false = pause)
   */
  /**
   * Send REQUEST_UPDATE for an existing request (draft-18 §10.9).
   *
   * MUST be sent on the same bidi stream as the original request; the Request
   * ID field is the ID of the request being updated (not a new ID). The
   * receiver MUST respond with exactly one REQUEST_OK or REQUEST_ERROR.
   *
   * When `awaitAck` is false, the update is fire-and-forget. Terminal
   * operations (unsubscribe, FETCH cancel) use this because §10.9.1 lets the
   * responder reset the data stream or close the bidi on failure, and in
   * practice some relays close the stream without sending REQUEST_OK for
   * cancels — awaiting the ack would hang.
   */
  async sendRequestUpdate(
    subscriptionRequestId: bigint | number,
    forwardState: boolean,
    options?: { awaitAck?: boolean; newGroupRequest?: boolean | number },
  ): Promise<void> {
    if (!this.isDraft18) {
      throw new Error('sendRequestUpdate() requires draft-18');
    }
    const rid = typeof subscriptionRequestId === 'bigint' ? subscriptionRequestId : BigInt(subscriptionRequestId);

    const stream = this.activeRequestStreams.get(rid);
    if (!stream) {
      throw new Error(
        `sendRequestUpdate: no active request stream for requestId=${rid.toString()}`,
      );
    }

    // §10.2.13 NEW_GROUP_REQUEST — subscriber asks the publisher to cut a new
    // group. The wire value is a varint; `true` sends 1 (any nonzero triggers).
    const extraParams = new Map<number, Uint8Array>();
    if (options?.newGroupRequest !== undefined && options.newGroupRequest !== false) {
      const val = typeof options.newGroupRequest === 'number' ? options.newGroupRequest : 1;
      extraParams.set(RequestParameterDraft18.NEW_GROUP_REQUEST, MOQTVarInt.encode(BigInt(val)));
    }

    const updateMessage: RequestUpdateMessageDraft18 = {
      type: MessageTypeDraft18.REQUEST_UPDATE,
      requestId: rid,
      forwardState,
      parameters: extraParams.size > 0 ? extraParams : undefined,
    };

    const bytes = this.codec.encodeControlMessage(updateMessage);
    await stream.write(bytes);
    log.info('Sent REQUEST_UPDATE (draft-18)', {
      subscriptionRequestId: rid.toString(),
      forwardState,
      newGroupRequest: options?.newGroupRequest ?? false,
    });

    if (options?.awaitAck === false) {
      return;
    }

    const response = await stream.readMessage();
    if (response.type === MessageTypeDraft18.REQUEST_ERROR) {
      const err = response as RequestErrorMessageDraft18;
      throw new Error(
        `REQUEST_UPDATE failed for requestId=${rid.toString()}: ${err.reasonPhrase} (code ${err.errorCode})`,
      );
    }
    if (response.type !== MessageTypeDraft18.REQUEST_OK) {
      log.warn('Unexpected response to REQUEST_UPDATE (draft-18)', {
        subscriptionRequestId: rid.toString(),
        responseType: response.type,
      });
    } else {
      log.info('REQUEST_UPDATE acknowledged (draft-18)', { subscriptionRequestId: rid.toString() });
    }
  }

  /**
   * Send PUBLISH_DONE to signal end of publishing on a track (draft-18)
   *
   * @param requestId - Request ID of the PUBLISH
   * @param finalGroup - Final group ID
   * @param finalObject - Final object ID
   * @param reasonPhrase - Optional reason phrase (see §10.11)
   * @param statusCode - Optional draft-18 §15.10.3 status code
   *                    (defaults to TRACK_ENDED when the caller supplies no code)
   */
  async sendPublishDone(
    requestId: bigint,
    finalGroup: number,
    finalObject: number,
    reasonPhrase?: string,
    statusCode?: PublishDoneErrorCodeDraft18
  ): Promise<void> {
    if (!this.isDraft18) {
      throw new Error('sendPublishDone() requires draft-18');
    }

    const publishDone: PublishDoneMessageDraft18 = {
      type: MessageTypeDraft18.PUBLISH_DONE,
      requestId,
      finalLocation: { group: BigInt(finalGroup), object: BigInt(finalObject) },
      statusCode: BigInt(statusCode ?? PublishDoneErrorCodeDraft18.TRACK_ENDED),
      reasonPhrase,
    };

    const bytes = this.codec.encodeControlMessage(publishDone);
    await this.doSendControl(bytes);
    // PUBLISH_DONE terminates the incoming subscription; drop routing state so
    // any future REQUEST_UPDATE on this id doesn't route as §10.9.1 by default.
    this.incomingRequestKinds.delete(requestId);
    log.info('Sent PUBLISH_DONE (draft-18)', { requestId: requestId.toString(), finalGroup, finalObject, statusCode: publishDone.statusCode?.toString() });
  }

  /**
   * Send PUBLISH_BLOCKED (draft-18 §10.20).
   *
   * The publisher tells the peer that it cannot open new subgroup streams for
   * `trackAlias` right now because of transport-level flow control. The peer
   * is expected to raise its stream limit; there is no reply.
   */
  async sendPublishBlocked(trackAlias: bigint | number | string): Promise<void> {
    if (!this.isDraft18) {
      throw new Error('sendPublishBlocked() requires draft-18');
    }
    const alias = typeof trackAlias === 'bigint' ? trackAlias : BigInt(trackAlias);
    const message: PublishBlockedMessageDraft18 = {
      type: MessageTypeDraft18.PUBLISH_BLOCKED,
      trackAlias: alias,
    };
    const bytes = this.codec.encodeControlMessage(message);
    await this.doSendControl(bytes);
    log.info('Sent PUBLISH_BLOCKED (draft-18)', { trackAlias: alias.toString() });
  }

  /**
   * Close the session, optionally with a draft-18 §15.10.1 termination code.
   *
   * @param options.code   Session Termination Code (SessionErrorCodeDraft18). Passed to the
   *                       underlying WebTransport `close({ closeCode })`. Defaults to NO_ERROR.
   * @param options.reason Human-readable reason string, forwarded verbatim.
   */
  /**
   * B3 SEC: enforce a per-session resource cap.
   *
   * Called from subscribe/publish/stream-open entry points. If `currentCount`
   * has reached or exceeded `limit`, terminate the session with
   * PROTOCOL_VIOLATION via the existing `close()` path and throw so the
   * caller unwinds without allocating additional state. The `code` on the
   * thrown error is set to `'resource-limit-exceeded'` so callers can
   * distinguish DoS caps from other failures.
   *
   * @internal — this is a security gate, not a public API.
   */
  private enforceResourceLimit(
    what: 'subscriptions' | 'tracks' | 'streams',
    currentCount: number,
    limit: number,
  ): void {
    if (currentCount < limit) return;
    if (!this.resourceCapTripped) {
      this.resourceCapTripped = true;
      log.error('Per-session resource cap exceeded', { what, currentCount, limit });
      // Best-effort session termination. `close()` handles the two transport
      // shapes (main-thread + worker) itself; we don't await here so a caller
      // holding a lock (e.g. an incoming-stream handler) doesn't deadlock.
      void this.close({
        code: SessionErrorCodeDraft18.PROTOCOL_VIOLATION,
        reason: `Peer exceeded ${what} limit (${limit})`,
      }).catch(() => { /* already closing */ });
    }
    const err = new Error(`Per-session ${what} limit ${limit} exceeded`) as Error & { code?: string };
    err.code = 'resource-limit-exceeded';
    throw err;
  }

  async close(options?: { code?: SessionErrorCodeDraft18; reason?: string }): Promise<void> {
    const code = options?.code ?? SessionErrorCodeDraft18.NO_ERROR;
    const reason = options?.reason ?? 'Normal closure';
    this._lastCloseReason = reason;
    this._lastCloseCode = code;
    this.metrics.counter('moq.session.close', 1, {
      remote: 'false',
      code: String(code),
    });
    log.info('Closing session', { code, reason });

    // §13.6.1: cancel the idle/keepalive timer before we tear down the
    // transport, otherwise a stale tick could try to send on a closed
    // stream.
    this.stopIdleTimer();

    // Stop all publications
    for (const [trackAlias] of this.publicationManager) {
      await this.unpublish(trackAlias);
    }

    // Close any remaining GOP streams
    for (const [trackAlias] of this.activeVideoStreams) {
      await this.closeVideoGOPStream(trackAlias);
    }

    // Stop all subscriptions
    for (const sub of this.subscriptionManager.getAll()) {
      await this.unsubscribe(sub.subscriptionId);
    }

    // Clean up transport handlers
    for (const cleanup of this.transportCleanup) {
      cleanup();
    }
    this.transportCleanup = [];

    // Clear managers
    this.subscriptionManager.clear();
    this.publicationManager.clear();
    this.incomingRequestKinds.clear();
    // §8: cancel every pending delivery-timeout so stale timers can't fire
    // after the session is gone.
    this.objectRouter.clearDeliveryTimeouts();
    this.publisherDeliveryTimeouts.clear();

    // Close underlying transport with the draft-18 session termination code.
    if (this.useWorker && this.transportWorker) {
      this.transportWorker.disconnect(code, reason);
    } else if (this.transport) {
      try { await this.transport.close(code, reason); } catch { /* already closed */ }
    }

    this._state = 'none';
    log.info('Session closed');
  }

  /**
   * Reset an outgoing subgroup or fetch stream with a draft-18 §15.10.4 Stream Reset Code.
   *
   * This is the low-level primitive publishers use when they want to signal to the
   * subscriber *why* a data stream ended abnormally (DELIVERY_TIMEOUT, TOO_FAR_BEHIND,
   * EXCESSIVE_LOAD, etc.). If a stream is not tracked, this is a no-op.
   *
   * @param trackAlias The publication whose active GOP/subgroup stream should be reset.
   * @param code       The Stream Reset Code to convey to the peer (§15.10.4).
   * @param reason     Optional human-readable reason string forwarded to `writer.abort()`.
   */
  // ─── §8 publisher-side delivery-timeout helpers ─────────────────────────

  /**
   * Arm a subgroup-delivery deadline for an outgoing publisher stream.
   *
   * Returns the timer key if a timer was armed (so the caller can disarm it
   * on successful completion) or `undefined` if the publication does not
   * have a `deliveryTimeout` configured.
   */
  private armPublisherSubgroupTimer(
    trackAlias: bigint,
    groupId: number,
    subgroupId: number,
  ): string | undefined {
    const aliasKey = trackAlias.toString();
    const config = this.publisherTimeoutConfig.get(aliasKey);
    const ms = config?.subgroupDeliveryTimeoutMs;
    if (!ms || ms <= 0) return undefined;
    const key = `pub-sg:${aliasKey}:${groupId}:${subgroupId}`;
    this.publisherDeliveryTimeouts.arm(key, 'subgroup', ms);
    return key;
  }

  /**
   * Called by the tracker when a publisher-side deadline elapses. Extracts
   * the alias/group/subgroup from the key, aborts the stream (if still
   * open), and emits a `delivery-timeout` event so consumers can react.
   */
  private handlePublisherTimeoutExpiry(
    key: string,
    reason: DeliveryTimeoutReason,
    resetCode: StreamResetErrorCodeDraft18,
  ): void {
    // Keys are `pub-sg:${alias}:${groupId}:${subgroupId}`.
    const parts = key.split(':');
    if (parts[0] !== 'pub-sg' || parts.length < 4) return;
    const aliasKey = parts[1];
    const groupId = Number(parts[2]);
    const subgroupId = Number(parts[3]);

    log.warn('Delivery timeout expired (publisher)', {
      trackAlias: aliasKey,
      groupId,
      subgroupId,
      reason,
      resetCode,
    });

    // Best-effort abort — if a GOP stream is still open for this alias, tear
    // it down with the §15.10.4 DELIVERY_TIMEOUT reset code. If no stream is
    // open, resetPublicationStream is a no-op.
    void this.resetPublicationStream(aliasKey, resetCode, 'delivery-timeout').catch((err) => {
      log.debug('resetPublicationStream on timeout failed', {
        aliasKey,
        error: (err as Error).message,
      });
    });

    this.emit('delivery-timeout', {
      side: 'publisher',
      reason,
      resetCode,
      trackAlias: BigInt(aliasKey),
      groupId,
      subgroupId,
    } as DeliveryTimeoutEvent);
  }

  async resetPublicationStream(
    trackAlias: string,
    code: StreamResetErrorCodeDraft18,
    reason?: string,
  ): Promise<void> {
    const existing = this.activeVideoStreams.get(trackAlias);
    if (!existing) {
      log.debug('resetPublicationStream: no active stream', { trackAlias });
      return;
    }
    // Include the symbolic enum name so the peer sees "TOO_FAR_BEHIND" rather
    // than an opaque number when it inspects the abort reason string.
    const codeName = StreamResetErrorCodeDraft18[code] ?? 'UNKNOWN';
    const abortReason = reason ?? `stream-reset code=${code} (${codeName})`;
    try {
      if (existing.writer) {
        await existing.writer.abort(abortReason);
      } else if (existing.streamId !== undefined && this.transportWorker) {
        // The worker's close-stream path swallows the STOP_SENDING/RESET_STREAM
        // errors from writer.close(); using it here surfaces the same behavior
        // for aborts. A dedicated abort-stream RPC can follow if we ever need
        // to propagate the numeric code down to the QUIC layer.
        this.transportWorker.closeStream(existing.streamId);
      }
      log.info('Reset publication stream', {
        trackAlias,
        code,
        reason: abortReason,
        groupId: existing.groupId,
        objectCount: existing.objectCount,
      });
    } catch (err) {
      log.warn('Error resetting publication stream', {
        trackAlias,
        error: (err as Error).message,
      });
    } finally {
      // B3 SEC: whether abort succeeded or threw, the stream is no longer
      // ours to hold — release the counter slot.
      this.decrementOpenStreamCount();
    }
    // Draft-18 §11.4.3 stream-reset — surface the code + context so consumers
    // (UI, metrics) can distinguish TOO_FAR_BEHIND / EXCESSIVE_LOAD from
    // §8 DELIVERY_TIMEOUT (which uses the `delivery-timeout` event instead).
    try {
      this.emit('stream-reset', {
        side: 'publisher',
        code,
        reason: abortReason,
        trackAlias: BigInt(trackAlias),
        groupId: existing.groupId,
      } as StreamResetEvent);
    } catch { /* alias may not parse as bigint in test fixtures */ }
    this.activeVideoStreams.delete(trackAlias);
  }

  /**
   * Draft-18 §11.4.3 helper — reset a publication's subgroup stream with the
   * §15.10.4 `TOO_FAR_BEHIND` code. Use when a subscriber is lagging past the
   * publisher's cache window and the publisher wants the subscriber to catch
   * up out-of-band (usually by resubscribing with a later filter).
   */
  async resetPublicationStreamTooFarBehind(
    trackAlias: string,
    reason?: string,
  ): Promise<void> {
    return this.resetPublicationStream(
      trackAlias,
      StreamResetErrorCodeDraft18.TOO_FAR_BEHIND,
      reason,
    );
  }

  /**
   * Draft-18 §11.5.1 — send a Padding Stream: a unidirectional stream whose
   * first varint is the reserved PADDING stream type (0x132B3E28) followed by
   * `bytes` zero-filled payload bytes. Receivers MUST discard.
   *
   * Padding is used to obfuscate traffic patterns (e.g. defeat MP-fingerprinting)
   * without polluting the object stream. The type prefix is not counted toward
   * `bytes`; pass 0 to emit just the type varint.
   */
  async sendPaddingStream(bytes: number): Promise<void> {
    if (!this.isDraft18) {
      throw new Error('sendPaddingStream requires draft-18');
    }
    if (!Number.isInteger(bytes) || bytes < 0) {
      throw new RangeError('bytes must be a non-negative integer');
    }
    const typeBytes = MOQTVarInt.encode(BigInt(StreamTypeDraft18.PADDING));
    const payload = new Uint8Array(typeBytes.length + bytes);
    payload.set(typeBytes);
    // Remaining bytes are already zero-initialized by the Uint8Array constructor.
    const streamInfo = await this.doCreateStream();
    await this.doWriteStream(streamInfo, payload, /* close */ true);
  }

  /**
   * Draft-18 §11.5.2 — send a Padding Datagram: a datagram whose first varint
   * is the reserved PADDING datagram type (0x132B3E29) followed by `bytes`
   * zero-filled bytes. Receivers MUST discard.
   */
  async sendPaddingDatagram(bytes: number): Promise<void> {
    if (!this.isDraft18) {
      throw new Error('sendPaddingDatagram requires draft-18');
    }
    if (!Number.isInteger(bytes) || bytes < 0) {
      throw new RangeError('bytes must be a non-negative integer');
    }
    const typeBytes = MOQTVarInt.encode(BigInt(DatagramTypeDraft18.PADDING));
    const datagram = new Uint8Array(typeBytes.length + bytes);
    datagram.set(typeBytes);
    await this.doSendDatagram(datagram);
  }

  /**
   * Subscribe to a track
   *
   * @param namespace - Track namespace
   * @param trackName - Track name
   * @param options - Subscribe options
   * @param onObject - Callback for received objects
   * @param onEndOfGroup - Callback when END_OF_GROUP is received
   * @returns Subscription ID
   */
  async subscribe(
    namespace: string[],
    trackName: string,
    options?: SubscribeOptions,
    onObject?: (data: Uint8Array, groupId: number, objectId: number, timestamp: number) => void,
    onEndOfGroup?: (groupId: number) => void
  ): Promise<number> {
    if (!this.isReady) {
      throw new Error('Session not ready');
    }
    assertNotReservedNamespace(namespace, 'SUBSCRIBE to');

    // B3 SEC: reject before allocating any request/subscription state.
    this.enforceResourceLimit('subscriptions', this.subscriptionManager.size, this.maxSubscriptions);

    // Local counter is small; widen for wire encode and state maps.
    const subscriptionId = this.getNextRequestId();
    const requestId = BigInt(subscriptionId);
    const trackAlias = requestId;

    const fullTrackNameForLog = [...namespace, trackName].join('/');
    log.info('Subscribing', {
      namespace,
      namespaceElements: namespace.length,
      trackName,
      fullTrackName: fullTrackNameForLog,
      subscriptionId,
      trackAlias: trackAlias.toString(),
      isDraft18: this.isDraft18,
    });

    // Create subscription
    const subscription: InternalSubscription = {
      subscriptionId,
      requestId,
      namespace,
      trackName,
      trackAlias,
      paused: false,
      onObject,
      onEndOfGroup,
      subgroupDeliveryTimeoutMs: options?.subgroupDeliveryTimeout,
      objectDeliveryTimeoutMs: options?.objectDeliveryTimeout,
    };
    this.subscriptionManager.add(subscription);

    if (this.isDraft18) {
      // Draft-18: Send SUBSCRIBE on a new bidirectional stream
      await this.subscribeDraft18(requestId, namespace, trackName, trackAlias, options);
    } else {
      // Draft-16 exposes only LATEST_GROUP and ABSOLUTE_START on the wire. Any
      // draft-18-only filter selection collapses to ABSOLUTE_START when it has
      // a start location, otherwise LATEST_GROUP.
      const wantsAbsolute =
        options?.filterType === 'absolute' ||
        options?.filterType === 'absolute-start' ||
        options?.filterType === 'absolute-range';
      const filterType = wantsAbsolute
        ? FilterType.ABSOLUTE_START
        : FilterType.LATEST_GROUP;
      const startGroup = options?.startGroup ?? 0;
      const startObject = options?.startObject ?? 0;

      // Send SUBSCRIBE message (draft-14/16)
      const subscribeMessage: SubscribeMessage = {
        type: MessageType.SUBSCRIBE,
        requestId,
        trackAlias,
        fullTrackName: { namespace, trackName },
        subscriberPriority: options?.priority ?? 128,
        groupOrder: options?.groupOrder ?? GroupOrder.ASCENDING,
        filterType,
        startGroup: filterType === FilterType.ABSOLUTE_START ? BigInt(startGroup) : undefined,
        startObject: filterType === FilterType.ABSOLUTE_START ? BigInt(startObject) : undefined,
        parameters: new Map(),
      };

      // Add per-request auth token if provided
      if (options?.authToken) {
        const authData = this.encodeRequestAuthToken(options.authToken);
        subscribeMessage.parameters!.set(RequestParameter.AUTHORIZATION_TOKEN, authData);
      }

      const subscribeBytes = this.codec.encodeControlMessage(subscribeMessage);

      const hexBytes = Array.from(subscribeBytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
      log.info('SUBSCRIBE bytes', { length: subscribeBytes.length, hex: hexBytes });

      await this.doSendControl(subscribeBytes);
      log.info('Sent SUBSCRIBE message', {
        requestId: requestId.toString(),
        trackAlias: trackAlias.toString(),
        namespace: namespace.join('/'),
        trackName,
      });
      this.emitMessageSent('SUBSCRIBE', subscribeBytes.length, `${namespace.join('/')}/${trackName}`, { requestId: requestId.toString(), trackAlias: trackAlias.toString() });
    }

    log.info('Subscription started', { subscriptionId });
    return subscriptionId;
  }

  /**
   * Draft-18: Subscribe using per-request bidirectional stream
   */
  private async subscribeDraft18(
    requestId: bigint,
    namespace: string[],
    trackName: string,
    trackAlias: bigint,
    options?: SubscribeOptions
  ): Promise<void> {
    const parameters = new Map<number, Uint8Array>();
    addDeliveryTimeoutParams(parameters, options);
    if (options?.authToken) {
      parameters.set(
        RequestParameterDraft18.AUTHORIZATION_TOKEN,
        this.encodeRequestAuthToken(options.authToken),
      );
    }
    // §7 / §10.2 — advertise subscriber-side scheduling hints when the caller
    // provided them. Publisher schedulers use these to derive `sendOrder`.
    if (options?.priority !== undefined) {
      parameters.set(
        RequestParameterDraft18.SUBSCRIBER_PRIORITY,
        new Uint8Array([Math.max(0, Math.min(0xff, Math.floor(options.priority)))]),
      );
    }
    if (options?.groupOrder !== undefined) {
      parameters.set(
        RequestParameterDraft18.GROUP_ORDER,
        new Uint8Array([options.groupOrder === GroupOrder.DESCENDING ? 2 : 1]),
      );
    }

    const { filter, startLocation, endGroupDelta } = mapSubscribeFilter(options);

    const subscribeMessage: SubscribeMessageDraft18 = {
      type: MessageTypeDraft18.SUBSCRIBE,
      requestId,
      trackNamespace: namespace,
      trackName,
      forwardState: true,
      filter,
      startLocation,
      endGroupDelta,
      parameters,
    };

    const encoded = this.codec.encodeControlMessage(subscribeMessage);
    const subHex = Array.from(encoded).map(b => b.toString(16).padStart(2, '0')).join(' ');
    log.info('Sent SUBSCRIBE (draft-18)', {
      requestId: requestId.toString(),
      trackAlias: trackAlias.toString(),
      namespace: namespace.join('/'),
      trackName,
      hex: subHex,
      length: encoded.length,
    });
    this.emitMessageSent('SUBSCRIBE', encoded.length, `${namespace.join('/')}/${trackName}`, { requestId: requestId.toString(), trackAlias: trackAlias.toString() });

    const response = await this.sendRequestAndWaitResponse(encoded, requestId);

    if (response.type === MessageTypeDraft18.SUBSCRIBE_OK) {
      const subscribeOk = response as SubscribeOkMessageDraft18;
      const relayTrackAlias = subscribeOk.trackAlias ?? subscribeOk.requestId;
      log.info('Received SUBSCRIBE_OK (draft-18)', {
        trackAlias: relayTrackAlias.toString(),
        localTrackAlias: trackAlias.toString(),
        largestGroup: subscribeOk.largestLocation.group.toString(),
        largestObject: subscribeOk.largestLocation.object.toString(),
      });
      const sub = this.subscriptionManager.findByRequestId(requestId);
      // Update subscription's track alias to match what relay assigned
      if (sub && relayTrackAlias !== trackAlias) {
        this.subscriptionManager.updateTrackAlias(sub.subscriptionId, relayTrackAlias);
        log.info('Updated subscription trackAlias', {
          subscriptionId: sub.subscriptionId,
          oldAlias: trackAlias.toString(),
          newAlias: relayTrackAlias.toString(),
        });
      }
      if (sub) {
        const largestGroup = subscribeOk.largestLocation.group;
        const largestObject = subscribeOk.largestLocation.object;
        const contentExists = largestGroup > 0n || largestObject > 0n;
        this.emit('subscribe-ok', {
          subscriptionId: sub.subscriptionId,
          requestId,
          trackAlias: relayTrackAlias,
          contentExists,
          largestGroupId: contentExists ? largestGroup : undefined,
          largestObjectId: contentExists ? largestObject : undefined,
          trackProperties: parseTrackProperties(subscribeOk.trackProperties),
        } as SubscribeOkEvent);
      }
    } else if (response.type === MessageTypeDraft18.REQUEST_ERROR) {
      const error = response as RequestErrorMessageDraft18;
      log.error('Received REQUEST_ERROR (draft-18)', {
        requestId: error.requestId.toString(),
        errorCode: error.errorCode,
        reasonPhrase: error.reasonPhrase,
      });
      await this.closeRequestStream(requestId);
      throw new Error(`SUBSCRIBE failed: ${error.reasonPhrase} (code ${error.errorCode})`);
    }
  }

  /**
   * Draft-18: Publish using per-request bidirectional stream
   */
  private async publishDraft18(
    requestId: bigint,
    namespace: string[],
    trackName: string,
    trackAlias: bigint,
    options?: PublishOptions
  ): Promise<void> {
    const trackProperties = buildTrackProperties({
      subgroupDeliveryTimeout: options?.deliveryTimeout,
      maxCacheDuration: options?.maxCacheDuration,
      priority: options?.priority,
      groupOrder: options?.groupOrder,
      priorGroupIdGap: options?.priorGroupIdGap,
      priorObjectIdGap: options?.priorObjectIdGap,
    });
    const publishMessage: PublishMessageDraft18 = {
      type: MessageTypeDraft18.PUBLISH,
      requestId,
      trackAlias,
      trackNamespace: namespace,
      trackName,
      forwardState: true,
      largestLocation: { group: 0n, object: 0n },
      trackProperties,
    };

    const encoded = this.codec.encodeControlMessage(publishMessage);
    const pubHex = Array.from(encoded).map(b => b.toString(16).padStart(2, '0')).join(' ');
    log.info('Sent PUBLISH (draft-18)', {
      requestId: requestId.toString(),
      trackAlias: trackAlias.toString(),
      namespace: namespace.join('/'),
      trackName,
      hex: pubHex,
      length: encoded.length,
    });

    const response = await this.sendRequestAndWaitResponse(encoded, requestId);

    if (response.type === MessageTypeDraft18.REQUEST_OK) {
      const ok = response as RequestOkMessageDraft18;
      const expiresMs = ok.expires !== undefined ? Number(ok.expires) : undefined;
      log.info('Received REQUEST_OK for PUBLISH (draft-18)', { requestId: requestId.toString(), expiresMs });
      this.emit('request-ok', { requestId, requestKind: 'publish', expiresMs } as RequestOkEvent);
      if (!options?.skipForwardWait) {
        log.info('PUBLISH accepted, starting immediately (draft-18)');
      }
    } else if (response.type === MessageTypeDraft18.REQUEST_ERROR) {
      const error = response as RequestErrorMessageDraft18;
      log.error('Received REQUEST_ERROR for PUBLISH (draft-18)', {
        requestId: error.requestId.toString(),
        errorCode: error.errorCode,
        reasonPhrase: error.reasonPhrase,
      });
      await this.closeRequestStream(requestId);
      throw new Error(`PUBLISH failed: ${error.reasonPhrase} (code ${error.errorCode})`);
    }
  }

  /**
   * Unsubscribe from a track
   *
   * @param subscriptionId - Subscription ID to cancel
   */
  async unsubscribe(subscriptionId: number): Promise<void> {
    const subscription = this.subscriptionManager.get(subscriptionId);
    if (!subscription) {
      log.warn('No subscription found', { subscriptionId });
      return;
    }

    log.info('Unsubscribing', { subscriptionId });

    if (this.isDraft18) {
      // Draft-18: Send REQUEST_UPDATE with forwardState=false to unsubscribe.
      // Fire-and-forget: the relay resets the data streams on cancel and
      // may close the bidi without a REQUEST_OK.
      try {
        await this.sendRequestUpdate(subscription.requestId, false, { awaitAck: false });
      } catch (err) {
        log.error('Failed to send REQUEST_UPDATE for unsubscribe', { error: (err as Error).message });
      }
      // Terminate the per-request bidi stream now that the subscription is gone.
      await this.closeRequestStream(subscription.requestId);
    } else {
      // Draft-14/16: Send UNSUBSCRIBE message
      const unsubscribeMessage = {
        type: MessageType.UNSUBSCRIBE as const,
        requestId: BigInt(subscription.requestId),
      };

      try {
        const unsubscribeBytes = this.codec.encodeControlMessage(unsubscribeMessage);
        await this.doSendControl(unsubscribeBytes);
        log.info('Sent UNSUBSCRIBE message', { requestId: subscription.requestId });
      } catch (err) {
        log.error('Failed to send UNSUBSCRIBE message', { error: (err as Error).message });
      }
    }

    // Remove from manager
    this.subscriptionManager.remove(subscriptionId);
    log.info('Unsubscribed', { subscriptionId });
  }

  // ============================================================================
  // FETCH Methods (DVR/Rewind Support)
  // ============================================================================

  /**
   * Fetch historical objects from a track
   *
   * Use this to request a specific range of past objects for DVR/rewind functionality.
   * Objects are delivered via 'fetch-object' events, completion via 'fetch-complete'.
   *
   * @param namespace - Track namespace
   * @param trackName - Track name
   * @param range - Range of objects to fetch (startGroup/Object to endGroup/Object)
   * @param options - Fetch options
   * @param onObject - Optional callback for received objects
   * @returns Fetch request ID
   *
   * @example
   * ```typescript
   * // Fetch objects from group 10 to group 20
   * const fetchId = await session.fetch(
   *   ['conference', 'room-1', 'media'],
   *   'video',
   *   { startGroup: 10, startObject: 0, endGroup: 20, endObject: 0 },
   *   {},
   *   (data, groupId, objectId) => {
   *     console.log('Fetched object:', { groupId, objectId, bytes: data.length });
   *   }
   * );
   *
   * // Listen for completion
   * session.on('fetch-complete', (event) => {
   *   if (event.requestId === fetchId) {
   *     console.log('Fetch complete, largest group:', event.largestGroupId);
   *   }
   * });
   * ```
   */
  async fetch(
    namespace: string[],
    trackName: string,
    range: FetchRange,
    options?: FetchOptions,
    onObject?: (data: Uint8Array, groupId: number, objectId: number) => void
  ): Promise<bigint> {
    if (!this.isReady) {
      throw new Error('Session not ready');
    }
    assertNotReservedNamespace(namespace, 'FETCH from');

    // Local counter is a small `number` (starts at 0/1, +2 per draft-16/18 request).
    // Widen to `bigint` immediately so downstream state, wire encode, and callback
    // comparisons all operate on the 62-bit varint type — no silent precision loss
    // for long-lived sessions.
    const requestId = BigInt(this.getNextRequestId());
    const fullTrackNameStr = [...namespace, trackName].join('/');

    log.info('Fetching historical objects', {
      namespace: namespace.join('/'),
      trackName,
      fullTrackName: fullTrackNameStr,
      range,
      requestId: requestId.toString(),
    });

    // Create fetch info
    const fetchInfo: FetchInfo = {
      requestId,
      namespace,
      trackName,
      range,
      completed: false,
    };
    this.activeFetches.set(requestId, fetchInfo);

    // Register object callback before wire send so no deliveries race us.
    if (onObject) {
      const handler = (event: FetchObjectEvent) => {
        if (event.requestId === requestId) {
          onObject(event.data, event.groupId, event.objectId);
        }
      };
      this.on('fetch-object', handler);
    }

    if (this.isDraft18) {
      await this.fetchDraft18(requestId, namespace, trackName, range, options);
    } else {
      // Draft-16 §7.4 End Location is exclusive on the wire: endObject == 0
      // means the whole End Group; endObject == N means objects 0..N-1. The
      // public FetchRange.endObject is inclusive, but callers use the sentinel
      // 0 to mean "whole group" (the spec's own semantics), so we only apply
      // the inclusive→exclusive +1 when the caller provided a specific object
      // index. See the matching draft-18 conversion in fetchDraft18() below.
      const wireEndObject = range.endObject === 0 ? 0 : range.endObject + 1;
      const fetchMessage: FetchMessage = {
        type: MessageType.FETCH,
        requestId,
        fullTrackName: { namespace, trackName },
        subscriberPriority: options?.priority ?? 128,
        groupOrder: options?.groupOrder ?? GroupOrder.ASCENDING,
        startGroup: BigInt(range.startGroup),
        startObject: BigInt(range.startObject),
        endGroup: BigInt(range.endGroup),
        endObject: BigInt(wireEndObject),
        parameters: new Map(),
      };

      const fetchBytes = this.codec.encodeControlMessage(fetchMessage);
      const hexBytes = Array.from(fetchBytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
      log.info('FETCH bytes', { length: fetchBytes.length, hex: hexBytes });

      await this.doSendControl(fetchBytes);
      log.info('Sent FETCH message', {
        requestId: requestId.toString(),
        namespace: namespace.join('/'),
        trackName,
        range,
      });
      this.emitMessageSent('FETCH', fetchBytes.length, `${namespace.join('/')}/${trackName} (${range.startGroup},${range.startObject})-(${range.endGroup},${range.endObject})`, { requestId: requestId.toString(), range });
    }

    return requestId;
  }

  /**
   * Draft-18: FETCH on a per-request bidirectional stream (spec §7.4).
   *
   * Sends FETCH, then reads the peer's response on the same bidi stream.
   * FETCH_OK / REQUEST_OK completes the request and lets the relay open a
   * unidirectional data stream (FETCH_HEADER 0x05) for the objects.
   * REQUEST_ERROR surfaces failure via the fetch-error event.
   */
  private async fetchDraft18(
    requestId: bigint,
    namespace: string[],
    trackName: string,
    range: FetchRange,
    options?: FetchOptions,
  ): Promise<void> {
    // Draft-18 endLocation is *exclusive* per spec §7.5 (relays such as moxygen
    // decrement the object component to derive the inclusive "last" location).
    // The API's FetchRange.endObject is inclusive, so we bump the wire value
    // by one before encoding. `endObject == 0` is the caller's "whole End
    // Group" sentinel (also spec-compliant on the wire), so leave it as 0.
    const fetchType = options?.fetchType ?? FetchTypeDraft18.STANDALONE;
    const isJoining =
      fetchType === FetchTypeDraft18.JOINING_RELATIVE ||
      fetchType === FetchTypeDraft18.JOINING_ABSOLUTE;
    if (isJoining && options?.subscribeRequestId === undefined) {
      throw new Error('Joining FETCH requires options.subscribeRequestId');
    }
    const parameters = new Map<number, Uint8Array>();
    addDeliveryTimeoutParams(parameters, options);
    if (options?.authToken) {
      parameters.set(
        RequestParameterDraft18.AUTHORIZATION_TOKEN,
        this.encodeRequestAuthToken(options.authToken),
      );
    }
    const fetchMessage: FetchMessageDraft18 = {
      type: MessageTypeDraft18.FETCH,
      requestId,
      fetchType,
      joiningFlag: isJoining,
      subscribeRequestId: options?.subscribeRequestId,
      joiningStart: options?.joiningStart ?? 0n,
      trackNamespace: namespace,
      trackName,
      subscriberPriority: options?.priority ?? 128,
      groupOrder: options?.groupOrder ?? GroupOrder.ASCENDING,
      startLocation: {
        group: BigInt(range.startGroup),
        object: BigInt(range.startObject),
      },
      endLocation: {
        group: BigInt(range.endGroup),
        object: BigInt(range.endObject === 0 ? 0 : range.endObject + 1),
      },
      parameters: parameters.size > 0 ? parameters : undefined,
    };

    const encoded = this.codec.encodeControlMessage(fetchMessage);
    const fetchHex = Array.from(encoded).map(b => b.toString(16).padStart(2, '0')).join(' ');
    log.info('Sent FETCH (draft-18)', {
      requestId: requestId.toString(),
      namespace: namespace.join('/'),
      trackName,
      range,
      hex: fetchHex,
      length: encoded.length,
    });
    this.emitMessageSent('FETCH', encoded.length, `${namespace.join('/')}/${trackName} (${range.startGroup},${range.startObject})-(${range.endGroup},${range.endObject})`, { requestId: requestId.toString(), range });

    const response = await this.sendRequestAndWaitResponse(encoded, requestId);

    if (response.type === MessageTypeDraft18.FETCH_OK) {
      const fetchOk = response as _FetchOkMessageDraft18;
      log.info('Received FETCH_OK (draft-18)', {
        requestId: requestId.toString(),
        endGroup: fetchOk.endLocation.group.toString(),
        endObject: fetchOk.endLocation.object.toString(),
        endOfTrack: fetchOk.endOfTrack,
      });
      const info = this.activeFetches.get(requestId);
      if (info) {
        info.completed = true;
        info.largestGroupId = fetchOk.endLocation.group;
        info.largestObjectId = fetchOk.endLocation.object;
        info.endOfTrack = fetchOk.endOfTrack;
      }
      this.emit('fetch-complete', {
        requestId,
        largestGroupId: fetchOk.endLocation.group,
        largestObjectId: fetchOk.endLocation.object,
        endOfTrack: fetchOk.endOfTrack,
      } as FetchCompleteEvent);
    } else if (response.type === MessageTypeDraft18.REQUEST_OK) {
      // Some relays send REQUEST_OK to accept the fetch and later stream data.
      const ok = response as RequestOkMessageDraft18;
      const expiresMs = ok.expires !== undefined ? Number(ok.expires) : undefined;
      log.info('Received REQUEST_OK for FETCH (draft-18)', { requestId: requestId.toString(), expiresMs });
      this.emit('request-ok', { requestId, requestKind: 'fetch', expiresMs } as RequestOkEvent);
    } else if (response.type === MessageTypeDraft18.REQUEST_ERROR) {
      const error = response as RequestErrorMessageDraft18;
      log.error('Received REQUEST_ERROR for FETCH (draft-18)', {
        requestId: requestId.toString(),
        errorCode: error.errorCode,
        reasonPhrase: error.reasonPhrase,
      });
      this.activeFetches.delete(requestId);
      await this.closeRequestStream(requestId);
      this.emit('fetch-error', {
        requestId,
        errorCode: error.errorCode,
        reason: error.reasonPhrase,
      } as FetchErrorEvent);
    } else {
      log.warn('Unexpected response to FETCH (draft-18)', {
        requestId: requestId.toString(),
        responseType: response.type,
      });
    }
  }

  /**
   * Cancel an in-progress fetch
   *
   * @param requestId - Fetch request ID to cancel
   */
  async cancelFetch(requestId: bigint | number): Promise<void> {
    const rid = typeof requestId === 'bigint' ? requestId : BigInt(requestId);
    const fetchInfo = this.activeFetches.get(rid);
    if (!fetchInfo) {
      log.warn('No fetch found to cancel', { requestId: rid.toString() });
      return;
    }

    log.info('Cancelling fetch', { requestId: rid.toString() });

    if (this.isDraft18) {
      // Draft-18 has no FETCH_CANCEL message; the equivalent is REQUEST_UPDATE
      // with forwardState=false, which terminates delivery for this requestId.
      // The relay resets the fetch data stream in response; fire-and-forget.
      try {
        await this.sendRequestUpdate(rid, false, { awaitAck: false });
        log.info('Sent REQUEST_UPDATE (forwardState=false) as FETCH cancel (draft-18)', { requestId: rid.toString() });
      } catch (err) {
        log.error('Failed to send REQUEST_UPDATE for FETCH cancel', { error: (err as Error).message });
      }
      await this.closeRequestStream(rid);
    } else {
      // Draft-14/16 send a dedicated FETCH_CANCEL message.
      const cancelMessage: FetchCancelMessage = {
        type: MessageType.FETCH_CANCEL,
        requestId: rid,
      };

      try {
        const cancelBytes = this.codec.encodeControlMessage(cancelMessage);
        await this.doSendControl(cancelBytes);
        log.info('Sent FETCH_CANCEL message', { requestId: rid.toString() });
      } catch (err) {
        log.error('Failed to send FETCH_CANCEL message', { error: (err as Error).message });
      }
    }

    // Remove from active fetches
    this.activeFetches.delete(rid);
    this.fetchStreamBuffers.delete(rid);
    log.info('Fetch cancelled', { requestId: rid.toString() });
  }

  /**
   * Get active fetch info
   */
  getFetch(requestId: bigint | number): FetchInfo | undefined {
    const rid = typeof requestId === 'bigint' ? requestId : BigInt(requestId);
    return this.activeFetches.get(rid);
  }

  /**
   * Get all active fetches
   */
  getActiveFetches(): FetchInfo[] {
    return Array.from(this.activeFetches.values());
  }

  // ============================================================================
  // Track Status (for live edge tracking)
  // ============================================================================

  /**
   * Request the current status of a track
   *
   * Used to determine the live edge position for DVR/trick play.
   * Returns the last known group and object IDs if the track is in progress.
   *
   * @param namespace - Track namespace
   * @param trackName - Track name
   * @param timeoutMs - Timeout in milliseconds (default: 5000)
   * @returns Track status info including lastGroupId and lastObjectId
   *
   * @example
   * ```typescript
   * const status = await session.requestTrackStatus(
   *   ['conference', 'meeting123'],
   *   'video'
   * );
   * if (status.statusCode === TrackStatusCode.IN_PROGRESS) {
   *   console.log('Live edge:', status.lastGroupId, status.lastObjectId);
   * }
   * ```
   */
  async requestTrackStatus(
    namespace: string[],
    trackName: string,
    timeoutMs = 5000
  ): Promise<TrackStatusOkMessage> {
    if (!this.isReady) {
      throw new Error('Session not ready');
    }

    // Local counter is small; widen to bigint for wire varint + state map key.
    const requestId = BigInt(this.getNextRequestId());

    log.info('Requesting track status', {
      namespace: namespace.join('/'),
      trackName,
      requestId: requestId.toString(),
    });

    // Build TRACK_STATUS message
    const trackStatusMessage: TrackStatusMessage = {
      type: MessageType.TRACK_STATUS,
      requestId,
      fullTrackName: { namespace, trackName },
    };

    const bytes = this.codec.encodeControlMessage(trackStatusMessage);
    await this.doSendControl(bytes);

    log.info('Sent TRACK_STATUS message', { requestId: requestId.toString() });

    // Wait for TRACK_STATUS_OK or TRACK_STATUS_ERROR
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.trackStatusCallbacks.delete(requestId);
        reject(new Error(`TRACK_STATUS request ${requestId.toString()} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.trackStatusCallbacks.set(requestId, {
        resolve: (status: TrackStatusOkMessage) => {
          clearTimeout(timer);
          this.trackStatusCallbacks.delete(requestId);
          resolve(status);
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          this.trackStatusCallbacks.delete(requestId);
          reject(error);
        },
      });
    });
  }

  /**
   * Subscribe to a namespace prefix
   *
   * When subscribed to a namespace, you receive PUBLISH messages from publishers
   * announcing tracks under that namespace. Respond with PUBLISH_OK to start
   * receiving objects on those tracks.
   *
   * @param namespacePrefix - Namespace prefix to subscribe to
   * @param options - Subscribe options
   * @returns Namespace subscription ID
   */
  async subscribeNamespace(
    namespacePrefix: string[],
    _options?: SubscribeNamespaceOptions
  ): Promise<number> {
    if (!this.isReady) {
      throw new Error('Session not ready');
    }
    assertNotReservedNamespace(namespacePrefix, 'SUBSCRIBE_NAMESPACE for');

    // Local counter is small; widen for wire encode and state maps.
    const subscriptionId = this.getNextRequestId();
    const requestId = BigInt(subscriptionId);
    const prefixStr = namespacePrefix.join('/');

    log.info('Subscribing to namespace', { namespacePrefix: prefixStr, requestId: requestId.toString() });

    // Store namespace subscription
    const subscription: NamespaceSubscriptionInfo = {
      subscriptionId,
      requestId,
      namespacePrefix,
      tracks: new Map(),
      onObject: _options?.onObject,
      expires: _options?.expires,
    };
    this.namespaceSubscriptions.set(subscriptionId, subscription);
    this.namespaceSubscriptionByRequestId.set(requestId, subscriptionId);

    if (this.isDraft18) {
      // Draft-18: Send SUBSCRIBE_NAMESPACE on per-request bidi stream
      await this.subscribeNamespaceDraft18(requestId, namespacePrefix, subscriptionId);
    } else {
      // Build SUBSCRIBE_NAMESPACE message
      const message = {
        type: MessageType.SUBSCRIBE_NAMESPACE as const,
        requestId,
        namespacePrefix,
        subscribeOptions: 0x00,
      };

      const bytes = this.codec.encodeControlMessage(message);

      // Draft-16: SUBSCRIBE_NAMESPACE must be sent on a new bidirectional stream
      if (this.isDraft16) {
        if (this.useWorker && this.transportWorker) {
          const streamId = await this.transportWorker.createBidiStream();
          this.transportWorker.writeStream(streamId, bytes, false);
          this.namespaceSubscriptionStreams.set(subscriptionId, streamId);
          console.warn('[MOQT-DIAG] Sent SUBSCRIBE_NAMESPACE on bidi stream (worker)', { prefix: prefixStr, requestId: requestId.toString(), streamId, subscriptionId });
          log.info('Sent SUBSCRIBE_NAMESPACE on bidi stream (worker)', { namespacePrefix: prefixStr, requestId: requestId.toString(), streamId });
        } else if (this.transport) {
          const bidiStream = await this.transport.createBidirectionalStream();
          const writer = bidiStream.writable.getWriter();
          await writer.write(bytes);
          writer.releaseLock();
          this.readNamespaceSubscriptionStream(bidiStream.readable, subscriptionId).catch(err => {
            log.error('Error reading namespace subscription stream', { error: (err as Error).message });
          });
          log.info('Sent SUBSCRIBE_NAMESPACE on bidi stream', { namespacePrefix: prefixStr, requestId: requestId.toString() });
        }
      } else {
        // Draft-14: send on control stream
        await this.doSendControl(bytes);
        log.info('Sent SUBSCRIBE_NAMESPACE on control stream', { namespacePrefix: prefixStr, requestId: requestId.toString() });
      }
    }

    return subscriptionId;
  }

  /**
   * Read responses from a namespace subscription bidirectional stream
   * Optimized to minimize buffer copies using chunked accumulation
   */
  private async readNamespaceSubscriptionStream(
    readable: ReadableStream<Uint8Array>,
    subscriptionId: number
  ): Promise<void> {
    const reader = readable.getReader();
    const chunks: Uint8Array[] = [];
    let totalLength = 0;
    let offset = 0;

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value || value.length === 0) continue;

        // Accumulate chunks without copying
        chunks.push(value);
        totalLength += value.length;

        // Try to decode messages from accumulated chunks
        const availableBytes = totalLength - offset;
        if (availableBytes === 0) continue;

        // Concatenate only when needed for decoding
        let buffer: Uint8Array;
        if (chunks.length === 1 && offset === 0) {
          buffer = chunks[0];
        } else {
          buffer = new Uint8Array(availableBytes);
          let writePos = 0;
          let skip = offset;
          for (const chunk of chunks) {
            if (skip >= chunk.length) {
              skip -= chunk.length;
              continue;
            }
            const src = skip > 0 ? chunk.subarray(skip) : chunk;
            buffer.set(src, writePos);
            writePos += src.length;
            skip = 0;
          }
        }

        // Decode messages
        let consumed = 0;
        while (consumed < buffer.length) {
          try {
            const view = buffer.subarray(consumed);
            const [message, bytesRead] = this.codec.decodeControlMessage(view, 0, this.metrics);
            consumed += bytesRead;

            log.info('Received message on namespace subscription stream', {
              type: MessageType[message.type],
              subscriptionId,
            });

            this.routeMessage(message as ControlMessage);
          } catch (err) {
            if ((err as Error).message?.includes('Incomplete') ||
                (err as Error).message?.includes('buffer')) {
              break;
            }
            throw err;
          }
        }

        // Update offset and compact if needed
        offset += consumed;
        if (offset > 4096) {
          const remaining = totalLength - offset;
          if (remaining === 0) {
            chunks.length = 0;
            totalLength = 0;
            offset = 0;
          } else {
            const leftover = buffer.subarray(consumed);
            chunks.length = 0;
            chunks.push(new Uint8Array(leftover));
            totalLength = leftover.length;
            offset = 0;
          }
        }
      }
    } catch (err) {
      log.error('Namespace subscription stream error', { error: (err as Error).message });
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Draft-18: Subscribe to namespace on per-request bidi stream
   */
  private async subscribeNamespaceDraft18(
    requestId: bigint,
    namespacePrefix: string[],
    subscriptionId: number
  ): Promise<void> {
    const prefixStr = namespacePrefix.join('/');

    const subscribeNsMessage: SubscribeNamespaceMessageDraft18 = {
      type: MessageTypeDraft18.SUBSCRIBE_NAMESPACE,
      requestId,
      trackNamespacePrefix: namespacePrefix,
    };

    const encoded = this.codec.encodeControlMessage(subscribeNsMessage);

    if (this.useWorker && this.transportWorker) {
      const streamId = await this.transportWorker.createBidiStream();
      this.transportWorker.writeStream(streamId, encoded);
      log.info('Sent SUBSCRIBE_NAMESPACE (draft-18) via worker', { namespacePrefix: prefixStr, requestId: requestId.toString(), streamId });

      // Create a ReadableStream for the bidi response
      const readable = new ReadableStream<Uint8Array>({
        start: (controller) => {
          this.incomingBidiControllers.set(streamId, controller);
        },
      });
      this.namespaceSubscriptionStreams.set(subscriptionId, streamId);
      this.readNamespaceSubscriptionStreamDraft18(readable, subscriptionId).catch(err => {
        log.error('Error reading namespace subscription stream (draft-18)', { error: (err as Error).message });
      });
    } else if (this.transport) {
      const { readable, writable } = await this.transport.createRequestStream();
      const writer = writable.getWriter();
      await writer.write(encoded);
      writer.releaseLock();
      log.info('Sent SUBSCRIBE_NAMESPACE (draft-18)', { namespacePrefix: prefixStr, requestId: requestId.toString() });

      this.readNamespaceSubscriptionStreamDraft18(readable, subscriptionId).catch(err => {
        log.error('Error reading namespace subscription stream (draft-18)', { error: (err as Error).message });
      });
    } else {
      throw new Error('No transport available');
    }
  }

  /**
   * Read namespace subscription responses (draft-18)
   */
  private async readNamespaceSubscriptionStreamDraft18(
    readable: ReadableStream<Uint8Array>,
    subscriptionId: number
  ): Promise<void> {
    const reader = readable.getReader();
    const chunks: Uint8Array[] = [];
    let totalLength = 0;
    let offset = 0;

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value || value.length === 0) continue;

        chunks.push(value);
        totalLength += value.length;

        const availableBytes = totalLength - offset;
        if (availableBytes === 0) continue;

        // Build buffer from chunks
        let buffer: Uint8Array;
        if (chunks.length === 1 && offset === 0) {
          buffer = chunks[0];
        } else {
          buffer = new Uint8Array(availableBytes);
          let writePos = 0;
          let skip = offset;
          for (const chunk of chunks) {
            if (skip >= chunk.length) { skip -= chunk.length; continue; }
            const src = skip > 0 ? chunk.subarray(skip) : chunk;
            buffer.set(src, writePos);
            writePos += src.length;
            skip = 0;
          }
        }

        // Decode messages
        let consumed = 0;
        while (consumed < buffer.length) {
          try {
            const view = buffer.subarray(consumed);
            const [message, bytesRead] = this.codec.decodeControlMessage(view, 0, this.metrics);
            consumed += bytesRead;

            log.info('Received message on namespace subscription stream (draft-18)', {
              type: MessageTypeDraft18[message.type],
              subscriptionId,
            });

            this.routeMessageDraft18(message as ControlMessageDraft18, subscriptionId);
          } catch (err) {
            if ((err as Error).message?.includes('Incomplete') || (err as Error).message?.includes('buffer')) {
              break;
            }
            throw err;
          }
        }

        offset += consumed;
        if (offset > 4096) {
          const remaining = totalLength - offset;
          if (remaining === 0) {
            chunks.length = 0; totalLength = 0; offset = 0;
          } else {
            const leftover = buffer.subarray(consumed);
            chunks.length = 0;
            chunks.push(new Uint8Array(leftover));
            totalLength = leftover.length;
            offset = 0;
          }
        }
      }
    } catch (err) {
      log.error('Namespace subscription stream error (draft-18)', { error: (err as Error).message });
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Route a draft-18 message received on a namespace subscription stream
   */
  private routeMessageDraft18(message: ControlMessageDraft18, subscriptionId: number): void {
    switch (message.type) {
      case MessageTypeDraft18.REQUEST_OK: {
        const ok = message as RequestOkMessageDraft18;
        const expiresMs = ok.expires !== undefined ? Number(ok.expires) : undefined;
        const sub = this.namespaceSubscriptions.get(subscriptionId);
        log.info('Namespace subscription accepted (draft-18)', {
          subscriptionId,
          requestId: sub?.requestId,
          expiresMs,
        });
        if (sub) {
          this.emit('request-ok', {
            requestId: sub.requestId,
            requestKind: 'subscribe-namespace',
            expiresMs,
          } as RequestOkEvent);
        }
        break;
      }

      case MessageTypeDraft18.REQUEST_ERROR: {
        const error = message as RequestErrorMessageDraft18;
        log.error('Namespace subscription rejected (draft-18)', {
          errorCode: error.errorCode,
          reasonPhrase: error.reasonPhrase,
        });
        const failedSub = this.namespaceSubscriptions.get(subscriptionId);
        this.namespaceSubscriptions.delete(subscriptionId);
        this.emit('namespace-error', {
          kind: 'subscribe-namespace',
          namespace: failedSub?.namespacePrefix ?? [],
          errorCode: error.errorCode,
          reasonPhrase: error.reasonPhrase,
          requestId: Number(error.requestId),
        });
        break;
      }

      case MessageTypeDraft18.NAMESPACE: {
        const nsMsg = message as NamespaceMessageDraft18;
        const subscription = this.namespaceSubscriptions.get(subscriptionId);
        // Wire carries the suffix relative to the subscribed prefix; the
        // absolute namespace is prefix ++ suffix.
        const absolute = subscription
          ? [...subscription.namespacePrefix, ...nsMsg.trackNamespace]
          : nsMsg.trackNamespace;
        log.info('Received NAMESPACE announcement (draft-18)', {
          namespace: absolute.join('/'),
          subscriptionId,
        });
        this.emit('namespace-announced', {
          namespaceSubscriptionId: subscriptionId,
          namespace: absolute,
        });
        break;
      }

      case MessageTypeDraft18.NAMESPACE_DONE: {
        const nsDone = message as NamespaceDoneMessageDraft18;
        const subscription = this.namespaceSubscriptions.get(subscriptionId);
        const absolute = subscription
          ? [...subscription.namespacePrefix, ...nsDone.finalNamespace]
          : nsDone.finalNamespace;
        log.info('Received NAMESPACE_DONE (draft-18)', {
          namespace: absolute.join('/'),
          subscriptionId,
        });
        this.emit('namespace-done', {
          namespaceSubscriptionId: subscriptionId,
          namespace: absolute,
        });
        break;
      }

      case MessageTypeDraft18.PUBLISH: {
        // Server sends PUBLISH to announce a track under the subscribed namespace
        const pubMsg = message as PublishMessageDraft18;
        this.handleIncomingPublishDraft18(pubMsg, new WritableStream()).catch(err => {
          log.error('Error handling PUBLISH from namespace stream', { error: (err as Error).message });
        });
        break;
      }

      default:
        log.warn('Unhandled message on namespace subscription stream', { type: message.type });
    }
  }

  /**
   * Unsubscribe from a namespace
   *
   * @param subscriptionId - Namespace subscription ID
   */
  async unsubscribeNamespace(subscriptionId: number): Promise<void> {
    const subscription = this.namespaceSubscriptions.get(subscriptionId);
    if (!subscription) {
      log.warn('Namespace subscription not found', { subscriptionId });
      return;
    }

    const prefixStr = subscription.namespacePrefix.join('/');
    log.info('Unsubscribing from namespace', { namespacePrefix: prefixStr });

    // Send UNSUBSCRIBE_NAMESPACE
    const message = {
      type: MessageType.UNSUBSCRIBE_NAMESPACE as const,
      namespacePrefix: subscription.namespacePrefix,
    };

    try {
      const bytes = this.codec.encodeControlMessage(message);
      await this.doSendControl(bytes);
      log.info('Sent UNSUBSCRIBE_NAMESPACE', { namespacePrefix: prefixStr });
    } catch (err) {
      log.error('Failed to send UNSUBSCRIBE_NAMESPACE', { error: (err as Error).message });
    }

    // Clean up
    this.namespaceSubscriptionByRequestId.delete(subscription.requestId);
    this.namespaceSubscriptions.delete(subscriptionId);
  }

  removeNamespaceSubscription(subscriptionId: number): void {
    const subscription = this.namespaceSubscriptions.get(subscriptionId);
    if (!subscription) return;
    this.namespaceSubscriptionByRequestId.delete(subscription.requestId);
    this.namespaceSubscriptions.delete(subscriptionId);
  }

  /**
   * Set own namespace prefix for filtering out self-publishes
   */
  setOwnNamespacePrefix(prefix: string): void {
    this.ownNamespacePrefix = prefix;
  }

  /**
   * Get all namespace subscriptions
   */
  getNamespaceSubscriptions(): NamespaceSubscriptionInfo[] {
    return Array.from(this.namespaceSubscriptions.values());
  }

  /**
   * Get all track subscriptions
   */
  getSubscriptions(): InternalSubscription[] {
    return this.subscriptionManager.getAll();
  }

  /**
   * Set or update the onObject callback for a subscription
   */
  setSubscriptionCallback(
    subscriptionId: number,
    onObject: (data: Uint8Array, groupId: number, objectId: number, timestamp: number) => void
  ): void {
    const subscription = this.subscriptionManager.get(subscriptionId);
    if (subscription) {
      subscription.onObject = onObject;
      // Flush any objects that arrived before the callback was set
      if (subscription.pendingObjects && subscription.pendingObjects.length > 0) {
        const pending = subscription.pendingObjects;
        subscription.pendingObjects = undefined;
        for (const obj of pending) {
          onObject(obj.data, obj.groupId, obj.objectId, obj.timestamp);
        }
      }
      log.debug('Updated subscription callback', { subscriptionId });
    } else {
      log.warn('Cannot set callback: subscription not found', { subscriptionId });
    }
  }

  /**
   * Publish to a track
   *
   * @param namespace - Track namespace
   * @param trackName - Track name
   * @param options - Publish options
   * @returns Track alias
   */
  async publish(
    namespace: string[],
    trackName: string,
    options?: PublishOptions
  ): Promise<bigint> {
    if (!this.isReady) {
      throw new Error('Session not ready');
    }
    assertNotReservedNamespace(namespace, 'PUBLISH');

    // B3 SEC: reject before allocating any request/publication state.
    this.enforceResourceLimit('tracks', this.publicationManager.size, this.maxTracks);

    // Check for existing subscription with same track name to use its alias.
    // Local counter is small; widen to bigint for wire varint and state keys.
    const requestId = BigInt(this.getNextRequestId());
    let trackAlias = requestId;
    const fullTrackName = [...namespace, trackName].join('/');

    const existingSub = this.subscriptionManager.getByTrackName(namespace, trackName);
    if (existingSub && existingSub.trackAlias !== undefined) {
      trackAlias = existingSub.trackAlias;
      log.info('Using track alias from existing subscription', {
        trackAlias: trackAlias.toString(),
        fullTrackName,
      });
    }
    const priority = options?.priority ?? 128;
    const deliveryTimeout = options?.deliveryTimeout ?? 5000;
    const deliveryMode = options?.deliveryMode ?? 'stream';
    const audioDeliveryMode = options?.audioDeliveryMode ?? 'datagram';

    log.info('Starting publish', {
      namespace,
      namespaceElements: namespace.length,
      trackName,
      trackAlias: trackAlias.toString(),
      fullTrackName,
    });

    // Build parameters
    const parameters = new Map<RequestParameter, Uint8Array>();
    if (deliveryTimeout > 0) {
      const writer = new BufferWriter();
      writer.writeVarInt(deliveryTimeout);
      parameters.set(RequestParameter.DELIVERY_TIMEOUT, writer.toUint8Array());
    }
    if (options?.maxCacheDuration !== undefined && options.maxCacheDuration > 0) {
      const writer = new BufferWriter();
      writer.writeVarInt(options.maxCacheDuration);
      parameters.set(RequestParameter.MAX_CACHE_DURATION, writer.toUint8Array());
    }

    // Add per-request auth token if provided
    if (options?.authToken) {
      const authData = this.encodeRequestAuthToken(options.authToken);
      parameters.set(RequestParameter.AUTHORIZATION_TOKEN, authData);
    }

    // Create publication (forward state will be set after PUBLISH_OK)
    const publication: InternalPublication = {
      trackAlias,
      namespace,
      trackName,
      priority,
      deliveryMode,
      audioDeliveryMode,
      requestId,
      cleanupHandlers: [],
      forward: 0, // Will be updated after PUBLISH_OK
    };
    this.publicationManager.add(publication);

    // §8: remember the publisher-side subgroup delivery deadline so
    // sendObjectViaStream / sendObjectWithGOP can arm timers per stream.
    if (deliveryTimeout > 0) {
      this.publisherTimeoutConfig.set(trackAlias.toString(), {
        subgroupDeliveryTimeoutMs: deliveryTimeout,
      });
    }

    if (this.isDraft18) {
      await this.publishDraft18(requestId, namespace, trackName, trackAlias, options);
    } else {
      // Send PUBLISH message
      const publishMessage: PublishMessage = {
        type: MessageType.PUBLISH,
        requestId,
        fullTrackName: { namespace, trackName },
        trackAlias,
        groupOrder: options?.groupOrder ?? GroupOrder.ASCENDING,
        contentExists: false,
        forward: 1,
        parameters,
      };

      log.info('PUBLISH with parameters', {
        deliveryTimeout,
        priority,
        hasDeliveryTimeoutParam: parameters.has(RequestParameter.DELIVERY_TIMEOUT),
      });

      const publishBytes = this.codec.encodeControlMessage(publishMessage);

      const hexBytes = Array.from(publishBytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
      log.info('PUBLISH bytes', { length: publishBytes.length, hex: hexBytes });

      await this.doSendControl(publishBytes);
      log.info('Sent PUBLISH message', {
        requestId: requestId.toString(),
        trackAlias: trackAlias.toString(),
        namespace: namespace.join('/'),
        trackName,
      });
      this.emitMessageSent('PUBLISH', publishBytes.length, `${namespace.join('/')}/${trackName}`, { requestId: requestId.toString(), trackAlias: trackAlias.toString() });

      // Wait for PUBLISH_OK
      const publishOkResult = await this.publicationManager.waitForPublishOk(requestId);
      console.warn('[MOQT-DIAG] PUBLISH_OK received', { requestId: requestId.toString(), forward: publishOkResult.forward, track: `${namespace.join('/')}/${trackName}` });
      log.info('Received PUBLISH_OK', {
        requestId: requestId.toString(),
        forward: publishOkResult.forward,
      });

      // If forward=0, wait for SUBSCRIBE_UPDATE (unless skipForwardWait is set)
      if (publishOkResult.forward === 0 && !options?.skipForwardWait) {
        log.info('Forward=0, waiting for subscriber (SUBSCRIBE_UPDATE with forward=1)');
        await this.publicationManager.waitForForward(requestId);
        log.info('Forward enabled by subscriber, can start sending data');
      } else if (publishOkResult.forward === 0) {
        log.info('Forward=0 but skipForwardWait=true, starting immediately');
      } else {
        log.info('Forward=1, subscriber already exists - starting immediately');
      }
    }

    log.info('Publishing started', { trackAlias: trackAlias.toString() });
    return trackAlias;
  }

  // ============================================================================
  // Announce Flow (PUBLISH_NAMESPACE based publishing)
  // ============================================================================

  /**
   * Announce a namespace for publishing (announce flow)
   *
   * In this flow:
   * 1. Publisher announces a namespace via PUBLISH_NAMESPACE
   * 2. Relay acknowledges with PUBLISH_NAMESPACE_OK
   * 3. Publisher waits for SUBSCRIBE messages from subscribers
   * 4. Publisher responds with SUBSCRIBE_OK for valid subscriptions
   * 5. Publisher can then send objects on subscribed tracks
   *
   * @param namespace - Namespace to announce
   * @param options - Announce options
   * @returns Promise that resolves when namespace is acknowledged
   *
   * @example
   * ```typescript
   * // Announce namespace
   * await session.announceNamespace(['conference', 'room-1', 'media'], {
   *   deliveryMode: 'stream',
   * });
   *
   * // Listen for incoming subscriptions
   * session.on('incoming-subscribe', async (event) => {
   *   console.log('Subscriber wants:', event.trackName);
   *   // Start sending media for this track
   *   await session.sendObject(event.trackAlias, data, { groupId: 0, objectId: 0 });
   * });
   * ```
   */
  async announceNamespace(
    namespace: string[],
    options?: AnnounceOptions
  ): Promise<void> {
    if (!this.isReady) {
      throw new Error('Session not ready');
    }
    assertNotReservedNamespace(namespace, 'ANNOUNCE');

    const namespaceStr = namespace.join('/');
    log.info('Announcing namespace', { namespace: namespaceStr });

    // Check if already announced
    if (this.announcedNamespaces.has(namespaceStr)) {
      log.warn('Namespace already announced', { namespace: namespaceStr });
      return;
    }

    // Create announced namespace info
    const announceInfo: AnnouncedNamespaceInfo = {
      namespace,
      namespaceStr,
      subscribers: new Map(),
      options: {
        priority: options?.priority ?? 128,
        groupOrder: options?.groupOrder ?? GroupOrder.ASCENDING,
        deliveryTimeout: options?.deliveryTimeout ?? 5000,
        deliveryMode: options?.deliveryMode ?? 'stream',
      },
      acknowledged: false,
    };
    this.announcedNamespaces.set(namespaceStr, announceInfo);

    // Local counter is small; widen for wire encode + state maps.
    const requestId = BigInt(this.getNextRequestId());

    if (this.isDraft18) {
      // Draft-18: Send PUBLISH_NAMESPACE on per-request bidi stream
      await this.announceNamespaceDraft18(requestId, namespace, namespaceStr, announceInfo);
    } else {
      // Draft-14/16: Send on control stream
      const publishNamespaceMessage: PublishNamespaceMessage = {
        type: MessageType.PUBLISH_NAMESPACE,
        requestId,
        namespace,
      };

      const bytes = this.codec.encodeControlMessage(publishNamespaceMessage);
      const hexBytes = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
      log.info('PUBLISH_NAMESPACE bytes', { length: bytes.length, hex: hexBytes, namespace: namespaceStr, requestId: requestId.toString() });

      this.announceRequestIdToNamespace.set(requestId, namespaceStr);

      await this.doSendControl(bytes);
      log.info('Sent PUBLISH_NAMESPACE', { namespace: namespaceStr, requestId: requestId.toString() });

      // Wait for PUBLISH_NAMESPACE_OK with timeout
      const timeout = 10000;
      const startTime = Date.now();

      return new Promise<void>((resolve, reject) => {
        const checkAcknowledged = () => {
          const info = this.announcedNamespaces.get(namespaceStr);
          if (info?.acknowledged) {
            resolve();
            return;
          }

          if (Date.now() - startTime > timeout) {
            this.announcedNamespaces.delete(namespaceStr);
            reject(new Error(`Timeout waiting for PUBLISH_NAMESPACE_OK for ${namespaceStr}`));
            return;
          }

          setTimeout(checkAcknowledged, 50);
        };
        checkAcknowledged();
      });
    }
  }

  /**
   * Draft-18: Announce namespace on per-request bidi stream
   */
  private async announceNamespaceDraft18(
    requestId: bigint,
    namespace: string[],
    namespaceStr: string,
    announceInfo: AnnouncedNamespaceInfo
  ): Promise<void> {
    const publishNsMessage: PublishNamespaceMessageDraft18 = {
      type: MessageTypeDraft18.PUBLISH_NAMESPACE,
      requestId,
      trackNamespacePrefix: namespace,
    };

    const encoded = this.codec.encodeControlMessage(publishNsMessage);

    if ((this.useWorker && this.transportWorker) || this.transport) {
      log.info('Sent PUBLISH_NAMESPACE (draft-18)', { namespace: namespaceStr, requestId: requestId.toString() });

      const response = await this.sendRequestAndWaitResponse(encoded, requestId);
      if (response.type === MessageTypeDraft18.REQUEST_OK) {
        const ok = response as RequestOkMessageDraft18;
        const expiresMs = ok.expires !== undefined ? Number(ok.expires) : undefined;
        announceInfo.acknowledged = true;
        this.emit('namespace-acknowledged', { namespace });
        this.emit('request-ok', {
          requestId,
          requestKind: 'publish-namespace',
          expiresMs,
        } as RequestOkEvent);
        log.info('PUBLISH_NAMESPACE accepted (draft-18)', { namespace: namespaceStr, expiresMs });
      } else if (response.type === MessageTypeDraft18.REQUEST_ERROR) {
        const error = response as RequestErrorMessageDraft18;
        this.announcedNamespaces.delete(namespaceStr);
        await this.closeRequestStream(requestId);
        throw new Error(`Namespace announcement failed: ${error.reasonPhrase} (code ${error.errorCode})`);
      }
    } else {
      throw new Error('No transport available');
    }
  }

  /**
   * Cancel a namespace announcement
   *
   * @param namespace - Namespace to cancel
   */
  async cancelAnnounce(namespace: string[]): Promise<void> {
    const namespaceStr = namespace.join('/');
    const announceInfo = this.announcedNamespaces.get(namespaceStr);

    if (!announceInfo) {
      log.warn('No announced namespace found', { namespace: namespaceStr });
      return;
    }

    log.info('Cancelling namespace announcement', { namespace: namespaceStr });

    // Send PUBLISH_NAMESPACE_CANCEL
    const cancelMessage = {
      type: MessageType.PUBLISH_NAMESPACE_CANCEL,
      namespace,
    };
    const bytes = this.codec.encodeControlMessage(cancelMessage as ControlMessage);
    await this.doSendControl(bytes);

    // Clean up local state
    this.announcedNamespaces.delete(namespaceStr);
    log.info('Namespace announcement cancelled', { namespace: namespaceStr });
  }

  /**
   * Get announced namespaces
   */
  getAnnouncedNamespaces(): AnnouncedNamespaceInfo[] {
    return Array.from(this.announcedNamespaces.values());
  }

  /**
   * Get subscribers for an announced namespace
   *
   * @param namespace - Namespace to get subscribers for
   */
  getSubscribers(namespace: string[]): IncomingSubscriber[] {
    const namespaceStr = namespace.join('/');
    const announceInfo = this.announcedNamespaces.get(namespaceStr);
    if (!announceInfo) {
      return [];
    }
    return Array.from(announceInfo.subscribers.values());
  }

  /**
   * Check if namespace prefix matches an announced namespace
   */
  private matchesAnnouncedNamespace(subscribeNamespace: string[]): AnnouncedNamespaceInfo | undefined {
    // Check for exact match or prefix match
    for (const [, info] of this.announcedNamespaces) {
      // Check if announced namespace is a prefix of subscribe namespace
      if (subscribeNamespace.length >= info.namespace.length) {
        let matches = true;
        for (let i = 0; i < info.namespace.length; i++) {
          if (subscribeNamespace[i] !== info.namespace[i]) {
            matches = false;
            break;
          }
        }
        if (matches) {
          return info;
        }
      }
    }
    return undefined;
  }

  /**
   * Handle incoming SUBSCRIBE message (for announce flow)
   */
  private async handleIncomingSubscribe(message: SubscribeMessage): Promise<void> {
    const { namespace, trackName } = message.fullTrackName;
    const fullTrackNameStr = [...namespace, trackName].join('/');

    log.info('Received SUBSCRIBE (announce flow)', {
      requestId: message.requestId,
      namespace: namespace.join('/'),
      trackName,
      fullTrackName: fullTrackNameStr,
    });

    // B3 SEC: A peer-initiated subscribe creates a publication for this
    // subscriber; gate it on maxTracks so a malicious peer can't OOM us by
    // spamming SUBSCRIBE. `enforceResourceLimit` throws when tripped, which
    // the outer async caller will observe.
    try {
      this.enforceResourceLimit('tracks', this.publicationManager.size, this.maxTracks);
    } catch {
      return;
    }

    // Check if this matches any announced namespace
    const announceInfo = this.matchesAnnouncedNamespace(namespace);

    if (!announceInfo) {
      log.warn('SUBSCRIBE does not match any announced namespace', {
        subscribeNamespace: namespace.join('/'),
        announcedNamespaces: Array.from(this.announcedNamespaces.keys()),
      });
      // Send SUBSCRIBE_ERROR
      await this.sendSubscribeError(message.requestId, 0x03, 'No matching namespace');
      return;
    }

    // Assign track alias for this subscriber
    const trackAlias = this.nextIncomingTrackAlias++;

    // Create subscriber info
    const subscriber: IncomingSubscriber = {
      requestId: message.requestId,
      fullTrackName: message.fullTrackName,
      trackAlias,
      subscriberPriority: message.subscriberPriority,
      groupOrder: message.groupOrder,
      active: true,
    };

    // Add to subscribers map
    announceInfo.subscribers.set(message.requestId, subscriber);

    // Send SUBSCRIBE_OK
    await this.sendSubscribeOk(message.requestId, trackAlias, announceInfo.options.groupOrder ?? GroupOrder.ASCENDING);

    // Create a publication entry for this track (forward=1 since subscriber is connected)
    const publication: InternalPublication = {
      trackAlias,
      namespace,
      trackName,
      priority: announceInfo.options.priority ?? 128,
      deliveryMode: announceInfo.options.deliveryMode ?? 'stream',
      audioDeliveryMode: announceInfo.options.audioDeliveryMode ?? 'datagram',
      requestId: message.requestId,
      cleanupHandlers: [],
      forward: 1, // Subscriber is connected, can send immediately
    };
    this.publicationManager.add(publication);

    // Emit event for application to handle
    this.emit('incoming-subscribe', {
      requestId: message.requestId,
      namespace,
      trackName,
      trackAlias,
    } as IncomingSubscribeEvent);

    log.info('Accepted SUBSCRIBE, ready to publish', {
      requestId: message.requestId,
      trackAlias: trackAlias.toString(),
      fullTrackName: fullTrackNameStr,
    });
  }

  /**
   * Handle incoming PUBLISH message (subscribe namespace flow - we are the subscriber)
   */
  private async handleIncomingPublish(message: PublishMessage): Promise<void> {
    const { namespace, trackName } = message.fullTrackName;
    const fullTrackNameStr = [...namespace, trackName].join('/');
    const namespaceStr = namespace.join('/');

    // B3 SEC: A peer-initiated publish creates a subscription for us to
    // ingest their track; gate it on maxSubscriptions.
    try {
      this.enforceResourceLimit('subscriptions', this.subscriptionManager.size, this.maxSubscriptions);
    } catch {
      return;
    }

    console.warn('[MOQT-DIAG] handleIncomingPublish', {
      fullTrackName: fullTrackNameStr,
      ownPrefix: this.ownNamespacePrefix,
      namespaceSubscriptionCount: this.namespaceSubscriptions.size,
      subscriptions: Array.from(this.namespaceSubscriptions.values()).map(s => s.namespacePrefix.join('/')),
    });

    log.info('Received PUBLISH (subscribe namespace flow)', {
      requestId: message.requestId,
      namespace: namespaceStr,
      trackName,
      trackAlias: message.trackAlias.toString(),
      groupOrder: message.groupOrder,
    });

    // Check if this is our own publish (filter out self)
    if (this.ownNamespacePrefix && namespaceStr.startsWith(this.ownNamespacePrefix)) {
      console.warn('[MOQT-DIAG] Filtered out own PUBLISH', { namespaceStr, ownPrefix: this.ownNamespacePrefix });
      log.debug('Ignoring own PUBLISH', { namespace: namespaceStr });
      return;
    }

    // Find most specific (longest prefix) matching namespace subscription
    let matchingSubscription: NamespaceSubscriptionInfo | undefined;
    let longestMatch = -1;
    for (const sub of this.namespaceSubscriptions.values()) {
      const prefix = sub.namespacePrefix.join('/');
      if (namespaceStr.startsWith(prefix) && prefix.length > longestMatch) {
        matchingSubscription = sub;
        longestMatch = prefix.length;
      }
    }

    if (!matchingSubscription) {
      log.warn('PUBLISH does not match any namespace subscription', {
        publishNamespace: namespaceStr,
        subscriptions: Array.from(this.namespaceSubscriptions.values()).map(s => s.namespacePrefix.join('/')),
      });
      return;
    }

    // Handle trackAlias reuse (e.g. remote user ended and redialed)
    const existingSubscription = this.subscriptionManager.getByAlias(BigInt(message.trackAlias));
    if (existingSubscription) {
      log.info('Replacing stale subscription for reused trackAlias', {
        trackAlias: message.trackAlias.toString(),
        oldSubscriptionId: existingSubscription.subscriptionId,
        track: fullTrackNameStr,
      });
      this.subscriptionManager.remove(existingSubscription.subscriptionId);
    }

    // Store track info
    const trackInfo: IncomingPublishInfo = {
      requestId: message.requestId,
      namespace,
      trackName,
      trackAlias: BigInt(message.trackAlias),
      groupOrder: message.groupOrder,
      acknowledged: false,
    };
    matchingSubscription.tracks.set(fullTrackNameStr, trackInfo);

    // Send PUBLISH_OK to accept the track
    await this.sendPublishOk(message.requestId, message.groupOrder);
    trackInfo.acknowledged = true;

    // Register this as a subscription so objects can be routed
    const subscriptionId = this.getNextRequestId();
    const subscription: InternalSubscription = {
      subscriptionId,
      requestId: message.requestId,
      namespace,
      trackName,
      trackAlias: BigInt(message.trackAlias),
      paused: false,
      onObject: matchingSubscription.onObject,
    };
    this.subscriptionManager.add(subscription);

    // Emit event for application to handle
    console.warn('[MOQT-DIAG] Emitting incoming-publish', {
      subscriptionId,
      trackName,
      namespace: namespace.join('/'),
      trackAlias: message.trackAlias.toString(),
    });
    const g = globalThis as any;
    if (!g.__moqtDiag) g.__moqtDiag = { controlMessages: {}, incomingPublish: [] };
    g.__moqtDiag.incomingPublish.push({ trackName, namespace: namespace.join('/'), ts: Date.now() });
    this.emit('incoming-publish', {
      namespaceSubscriptionId: matchingSubscription.subscriptionId,
      subscriptionId,
      requestId: message.requestId,
      namespace,
      trackName,
      trackAlias: BigInt(message.trackAlias),
      groupOrder: message.groupOrder,
    } as IncomingPublishEvent);

    log.info('Accepted PUBLISH, ready to receive objects', {
      requestId: message.requestId,
      trackAlias: message.trackAlias.toString(),
      fullTrackName: fullTrackNameStr,
      subscriptionId,
    });
  }

  /**
   * Send PUBLISH_OK response
   */
  private async sendPublishOk(requestId: bigint, groupOrder: GroupOrder): Promise<void> {
    const publishOk = {
      type: MessageType.PUBLISH_OK as const,
      requestId,
      forward: 1,
      subscriberPriority: 128,
      groupOrder,
      filterType: FilterType.LATEST_GROUP,
      expires: 0n,
    };

    const bytes = this.codec.encodeControlMessage(publishOk);
    await this.doSendControl(bytes);
    log.info('Sent PUBLISH_OK', { requestId: requestId.toString() });
  }

  /**
   * Send SUBSCRIBE_OK response
   */
  private async sendSubscribeOk(
    requestId: bigint,
    trackAlias: bigint,
    groupOrder: GroupOrder
  ): Promise<void> {
    const subscribeOk: SubscribeOkMessage = {
      type: MessageType.SUBSCRIBE_OK,
      requestId,
      trackAlias,
      expires: 0n,
      groupOrder,
      contentExists: false,
    };

    const bytes = this.codec.encodeControlMessage(subscribeOk);
    const hexBytes = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
    log.info('SUBSCRIBE_OK bytes', { length: bytes.length, hex: hexBytes });
    await this.doSendControl(bytes);
    log.info('Sent SUBSCRIBE_OK', { requestId: requestId.toString(), trackAlias: trackAlias.toString() });
  }

  /**
   * Send SUBSCRIBE_ERROR response
   */
  private async sendSubscribeError(
    requestId: bigint,
    errorCode: number,
    reasonPhrase: string
  ): Promise<void> {
    const subscribeError = {
      type: MessageType.SUBSCRIBE_ERROR,
      requestId,
      errorCode,
      reasonPhrase,
      trackAlias: 0n,
    };

    const bytes = this.codec.encodeControlMessage(subscribeError as ControlMessage);
    await this.doSendControl(bytes);
    log.info('Sent SUBSCRIBE_ERROR', { requestId: requestId.toString(), errorCode, reasonPhrase });
  }

  // ============================================================================
  // End Announce Flow
  // ============================================================================

  // ============================================================================
  // VOD Publishing (for DVR/Rewind support)
  // ============================================================================

  /**
   * Publish VOD (Video on Demand) content
   *
   * VOD tracks respond to FETCH requests from subscribers, allowing them to
   * seek/rewind to any point in the content.
   *
   * @param namespace - Track namespace
   * @param trackName - Track name
   * @param options - VOD publish options including metadata and object retrieval callback
   * @returns Track alias
   *
   * @example
   * ```typescript
   * // Publish a pre-recorded video as VOD
   * const trackAlias = await session.publishVOD(
   *   ['vod', 'movie-1'],
   *   'video',
   *   {
   *     metadata: {
   *       duration: 120000, // 2 minutes
   *       totalGroups: 240, // 30fps * 2min / 15 frames per GOP = 240 GOPs
   *       gopDuration: 500, // 500ms per GOP
   *       framerate: 30,
   *     },
   *     getObject: async (groupId, objectId) => {
   *       // Return the encoded frame data for this group/object
   *       return await loadFrameFromStorage(groupId, objectId);
   *     },
   *     isKeyframe: (groupId, objectId) => objectId === 0,
   *     objectsPerGroup: 15, // 15 frames per GOP
   *   }
   * );
   * ```
   */
  async publishVOD(
    namespace: string[],
    trackName: string,
    options: VODPublishOptions
  ): Promise<bigint> {
    if (!this.isReady) {
      throw new Error('Session not ready');
    }
    assertNotReservedNamespace(namespace, 'publish VOD content under');

    // Local counter is small; widen to bigint for wire varint + state keys.
    const requestId = BigInt(this.getNextRequestId());
    const trackAlias = requestId;
    const fullTrackName = [...namespace, trackName].join('/');

    log.info('Publishing VOD content', {
      namespace: namespace.join('/'),
      trackName,
      fullTrackName,
      duration: options.metadata.duration,
      totalGroups: options.metadata.totalGroups,
    });

    // Create VOD track info
    const vodTrack: VODTrackInfo = {
      trackAlias,
      namespace,
      trackName,
      metadata: options.metadata,
      activeFetches: new Map(),
    };
    this.vodTracks.set(trackAlias.toString(), vodTrack);

    // Store the object retrieval callback for serving fetch requests
    // This will be used when we receive FETCH messages
    const vodKey = `${namespace.join('/')}/${trackName}`;
    // Store in a separate map keyed by track name for incoming fetch lookup
    (this as unknown as { vodCallbacks: Map<string, VODPublishOptions> }).vodCallbacks =
      (this as unknown as { vodCallbacks: Map<string, VODPublishOptions> }).vodCallbacks || new Map();
    (this as unknown as { vodCallbacks: Map<string, VODPublishOptions> }).vodCallbacks.set(vodKey, options);

    // Send PUBLISH message with contentExists=true to indicate VOD content
    const publishMessage: PublishMessage = {
      type: MessageType.PUBLISH,
      requestId,
      fullTrackName: { namespace, trackName },
      trackAlias,
      groupOrder: options.groupOrder ?? GroupOrder.ASCENDING,
      contentExists: true, // VOD content exists
      forward: 0, // Not forwarding live content
      parameters: new Map(),
    };

    const publishBytes = this.codec.encodeControlMessage(publishMessage);
    await this.doSendControl(publishBytes);
    log.info('Sent VOD PUBLISH message', {
      requestId: requestId.toString(),
      trackAlias: trackAlias.toString(),
      namespace: namespace.join('/'),
      trackName,
    });

    // Wait for PUBLISH_OK
    const publishOkResult = await this.publicationManager.waitForPublishOk(requestId);
    log.info('Received PUBLISH_OK for VOD track', {
      requestId: requestId.toString(),
      forward: publishOkResult.forward,
    });

    // Create publication entry with initial forward state
    const publication: InternalPublication = {
      trackAlias,
      namespace,
      trackName,
      priority: options.priority ?? 128,
      deliveryMode: options.deliveryMode ?? 'stream',
      audioDeliveryMode: options.audioDeliveryMode ?? 'datagram',
      requestId,
      cleanupHandlers: [],
      forward: publishOkResult.forward,
    };
    this.publicationManager.add(publication);

    // Start VOD auto-stream unless fetchOnly mode is enabled
    // In fetchOnly mode, content is only delivered via FETCH requests
    if (!options.fetchOnly) {
      log.info('Starting VOD auto-stream', {
        trackAlias: trackAlias.toString(),
        initialForward: publishOkResult.forward,
      });
      this.startVODAutoStream(trackAlias, options);
    } else {
      log.info('VOD fetchOnly mode - waiting for FETCH requests', {
        trackAlias: trackAlias.toString(),
      });
    }

    log.info('VOD publishing started', { trackAlias: trackAlias.toString() });
    return trackAlias;
  }

  /**
   * Auto-stream VOD content to subscribers at realtime pace
   * Handles forward state: waits for forward=1, pauses on forward=0, resumes on forward=1
   */
  private async startVODAutoStream(trackAlias: bigint, options: VODPublishOptions): Promise<void> {
    const { metadata, getObject, objectsPerGroup = 30 } = options;
    const frameDuration = 1000 / (metadata.framerate ?? 30); // ms per frame
    const totalGroups = Math.min(metadata.totalGroups, Number.MAX_SAFE_INTEGER);
    const aliasStr = trackAlias.toString();

    log.info('VOD auto-stream initialized', {
      trackAlias: aliasStr,
      totalGroups,
      framerate: metadata.framerate,
      frameDuration,
    });

    const publication = this.publicationManager.get(trackAlias);
    if (!publication) {
      log.warn('No publication found for VOD auto-stream', { trackAlias: aliasStr });
      return;
    }

    // VOD position tracking for pause/resume
    let currentGroupId = 0;
    let currentObjectId = 0;

    // Forward state change handling
    let forwardResolve: (() => void) | null = null;

    const waitForForward = (): Promise<void> => {
      return new Promise((resolve) => {
        // Check current state
        if (this.publicationManager.getForward(trackAlias) === 1) {
          resolve();
          return;
        }
        // Wait for forward=1
        forwardResolve = resolve;
      });
    };

    // Listen for forward state changes
    const cleanupListener = this.publicationManager.onForwardStateChange((alias, forward) => {
      if (alias.toString() === aliasStr) {
        log.info('VOD auto-stream forward state changed', { trackAlias: aliasStr, forward });
        if (forward === 1 && forwardResolve) {
          forwardResolve();
          forwardResolve = null;
        }
      }
    });

    // Stream VOD content in realtime
    const streamLoop = async () => {
      try {
        // Wait for initial forward=1 if needed
        if (this.publicationManager.getForward(trackAlias) !== 1) {
          log.info('VOD auto-stream waiting for forward=1', { trackAlias: aliasStr });
          await waitForForward();
          log.info('VOD auto-stream received forward=1, starting', { trackAlias: aliasStr });
        }

        // Wait for subscriber to set up decode pipeline
        await new Promise(resolve => setTimeout(resolve, 500));
        log.info('VOD auto-stream starting after subscriber setup delay', { trackAlias: aliasStr });

        while (true) {
          // Check if publication still exists
          if (!this.publicationManager.get(trackAlias)) {
            log.info('VOD publication ended, stopping auto-stream', { trackAlias: aliasStr });
            break;
          }

          // Check forward state - pause if forward=0
          if (this.publicationManager.getForward(trackAlias) !== 1) {
            log.info('VOD auto-stream paused (forward=0)', {
              trackAlias: aliasStr,
              pausedAt: { groupId: currentGroupId, objectId: currentObjectId },
            });
            await waitForForward();
            log.info('VOD auto-stream resumed (forward=1)', {
              trackAlias: aliasStr,
              resumeAt: { groupId: currentGroupId, objectId: currentObjectId },
            });
          }

          // Loop group ID for looping content
          const effectiveGroupId = currentGroupId % (totalGroups || 1);

          // Stream all objects in this group (starting from currentObjectId for resume)
          for (let objectId = currentObjectId; objectId < objectsPerGroup; objectId++) {
            // Check forward state before each object
            if (this.publicationManager.getForward(trackAlias) !== 1) {
              currentObjectId = objectId;
              break; // Will pause in outer loop
            }

            const data = await getObject(effectiveGroupId, objectId);
            if (!data) {
              // No more objects in this group
              break;
            }

            try {
              // Send object using normal publish flow
              // Note: Omitting maxCacheDuration to avoid extension encoding issues with relay
              await this.sendObject(trackAlias, data, {
                groupId: currentGroupId,
                objectId,
                type: 'video',
                isKeyframe: objectId === 0,
              });
            } catch (err) {
              log.warn('Failed to send VOD object', {
                trackAlias: aliasStr,
                groupId: currentGroupId,
                objectId,
                error: err,
              });
            }

            // Wait for frame duration to maintain realtime playback
            await new Promise(resolve => setTimeout(resolve, frameDuration));
          }

          // Reset objectId for next group
          currentObjectId = 0;
          currentGroupId++;

          // For non-looping content, stop at end
          if (currentGroupId >= totalGroups && totalGroups !== Number.MAX_SAFE_INTEGER) {
            log.info('VOD auto-stream completed', { trackAlias: aliasStr, totalGroups: currentGroupId });
            break;
          }
        }
      } finally {
        // Clean up listener
        cleanupListener();
      }
    };

    // Start streaming in background
    streamLoop().catch(err => {
      log.error('VOD auto-stream error', { trackAlias: aliasStr, error: err });
      cleanupListener();
    });
  }

  /**
   * Handle incoming FETCH request (we are the VOD publisher)
   */
  private async handleIncomingFetch(message: FetchMessage): Promise<void> {
    const { namespace, trackName } = message.fullTrackName;
    const fullTrackNameStr = [...namespace, trackName].join('/');
    const vodKey = `${namespace.join('/')}/${trackName}`;

    log.info('Received FETCH request', {
      requestId: message.requestId.toString(),
      namespace: namespace.join('/'),
      trackName,
      startGroup: message.startGroup.toString(),
      startObject: message.startObject.toString(),
      endGroup: message.endGroup.toString(),
      endObject: message.endObject.toString(),
    });

    // Find VOD track by name
    const vodCallbacks = (this as unknown as { vodCallbacks: Map<string, VODPublishOptions> }).vodCallbacks;
    const vodOptions = vodCallbacks?.get(vodKey);

    if (!vodOptions) {
      log.warn('FETCH for unknown VOD track', { fullTrackName: fullTrackNameStr });
      await this.sendFetchError(message.requestId, 0x03, 'Track not found');
      return;
    }

    // FetchRange is deliberately `number` (see types.ts); range-check-and-narrow
    // the wire bigints for the emit event and downstream FETCH pipeline.
    const rangeStartGroup = narrowBigIntToNumber(message.startGroup, 'FETCH.startGroup');
    const rangeStartObject = narrowBigIntToNumber(message.startObject, 'FETCH.startObject');
    const rangeEndGroup = narrowBigIntToNumber(message.endGroup, 'FETCH.endGroup');
    const rangeEndObject = narrowBigIntToNumber(message.endObject, 'FETCH.endObject');

    // Emit event for application to handle (optional custom handling)
    this.emit('incoming-fetch', {
      requestId: message.requestId,
      namespace,
      trackName,
      range: {
        startGroup: rangeStartGroup,
        startObject: rangeStartObject,
        endGroup: rangeEndGroup,
        endObject: rangeEndObject,
      },
      priority: message.subscriberPriority,
      groupOrder: message.groupOrder,
    } as IncomingFetchEvent);

    // Send FETCH_OK first
    const fetchOk: FetchOkMessage = {
      type: MessageType.FETCH_OK,
      requestId: message.requestId,
      groupOrder: message.groupOrder,
      endOfTrack: rangeEndGroup >= vodOptions.metadata.totalGroups - 1,
      largestGroupId: BigInt(vodOptions.metadata.totalGroups - 1),
      largestObjectId: BigInt((vodOptions.objectsPerGroup ?? 1) - 1),
    };

    const fetchOkBytes = this.codec.encodeControlMessage(fetchOk);
    await this.doSendControl(fetchOkBytes);
    log.info('Sent FETCH_OK', {
      requestId: message.requestId.toString(),
      largestGroupId: fetchOk.largestGroupId.toString(),
      largestObjectId: fetchOk.largestObjectId.toString(),
      encodedLength: fetchOkBytes.length,
    });

    // Create a stream to send the fetched objects
    await this.sendFetchedObjects(message, vodOptions);
  }

  /**
   * Send fetched objects on a FETCH stream
   *
   * Draft-15/16 FETCH response format uses serialization flags for each object,
   * which is different from SUBSCRIBE delivery (subgroup headers).
   */
  private async sendFetchedObjects(
    fetchMessage: FetchMessage,
    vodOptions: VODPublishOptions
  ): Promise<void> {
    const requestId = fetchMessage.requestId;
    // FetchRange arithmetic runs in `number`; narrow with range check.
    const startGroup = narrowBigIntToNumber(fetchMessage.startGroup, 'FETCH.startGroup');
    const startObject = narrowBigIntToNumber(fetchMessage.startObject, 'FETCH.startObject');
    const endGroup = narrowBigIntToNumber(fetchMessage.endGroup, 'FETCH.endGroup');
    const endObject = narrowBigIntToNumber(fetchMessage.endObject, 'FETCH.endObject');
    const objectsPerGroup = vodOptions.objectsPerGroup ?? 1;

    log.info('Sending fetched objects', {
      requestId: requestId.toString(),
      startGroup,
      startObject,
      endGroup,
      endObject,
      objectsPerGroup,
      objectsPerGroupSource: vodOptions.objectsPerGroup,
    });
    console.log('[FETCH] Sending objects', {
      requestId: requestId.toString(),
      range: `group ${startGroup}-${endGroup}, objects 0-${objectsPerGroup - 1}`,
      objectsPerGroup,
    });

    try {
      // Create a unidirectional stream for the FETCH response
      const streamInfo = await this.doCreateStream();

      // Send FETCH_HEADER first (stream type + request ID)
      const headerWriter = new BufferWriter();
      headerWriter.writeVarInt(DataStreamType.FETCH_HEADER);
      headerWriter.writeVarInt(requestId);
      await this.doWriteStream(streamInfo, headerWriter.toUint8Array());

      // Create encoder state for delta encoding across objects
      const fetchState = this.codec.createFetchEncoderState();

      // Draft-16 §7.4: End Location is exclusive on the wire. endObject == 0
      // means "entire End Group" (equivalent to objectsPerGroup); otherwise
      // deliver objects 0..endObject-1 in the final group.
      for (let groupId = startGroup; groupId <= endGroup; groupId++) {
        const objStart = groupId === startGroup ? startObject : 0;
        const objEnd = groupId === endGroup && endObject > 0
          ? endObject - 1
          : objectsPerGroup - 1;

        for (let objectId = objStart; objectId <= objEnd; objectId++) {
          // Check if fetch was cancelled
          if (this.pendingFetchResponses.has(requestId) === false && requestId !== fetchMessage.requestId) {
            log.info('Fetch cancelled, stopping send', { requestId: requestId.toString() });
            await this.doCloseStream(streamInfo);
            return;
          }

          // Get object data
          const data = await vodOptions.getObject(groupId, objectId);
          if (!data) {
            log.warn('Object not found', { groupId, objectId });
            continue;
          }

          const isKeyframe = vodOptions.isKeyframe?.(groupId, objectId) ?? objectId === 0;

          // Encode using draft-15/16 FETCH object format (serialization flags)
          const objectData = this.codec.encodeFetchObject(
            groupId,
            0, // subgroupId
            objectId,
            data,
            fetchState,
            128 // priority
          );

          // Debug: show exact bytes for first few objects (before write transfers buffer)
          if (objectId < 3) {
            const bytesHex = Array.from(objectData.slice(0, Math.min(32, objectData.length)))
              .map(b => b.toString(16).padStart(2, '0')).join(' ');
            // OPS-hi 1: per-object hot-path — demoted from .info to .trace.
            log.trace('FETCH object encoded', {
              requestId: requestId.toString(),
              groupId,
              objectId,
              payloadSize: data.byteLength,
              encodedSize: objectData.byteLength,
              firstBytes: bytesHex,
            });
          }

          await this.doWriteStream(streamInfo, objectData);

          log.trace('Sent fetched object', {
            requestId: requestId.toString(),
            groupId,
            objectId,
            isKeyframe,
            bytes: data.byteLength,
            encodedBytes: objectData.byteLength,
          });
        }
      }

      // Close the stream
      await this.doCloseStream(streamInfo);
      log.info('Fetch stream completed', { requestId: requestId.toString() });

    } catch (err) {
      log.error('Error sending fetched objects', {
        requestId,
        error: (err as Error).message,
      });
    }
  }

  /**
   * Send FETCH_ERROR response
   */
  private async sendFetchError(
    requestId: bigint,
    errorCode: number,
    reasonPhrase: string
  ): Promise<void> {
    const fetchError: FetchErrorMessage = {
      type: MessageType.FETCH_ERROR,
      requestId,
      errorCode: errorCode as import('@moq-web/core').RequestErrorCode,
      reasonPhrase,
    };

    const bytes = this.codec.encodeControlMessage(fetchError);
    await this.doSendControl(bytes);
    log.info('Sent FETCH_ERROR', { requestId: requestId.toString(), errorCode, reasonPhrase });
  }

  /**
   * Get VOD track info
   */
  getVODTrack(trackAlias: bigint | string): VODTrackInfo | undefined {
    return this.vodTracks.get(trackAlias.toString());
  }

  /**
   * Get all VOD tracks
   */
  getVODTracks(): VODTrackInfo[] {
    return Array.from(this.vodTracks.values());
  }

  // ============================================================================
  // End VOD Publishing
  // ============================================================================

  /**
   * Stop publishing a track
   *
   * @param trackAlias - Track alias to unpublish
   */
  async unpublish(trackAlias: bigint | string): Promise<void> {
    const key = trackAlias.toString();
    const publication = this.publicationManager.get(key);
    if (!publication) {
      log.warn('No publication found for track alias', { trackAlias: key });
      return;
    }

    log.info('Stopping publish', { trackAlias: key });

    // Close any active GOP stream
    await this.closeVideoGOPStream(key);

    // Send PUBLISH_DONE to notify the relay/subscribers
    if (this.isDraft18) {
      await this.sendPublishDone(
        publication.requestId,
        0,
        0,
        undefined,
        PublishDoneErrorCodeDraft18.TRACK_ENDED,
      ).catch(() => {});
    } else {
      const publishDone: PublishDoneMessage = {
        type: MessageType.PUBLISH_DONE,
        requestId: publication.requestId,
        statusCode: RequestErrorCode.INTERNAL_ERROR,
        reasonPhrase: '',
        contentExists: false,
      };
      const bytes = this.codec.encodeControlMessage(publishDone);
      await this.doSendControl(bytes).catch(() => {});
      log.info('Sent PUBLISH_DONE', { trackAlias: key, requestId: publication.requestId });
    }

    // Remove from manager (this also runs cleanup handlers)
    this.publicationManager.remove(key);

    log.info('Publishing stopped', { trackAlias: key });
  }

  /**
   * Send an object via the configured delivery mode
   */
  async sendObject(
    trackAlias: bigint,
    data: Uint8Array,
    metadata: ObjectMetadata
  ): Promise<void> {
    const publication = this.publicationManager.get(trackAlias);
    const priority = publication?.priority ?? 128;
    const deliveryMode = publication?.deliveryMode ?? 'stream';
    const audioDeliveryMode = publication?.audioDeliveryMode ?? 'datagram';

    if (deliveryMode === 'datagram') {
      await this.sendObjectViaDatagram(trackAlias, data, metadata, priority);
    } else {
      // newGroup flag triggers group-based stream batching (one stream per group)
      if (metadata.newGroup !== undefined) {
        await this.sendObjectWithGOP(trackAlias, data, metadata, priority);
      } else if (metadata.type === 'audio') {
        // Audio uses configured audioDeliveryMode (default: datagram for low latency)
        if (audioDeliveryMode === 'datagram') {
          await this.sendObjectViaDatagram(trackAlias, data, metadata, priority);
        } else {
          await this.sendObjectViaStream(trackAlias, data, metadata, priority);
        }
      } else {
        // Other data uses individual streams
        await this.sendObjectViaStream(trackAlias, data, metadata, priority);
      }
    }

    // Track largest (group, object) tuple for §10.14 TRACK_STATUS replies.
    this.publicationManager.updateLatest(trackAlias, BigInt(metadata.groupId), BigInt(metadata.objectId));

    // Emit stats
    this.emit('publish-stats', {
      trackAlias: trackAlias.toString(),
      type: metadata.type,
      groupId: metadata.groupId,
      objectId: metadata.objectId,
      bytes: data.byteLength,
    } as PublishStatsEvent);
  }

  /**
   * Send an object via datagram (low-latency unreliable delivery)
   */
  async sendObjectViaDatagram(
    trackAlias: bigint,
    data: Uint8Array,
    metadata: ObjectMetadata,
    priority?: number
  ): Promise<void> {
    const header: ObjectHeader = {
      trackAlias,
      groupId: metadata.groupId,
      subgroupId: 0,
      objectId: metadata.objectId,
      publisherPriority: priority ?? 128,
      objectStatus: ObjectStatus.NORMAL,
    };

    const datagram = this.codec.encodeDatagramObject({
      header,
      payload: data,
      payloadLength: data.byteLength,
    });

    if (datagram.byteLength <= this.maxDatagramSize) {
      try {
        await this.doSendDatagram(datagram);
        log.trace('Sent object via datagram', {
          trackAlias: trackAlias.toString(),
          groupId: metadata.groupId,
          objectId: metadata.objectId,
          size: datagram.byteLength,
        });
      } catch (err) {
        log.warn('Failed to send datagram, falling back to stream', {
          trackAlias: trackAlias.toString(),
          size: datagram.byteLength,
          error: (err as Error).message,
        });
        await this.sendObjectViaStream(trackAlias, data, metadata, priority);
      }
    } else {
      log.debug('Object too large for datagram, using stream', {
        size: datagram.byteLength,
        maxSize: this.maxDatagramSize,
      });
      await this.sendObjectViaStream(trackAlias, data, metadata, priority);
    }
  }

  /**
   * Send an object via stream (reliable ordered delivery)
   */
  async sendObjectViaStream(
    trackAlias: bigint,
    data: Uint8Array,
    metadata: ObjectMetadata,
    priority?: number
  ): Promise<void> {
    // §8: arm the subgroup-delivery deadline before touching the wire so a
    // stalled create/write path is caught by the same timer that guards
    // long-running GOP streams. Since sendObjectViaStream sends one whole
    // object per stream, we key on (alias, groupId, subgroupId=0).
    const timeoutKey = this.armPublisherSubgroupTimer(trackAlias, metadata.groupId, 0);
    try {
      const sendOrder = this.deriveSendOrder(trackAlias, priority, metadata.groupId);
      const streamInfo = await this.doCreateStream(sendOrder !== undefined ? { sendOrder } : undefined);

      // Set END_OF_GROUP=true since this stream contains one complete object/group
      const [subgroupHeader, hasExtensions] = this.codec.encodeSubgroupHeader({
        trackAlias,
        groupId: metadata.groupId,
        subgroupId: 0,
        publisherPriority: priority ?? 128,
      }, true /* endOfGroup */);

      // Build extensions map if maxCacheDuration is specified
      let extensions: Map<number, number> | undefined;
      if (metadata.maxCacheDuration !== undefined && metadata.maxCacheDuration > 0) {
        extensions = new Map();
        extensions.set(ObjectExtension.MAX_CACHE_DURATION, metadata.maxCacheDuration);
      }

      const objectData = this.codec.encodeStreamObject(
        metadata.objectId,
        data,
        ObjectStatus.NORMAL,
        -1, // previousObjectId (first object)
        hasExtensions,
        extensions
      );

      const combinedData = new Uint8Array(subgroupHeader.length + objectData.length);
      combinedData.set(subgroupHeader, 0);
      combinedData.set(objectData, subgroupHeader.length);

      const headerHex = Array.from(subgroupHeader).map(b => b.toString(16).padStart(2, '0')).join(' ');
      log.debug('Sending stream data', {
        trackAlias: trackAlias.toString(),
        groupId: metadata.groupId,
        objectId: metadata.objectId,
        headerBytes: headerHex,
        headerSize: subgroupHeader.length,
        objectDataSize: objectData.length,
        totalSize: combinedData.length,
        payloadSize: data.byteLength,
      });

      await this.doWriteStream(streamInfo, combinedData, true /* close */);

      log.trace('Sent object via stream', {
        trackAlias: trackAlias.toString(),
        groupId: metadata.groupId,
        objectId: metadata.objectId,
        size: data.byteLength,
      });
    } catch (err) {
      log.error('Failed to send stream object', {
        trackAlias: trackAlias.toString(),
        size: data.byteLength,
        error: (err as Error).message,
        stack: (err as Error).stack,
      });
    } finally {
      // Delivery finished (or errored) — disarm the deadline either way.
      if (timeoutKey) this.publisherDeliveryTimeouts.disarm(timeoutKey);
    }
  }

  /**
   * Send object with GOP batching for video
   */
  private async sendObjectWithGOP(
    trackAlias: bigint,
    data: Uint8Array,
    metadata: ObjectMetadata,
    priority: number
  ): Promise<void> {
    const aliasKey = trackAlias.toString();

    try {
      // OPS-hi 1: per-frame hot-path — demoted from .info to .trace.
      log.trace('sendObjectWithGOP', {
        trackAlias: aliasKey,
        groupId: metadata.groupId,
        objectId: metadata.objectId,
        newGroup: metadata.newGroup,
        type: metadata.type,
        existingGroupId: this.activeVideoStreams.get(aliasKey)?.groupId,
      });

      if (metadata.newGroup) {
        // Close existing stream — END_OF_GROUP is signaled by the header bit,
        // so just close the stream without writing a status object

        const existing = this.activeVideoStreams.get(aliasKey);
        if (existing) {
          // Previous GOP just ended cleanly — disarm its §8 deadline.
          this.publisherDeliveryTimeouts.disarm(`pub-sg:${aliasKey}:${existing.groupId}:0`);
          try {
            await this.doCloseStream({ writer: existing.writer, streamId: existing.streamId });
            // OPS-hi 1: fires per group boundary — demoted from .info to .debug.
        log.debug('Closed previous GOP stream', {
              trackAlias: aliasKey,
              previousGroupId: existing.groupId,
              objectCount: existing.objectCount,
            });
          } catch (closeErr) {
            log.warn('Error closing previous GOP stream', {
              trackAlias: aliasKey,
              error: (closeErr as Error).message,
            });
          }
        }

        // §8: arm a fresh subgroup-delivery deadline for the incoming GOP.
        this.armPublisherSubgroupTimer(trackAlias, metadata.groupId, 0);

        // Create new stream for this GOP — §7.2 sendOrder pulls priority
        // from the subscribing peer's SUBSCRIBER_PRIORITY / GROUP_ORDER.
        const gopSendOrder = this.deriveSendOrder(trackAlias, priority, metadata.groupId);
        const streamInfo = await this.doCreateStream(gopSendOrder !== undefined ? { sendOrder: gopSendOrder } : undefined);

        // Set END_OF_GROUP=true since each stream contains exactly one complete group (one GOP)
        const [subgroupHeader, hasExtensions] = this.codec.encodeSubgroupHeader({
          trackAlias,
          groupId: metadata.groupId,
          subgroupId: 0,
          publisherPriority: priority,
        }, true /* endOfGroup */);

        // Build extensions map if maxCacheDuration is specified
        let extensions: Map<number, number> | undefined;
        if (metadata.maxCacheDuration !== undefined && metadata.maxCacheDuration > 0) {
          extensions = new Map();
          extensions.set(ObjectExtension.MAX_CACHE_DURATION, metadata.maxCacheDuration);
        }

        const objectData = this.codec.encodeStreamObject(
          metadata.objectId,
          data,
          ObjectStatus.NORMAL,
          -1, // previousObjectId (first object)
          hasExtensions,
          extensions
        );

        const combinedData = new Uint8Array(subgroupHeader.length + objectData.length);
        combinedData.set(subgroupHeader, 0);
        combinedData.set(objectData, subgroupHeader.length);

        await this.doWriteStream(streamInfo, combinedData);

        this.activeVideoStreams.set(aliasKey, {
          writer: streamInfo.writer!,
          streamId: streamInfo.streamId!,
          groupId: metadata.groupId,
          objectCount: 1,
          previousObjectId: metadata.objectId, // For delta encoding
          hasExtensions,
          maxCacheDuration: metadata.maxCacheDuration, // Store for P-frames
        });

        // OPS-hi 1: fires per keyframe (~1/sec at 30fps GOP=30) — demoted from .info to .debug.
        log.debug('Started new GOP stream with keyframe', {
          trackAlias: aliasKey,
          groupId: metadata.groupId,
          objectId: metadata.objectId,
          payloadSize: data.byteLength,
        });
      } else {
        // P-frame: write to existing stream
        const existing = this.activeVideoStreams.get(aliasKey);

        if (!existing) {
          // No active stream — open one (treat this object as the start of a subgroup)
          // OPS-hi 1: fires per group start — demoted from .info to .debug.
          log.debug('No active GOP stream, opening new stream for group', {
            trackAlias: aliasKey,
            groupId: metadata.groupId,
            objectId: metadata.objectId,
          });

          const pfSendOrder = this.deriveSendOrder(trackAlias, priority, metadata.groupId);
          const streamInfo = await this.doCreateStream(pfSendOrder !== undefined ? { sendOrder: pfSendOrder } : undefined);
          const [subgroupHeader, hasExtensions] = this.codec.encodeSubgroupHeader({
            trackAlias,
            groupId: metadata.groupId,
            subgroupId: 0,
            publisherPriority: priority,
          }, false);

          const objectData = this.codec.encodeStreamObject(
            metadata.objectId,
            data,
            ObjectStatus.NORMAL,
            -1,
            hasExtensions
          );

          const combinedData = new Uint8Array(subgroupHeader.length + objectData.length);
          combinedData.set(subgroupHeader, 0);
          combinedData.set(objectData, subgroupHeader.length);

          await this.doWriteStream(streamInfo, combinedData);

          this.activeVideoStreams.set(aliasKey, {
            writer: streamInfo.writer!,
            streamId: streamInfo.streamId!,
            groupId: metadata.groupId,
            objectCount: 1,
            previousObjectId: metadata.objectId,
            hasExtensions,
          });
          return;
        }

        if (existing.groupId !== metadata.groupId) {
          log.warn('P-frame groupId mismatch, closing stream and creating new', {
            trackAlias: aliasKey,
            existingGroupId: existing.groupId,
            objectGroupId: metadata.groupId,
          });
          try {
            await this.doCloseStream({ writer: existing.writer, streamId: existing.streamId });
          } catch {
            // Ignore close errors
          }
          this.activeVideoStreams.delete(aliasKey);
          await this.sendObjectViaStream(trackAlias, data, metadata, priority);
          return;
        }

        // Build extensions map if maxCacheDuration was set on the keyframe
        let extensions: Map<number, number> | undefined;
        if (existing.maxCacheDuration !== undefined && existing.maxCacheDuration > 0) {
          extensions = new Map();
          extensions.set(ObjectExtension.MAX_CACHE_DURATION, existing.maxCacheDuration);
        }

        const objectData = this.codec.encodeStreamObject(
          metadata.objectId,
          data,
          ObjectStatus.NORMAL,
          existing.previousObjectId, // Delta encoding from previous object
          existing.hasExtensions,
          extensions
        );

        try {
          await this.doWriteStream({ writer: existing.writer, streamId: existing.streamId }, objectData);
          existing.objectCount++;
          existing.previousObjectId = metadata.objectId; // Update for next delta

          log.debug('Added P-frame to GOP stream', {
            trackAlias: aliasKey,
            groupId: metadata.groupId,
            objectId: metadata.objectId,
            objectCount: existing.objectCount,
            payloadSize: data.byteLength,
          });
        } catch (writeErr) {
          const errMsg = (writeErr as Error).message;
          if (errMsg.includes('not found') || errMsg.includes('STOP_SENDING')) {
            // OPS-hi 1: keep at info — genuinely useful on error paths but not per-frame.
            // (this only fires on write failure, not per successful object)
            log.info('GOP stream closed by relay, reopening for same group', {
              trackAlias: aliasKey,
              groupId: metadata.groupId,
              objectId: metadata.objectId,
            });
            this.activeVideoStreams.delete(aliasKey);

            // Reopen stream and retry as if this is a new keyframe for the same group
            const reopenSendOrder = this.deriveSendOrder(trackAlias, priority, metadata.groupId);
            const streamInfo = await this.doCreateStream(reopenSendOrder !== undefined ? { sendOrder: reopenSendOrder } : undefined);
            const [subgroupHeader, hasExtensions] = this.codec.encodeSubgroupHeader({
              trackAlias,
              groupId: metadata.groupId,
              subgroupId: 0,
              publisherPriority: priority,
            }, false /* not endOfGroup - stream stays open */);

            const retryObjectData = this.codec.encodeStreamObject(
              metadata.objectId,
              data,
              ObjectStatus.NORMAL,
              -1, // first object in new subgroup
              hasExtensions
            );

            const combinedData = new Uint8Array(subgroupHeader.length + retryObjectData.length);
            combinedData.set(subgroupHeader, 0);
            combinedData.set(retryObjectData, subgroupHeader.length);

            await this.doWriteStream(streamInfo, combinedData);

            this.activeVideoStreams.set(aliasKey, {
              writer: streamInfo.writer!,
              streamId: streamInfo.streamId!,
              groupId: metadata.groupId,
              objectCount: 1,
              previousObjectId: metadata.objectId,
              hasExtensions,
            });
          } else {
            throw writeErr;
          }
        }
      }
    } catch (err) {
      log.error('Failed to send video object with GOP batching', {
        trackAlias: aliasKey,
        groupId: metadata.groupId,
        objectId: metadata.objectId,
        newGroup: metadata.newGroup,
        error: (err as Error).message,
      });
      this.activeVideoStreams.delete(aliasKey);
    }
  }

  /**
   * Close video GOP stream
   */
  private async closeVideoGOPStream(trackAlias: string): Promise<void> {
    const existing = this.activeVideoStreams.get(trackAlias);
    if (existing) {
      // §8: stream is closing cleanly — cancel the pending deadline.
      this.publisherDeliveryTimeouts.disarm(`pub-sg:${trackAlias}:${existing.groupId}:0`);
      try {
        await this.doCloseStream({ writer: existing.writer, streamId: existing.streamId });
        // OPS-hi 1: fires per group boundary — demoted from .info to .debug.
        log.debug('Closed video GOP stream', {
          trackAlias,
          groupId: existing.groupId,
          objectCount: existing.objectCount,
        });
      } catch (err) {
        log.warn('Error closing video GOP stream', {
          trackAlias,
          error: (err as Error).message,
        });
      }
      this.activeVideoStreams.delete(trackAlias);
    }
  }

  /**
   * Pause a subscription
   */
  async pauseSubscription(subscriptionId: number): Promise<void> {
    const subscription = this.subscriptionManager.get(subscriptionId);
    if (!subscription) {
      log.warn('No subscription found for pause', { subscriptionId });
      return;
    }

    if (subscription.paused) {
      log.info('Subscription already paused', { subscriptionId });
      return;
    }

    log.info('Pausing subscription', { subscriptionId });

    if (this.isDraft18) {
      await this.sendRequestUpdate(subscription.requestId, false);
      subscription.paused = true;
    } else {
      const subscribeUpdateMessage = {
        type: MessageType.SUBSCRIBE_UPDATE as const,
        requestId: BigInt(this.getNextRequestId()),
        subscriptionRequestId: subscription.requestId,
        startLocation: { groupId: 0n, objectId: 0n },
        endGroup: 0n,
        subscriberPriority: 128,
        forward: 0,
      };

      try {
        const updateBytes = this.codec.encodeControlMessage(subscribeUpdateMessage);
        await this.doSendControl(updateBytes);
        subscription.paused = true;
        log.info('Sent SUBSCRIBE_UPDATE (pause)', { subscriptionId, requestId: subscribeUpdateMessage.requestId.toString() });
      } catch (err) {
        log.error('Failed to send SUBSCRIBE_UPDATE (pause)', { error: (err as Error).message });
        throw err;
      }
    }
  }

  /**
   * Resume a subscription
   */
  async resumeSubscription(subscriptionId: number): Promise<void> {
    const subscription = this.subscriptionManager.get(subscriptionId);
    if (!subscription) {
      log.warn('No subscription found for resume', { subscriptionId });
      return;
    }

    if (!subscription.paused) {
      log.info('Subscription not paused', { subscriptionId });
      return;
    }

    log.info('Resuming subscription', { subscriptionId });

    if (this.isDraft18) {
      await this.sendRequestUpdate(subscription.requestId, true);
      subscription.paused = false;
    } else {
      const subscribeUpdateMessage = {
        type: MessageType.SUBSCRIBE_UPDATE as const,
        requestId: BigInt(this.getNextRequestId()),
        subscriptionRequestId: subscription.requestId,
        startLocation: { groupId: 0n, objectId: 0n },
        endGroup: 0n,
        subscriberPriority: 128,
        forward: 1,
      };

      try {
        const updateBytes = this.codec.encodeControlMessage(subscribeUpdateMessage);
        await this.doSendControl(updateBytes);
        subscription.paused = false;
        log.info('Sent SUBSCRIBE_UPDATE (resume)', { subscriptionId, requestId: subscribeUpdateMessage.requestId.toString() });
      } catch (err) {
        log.error('Failed to send SUBSCRIBE_UPDATE (resume)', { error: (err as Error).message });
        throw err;
      }
    }
  }

  /**
   * Seek a subscription to a specific position using SUBSCRIBE_UPDATE
   * Used for live trick play to change the start position
   */
  async seekSubscription(
    subscriptionId: number,
    groupId: number,
    objectId: number = 0
  ): Promise<void> {
    const subscription = this.subscriptionManager.get(subscriptionId);
    if (!subscription) {
      log.warn('No subscription found for seek', { subscriptionId });
      return;
    }

    log.info('Seeking subscription', { subscriptionId, groupId, objectId });

    const subscribeUpdateMessage = {
      type: MessageType.SUBSCRIBE_UPDATE as const,
      requestId: BigInt(this.getNextRequestId()),
      subscriptionRequestId: subscription.requestId,
      startLocation: { groupId: BigInt(groupId), objectId: BigInt(objectId) },
      endGroup: 0n,
      subscriberPriority: 128,
      forward: 1,
    };

    try {
      const updateBytes = this.codec.encodeControlMessage(subscribeUpdateMessage);
      await this.doSendControl(updateBytes);
      log.info('Sent SUBSCRIBE_UPDATE (seek)', {
        subscriptionId,
        requestId: subscribeUpdateMessage.requestId.toString(),
        groupId,
        objectId,
      });
    } catch (err) {
      log.error('Failed to send SUBSCRIBE_UPDATE (seek)', { error: (err as Error).message });
      throw err;
    }
  }

  /**
   * Check if a subscription is paused
   */
  isSubscriptionPaused(subscriptionId: number): boolean {
    const subscription = this.subscriptionManager.get(subscriptionId);
    return subscription?.paused ?? false;
  }

  /**
   * Get subscription info
   */
  getSubscription(subscriptionId: number): SubscriptionInfo | undefined {
    const sub = this.subscriptionManager.get(subscriptionId);
    if (!sub) return undefined;
    return {
      subscriptionId: sub.subscriptionId,
      requestId: sub.requestId,
      namespace: sub.namespace,
      trackName: sub.trackName,
      trackAlias: sub.trackAlias,
      paused: sub.paused,
    };
  }

  /**
   * Get publication info
   */
  getPublication(trackAlias: bigint | string): PublicationInfo | undefined {
    const pub = this.publicationManager.get(trackAlias);
    if (!pub) return undefined;
    return {
      trackAlias: pub.trackAlias,
      namespace: pub.namespace,
      trackName: pub.trackName,
      priority: pub.priority,
      deliveryMode: pub.deliveryMode,
    };
  }

  /**
   * Register an event handler
   */
  on(event: 'state-change', handler: (state: SessionState) => void): () => void;
  on(event: 'object', handler: (data: ReceivedObjectEvent) => void): () => void;
  on(event: 'error', handler: (err: Error) => void): () => void;
  on(event: 'publish-stats', handler: (stats: PublishStatsEvent) => void): () => void;
  on(event: 'subscribe-stats', handler: (stats: SubscribeStatsEvent) => void): () => void;
  on(event: 'subscribe-ok', handler: (event: SubscribeOkEvent) => void): () => void;
  on(event: 'subscribe-error', handler: (event: SubscribeErrorEvent) => void): () => void;
  on(event: 'namespace-error', handler: (event: NamespaceErrorEvent) => void): () => void;
  on(event: 'request-ok', handler: (event: RequestOkEvent) => void): () => void;
  on(event: 'publish-done', handler: (event: PublishDoneEvent) => void): () => void;
  on(event: 'publish-blocked', handler: (event: PublishBlockedEvent) => void): () => void;
  on(event: 'session-terminated', handler: (event: SessionTerminatedEvent) => void): () => void;
  on(event: 'session-migrating', handler: (event: SessionMigrationEvent) => void): () => void;
  on(event: 'session-migrated', handler: (event: SessionMigrationEvent) => void): () => void;
  on(event: 'incoming-subscribe', handler: (event: IncomingSubscribeEvent) => void): () => void;
  on(event: 'incoming-publish', handler: (event: IncomingPublishEvent) => void): () => void;
  on(event: 'namespace-acknowledged', handler: (data: { namespace: string[] }) => void): () => void;
  on(event: 'namespace-announced', handler: (event: NamespaceAnnouncedEvent) => void): () => void;
  on(event: 'namespace-done', handler: (event: NamespaceDoneEvent) => void): () => void;
  // FETCH / DVR events
  on(event: 'fetch-object', handler: (event: FetchObjectEvent) => void): () => void;
  on(event: 'fetch-complete', handler: (event: FetchCompleteEvent) => void): () => void;
  on(event: 'fetch-stream-complete', handler: (event: FetchStreamCompleteEvent) => void): () => void;
  on(event: 'fetch-error', handler: (event: FetchErrorEvent) => void): () => void;
  on(event: 'incoming-fetch', handler: (event: IncomingFetchEvent) => void): () => void;
  // Message logging events
  on(event: 'message-sent', handler: (event: MessageLogEvent) => void): () => void;
  on(event: 'message-received', handler: (event: MessageLogEvent) => void): () => void;
  // Forward state events
  on(event: 'forward-state-change', handler: (event: ForwardStateChangeEvent) => void): () => void;
  on(event: 'namespace-forward-paused', handler: (event: NamespaceForwardEvent) => void): () => void;
  on(event: 'namespace-forward-resumed', handler: (event: NamespaceForwardEvent) => void): () => void;
  on(event: 'new-group-request', handler: (event: NewGroupRequestEvent) => void): () => void;
  on(event: 'stream-reset', handler: (event: StreamResetEvent) => void): () => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: SessionEventType, handler: (data: any) => void): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler);

    return () => {
      this.handlers.get(event)?.delete(handler);
    };
  }

  // =========================================================================
  // Private methods
  // =========================================================================

  /**
   * Wait for SERVER_SETUP message (draft-14/16)
   */
  private waitForServerSetup(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timeout waiting for SERVER_SETUP'));
      }, 10000);

      const handler = (message: MOQTMessage) => {
        if (message.type === MessageType.SERVER_SETUP) {
          clearTimeout(timeout);
          const serverSetup = message as ServerSetupMessage;
          log.debug('Received SERVER_SETUP', {
            version: serverSetup.selectedVersion,
          });
          this.emitMessageReceived('SERVER_SETUP', 0, `version=${serverSetup.selectedVersion}`, { version: serverSetup.selectedVersion });
          this.setState('ready');
          resolve();
        }
      };

      this.onMessage = handler;
    });
  }

  /**
   * Wait for SERVER_SETUP message (draft-18).
   *
   * Draft-18 lets either endpoint send SETUP first on the shared setup stream,
   * so SERVER_SETUP can arrive before this waiter installs its handler. Any
   * setup messages that arrived before subscription are queued in
   * `pendingSetupMessages` and drained here.
   */
  private waitForServerSetupDraft18(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timeout waiting for SERVER_SETUP (draft-18)'));
      }, 10000);

      const handler = (message: ControlMessageDraft18) => {
        if (message.type === MessageTypeDraft18.SERVER_SETUP) {
          clearTimeout(timeout);
          const serverSetup = message as ServerSetupMessageDraft18;
          this._peerExtensions = serverSetup.extensions;
          log.debug('Received SERVER_SETUP (draft-18)', {
            version: serverSetup.selectedVersion,
            role: serverSetup.role,
            extensionCount: serverSetup.extensions?.size ?? 0,
          });
          this.setState('ready');
          resolve();
        }
      };

      this.onSetupMessage = handler;

      // Drain anything that arrived before we subscribed.
      if (this.pendingSetupMessages.length > 0) {
        const queued = this.pendingSetupMessages;
        this.pendingSetupMessages = [];
        for (const m of queued) handler(m);
      }
    });
  }

  /** Draft-18 setup message handler */
  private onSetupMessage?: (message: ControlMessageDraft18) => void;
  /** Setup messages received before `onSetupMessage` was registered. */
  private pendingSetupMessages: ControlMessageDraft18[] = [];

  /** Setup message buffer for draft-18 */
  private setupBuffer = new Uint8Array(0);
  private setupBufferOffset = 0;

  /**
   * Handle incoming setup stream messages (draft-18)
   */
  private handleSetupMessage(data: Uint8Array): void {
    const hex = Array.from(data.subarray(0, Math.min(32, data.length)))
      .map(b => b.toString(16).padStart(2, '0')).join(' ');
    log.info('Setup message received (draft-18)', { size: data.length, hex });

    try {
      // Append to buffer
      if (this.setupBuffer.length === 0) {
        this.setupBuffer = new Uint8Array(data);
        this.setupBufferOffset = 0;
      } else {
        const remaining = this.setupBuffer.length - this.setupBufferOffset;
        const newBuffer = new Uint8Array(remaining + data.length);
        newBuffer.set(this.setupBuffer.subarray(this.setupBufferOffset));
        newBuffer.set(data, remaining);
        this.setupBuffer = newBuffer;
        this.setupBufferOffset = 0;
      }

      // Try to decode messages (setup stream has no message type prefix)
      while (this.setupBufferOffset < this.setupBuffer.length) {
        try {
          const view = this.setupBuffer.subarray(this.setupBufferOffset);
          const [message, bytesRead] = this.codec.decodeSetupStream(view);

          this.setupBufferOffset += bytesRead;

          log.info('Received setup message (draft-18)', {
            type: MessageTypeDraft18[message.type],
          });

          // Handle setup callback (used during initial setup). If the waiter
          // hasn't subscribed yet (draft-18 allows SERVER_SETUP to arrive
          // before or in parallel with CLIENT_SETUP), queue for later drain.
          if (this.onSetupMessage) {
            this.onSetupMessage(message);
          } else if (this._state !== 'ready' && this._state !== 'closing') {
            this.pendingSetupMessages.push(message);
          }

          // Route post-setup messages (GOAWAY, REQUEST_UPDATE on setup stream)
          if (this._state === 'ready' || this._state === 'closing') {
            this.routeSetupStreamMessage(message);
          }
        } catch (err) {
          if ((err as Error).message?.includes('Incomplete') ||
              (err as Error).message?.includes('buffer')) {
            break;
          }
          throw err;
        }
      }

      // Reset buffer if all consumed
      if (this.setupBufferOffset >= this.setupBuffer.length) {
        this.setupBuffer = new Uint8Array(0);
        this.setupBufferOffset = 0;
      }
    } catch (err) {
      log.error('Error handling setup message (draft-18)', err as Error);
    }
  }

  /**
   * Route messages received on the setup stream after connection established (draft-18)
   */
  private routeSetupStreamMessage(message: ControlMessageDraft18): void {
    switch (message.type) {
      case MessageTypeDraft18.GOAWAY:
        this.handleIncomingGoAwayDraft18(message as GoAwayMessageDraft18);
        break;

      case MessageTypeDraft18.REQUEST_UPDATE:
        this.dispatchRequestUpdateDraft18(message as RequestUpdateMessageDraft18);
        break;

      case MessageTypeDraft18.PUBLISH_BLOCKED:
        this.handleIncomingPublishBlockedDraft18(message as PublishBlockedMessageDraft18);
        break;

      case MessageTypeDraft18.PUBLISH_DONE:
        this.handleIncomingPublishDoneDraft18(message as PublishDoneMessageDraft18);
        break;

      default:
        // SERVER_SETUP messages are ignored post-setup
        if (message.type !== MessageTypeDraft18.SERVER_SETUP) {
          log.warn('Unhandled message on setup stream', { type: MessageTypeDraft18[message.type] });
        }
    }
  }

  /**
   * Handle incoming bidirectional stream (draft-18 server-initiated requests)
   */
  private handleIncomingBidiStream(stream: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }): void {
    log.info('Handling incoming bidi stream (draft-18)');
    this.processIncomingBidiStream(stream).catch(err => {
      log.error('Error processing incoming bidi stream', { error: (err as Error).message });
    });
  }

  /**
   * Process incoming bidi stream: read request, dispatch, respond
   */
  private async processIncomingBidiStream(stream: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }): Promise<void> {
    const reader = stream.readable.getReader();
    const chunks: Uint8Array[] = [];
    let totalLength = 0;

    try {
      // Read until we have a complete message
      let message: ControlMessageDraft18 | null = null;
      while (!message) {
        const { value, done } = await reader.read();
        if (done) {
          log.warn('Incoming bidi stream closed before message received');
          return;
        }
        chunks.push(value);
        totalLength += value.length;

        const buffer = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of chunks) {
          buffer.set(chunk, offset);
          offset += chunk.length;
        }

        try {
          const [decoded] = this.codec.decodeControlMessage(buffer, 0, this.metrics);
          message = decoded as ControlMessageDraft18;
        } catch (err) {
          if ((err as Error).message?.includes('Incomplete') || (err as Error).message?.includes('buffer')) {
            continue;
          }
          throw err;
        }
      }

      log.info('Received message on incoming bidi stream', { type: MessageTypeDraft18[message.type] });

      // Dispatch based on message type
      switch (message.type) {
        case MessageTypeDraft18.SUBSCRIBE:
          await this.handleIncomingSubscribeDraft18(message as SubscribeMessageDraft18, stream.writable);
          break;

        case MessageTypeDraft18.PUBLISH:
          await this.handleIncomingPublishDraft18(message as PublishMessageDraft18, stream.writable);
          break;

        case MessageTypeDraft18.FETCH:
          await this.handleIncomingFetchDraft18(message as FetchMessageDraft18, stream.writable);
          break;

        case MessageTypeDraft18.TRACK_STATUS:
          await this.handleIncomingTrackStatusDraft18(message as TrackStatusMessageDraft18, stream.writable);
          break;

        case MessageTypeDraft18.SUBSCRIBE_NAMESPACE:
          await this.handleIncomingSubscribeNamespaceDraft18(message as SubscribeNamespaceMessageDraft18, stream.writable, reader);
          break;

        case MessageTypeDraft18.PUBLISH_NAMESPACE:
          await this.handleIncomingPublishNamespaceDraft18(message as PublishNamespaceMessageDraft18, stream.writable);
          break;

        case MessageTypeDraft18.SUBSCRIBE_TRACKS:
          await this.handleIncomingSubscribeTracksDraft18(message as SubscribeTracksMessageDraft18, stream.writable);
          break;

        case MessageTypeDraft18.REQUEST_UPDATE:
          await this.handleIncomingRequestUpdateDraft18(message as RequestUpdateMessageDraft18, stream.writable);
          break;

        case MessageTypeDraft18.PUBLISH_DONE:
          this.handleIncomingPublishDoneDraft18(message as PublishDoneMessageDraft18);
          break;

        case MessageTypeDraft18.GOAWAY:
          this.handleIncomingGoAwayDraft18(message as GoAwayMessageDraft18);
          break;

        case MessageTypeDraft18.PUBLISH_BLOCKED:
          this.handleIncomingPublishBlockedDraft18(message as PublishBlockedMessageDraft18);
          break;

        default:
          log.warn('Unhandled message type on incoming bidi stream', { type: message.type });
          await this.sendRequestErrorOnStream(
            stream.writable,
            0n,
            RequestErrorCodeDraft18.NOT_SUPPORTED,
            'Unsupported message type',
          );
      }
    } catch (err) {
      log.error('Error reading incoming bidi stream', { error: (err as Error).message });
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Handle incoming SUBSCRIBE on bidi stream (we are the publisher)
   */
  private async handleIncomingSubscribeDraft18(
    message: SubscribeMessageDraft18,
    writable: WritableStream<Uint8Array>
  ): Promise<void> {
    const namespace = message.trackNamespace;
    const trackName = message.trackName;
    const fullTrackNameStr = [...namespace, trackName].join('/');

    log.info('Received SUBSCRIBE (draft-18 bidi)', {
      requestId: message.requestId.toString(),
      namespace: namespace.join('/'),
      trackName,
    });

    // B3 SEC: peer-initiated draft-18 subscribe creates a publication for
    // this subscriber; gate on maxTracks before accepting.
    try {
      this.enforceResourceLimit('tracks', this.publicationManager.size, this.maxTracks);
    } catch {
      return;
    }

    // Check if this matches any announced namespace
    const announceInfo = this.matchesAnnouncedNamespace(namespace);

    if (!announceInfo) {
      log.warn('SUBSCRIBE does not match any announced namespace', { namespace: namespace.join('/') });
      await this.sendRequestErrorOnStream(
        writable,
        message.requestId,
        RequestErrorCodeDraft18.DOES_NOT_EXIST,
        'No matching namespace',
      );
      return;
    }

    // Assign track alias
    const trackAlias = BigInt(this.nextIncomingTrackAlias++);

    // Send SUBSCRIBE_OK with the track alias we'll use on data streams.
    // Advertise §10.2.10 EXPIRES when the announcer configured it — 0 means
    // "no expiration" per spec, undefined omits the parameter.
    const expires = announceInfo.options.expires;
    const subscribeOk: SubscribeOkMessageDraft18 = {
      type: MessageTypeDraft18.SUBSCRIBE_OK,
      requestId: message.requestId,
      trackAlias,
      largestLocation: { group: 0n, object: 0n },
      expires: expires !== undefined ? BigInt(expires) : undefined,
    };
    const responseBytes = this.codec.encodeControlMessage(subscribeOk);
    const writer = writable.getWriter();
    await writer.write(responseBytes);
    writer.releaseLock();

    // Remember the kind so a later REQUEST_UPDATE (§10.9.1) routes correctly
    this.incomingRequestKinds.set(message.requestId, 'subscribe');

    // §7 — pull subscriber-side scheduling hints from the SUBSCRIBE parameters
    // (§10.2 SUBSCRIBER_PRIORITY, GROUP_ORDER). Missing values fall back to
    // the neutral defaults (priority=128, ASCENDING).
    const sched = parseSubscriberSchedulingParams(message.parameters);
    const subscriberPriority = sched.subscriberPriority ?? 128;
    const subscriberGroupOrder = sched.groupOrder ?? GroupOrder.ASCENDING;

    // Create publication entry
    const publication: InternalPublication = {
      trackAlias,
      namespace,
      trackName,
      priority: announceInfo.options.priority ?? 128,
      deliveryMode: announceInfo.options.deliveryMode ?? 'stream',
      audioDeliveryMode: announceInfo.options.audioDeliveryMode ?? 'datagram',
      requestId: message.requestId,
      cleanupHandlers: [],
      forward: 1,
      subscriberPriority,
      subscriberGroupOrder,
    };
    this.publicationManager.add(publication);

    // Add to subscribers map. Bounded number cast: subscribers is keyed by
    // request id in the announce table which is locally scoped, but we must
    // stringify to keep bigint precision in future migration; today we still
    // key by number for cheap Map lookup (announcements are short-lived).
    const subscriber: IncomingSubscriber = {
      requestId: message.requestId,
      fullTrackName: { namespace, trackName },
      trackAlias,
      subscriberPriority,
      groupOrder: subscriberGroupOrder,
      active: true,
    };
    announceInfo.subscribers.set(message.requestId, subscriber);

    // Emit event
    this.emit('incoming-subscribe', {
      requestId: message.requestId,
      namespace,
      trackName,
      trackAlias,
    } as IncomingSubscribeEvent);

    log.info('Accepted SUBSCRIBE (draft-18)', { trackAlias: trackAlias.toString(), fullTrackName: fullTrackNameStr });
  }

  /**
   * Handle incoming PUBLISH on bidi stream (we are the subscriber)
   */
  private async handleIncomingPublishDraft18(
    message: PublishMessageDraft18,
    writable: WritableStream<Uint8Array>
  ): Promise<void> {
    const namespace = message.trackNamespace;
    const trackName = message.trackName;
    const fullTrackNameStr = [...namespace, trackName].join('/');
    const namespaceStr = namespace.join('/');

    // B3 SEC: peer-initiated draft-18 publish creates a subscription for us
    // to ingest their track; gate on maxSubscriptions before accepting.
    try {
      this.enforceResourceLimit('subscriptions', this.subscriptionManager.size, this.maxSubscriptions);
    } catch {
      return;
    }

    log.info('Received PUBLISH (draft-18 bidi)', {
      requestId: message.requestId.toString(),
      namespace: namespaceStr,
      trackName,
      trackAlias: message.trackAlias.toString(),
    });

    // Check if this is our own publish
    if (this.ownNamespacePrefix && namespaceStr.startsWith(this.ownNamespacePrefix)) {
      log.debug('Ignoring own PUBLISH', { namespace: namespaceStr });
      return;
    }

    // Find matching namespace subscription
    let matchingSubscription: NamespaceSubscriptionInfo | undefined;
    for (const sub of this.namespaceSubscriptions.values()) {
      const prefix = sub.namespacePrefix.join('/');
      if (namespaceStr.startsWith(prefix)) {
        matchingSubscription = sub;
        break;
      }
    }

    if (!matchingSubscription) {
      log.warn('PUBLISH does not match any namespace subscription', { publishNamespace: namespaceStr });
      await this.sendRequestErrorOnStream(
        writable,
        message.requestId,
        RequestErrorCodeDraft18.UNINTERESTED,
        'No matching subscription',
      );
      return;
    }

    // Send REQUEST_OK to accept. §10.2.10 EXPIRES carries the namespace
    // subscription's expiry hint when set.
    const expires = matchingSubscription.expires;
    const requestOk: RequestOkMessageDraft18 = {
      type: MessageTypeDraft18.REQUEST_OK,
      requestId: message.requestId,
      expires: expires !== undefined ? BigInt(expires) : undefined,
    };
    const responseBytes = this.codec.encodeControlMessage(requestOk);
    const writer = writable.getWriter();
    await writer.write(responseBytes);
    writer.releaseLock();

    this.incomingRequestKinds.set(message.requestId, 'publish');

    // Register as subscription for object routing
    const subscriptionId = this.getNextRequestId();
    const subscription: InternalSubscription = {
      subscriptionId,
      requestId: message.requestId,
      namespace,
      trackName,
      trackAlias: message.trackAlias,
      paused: false,
      onObject: matchingSubscription.onObject,
    };
    this.subscriptionManager.add(subscription);

    // Store track info
    const trackInfo: IncomingPublishInfo = {
      requestId: message.requestId,
      namespace,
      trackName,
      trackAlias: message.trackAlias,
      groupOrder: GroupOrder.ASCENDING,
      acknowledged: true,
    };
    matchingSubscription.tracks.set(fullTrackNameStr, trackInfo);

    // Emit event
    this.emit('incoming-publish', {
      namespaceSubscriptionId: matchingSubscription.subscriptionId,
      subscriptionId,
      requestId: message.requestId,
      namespace,
      trackName,
      trackAlias: message.trackAlias,
      groupOrder: GroupOrder.ASCENDING,
    } as IncomingPublishEvent);

    log.info('Accepted PUBLISH (draft-18)', { trackAlias: message.trackAlias.toString(), fullTrackName: fullTrackNameStr });
  }

  /**
   * Handle incoming FETCH on bidi stream
   */
  private async handleIncomingFetchDraft18(
    message: FetchMessageDraft18,
    writable: WritableStream<Uint8Array>
  ): Promise<void> {
    log.info('Received FETCH (draft-18)', { requestId: message.requestId.toString() });
    // For now, respond with REQUEST_ERROR since we don't cache objects
    await this.sendRequestErrorOnStream(
      writable,
      message.requestId,
      RequestErrorCodeDraft18.NOT_SUPPORTED,
      'Fetch not supported',
    );
  }

  /**
   * Handle incoming TRACK_STATUS on bidi stream (draft-18 §10.14).
   *
   * If we're publishing the queried track, reply with REQUEST_OK carrying
   * LARGEST_OBJECT (0x09) so the requester knows the live edge; otherwise
   * reply with REQUEST_ERROR DOES_NOT_EXIST (§15.10.2). LARGEST_OBJECT is
   * omitted when the publication has not yet sent any objects.
   */
  private async handleIncomingTrackStatusDraft18(
    message: TrackStatusMessageDraft18,
    writable: WritableStream<Uint8Array>
  ): Promise<void> {
    log.info('Received TRACK_STATUS (draft-18)', {
      requestId: message.requestId.toString(),
      namespace: message.trackNamespace.join('/'),
      trackName: message.trackName,
    });

    const pub = this.publicationManager.getByTrackName(message.trackNamespace, message.trackName);
    if (!pub) {
      await this.sendRequestErrorOnStream(
        writable,
        message.requestId,
        RequestErrorCodeDraft18.DOES_NOT_EXIST,
        'Track not published by this session',
      );
      return;
    }

    const requestOk: RequestOkMessageDraft18 = {
      type: MessageTypeDraft18.REQUEST_OK,
      requestId: message.requestId,
    };
    if (pub.latestGroup !== undefined && pub.latestObject !== undefined) {
      requestOk.largestLocation = { group: pub.latestGroup, object: pub.latestObject };
    }
    const writer = writable.getWriter();
    try {
      await writer.write(this.codec.encodeControlMessage(requestOk));
    } finally {
      writer.releaseLock();
    }
  }

  /**
   * Handle incoming SUBSCRIBE_NAMESPACE on bidi stream (we are the publisher)
   */
  private async handleIncomingSubscribeNamespaceDraft18(
    message: SubscribeNamespaceMessageDraft18,
    writable: WritableStream<Uint8Array>,
    _reader: ReadableStreamDefaultReader<Uint8Array>
  ): Promise<void> {
    const prefix = message.trackNamespacePrefix.join('/');
    log.info('Received SUBSCRIBE_NAMESPACE (draft-18)', {
      requestId: message.requestId.toString(),
      prefix,
    });

    // Send REQUEST_OK
    const requestOk: RequestOkMessageDraft18 = {
      type: MessageTypeDraft18.REQUEST_OK,
      requestId: message.requestId,
    };
    const writer = writable.getWriter();
    await writer.write(this.codec.encodeControlMessage(requestOk));

    // Remember the kind so a later REQUEST_UPDATE (§10.9.2) routes correctly
    this.incomingRequestKinds.set(message.requestId, 'subscribe-namespace');

    // Send NAMESPACE messages for matching announced namespaces
    for (const [, announceInfo] of this.announcedNamespaces) {
      const nsStr = announceInfo.namespace.join('/');
      if (nsStr.startsWith(prefix)) {
        const nsMsg: NamespaceMessageDraft18 = {
          type: MessageTypeDraft18.NAMESPACE,
          trackNamespace: announceInfo.namespace,
        };
        await writer.write(this.codec.encodeControlMessage(nsMsg));
      }
    }

    // Send NAMESPACE_DONE
    const nsDone: NamespaceDoneMessageDraft18 = {
      type: MessageTypeDraft18.NAMESPACE_DONE,
      finalNamespace: message.trackNamespacePrefix,
    };
    await writer.write(this.codec.encodeControlMessage(nsDone));
    writer.releaseLock();
  }

  /**
   * Handle incoming PUBLISH_NAMESPACE on bidi stream (we are the subscriber)
   */
  private async handleIncomingPublishNamespaceDraft18(
    message: PublishNamespaceMessageDraft18,
    writable: WritableStream<Uint8Array>
  ): Promise<void> {
    const prefix = message.trackNamespacePrefix.join('/');
    log.info('Received PUBLISH_NAMESPACE (draft-18)', {
      requestId: message.requestId.toString(),
      prefix,
    });

    // Accept with REQUEST_OK
    const requestOk: RequestOkMessageDraft18 = {
      type: MessageTypeDraft18.REQUEST_OK,
      requestId: message.requestId,
    };
    const responseBytes = this.codec.encodeControlMessage(requestOk);
    const writer = writable.getWriter();
    await writer.write(responseBytes);
    writer.releaseLock();

    this.incomingRequestKinds.set(message.requestId, 'publish-namespace');

    log.info('Accepted PUBLISH_NAMESPACE (draft-18)', { prefix });
  }

  /**
   * Handle incoming SUBSCRIBE_TRACKS on bidi stream
   */
  private async handleIncomingSubscribeTracksDraft18(
    message: SubscribeTracksMessageDraft18,
    writable: WritableStream<Uint8Array>
  ): Promise<void> {
    const prefix = message.trackNamespacePrefix.join('/');

    // §10.2.14 TRACK_NAMESPACE_PREFIX narrows the top-level prefix. When the
    // parameter is present and parseable we require publications to match the
    // narrower tuple; malformed parameters are ignored so we don't drop matches
    // due to a decoder bug on the peer.
    const paramPrefixBytes = message.parameters?.get(RequestParameterDraft18.TRACK_NAMESPACE_PREFIX);
    const paramPrefix = paramPrefixBytes ? decodeTrackNamespaceBytes(paramPrefixBytes) : undefined;
    const paramPrefixStr = paramPrefix?.join('/');

    log.info('Received SUBSCRIBE_TRACKS (draft-18)', {
      requestId: message.requestId.toString(),
      prefix,
      paramPrefix: paramPrefixStr,
      forwardState: message.forwardState,
      filter: message.filter,
    });

    // Accept with REQUEST_OK
    const requestOk: RequestOkMessageDraft18 = {
      type: MessageTypeDraft18.REQUEST_OK,
      requestId: message.requestId,
    };
    const responseBytes = this.codec.encodeControlMessage(requestOk);
    const writer = writable.getWriter();
    await writer.write(responseBytes);
    writer.releaseLock();

    // SUBSCRIBE_TRACKS is a namespace-scoped subscription for track discovery;
    // future REQUEST_UPDATE on this requestId is §10.9.2 namespace-scoped.
    this.incomingRequestKinds.set(message.requestId, 'subscribe-namespace');

    // Emit incoming-subscribe for each track we publish under this prefix,
    // applying the §10.2.14 narrower prefix filter when supplied.
    for (const [, pub] of this.publicationManager) {
      const pubNs = pub.namespace.join('/');
      if (!pubNs.startsWith(prefix)) continue;
      if (paramPrefixStr && !pubNs.startsWith(paramPrefixStr)) continue;
      this.emit('incoming-subscribe', {
        requestId: message.requestId,
        namespace: pub.namespace,
        trackName: pub.trackName,
        trackAlias: pub.trackAlias,
      } as IncomingSubscribeEvent);
    }
  }

  /**
   * Handle incoming REQUEST_UPDATE on bidi stream
   */
  private async handleIncomingRequestUpdateDraft18(
    message: RequestUpdateMessageDraft18,
    _writable: WritableStream<Uint8Array>
  ): Promise<void> {
    this.dispatchRequestUpdateDraft18(message);
  }

  /**
   * Route a draft-18 REQUEST_UPDATE (§10.9) to the correct variant handler
   * based on the request kind we previously accepted for `requestId`:
   * - §10.9.1 subscription-scoped → forward-paused / forward-resumed
   * - §10.9.2 namespace-scoped   → namespace-forward-paused / -resumed
   *
   * If the target requestId is unknown we log and fall back to the
   * subscription variant, which matches prior behaviour and keeps backward
   * compatibility with peers that don't set up state before updating.
   */
  private dispatchRequestUpdateDraft18(message: RequestUpdateMessageDraft18): void {
    const requestId = message.requestId;
    const kind = this.incomingRequestKinds.get(requestId) ?? 'unknown';
    log.info('Received REQUEST_UPDATE (draft-18)', {
      requestId: message.requestId.toString(),
      forwardState: message.forwardState,
      variant: kind,
    });

    // §10.2.13 NEW_GROUP_REQUEST — the subscriber wants us to cut a new group.
    // Surfaced independently of pause/resume because the two flags can arrive
    // together (typical: resume forwarding *and* rebase on a keyframe).
    const ngrBytes = message.parameters?.get(RequestParameterDraft18.NEW_GROUP_REQUEST);
    if (ngrBytes && ngrBytes.length > 0) {
      let value: number;
      try {
        value = Number(MOQTVarInt.decode(ngrBytes)[0]);
      } catch {
        value = ngrBytes[0] ?? 0;
      }
      if (value !== 0) {
        this.emit('new-group-request', {
          requestId,
          value,
          forwardState: message.forwardState,
        });
      }
    }

    if (kind === 'subscribe-namespace') {
      // §10.9.2 — namespace-scoped update; do not touch per-track publications.
      const event: NamespaceForwardEvent = { namespaceRequestId: requestId };
      this.emit(message.forwardState ? 'namespace-forward-resumed' : 'namespace-forward-paused', event);
      return;
    }

    // §7 / §10.9.1 — if the update carries new SUBSCRIBER_PRIORITY or
    // GROUP_ORDER, mirror them onto the matching publication and the
    // announced-subscriber entry. The spec says a best effort SHOULD be made
    // to apply the change to objects not yet scheduled; we update state so
    // future streams pick up the new values via `computeSendOrder`.
    const sched = parseSubscriberSchedulingParams(message.parameters);
    if (sched.subscriberPriority !== undefined || sched.groupOrder !== undefined) {
      const pub = this.publicationManager.getByRequestId(requestId);
      if (pub) {
        if (sched.subscriberPriority !== undefined) pub.subscriberPriority = sched.subscriberPriority;
        if (sched.groupOrder !== undefined) pub.subscriberGroupOrder = sched.groupOrder;
      }
      for (const info of this.announcedNamespaces.values()) {
        const sub = info.subscribers.get(requestId);
        if (sub) {
          if (sched.subscriberPriority !== undefined) sub.subscriberPriority = sched.subscriberPriority;
          if (sched.groupOrder !== undefined) sub.groupOrder = sched.groupOrder;
          break;
        }
      }
    }

    // §10.9.1 — subscription-scoped update. Narrow the forward-state flip to
    // the publication bound to this requestId so a pause from one subscriber
    // doesn't stall the session's other tracks. If we don't have a matching
    // publication (kind === 'unknown'), fall back to the session-wide update
    // for backward compatibility with peers that don't set up state first.
    const forward = message.forwardState ? 1 : 0;
    const matched = this.publicationManager.setForwardByRequestId(requestId, forward);
    if (!matched) {
      if (message.forwardState) {
        this.publicationManager.resolveAllForward();
      }
      // No matching publication → nothing to pause on our side; still emit
      // the event so any bespoke listener can react.
    }
    if (message.forwardState) {
      this.emit('forward-resumed', { requestId });
    } else {
      this.emit('forward-paused', { subscriptionRequestId: requestId });
    }
  }

  /**
   * Handle incoming PUBLISH_DONE
   */
  private handleIncomingPublishDoneDraft18(message: PublishDoneMessageDraft18): void {
    const requestId = message.requestId;
    log.info('Received PUBLISH_DONE (draft-18)', {
      requestId: requestId.toString(),
      finalGroup: message.finalLocation.group.toString(),
      finalObject: message.finalLocation.object.toString(),
      statusCode: message.statusCode?.toString(),
      reasonPhrase: message.reasonPhrase,
      streamCount: message.streamCount?.toString(),
    });

    // Find and remove the subscription by requestId
    const sub = this.subscriptionManager.findByRequestId(requestId);
    // Object-plane finalGroup/finalObject remain `number` (see PublishDoneEvent);
    // narrow with range check.
    this.emit('publish-done', {
      requestId,
      subscriptionId: sub?.subscriptionId,
      finalGroupId: narrowBigIntToNumber(message.finalLocation.group, 'PUBLISH_DONE.finalGroup'),
      finalObjectId: narrowBigIntToNumber(message.finalLocation.object, 'PUBLISH_DONE.finalObject'),
      statusCode: message.statusCode !== undefined ? Number(message.statusCode) : undefined,
      reasonPhrase: message.reasonPhrase,
      streamCount: message.streamCount !== undefined ? Number(message.streamCount) : undefined,
    } as PublishDoneEvent);

    if (sub) {
      this.subscriptionManager.remove(sub.subscriptionId);
      log.info('Subscription removed after PUBLISH_DONE', { subscriptionId: sub.subscriptionId });
    }
  }

  /**
   * Handle incoming GOAWAY (draft-18 §3.5 / §3.6).
   *
   * The peer is telling us to wind down. If `newSessionUri` is non-empty
   * (§3.6 migration), we cache it so callers can call `migrate()` later, and
   * — when `autoMigrate` was set on the session config — kick off migration
   * automatically after the current tick. The `goaway` event is emitted
   * regardless so callers can react (drain pending publishes, warn UI, etc.).
   */
  private handleIncomingGoAwayDraft18(message: GoAwayMessageDraft18): void {
    const uri = message.newSessionUri && message.newSessionUri.length > 0
      ? message.newSessionUri
      : undefined;
    log.info('Received GOAWAY (draft-18)', {
      newSessionUri: uri,
      timeoutMs: message.timeout.toString(),
      requestId: message.requestId?.toString(),
    });

    if (uri) {
      this._pendingMigrationUri = uri;
    }

    this.emit('goaway', {
      newSessionUri: uri,
      timeoutMs: message.timeout,
      requestId: message.requestId,
    });
    this.setState('closing');

    // §3.6 auto-migration: only meaningful in worker mode, since main-thread
    // callers own the transport lifecycle themselves.
    if (uri && this.useWorker && this.workerConfig?.autoMigrate) {
      // Defer to the next microtask so the caller's `goaway` handler runs
      // first and can veto by clearing `_pendingMigrationUri` if needed.
      queueMicrotask(() => {
        if (this._pendingMigrationUri === uri) {
          this.autoMigrateWithBackoff(uri).catch((err) => {
            log.error('Auto-migrate failed after retries', err as Error);
            this.emit('error', err as Error);
          });
        }
      });
    }
  }

  /**
   * Reconnect (auto-migrate) driven by the injected {@link ReconnectPolicy}.
   *
   * The policy owns the timing math — historically this loop hand-rolled
   * jittered exponential backoff, but Wave 2 Track E consolidated on the
   * shared `JitteredExponentialBackoff` so callers can inject deterministic
   * policies for tests and tune per-deployment retry budgets without
   * touching session code.
   *
   * `nextDelayMs()` returning `null` is the policy's "give up" signal; when
   * we see it we throw the last observed error (or a synthetic one if the
   * policy vetoed before any attempt ran) so the caller can surface it via
   * the session `error` event.
   */
  private async autoMigrateWithBackoff(uri: string): Promise<void> {
    const policy: ReconnectPolicy =
      this._reconnectPolicy ??
      new JitteredExponentialBackoff({
        baseMs: 500,
        factor: 2,
        capMs: 30_000,
        jitter: 0.25,
        maxAttempts: 8,
      });

    let attempt = 0;
    let lastError: unknown;
    // Loop attempts driven by the policy. Each iteration executes attempt N,
    // then asks the policy how long to wait before attempt N+1. A `null`
    // response ends the loop with "give up".
    // eslint-disable-next-line no-constant-condition
    while (true) {
      // Caller cleared the pending URI (or a subsequent GOAWAY replaced it)
      // — abandon this retry loop.
      if (this._pendingMigrationUri !== uri) {
        return;
      }
      try {
        await this.migrate(uri);
        return;
      } catch (err) {
        lastError = err;
        attempt++;
        this.metrics.counter('moq.session.reconnect.attempt', 1);
        const delay = policy.nextDelayMs(attempt);
        if (delay === null) {
          // Policy exhausted its budget — stop retrying, surface the error.
          this.metrics.counter('moq.session.reconnect.give_up', 1);
          break;
        }
        log.warn('Auto-migrate attempt failed, retrying', {
          attempt,
          nextDelayMs: delay,
          error: (err as Error).message,
        });
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Auto-migrate failed');
  }

  /**
   * Handle transport close (draft-18 §15.10.1 termination code path).
   *
   * When the peer closes the WebTransport with a non-zero closeCode, we
   * surface it as a typed `session-terminated` event. Local closes and
   * migrations are silent — we don't re-emit for our own `session.close()`
   * because those already ran the teardown path.
   */
  private handleTransportClosed(info: { closeCode: number; reason: string; remote: boolean }): void {
    // Migrations run through `close() + connect()`, and we don't want the
    // local close to trigger a spurious termination event on the way down.
    if (this._migrating) {
      log.debug('Ignoring transport close during migration', info);
      return;
    }

    if (!info.remote) {
      // Local-initiated close — we already ran the teardown; nothing else to do.
      log.debug('Local transport close', info);
      return;
    }

    // §14 grease: normalize unknown Session Termination codes to
    // INTERNAL_ERROR before emitting. Preserve the raw code on the event so
    // callers with newer registry knowledge can still inspect it if needed.
    const normalizedCode = this.isDraft18
      ? normalizeSessionErrorCode(info.closeCode)
      : info.closeCode;
    this._lastCloseCode = normalizedCode;
    this._lastCloseReason = info.reason;
    this.metrics.counter('moq.session.close', 1, {
      remote: 'true',
      code: String(normalizedCode),
    });
    this.sessionLog.debug('Peer closed session', { ...info, normalizedCode });
    this.emit('session-terminated', {
      code: normalizedCode,
      reason: info.reason,
      remote: true,
    } as SessionTerminatedEvent);

    // If the peer aborted with an error code, elevate to the `error` state so
    // downstream consumers stop issuing new requests.
    if (info.closeCode !== 0) {
      this.handleError(new Error(`Peer closed session (code=${info.closeCode}, reason=${info.reason || '<empty>'})`));
    } else {
      this.setState('none');
    }
  }

  /**
   * Migrate the session to a new relay URI (draft-18 §3.6).
   *
   * Closes the current transport gracefully, then re-connects to
   * `newSessionUri` (or the URI cached from the most recent GOAWAY when
   * omitted), and replays CLIENT_SETUP with the same auth token. Only
   * available in worker mode — main-thread callers own their `MOQTransport`
   * lifecycle and should reconnect their own instance.
   *
   * Note: existing subscriptions and publications are dropped; the caller is
   * responsible for re-subscribing after migration. `session-migrating` fires
   * before teardown; `session-migrated` fires once SETUP completes on the
   * new URI.
   */
  async migrate(newSessionUri?: string): Promise<void> {
    if (!this.useWorker) {
      throw new Error('migrate() is only available in worker mode');
    }

    const target = newSessionUri ?? this._pendingMigrationUri;
    if (!target) {
      throw new Error('migrate(): no target URI (pass newSessionUri or wait for GOAWAY with newSessionUri)');
    }

    const oldSessionUri = this._lastConnectUrl;
    this.sessionLog.info('Migrating session (draft-18 §3.6)', { from: oldSessionUri, to: target });
    this.metrics.counter('moq.session.migrate.attempt', 1);

    this._migrating = true;
    try {
      this.emit('session-migrating', { newSessionUri: target, oldSessionUri } as SessionMigrationEvent);

      // Tear down publications / subscriptions / transport with NO_ERROR so
      // the peer sees a clean close on the outgoing side.
      await this.close({ code: SessionErrorCodeDraft18.NO_ERROR, reason: 'session migration' });

      // `close()` sets state to 'none'; walk through the normal connect+setup
      // path against the new URI.
      await this.connect(target);
      await this.setup();

      this._pendingMigrationUri = undefined;
      this._reconnectAttempts += 1;
      this._lastCloseReason = undefined;
      this._lastCloseCode = undefined;
      this.metrics.counter('moq.session.migrate.success', 1);
      this.emit('session-migrated', { newSessionUri: target, oldSessionUri } as SessionMigrationEvent);
      this.sessionLog.info('Migration complete', { reconnectAttempts: this._reconnectAttempts });
    } catch (err) {
      this.metrics.counter('moq.session.migrate.failure', 1);
      throw err;
    } finally {
      this._migrating = false;
    }
  }

  /**
   * URI most recently supplied by an incoming GOAWAY message. Useful for
   * callers that want to log or confirm migration targets before invoking
   * `migrate()` themselves. Cleared after a successful migration.
   */
  get pendingMigrationUri(): string | undefined {
    return this._pendingMigrationUri;
  }

  /**
   * Handle incoming PUBLISH_BLOCKED
   */
  private handleIncomingPublishBlockedDraft18(message: PublishBlockedMessageDraft18): void {
    log.info('Received PUBLISH_BLOCKED (draft-18)', { trackAlias: message.trackAlias.toString() });
    this.emit('publish-blocked', { trackAlias: message.trackAlias } as PublishBlockedEvent);
  }

  /**
   * Send REQUEST_ERROR on a bidi stream
   */
  private async sendRequestErrorOnStream(
    writable: WritableStream<Uint8Array>,
    requestId: bigint,
    errorCode: number,
    reasonPhrase: string
  ): Promise<void> {
    const errorMsg: RequestErrorMessageDraft18 = {
      type: MessageTypeDraft18.REQUEST_ERROR,
      requestId,
      errorCode,
      reasonPhrase,
    };
    const writer = writable.getWriter();
    await writer.write(this.codec.encodeControlMessage(errorMsg));
    writer.releaseLock();
  }

  /**
   * Handle incoming control messages
   */
  private handleControlMessage(data: Uint8Array): void {
    this.markInboundActivity();
    const remainingBytes = this.controlBuffer.length - this.controlBufferOffset;
    log.debug('Control message received', {
      newDataSize: data.length,
      existingBufferSize: remainingBytes,
    });

    try {
      // Append to buffer efficiently
      if (remainingBytes === 0) {
        // No pending data, use incoming data directly
        this.controlBuffer = new Uint8Array(data);
        this.controlBufferOffset = 0;
      } else if (this.controlBufferOffset > 0 && this.controlBufferOffset > this.controlBuffer.length / 2) {
        // Compact buffer if offset is past halfway - reduces memory usage
        const newBuffer = new Uint8Array(remainingBytes + data.length);
        newBuffer.set(this.controlBuffer.slice(this.controlBufferOffset));
        newBuffer.set(data, remainingBytes);
        this.controlBuffer = newBuffer;
        this.controlBufferOffset = 0;
      } else {
        // Append new data
        const newBuffer = new Uint8Array(this.controlBuffer.length + data.length);
        newBuffer.set(this.controlBuffer);
        newBuffer.set(data, this.controlBuffer.length);
        this.controlBuffer = newBuffer;
      }

      // Try to decode messages
      let messagesDecoded = 0;
      const bufferLength = this.controlBuffer.length;
      while (this.controlBufferOffset < bufferLength) {
        try {
          // Decode from current offset using subarray (no copy)
          const view = this.controlBuffer.subarray(this.controlBufferOffset);
          const [message, bytesRead] = this.codec.decodeControlMessage(view, 0, this.metrics);

          this.controlBufferOffset += bytesRead;
          messagesDecoded++;

          log.info('Received control message', {
            type: MessageType[message.type],
            typeNum: message.type,
            bytesRead,
            remainingBuffer: bufferLength - this.controlBufferOffset,
          });

          // Persist control message stats on globalThis for late console inspection
          const g = globalThis as any;
          if (!g.__moqtDiag) g.__moqtDiag = { controlMessages: {}, incomingPublish: [] };
          const typeName = MessageType[message.type] ?? `unknown(${message.type})`;
          g.__moqtDiag.controlMessages[typeName] = (g.__moqtDiag.controlMessages[typeName] ?? 0) + 1;

          // Handle setup callback
          if (this.onMessage) {
            this.onMessage(message as MOQTMessage);
          }

          // Route message
          this.routeMessage(message as ControlMessage);
        } catch (err) {
          if ((err as Error).message?.includes('Incomplete') ||
              (err as Error).message?.includes('buffer') ||
              (err as Error).message?.includes('beyond')) {
            log.debug('Waiting for more data', {
              bufferSize: bufferLength - this.controlBufferOffset,
              messagesDecoded,
            });
            break;
          }
          const view = this.controlBuffer.subarray(this.controlBufferOffset);
          const hexPreview = Array.from(view.subarray(0, 20)).map(b => b.toString(16).padStart(2, '0')).join(' ');
          console.error('[MOQT-DIAG] Control message decode FAILED', { error: (err as Error).message, hex: hexPreview, bufferSize: bufferLength - this.controlBufferOffset });
          log.error('Control message decode error', {
            error: (err as Error).message,
            bufferSize: bufferLength - this.controlBufferOffset,
            bufferPreview: hexPreview,
          });
          throw err;
        }
      }

      // If all data consumed, reset buffer
      if (this.controlBufferOffset >= bufferLength) {
        this.controlBuffer = new Uint8Array(0);
        this.controlBufferOffset = 0;
      }
    } catch (err) {
      log.error('Error handling control message', err as Error);
    }
  }

  /**
   * Route decoded message to appropriate handler
   */
  private routeMessage(message: ControlMessage): void {
    switch (message.type) {
      case MessageType.PUBLISH_OK: {
        const publishOk = message as PublishOkMessage;
        log.info('Received PUBLISH_OK in handler', {
          requestId: publishOk.requestId.toString(),
          trackAlias: publishOk.trackAlias?.toString(),
          forward: publishOk.forward,
          startLocation: publishOk.startLocation
            ? { groupId: publishOk.startLocation.groupId.toString(), objectId: publishOk.startLocation.objectId.toString() }
            : undefined,
          endGroup: publishOk.endGroup?.toString(),
        });
        const locationStr = publishOk.startLocation
          ? ` loc=(${publishOk.startLocation.groupId.toString()},${publishOk.startLocation.objectId.toString()})`
          : '';
        this.emitMessageReceived(
          'PUBLISH_OK',
          0,
          `trackAlias=${publishOk.trackAlias?.toString()} forward=${publishOk.forward}${locationStr}`,
          {
            requestId: publishOk.requestId.toString(),
            trackAlias: publishOk.trackAlias?.toString(),
            forward: publishOk.forward,
            startLocation: publishOk.startLocation
              ? { groupId: publishOk.startLocation.groupId.toString(), objectId: publishOk.startLocation.objectId.toString() }
              : undefined,
          }
        );

        this.publicationManager.resolvePublishOk(publishOk.requestId, {
          forward: publishOk.forward ?? 0,
          trackAlias: publishOk.trackAlias,
        });
        break;
      }

      case MessageType.PUBLISH_ERROR: {
        const publishError = message as PublishErrorMessage;
        log.error('Received PUBLISH_ERROR', {
          requestId: publishError.requestId.toString(),
          errorCode: publishError.errorCode,
          reasonPhrase: publishError.reasonPhrase,
        });

        this.publicationManager.rejectPublishOk(
          publishError.requestId,
          new Error(`PUBLISH_ERROR: ${publishError.reasonPhrase} (code ${publishError.errorCode})`)
        );
        break;
      }

      case MessageType.SUBSCRIBE_OK: {
        const subscribeOk = message as SubscribeOkMessage;
        const trackAliasNum = typeof subscribeOk.trackAlias === 'bigint'
          ? subscribeOk.trackAlias
          : BigInt(subscribeOk.trackAlias);
        log.info('Received SUBSCRIBE_OK', {
          requestId: subscribeOk.requestId,
          trackAlias: subscribeOk.trackAlias,
          trackAliasStr: subscribeOk.trackAlias.toString(),
          trackAliasBigInt: trackAliasNum.toString(),
          trackAliasType: typeof subscribeOk.trackAlias,
          expires: subscribeOk.expires,
          groupOrder: subscribeOk.groupOrder,
          contentExists: subscribeOk.contentExists,
          largestGroupId: subscribeOk.largestGroupId,
          largestObjectId: subscribeOk.largestObjectId,
        });
        this.emitMessageReceived('SUBSCRIBE_OK', 0, `trackAlias=${trackAliasNum}${subscribeOk.largestGroupId !== undefined ? ` largestGroup=${subscribeOk.largestGroupId}` : ''}`, { requestId: subscribeOk.requestId, trackAlias: trackAliasNum.toString(), largestGroupId: subscribeOk.largestGroupId });

        // Find subscription by request ID and update track alias
        const sub = this.subscriptionManager.findByRequestId(subscribeOk.requestId);
        if (sub) {
          this.subscriptionManager.updateTrackAlias(sub.subscriptionId, BigInt(subscribeOk.trackAlias));

          // Emit subscribe-ok event for listeners (e.g., catalog subscriber)
          const contentExists = typeof subscribeOk.contentExists === 'boolean'
            ? subscribeOk.contentExists
            : subscribeOk.contentExists === 1; // ObjectExistence.EXISTS
          this.emit('subscribe-ok', {
            subscriptionId: sub.subscriptionId,
            requestId: subscribeOk.requestId,
            trackAlias: trackAliasNum,
            contentExists,
            largestGroupId: subscribeOk.largestGroupId,
            largestObjectId: subscribeOk.largestObjectId,
            trackProperties: parseTrackProperties(
              (subscribeOk as SubscribeOkMessage & { trackProperties?: Map<number, Uint8Array> }).trackProperties,
            ),
          } as SubscribeOkEvent);
        } else {
          log.warn('SUBSCRIBE_OK received but no matching subscription found', {
            requestId: subscribeOk.requestId,
          });
        }
        break;
      }

      case MessageType.SUBSCRIBE_ERROR: {
        const subscribeError = message as SubscribeErrorMessage;
        log.error('Received SUBSCRIBE_ERROR', {
          requestId: subscribeError.requestId.toString(),
          errorCode: subscribeError.errorCode,
          reasonPhrase: subscribeError.reasonPhrase,
          trackAlias: subscribeError.trackAlias.toString(),
        });
        this.emitMessageReceived('SUBSCRIBE_ERROR', 0, `code=${subscribeError.errorCode} "${subscribeError.reasonPhrase}"`, { requestId: subscribeError.requestId.toString(), errorCode: subscribeError.errorCode, reasonPhrase: subscribeError.reasonPhrase });

        // Find and clean up the failed subscription
        const sub = this.subscriptionManager.findByRequestId(subscribeError.requestId);
        if (sub) {
          log.info('Cleaning up failed subscription', { subscriptionId: sub.subscriptionId });
          this.subscriptionManager.remove(sub.subscriptionId);
        }

        // SUBSCRIBE_ERROR is per-subscription, not fatal to the session.
        // Emit a dedicated event so callers can handle the specific failure
        // without tearing down other in-flight subscriptions/publications.
        this.emit('subscribe-error', {
          requestId: subscribeError.requestId,
          subscriptionId: sub?.subscriptionId,
          errorCode: subscribeError.errorCode,
          reasonPhrase: subscribeError.reasonPhrase,
          trackAlias: subscribeError.trackAlias,
        });
        break;
      }

      case MessageType.SUBSCRIBE_UPDATE: {
        const subscribeUpdate = message as SubscribeUpdateMessage;
        log.info('Received SUBSCRIBE_UPDATE', {
          requestId: subscribeUpdate.requestId.toString(),
          subscriptionRequestId: subscribeUpdate.subscriptionRequestId.toString(),
          forward: subscribeUpdate.forward,
          startLocation: subscribeUpdate.startLocation
            ? { groupId: subscribeUpdate.startLocation.groupId.toString(), objectId: subscribeUpdate.startLocation.objectId.toString() }
            : undefined,
        });

        // §9.11 SUBSCRIBE_UPDATE is scoped to `subscriptionRequestId` — only
        // touch the publication bound to that request so a pause from one
        // subscriber doesn't stall other tracks this session publishes.
        if (subscribeUpdate.forward === 1) {
          const matched = this.publicationManager.setForwardByRequestId(
            subscribeUpdate.subscriptionRequestId,
            1,
          );
          if (!matched) {
            log.warn('SUBSCRIBE_UPDATE forward=1 for unknown requestId, falling back to resolveAllForward', {
              subscriptionRequestId: subscribeUpdate.subscriptionRequestId,
            });
            this.publicationManager.resolveAllForward();
          }
        } else if (subscribeUpdate.forward === 0) {
          const matched = this.publicationManager.setForwardByRequestId(
            subscribeUpdate.subscriptionRequestId,
            0,
          );
          if (!matched) {
            log.warn('SUBSCRIBE_UPDATE forward=0 for unknown requestId, falling back to setAllForward', {
              subscriptionRequestId: subscribeUpdate.subscriptionRequestId,
            });
            this.publicationManager.setAllForward(0);
          }
        }
        break;
      }

      // Track Status handlers (for live edge tracking)
      case MessageType.TRACK_STATUS_OK: {
        const trackStatusOk = message as TrackStatusOkMessage;
        log.info('Received TRACK_STATUS_OK', {
          requestId: trackStatusOk.requestId,
          statusCode: trackStatusOk.statusCode,
          lastGroupId: trackStatusOk.lastGroupId,
          lastObjectId: trackStatusOk.lastObjectId,
        });

        // Resolve the pending callback
        const callback = this.trackStatusCallbacks.get(trackStatusOk.requestId);
        if (callback) {
          callback.resolve(trackStatusOk);
        } else {
          log.warn('TRACK_STATUS_OK for unknown request', { requestId: trackStatusOk.requestId });
        }
        break;
      }

      case MessageType.TRACK_STATUS_ERROR: {
        const trackStatusError = message as TrackStatusErrorMessage;
        log.error('Received TRACK_STATUS_ERROR', {
          requestId: trackStatusError.requestId,
          errorCode: trackStatusError.errorCode,
          reasonPhrase: trackStatusError.reasonPhrase,
        });

        // Reject the pending callback
        const callback = this.trackStatusCallbacks.get(trackStatusError.requestId);
        if (callback) {
          callback.reject(new Error(`Track status error: ${trackStatusError.reasonPhrase} (code: ${trackStatusError.errorCode})`));
        } else {
          log.warn('TRACK_STATUS_ERROR for unknown request', { requestId: trackStatusError.requestId });
        }
        break;
      }

      // Announce flow handlers
      case MessageType.PUBLISH_NAMESPACE_OK: {
        const publishNamespaceOk = message as PublishNamespaceOkMessage;

        // Draft-16 uses requestId, draft-14 uses namespace
        let namespaceStr: string;
        let namespace: string[];

        if (this.isDraft16 && publishNamespaceOk.requestId !== undefined) {
          // Draft-16: Look up namespace by requestId
          namespaceStr = this.announceRequestIdToNamespace.get(publishNamespaceOk.requestId) ?? '';
          namespace = namespaceStr ? namespaceStr.split('/') : [];
          log.info('Received PUBLISH_NAMESPACE_OK (draft-16)', {
            requestId: publishNamespaceOk.requestId,
            expires: publishNamespaceOk.expires,
            namespace: namespaceStr,
          });
          // Clean up the mapping
          this.announceRequestIdToNamespace.delete(publishNamespaceOk.requestId);
        } else {
          // Draft-14: Use namespace from message
          namespace = publishNamespaceOk.namespace ?? [];
          namespaceStr = namespace.join('/');
          log.info('Received PUBLISH_NAMESPACE_OK (draft-14)', { namespace: namespaceStr });
        }

        // Mark namespace as acknowledged
        const announceInfo = this.announcedNamespaces.get(namespaceStr);
        if (announceInfo) {
          announceInfo.acknowledged = true;
          this.emit('namespace-acknowledged', { namespace });
        } else {
          log.warn('PUBLISH_NAMESPACE_OK for unknown namespace', { namespace: namespaceStr });
        }
        break;
      }

      case MessageType.PUBLISH_NAMESPACE_ERROR: {
        const publishNamespaceError = message as {
          namespace: string[];
          errorCode: number;
          reasonPhrase: string;
        };
        const namespaceStr = publishNamespaceError.namespace.join('/');
        log.error('Received PUBLISH_NAMESPACE_ERROR', {
          namespace: namespaceStr,
          errorCode: publishNamespaceError.errorCode,
          reasonPhrase: publishNamespaceError.reasonPhrase,
        });

        // Remove the failed namespace announcement
        this.announcedNamespaces.delete(namespaceStr);
        this.emit('namespace-error', {
          kind: 'publish-namespace',
          namespace: publishNamespaceError.namespace,
          errorCode: publishNamespaceError.errorCode,
          reasonPhrase: publishNamespaceError.reasonPhrase,
        });
        break;
      }

      case MessageType.SUBSCRIBE_NAMESPACE_OK: {
        const subscribeNamespaceOk = message as SubscribeNamespaceOkMessage;
        console.warn('[MOQT-DIAG] Received SUBSCRIBE_NAMESPACE_OK', {
          requestId: subscribeNamespaceOk.requestId,
          namespacePrefix: subscribeNamespaceOk.namespacePrefix?.join('/'),
        });
        let subscriptionId: number | undefined;

        if (this.isDraft16 && subscribeNamespaceOk.requestId !== undefined) {
          // Draft-16: Use requestId to find subscription
          subscriptionId = this.namespaceSubscriptionByRequestId.get(subscribeNamespaceOk.requestId);
        } else if (subscribeNamespaceOk.namespacePrefix) {
          // Draft-14: Use namespacePrefix to find subscription
          const prefixStr = subscribeNamespaceOk.namespacePrefix.join('/');
          for (const [id, sub] of this.namespaceSubscriptions) {
            if (sub.namespacePrefix.join('/') === prefixStr) {
              subscriptionId = id;
              break;
            }
          }
        }

        if (subscriptionId !== undefined) {
          const subscription = this.namespaceSubscriptions.get(subscriptionId);
          if (subscription) {
            log.info('Received SUBSCRIBE_NAMESPACE_OK', {
              requestId: subscribeNamespaceOk.requestId,
              namespacePrefix: subscription.namespacePrefix.join('/'),
            });
          }
        } else {
          log.warn('SUBSCRIBE_NAMESPACE_OK for unknown request', {
            requestId: subscribeNamespaceOk.requestId,
            namespacePrefix: subscribeNamespaceOk.namespacePrefix?.join('/'),
          });
        }
        break;
      }

      case MessageType.SUBSCRIBE_NAMESPACE_ERROR: {
        const subscribeNamespaceError = message as SubscribeNamespaceErrorMessage;
        let subscriptionId: number | undefined;

        if (this.isDraft16 && subscribeNamespaceError.requestId !== undefined) {
          subscriptionId = this.namespaceSubscriptionByRequestId.get(subscribeNamespaceError.requestId);
        } else if (subscribeNamespaceError.namespacePrefix) {
          const prefixStr = subscribeNamespaceError.namespacePrefix.join('/');
          for (const [id, sub] of this.namespaceSubscriptions) {
            if (sub.namespacePrefix.join('/') === prefixStr) {
              subscriptionId = id;
              break;
            }
          }
        }

        log.error('Received SUBSCRIBE_NAMESPACE_ERROR', {
          requestId: subscribeNamespaceError.requestId,
          namespacePrefix: subscribeNamespaceError.namespacePrefix?.join('/'),
          errorCode: subscribeNamespaceError.errorCode,
          reasonPhrase: subscribeNamespaceError.reasonPhrase,
        });

        let failedPrefix: string[] = subscribeNamespaceError.namespacePrefix ?? [];
        if (subscriptionId !== undefined) {
          const subscription = this.namespaceSubscriptions.get(subscriptionId);
          if (subscription) failedPrefix = subscription.namespacePrefix;
          this.namespaceSubscriptions.delete(subscriptionId);
          if (subscription) {
            this.namespaceSubscriptionByRequestId.delete(subscription.requestId);
          }
        }
        this.emit('namespace-error', {
          kind: 'subscribe-namespace',
          namespace: failedPrefix,
          errorCode: subscribeNamespaceError.errorCode,
          reasonPhrase: subscribeNamespaceError.reasonPhrase,
          requestId: subscribeNamespaceError.requestId,
        });
        break;
      }

      case MessageType.SUBSCRIBE: {
        // Handle incoming SUBSCRIBE (announce flow - we are the publisher)
        const subscribeMessage = message as SubscribeMessage;
        this.handleIncomingSubscribe(subscribeMessage).catch(err => {
          log.error('Error handling incoming SUBSCRIBE', { error: (err as Error).message });
        });
        break;
      }

      case MessageType.PUBLISH: {
        // Handle incoming PUBLISH (subscribe namespace flow - we are the subscriber)
        const publishMessage = message as PublishMessage;
        console.warn('[MOQT-DIAG] Received PUBLISH on control stream', {
          requestId: publishMessage.requestId,
          trackName: publishMessage.fullTrackName?.trackName,
          namespace: publishMessage.fullTrackName?.namespace?.join('/'),
          trackAlias: publishMessage.trackAlias?.toString(),
        });
        this.handleIncomingPublish(publishMessage).catch(err => {
          console.error('[MOQT-DIAG] Error handling incoming PUBLISH', err);
          log.error('Error handling incoming PUBLISH', { error: (err as Error).message });
        });
        break;
      }

      // FETCH message handlers (DVR support)
      case MessageType.FETCH_OK: {
        const fetchOk = message as FetchOkMessage;
        log.info('Received FETCH_OK', {
          requestId: fetchOk.requestId,
          groupOrder: fetchOk.groupOrder,
          endOfTrack: fetchOk.endOfTrack,
          largestGroupId: fetchOk.largestGroupId,
          largestObjectId: fetchOk.largestObjectId,
        });
        this.emitMessageReceived('FETCH_OK', 0, `largestGroup=${fetchOk.largestGroupId}${fetchOk.endOfTrack ? ' (EOT)' : ''}`, { requestId: fetchOk.requestId, largestGroupId: fetchOk.largestGroupId });

        const fetchInfo = this.activeFetches.get(fetchOk.requestId);
        if (fetchInfo) {
          fetchInfo.completed = true;
          fetchInfo.largestGroupId = fetchOk.largestGroupId;
          fetchInfo.largestObjectId = fetchOk.largestObjectId;
          fetchInfo.endOfTrack = fetchOk.endOfTrack;

          // Emit fetch complete event
          this.emit('fetch-complete', {
            requestId: fetchOk.requestId,
            largestGroupId: fetchOk.largestGroupId,
            largestObjectId: fetchOk.largestObjectId,
            endOfTrack: fetchOk.endOfTrack,
          } as FetchCompleteEvent);
        } else {
          log.warn('FETCH_OK for unknown fetch request', { requestId: fetchOk.requestId });
        }
        break;
      }

      case MessageType.FETCH_ERROR: {
        const fetchError = message as FetchErrorMessage;
        log.error('Received FETCH_ERROR', {
          requestId: fetchError.requestId,
          errorCode: fetchError.errorCode,
          reasonPhrase: fetchError.reasonPhrase,
        });

        const fetchInfo = this.activeFetches.get(fetchError.requestId);
        if (fetchInfo) {
          // Remove from active fetches
          this.activeFetches.delete(fetchError.requestId);
          this.fetchStreamBuffers.delete(fetchError.requestId);

          // Emit fetch error event
          this.emit('fetch-error', {
            requestId: fetchError.requestId,
            errorCode: fetchError.errorCode,
            reason: fetchError.reasonPhrase,
          } as FetchErrorEvent);
        }
        break;
      }

      case MessageType.FETCH: {
        // Handle incoming FETCH (we are the VOD publisher)
        const fetchMessage = message as FetchMessage;
        this.handleIncomingFetch(fetchMessage).catch(err => {
          log.error('Error handling incoming FETCH', { error: (err as Error).message });
        });
        break;
      }

      case MessageType.FETCH_CANCEL: {
        const fetchCancel = message as FetchCancelMessage;
        log.info('Received FETCH_CANCEL', { requestId: fetchCancel.requestId });

        // Cancel any pending fetch response
        const pendingResponse = this.pendingFetchResponses.get(fetchCancel.requestId);
        if (pendingResponse) {
          this.pendingFetchResponses.delete(fetchCancel.requestId);
          log.info('Cancelled pending fetch response', { requestId: fetchCancel.requestId });
        }
        break;
      }

      default:
        log.trace('Unhandled message type', { type: MessageType[message.type] });
    }
  }

  /**
   * Update session state.
   *
   * Every transition is mirrored into the `ConnectionStateMachine` so illegal
   * transitions are caught centrally and surfaced via metrics
   * (`moq.session.illegal_state_transition`). The high-level `SessionState`
   * vocabulary (`none`/`setup`/`ready`/`closing`/`error`) is mapped onto the
   * spec-tracking `ConnectionState` values so downstream tools that read
   * either surface stay consistent.
   */
  private setState(state: SessionState): void {
    if (this._state === state) return;
    const prev = this._state;
    this._state = state;
    // Demoted from .info to .debug (OPS-hi 1): state changes fire on every
    // subscribe / publish and were dominating hot-path log volume.
    this.sessionLog.debug('Session state changed', { from: prev, to: state });
    this.emit('state-change', state);

    // Route through the ConnectionStateMachine so any illegal transition is
    // caught and counted centrally. `forceState` is used when the FSM
    // rejects the transition — the session's public state has already
    // moved on, so we don't want to leave the FSM stuck.
    this.driveStateMachine(prev, state);

    this.metrics.counter('moq.session.state_transition', 1, {
      from: prev,
      to: state,
    });

    // §13.6.1: arm the idle/keepalive timer once we've completed SETUP and
    // disarm on any leave. Configuration may have been set before setup(),
    // in which case this is the first place we can honor it.
    if (state === 'ready') {
      this.startIdleTimer();
    } else {
      this.stopIdleTimer();
    }
  }

  /**
   * Drive the ConnectionStateMachine from a coarse SessionState transition.
   * Maps the session's 5-state vocabulary onto the spec-tracking state
   * machine and counts any transition the FSM refuses.
   */
  private driveStateMachine(from: SessionState, to: SessionState): void {
    const target = sessionStateToConnectionState(to);
    if (target === undefined) return;

    // Special handling: 'setup' represents "we've sent CLIENT_SETUP", which
    // the FSM expresses as `connecting → setup_sent`. Feed both steps when
    // arriving from a state that hasn't yet crossed `connecting`.
    if (target === 'setup_sent' && this.stateMachine.state === 'disconnected') {
      if (!this.stateMachine.transition('connecting', `session:${from}->${to}`)) {
        this.metrics.counter('moq.session.illegal_state_transition', 1, {
          from: this.stateMachine.state,
          to: 'connecting',
        });
        this.stateMachine.forceState('connecting', `session:${from}->${to}`);
      }
    }

    if (this.stateMachine.state === target) return;

    if (!this.stateMachine.transition(target, `session:${from}->${to}`)) {
      this.metrics.counter('moq.session.illegal_state_transition', 1, {
        from: this.stateMachine.state,
        to: target,
      });
      // Force the state so downstream reads of `stateMachine.state` remain
      // consistent with `_state`. The metric is the durable signal for
      // "this transition wasn't valid".
      this.stateMachine.forceState(target, `illegal:${from}->${to}`);
    }
  }

  /**
   * Public diagnostics snapshot for debugging and support telemetry. Safe to
   * call in any state; returned object is a fresh copy and JSON-serializable.
   */
  getDiagnostics(): SessionDiagnostics {
    const now = typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();
    let counterTotals: Record<string, number> = {};
    if (this.metrics instanceof InMemoryMetricsSink) {
      counterTotals = this.metrics.counterTotals();
    }
    const diag: SessionDiagnostics = {
      sessionId: this.sessionId,
      state: this._state,
      connectionState: this.stateMachine.state,
      uptimeMs: Math.max(0, now - this._createdAtMs),
      reconnectAttempts: this._reconnectAttempts,
      metrics: counterTotals,
    };
    if (this._lastCloseReason !== undefined) diag.lastCloseReason = this._lastCloseReason;
    if (this._lastCloseCode !== undefined) diag.lastCloseCode = this._lastCloseCode;
    if (this._lastConnectUrl !== undefined) diag.currentUrl = this._lastConnectUrl;
    if (this._pendingMigrationUri !== undefined) diag.pendingMigrationUri = this._pendingMigrationUri;
    return diag;
  }

  /**
   * Handle errors
   */
  private handleError(err: Error): void {
    this.setState('error');
    this.emit('error', err);
  }

  /**
   * Emit a message-sent event for the message log panel
   */
  private emitMessageSent(messageType: string, bytes: number, summary: string, details?: Record<string, unknown>): void {
    this.emit('message-sent', {
      messageType,
      timestamp: Date.now(),
      bytes,
      summary,
      details,
    } as MessageLogEvent);
  }

  /**
   * Emit a message-received event for the message log panel
   */
  private emitMessageReceived(messageType: string, bytes: number, summary: string, details?: Record<string, unknown>): void {
    this.emit('message-received', {
      messageType,
      timestamp: Date.now(),
      bytes,
      summary,
      details,
    } as MessageLogEvent);
  }

  /**
   * Emit an event
   */
  private emit(event: SessionEventType, data: unknown): void {
    const handlers = this.handlers.get(event);
    if (!handlers) return;

    for (const handler of handlers) {
      try {
        handler(data);
      } catch (err) {
        log.error('Event handler error', err as Error);
      }
    }
  }
}

/**
 * Map the session-scoped `SessionState` to the spec-tracking
 * `ConnectionState` used by `ConnectionStateMachine`. Returns `undefined`
 * when no direct mapping applies (caller should skip).
 */
function sessionStateToConnectionState(state: SessionState): ConnectionState | undefined {
  switch (state) {
    case 'none':
      return 'disconnected';
    case 'setup':
      return 'setup_sent';
    case 'ready':
      return 'connected';
    case 'closing':
      return 'closing';
    case 'error':
      return 'error';
    default:
      return undefined;
  }
}

/**
 * Generate a random 16-char hex session identifier. Prefers
 * `crypto.randomUUID()` when available (browsers, Node 20+) and falls back
 * to `Math.random()` in stripped-down environments (some old worker hosts).
 */
function generateSessionId(): string {
  if (typeof crypto !== 'undefined') {
    const c: unknown = crypto;
    if (typeof (c as { randomUUID?: () => string }).randomUUID === 'function') {
      return (c as { randomUUID: () => string }).randomUUID().replace(/-/g, '').slice(0, 16);
    }
    if (typeof (c as { getRandomValues?: (arr: Uint8Array) => Uint8Array }).getRandomValues === 'function') {
      const bytes = new Uint8Array(8);
      (c as { getRandomValues: (arr: Uint8Array) => Uint8Array }).getRandomValues(bytes);
      let out = '';
      for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
      return out;
    }
  }
  let out = '';
  for (let i = 0; i < 16; i++) out += Math.floor(Math.random() * 16).toString(16);
  return out;
}

/**
 * Convert a legacy dot-separated token to COSE_Sign1 CBOR bytes.
 * Format: base64url(protectedHeader).base64url(payload).base64url(signature)
 */
function dotTokenToCoseSign1Bytes(token: string): Uint8Array {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return new TextEncoder().encode(token);
  }
  const protectedHeader = base64urlDecode(parts[0]);
  const payload = base64urlDecode(parts[1]);
  const signature = base64urlDecode(parts[2]);

  return coseSign1Encode({
    protectedHeader,
    unprotectedHeader: new Map(),
    payload,
    signature,
  });
}
