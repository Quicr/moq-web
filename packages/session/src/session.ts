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
  TrackPropertyDraft18,
  MOQTVarInt,
  SetupParameter,
  SubscriptionFilterDraft18,
  ObjectExtension,
  BufferWriter,
  Logger,
  IS_DRAFT_16,
  IS_DRAFT_18,
  getCurrentALPNProtocol,
  getProtocolCodec,
  DataStreamType,
  type ClientSetupMessage,
  type ServerSetupMessage,
  type ClientSetupMessageDraft18,
  type ServerSetupMessageDraft18,
  type PublishMessage,
  type PublishMessageDraft18,
  type SubscribeMessage,
  type SubscribeMessageDraft18,
  type SubscribeOkMessage,
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
import { TransportWorkerClient } from './workers/index.js';
import { parseTrackProperties } from './track-properties.js';
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
  RequestOkEvent,
  PublishDoneEvent,
  PublishBlockedEvent,
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
} from './types.js';

const log = Logger.create('moqt:session');

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
 * Draft-18 §12 publisher-side track properties advertised on PUBLISH.
 * Each key is an even-key MOQT varint; 0/undefined omits it.
 */
function buildTrackProperties(options?: {
  subgroupDeliveryTimeout?: number;
  objectDeliveryTimeout?: number;
  maxCacheDuration?: number;
  priority?: number;
  groupOrder?: number;
}): Map<number, Uint8Array> | undefined {
  if (!options) return undefined;
  const props = new Map<number, Uint8Array>();
  const setMs = (key: number, ms: number | undefined) => {
    if (!ms || ms <= 0) return;
    props.set(key, MOQTVarInt.encode(BigInt(ms)));
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
  /** Server certificate hashes for self-signed certs */
  serverCertificateHashes?: ArrayBuffer[];
  /** Connection timeout in ms */
  connectionTimeout?: number;
  /** Maximum datagram size in bytes (default: 1200) */
  maxDatagramSize?: number;
  /** Enable debug logging in worker */
  debug?: boolean;
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
  /** Transport event cleanup handlers */
  private transportCleanup: Array<() => void> = [];
  /** Message buffer for incomplete control messages */
  private controlBuffer = new Uint8Array(0);
  /** Offset into controlBuffer where unprocessed data starts */
  private controlBufferOffset = 0;
  /**
   * Next request ID for subscribing/publishing
   * Draft-14: Start at 1, increment by 1
   * Draft-16+: Clients use even IDs (0, 2, 4, ...), servers use odd (1, 3, 5, ...)
   */
  private nextRequestId = (IS_DRAFT_16 || IS_DRAFT_18) ? 0 : 1;
  /** Protocol codec for version-specific encoding/decoding */
  private readonly codec = getProtocolCodec();
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
  private announceRequestIdToNamespace = new Map<number, string>();
  /** Next track alias for incoming subscriptions (announce flow) */
  private nextIncomingTrackAlias = BigInt(1000);
  /** Namespace subscriptions (for subscribe namespace flow) */
  private namespaceSubscriptions = new Map<number, NamespaceSubscriptionInfo>();
  /** Request ID to namespace subscription mapping */
  private namespaceSubscriptionByRequestId = new Map<number, number>();
  /** Stream ID to subscription ID mapping for worker mode bidi streams */
  private namespaceSubscriptionStreams = new Map<number, number>();
  /** Our own namespace prefix for filtering out self-publishes */
  private ownNamespacePrefix: string | null = null;
  /** Authorization token for CLIENT_SETUP */
  private authToken: string | null = null;
  /** Token type for AUTHORIZATION_TOKEN parameter (default: C4M = 0x63346d) */
  private authTokenType: number = C4M_TOKEN_TYPE;
  // @ts-expect-error Reserved for token alias caching support (aliasType 1/2)
  private tokenAliasCache = new Map<number, { tokenType: number; tokenValue: Uint8Array }>();
  // @ts-expect-error Reserved for token alias caching support
  private nextTokenAlias = 0;
  // @ts-expect-error Reserved for token alias caching support
  private maxAuthTokenCacheSize = 0;

  // ============================================================================
  // FETCH / DVR State
  // ============================================================================

  /** Active fetch requests (we are the fetcher/subscriber) */
  private activeFetches = new Map<number, FetchInfo>();
  /** Request ID to fetch stream mapping for receiving fetch data */
  private fetchStreamBuffers = new Map<number, Uint8Array[]>();

  // ============================================================================
  // Track Status State (for live edge tracking)
  // ============================================================================

  /** Pending TRACK_STATUS request callbacks */
  private trackStatusCallbacks = new Map<number, {
    resolve: (status: TrackStatusOkMessage) => void;
    reject: (error: Error) => void;
  }>();

  // ============================================================================
  // VOD Publishing State
  // ============================================================================

  /** VOD tracks we are publishing */
  private vodTracks = new Map<string, VODTrackInfo>();
  /** Pending fetch responses we need to send (VOD publisher serving fetches) */
  private pendingFetchResponses = new Map<number, {
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
    if (transportOrConfig instanceof MOQTransport) {
      // Main thread mode - existing behavior
      this.transport = transportOrConfig;
      this.useWorker = false;
    } else {
      // Worker mode - transport runs in worker
      this.workerConfig = transportOrConfig;
      this.transportWorker = new TransportWorkerClient(transportOrConfig.worker);
      this.useWorker = true;
    }

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
    });

    // Set up FETCH object callback to emit fetch-object events
    this.objectRouter.setFetchObjectCallback((requestId, data, groupId, objectId) => {
      log.info('FETCH object received', { requestId, groupId, objectId, dataSize: data.length });
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
      isDraft18: IS_DRAFT_18,
      isDraft16: IS_DRAFT_16,
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
      serverCertificateHashes: this.workerConfig.serverCertificateHashes,
      connectionTimeout: this.workerConfig.connectionTimeout,
      debug: this.workerConfig.debug,
    });

    log.info('Connected via worker');
  }

  /**
   * Get next request ID (handles draft-14/16/18 parity rules)
   * Draft-14: Increment by 1 (1, 2, 3, ...)
   * Draft-16+: Clients use even, increment by 2 (0, 2, 4, ...)
   */
  private getNextRequestId(): number {
    const id = this.nextRequestId;
    this.nextRequestId += (IS_DRAFT_16 || IS_DRAFT_18) ? 2 : 1;
    return id;
  }

  // ===== Transport Abstraction Methods =====
  // These methods abstract transport operations for both main thread and worker modes

  /**
   * Send data on control stream (works in both modes)
   */
  private async doSendControl(data: Uint8Array): Promise<void> {
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
  private async doCreateStream(): Promise<{ writer?: WritableStreamDefaultWriter<Uint8Array>; streamId?: number }> {
    if (this.useWorker) {
      const streamId = await this.transportWorker!.createStream();
      return { streamId };
    } else {
      const stream = await this.transport!.createUnidirectionalStream();
      const writer = stream.getWriter();
      return { writer };
    }
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
    if (this.useWorker && streamInfo.streamId !== undefined) {
      this.transportWorker!.closeStream(streamInfo.streamId);
    } else if (streamInfo.writer) {
      await streamInfo.writer.close();
    }
  }

  /**
   * Set up handlers for main thread transport mode
   */
  private setupTransportHandlers(): void {
    if (!this.transport) return;

    if (IS_DRAFT_18) {
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
  }

  /**
   * Set up handlers for worker transport mode
   */
  private setupWorkerHandlers(): void {
    if (!this.transportWorker) return;

    if (IS_DRAFT_18) {
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
      log.error('Worker transport error', { message });
      this.handleError(new Error(message));
    });

    // Disconnection handler
    this.transportWorker.on('disconnected', ({ reason }) => {
      log.warn('Worker transport disconnected', { reason });
      this.handleError(new Error(reason ?? 'Transport disconnected'));
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
   * Long-lived per-request bidi stream (draft-18 §3.3, §10.9). Keeps the writer
   * alive so REQUEST_UPDATE can be sent on the same bidi stream that carried
   * the original request, and buffers received bytes so successive control
   * messages can be read from the same stream.
   */
  private activeRequestStreams = new Map<number, Draft18RequestStream>();

  /**
   * Open a new per-request bidi stream, write the initial request bytes, and
   * return a handle that supports sending more messages (e.g. REQUEST_UPDATE)
   * and reading successive response messages on the same stream.
   */
  private async openRequestStream(
    requestId: number,
    initialEncoded: Uint8Array
  ): Promise<Draft18RequestStream> {
    const existing = this.activeRequestStreams.get(requestId);
    if (existing) {
      throw new Error(`Request stream already open for requestId=${requestId}`);
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
  private async closeRequestStream(requestId: number): Promise<void> {
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
    requestId: number
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
        const [message, bytesRead] = this.codec.decodeControlMessage(view);
        consumed += bytesRead;

        log.info('Received message on namespace subscription stream (worker)', {
          type: MessageType[message.type],
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
   * Set up the MOQT session
   *
   * Sends CLIENT_SETUP and waits for SERVER_SETUP
   */
  async setup(): Promise<void> {
    if (this._state !== 'none') {
      throw new Error(`Cannot setup: session is ${this._state}`);
    }

    log.info('Setting up MOQT session', { useWorker: this.useWorker, isDraft18: IS_DRAFT_18 });
    this.setState('setup');

    // Set up event handlers based on mode
    if (this.useWorker) {
      this.setupWorkerHandlers();
    } else {
      this.setupTransportHandlers();
    }

    if (IS_DRAFT_18) {
      // Draft-18: Single SETUP message with no version/role (negotiated via ALPN)
      // On the setup stream, message type is implicit (stream type = 0x2F00)
      // Wire format: Length (16-bit) | Setup Options
      const clientSetup: ClientSetupMessageDraft18 = {
        type: MessageTypeDraft18.CLIENT_SETUP,
        moqtImplementation: 'moq-web 0.1.0',
      };

      const setupBytes = this.codec.encodeSetupStream(clientSetup);

      const hexBytes = Array.from(setupBytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
      log.info('SETUP bytes (draft-18)', {
        length: setupBytes.length,
        hex: hexBytes,
        alpnProtocol: getCurrentALPNProtocol(),
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
        isDraft16: IS_DRAFT_16,
        alpnProtocol: getCurrentALPNProtocol(),
      });

      await this.doSendControl(setupBytes);
      log.info('Sent CLIENT_SETUP');
      this.emitMessageSent('CLIENT_SETUP', setupBytes.length, 'draft-16', { isDraft16: IS_DRAFT_16 });

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
    if (!IS_DRAFT_18) {
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
   * Query track status (draft-18)
   *
   * @param namespace - Track namespace
   * @param trackName - Track name
   */
  async trackStatus(
    namespace: string[],
    trackName: string
  ): Promise<void> {
    if (!IS_DRAFT_18) {
      throw new Error('trackStatus() requires draft-18');
    }
    if (!this.isReady) {
      throw new Error('Session not ready');
    }

    const requestId = this.getNextRequestId();

    const trackStatusMessage: TrackStatusMessageDraft18 = {
      type: MessageTypeDraft18.TRACK_STATUS,
      requestId: BigInt(requestId),
      trackNamespace: namespace,
      trackName,
    };

    const encoded = this.codec.encodeControlMessage(trackStatusMessage);
    log.info('Sent TRACK_STATUS (draft-18)', {
      requestId,
      namespace: namespace.join('/'),
      trackName,
    });

    try {
      const response = await this.sendRequestAndWaitResponse(encoded, requestId);

      if (response.type === MessageTypeDraft18.REQUEST_ERROR) {
        const error = response as RequestErrorMessageDraft18;
        throw new Error(`TRACK_STATUS failed: ${error.reasonPhrase} (code ${error.errorCode})`);
      }

      if (response.type === MessageTypeDraft18.REQUEST_OK) {
        const ok = response as RequestOkMessageDraft18;
        const expiresMs = ok.expires !== undefined ? Number(ok.expires) : undefined;
        this.emit('request-ok', {
          requestId,
          requestKind: 'track-status',
          expiresMs,
        } as RequestOkEvent);
        log.info('TRACK_STATUS response received (draft-18)', { requestId, expiresMs });
      } else {
        log.info('TRACK_STATUS response received (draft-18)', { requestId });
      }
    } finally {
      await this.closeRequestStream(requestId);
    }
  }

  /**
   * Subscribe to tracks matching a namespace prefix (draft-18)
   *
   * @param namespacePrefix - Namespace prefix to match
   * @param onObject - Callback for objects on matching tracks
   */
  async subscribeTracks(
    namespacePrefix: string[],
    onObject?: (data: Uint8Array, groupId: number, objectId: number, timestamp: number) => void
  ): Promise<number> {
    if (!IS_DRAFT_18) {
      throw new Error('subscribeTracks() requires draft-18');
    }
    if (!this.isReady) {
      throw new Error('Session not ready');
    }

    const requestId = this.getNextRequestId();

    const subscribeTracksMessage: SubscribeTracksMessageDraft18 = {
      type: MessageTypeDraft18.SUBSCRIBE_TRACKS,
      requestId: BigInt(requestId),
      trackNamespacePrefix: namespacePrefix,
      forwardState: true,
      filter: SubscriptionFilterDraft18.NEXT_GROUP_START,
    };

    const encoded = this.codec.encodeControlMessage(subscribeTracksMessage);
    log.info('Sent SUBSCRIBE_TRACKS (draft-18)', {
      requestId,
      prefix: namespacePrefix.join('/'),
    });

    const response = await this.sendRequestAndWaitResponse(encoded, requestId);

    if (response.type === MessageTypeDraft18.REQUEST_ERROR) {
      const error = response as RequestErrorMessageDraft18;
      await this.closeRequestStream(requestId);
      throw new Error(`SUBSCRIBE_TRACKS failed: ${error.reasonPhrase} (code ${error.errorCode})`);
    }

    // Store the namespace subscription for incoming PUBLISH messages
    const subscriptionId = requestId;
    const subscription: NamespaceSubscriptionInfo = {
      subscriptionId,
      requestId,
      namespacePrefix,
      tracks: new Map(),
      onObject,
    };
    this.namespaceSubscriptions.set(subscriptionId, subscription);
    this.namespaceSubscriptionByRequestId.set(requestId, subscriptionId);

    log.info('SUBSCRIBE_TRACKS accepted (draft-18)', { requestId });
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
    subscriptionRequestId: number,
    forwardState: boolean,
    options?: { awaitAck?: boolean },
  ): Promise<void> {
    if (!IS_DRAFT_18) {
      throw new Error('sendRequestUpdate() requires draft-18');
    }

    const stream = this.activeRequestStreams.get(subscriptionRequestId);
    if (!stream) {
      throw new Error(
        `sendRequestUpdate: no active request stream for requestId=${subscriptionRequestId}`,
      );
    }

    const updateMessage: RequestUpdateMessageDraft18 = {
      type: MessageTypeDraft18.REQUEST_UPDATE,
      requestId: BigInt(subscriptionRequestId),
      forwardState,
    };

    const bytes = this.codec.encodeControlMessage(updateMessage);
    await stream.write(bytes);
    log.info('Sent REQUEST_UPDATE (draft-18)', { subscriptionRequestId, forwardState });

    if (options?.awaitAck === false) {
      return;
    }

    const response = await stream.readMessage();
    if (response.type === MessageTypeDraft18.REQUEST_ERROR) {
      const err = response as RequestErrorMessageDraft18;
      throw new Error(
        `REQUEST_UPDATE failed for requestId=${subscriptionRequestId}: ${err.reasonPhrase} (code ${err.errorCode})`,
      );
    }
    if (response.type !== MessageTypeDraft18.REQUEST_OK) {
      log.warn('Unexpected response to REQUEST_UPDATE (draft-18)', {
        subscriptionRequestId,
        responseType: response.type,
      });
    } else {
      log.info('REQUEST_UPDATE acknowledged (draft-18)', { subscriptionRequestId });
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
    requestId: number,
    finalGroup: number,
    finalObject: number,
    reasonPhrase?: string,
    statusCode?: PublishDoneErrorCodeDraft18
  ): Promise<void> {
    if (!IS_DRAFT_18) {
      throw new Error('sendPublishDone() requires draft-18');
    }

    const publishDone: PublishDoneMessageDraft18 = {
      type: MessageTypeDraft18.PUBLISH_DONE,
      requestId: BigInt(requestId),
      finalLocation: { group: BigInt(finalGroup), object: BigInt(finalObject) },
      statusCode: BigInt(statusCode ?? PublishDoneErrorCodeDraft18.TRACK_ENDED),
      reasonPhrase,
    };

    const bytes = this.codec.encodeControlMessage(publishDone);
    await this.doSendControl(bytes);
    log.info('Sent PUBLISH_DONE (draft-18)', { requestId, finalGroup, finalObject, statusCode: publishDone.statusCode?.toString() });
  }

  /**
   * Close the session
   */
  async close(): Promise<void> {
    log.info('Closing session');

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

    // Disconnect transport worker if using worker mode
    if (this.useWorker && this.transportWorker) {
      this.transportWorker.disconnect();
    }

    this._state = 'none';
    log.info('Session closed');
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

    const requestId = this.getNextRequestId();
    const subscriptionId = requestId;
    const trackAlias = BigInt(requestId);

    const fullTrackNameForLog = [...namespace, trackName].join('/');
    log.info('Subscribing', {
      namespace,
      namespaceElements: namespace.length,
      trackName,
      fullTrackName: fullTrackNameForLog,
      subscriptionId,
      trackAlias: trackAlias.toString(),
      isDraft18: IS_DRAFT_18,
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
    };
    this.subscriptionManager.add(subscription);

    if (IS_DRAFT_18) {
      // Draft-18: Send SUBSCRIBE on a new bidirectional stream
      await this.subscribeDraft18(requestId, namespace, trackName, trackAlias, options);
    } else {
      // Determine filter type - use ABSOLUTE_START for VOD, LATEST_GROUP for live
      const filterType = options?.filterType === 'absolute'
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
        startGroup: filterType === FilterType.ABSOLUTE_START ? startGroup : undefined,
        startObject: filterType === FilterType.ABSOLUTE_START ? startObject : undefined,
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
        requestId,
        trackAlias: trackAlias.toString(),
        namespace: namespace.join('/'),
        trackName,
      });
      this.emitMessageSent('SUBSCRIBE', subscribeBytes.length, `${namespace.join('/')}/${trackName}`, { requestId, trackAlias: trackAlias.toString() });
    }

    log.info('Subscription started', { subscriptionId });
    return subscriptionId;
  }

  /**
   * Draft-18: Subscribe using per-request bidirectional stream
   */
  private async subscribeDraft18(
    requestId: number,
    namespace: string[],
    trackName: string,
    trackAlias: bigint,
    options?: SubscribeOptions
  ): Promise<void> {
    const parameters = new Map<number, Uint8Array>();
    addDeliveryTimeoutParams(parameters, options);

    const subscribeMessage: SubscribeMessageDraft18 = {
      type: MessageTypeDraft18.SUBSCRIBE,
      requestId: BigInt(requestId),
      trackNamespace: namespace,
      trackName,
      forwardState: true,
      filter: SubscriptionFilterDraft18.NEXT_GROUP_START,
      parameters,
    };

    const encoded = this.codec.encodeControlMessage(subscribeMessage);
    const subHex = Array.from(encoded).map(b => b.toString(16).padStart(2, '0')).join(' ');
    log.info('Sent SUBSCRIBE (draft-18)', {
      requestId,
      trackAlias: trackAlias.toString(),
      namespace: namespace.join('/'),
      trackName,
      hex: subHex,
      length: encoded.length,
    });
    this.emitMessageSent('SUBSCRIBE', encoded.length, `${namespace.join('/')}/${trackName}`, { requestId, trackAlias: trackAlias.toString() });

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
        const largestGroup = Number(subscribeOk.largestLocation.group);
        const largestObject = Number(subscribeOk.largestLocation.object);
        const contentExists = largestGroup > 0 || largestObject > 0;
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
    requestId: number,
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
    });
    const publishMessage: PublishMessageDraft18 = {
      type: MessageTypeDraft18.PUBLISH,
      requestId: BigInt(requestId),
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
      requestId,
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
      log.info('Received REQUEST_OK for PUBLISH (draft-18)', { requestId, expiresMs });
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

    if (IS_DRAFT_18) {
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
        requestId: subscription.requestId,
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
  ): Promise<number> {
    if (!this.isReady) {
      throw new Error('Session not ready');
    }

    const requestId = this.getNextRequestId();
    const fullTrackNameStr = [...namespace, trackName].join('/');

    log.info('Fetching historical objects', {
      namespace: namespace.join('/'),
      trackName,
      fullTrackName: fullTrackNameStr,
      range,
      requestId,
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

    if (IS_DRAFT_18) {
      await this.fetchDraft18(requestId, namespace, trackName, range, options);
    } else {
      const fetchMessage: FetchMessage = {
        type: MessageType.FETCH,
        requestId,
        fullTrackName: { namespace, trackName },
        subscriberPriority: options?.priority ?? 128,
        groupOrder: options?.groupOrder ?? GroupOrder.ASCENDING,
        startGroup: range.startGroup,
        startObject: range.startObject,
        endGroup: range.endGroup,
        endObject: range.endObject,
        parameters: new Map(),
      };

      const fetchBytes = this.codec.encodeControlMessage(fetchMessage);
      const hexBytes = Array.from(fetchBytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
      log.info('FETCH bytes', { length: fetchBytes.length, hex: hexBytes });

      await this.doSendControl(fetchBytes);
      log.info('Sent FETCH message', {
        requestId,
        namespace: namespace.join('/'),
        trackName,
        range,
      });
      this.emitMessageSent('FETCH', fetchBytes.length, `${namespace.join('/')}/${trackName} (${range.startGroup},${range.startObject})-(${range.endGroup},${range.endObject})`, { requestId, range });
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
    requestId: number,
    namespace: string[],
    trackName: string,
    range: FetchRange,
    options?: FetchOptions,
  ): Promise<void> {
    // Draft-18 endLocation is *exclusive* per spec §7.5 (relays such as moxygen
    // decrement the object component to derive the inclusive "last" location).
    // The API's FetchRange.endObject is inclusive, so we bump the wire value
    // by one before encoding.
    const fetchType = options?.fetchType ?? FetchTypeDraft18.STANDALONE;
    const isJoining =
      fetchType === FetchTypeDraft18.JOINING_RELATIVE ||
      fetchType === FetchTypeDraft18.JOINING_ABSOLUTE;
    if (isJoining && options?.subscribeRequestId === undefined) {
      throw new Error('Joining FETCH requires options.subscribeRequestId');
    }
    const parameters = new Map<number, Uint8Array>();
    addDeliveryTimeoutParams(parameters, options);
    const fetchMessage: FetchMessageDraft18 = {
      type: MessageTypeDraft18.FETCH,
      requestId: BigInt(requestId),
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
        object: BigInt(range.endObject + 1),
      },
      parameters: parameters.size > 0 ? parameters : undefined,
    };

    const encoded = this.codec.encodeControlMessage(fetchMessage);
    const fetchHex = Array.from(encoded).map(b => b.toString(16).padStart(2, '0')).join(' ');
    log.info('Sent FETCH (draft-18)', {
      requestId,
      namespace: namespace.join('/'),
      trackName,
      range,
      hex: fetchHex,
      length: encoded.length,
    });
    this.emitMessageSent('FETCH', encoded.length, `${namespace.join('/')}/${trackName} (${range.startGroup},${range.startObject})-(${range.endGroup},${range.endObject})`, { requestId, range });

    const response = await this.sendRequestAndWaitResponse(encoded, requestId);

    if (response.type === MessageTypeDraft18.FETCH_OK) {
      const fetchOk = response as _FetchOkMessageDraft18;
      log.info('Received FETCH_OK (draft-18)', {
        requestId,
        endGroup: fetchOk.endLocation.group.toString(),
        endObject: fetchOk.endLocation.object.toString(),
        endOfTrack: fetchOk.endOfTrack,
      });
      const info = this.activeFetches.get(requestId);
      if (info) {
        info.completed = true;
        info.largestGroupId = Number(fetchOk.endLocation.group);
        info.largestObjectId = Number(fetchOk.endLocation.object);
        info.endOfTrack = fetchOk.endOfTrack;
      }
      this.emit('fetch-complete', {
        requestId,
        largestGroupId: Number(fetchOk.endLocation.group),
        largestObjectId: Number(fetchOk.endLocation.object),
        endOfTrack: fetchOk.endOfTrack,
      } as FetchCompleteEvent);
    } else if (response.type === MessageTypeDraft18.REQUEST_OK) {
      // Some relays send REQUEST_OK to accept the fetch and later stream data.
      const ok = response as RequestOkMessageDraft18;
      const expiresMs = ok.expires !== undefined ? Number(ok.expires) : undefined;
      log.info('Received REQUEST_OK for FETCH (draft-18)', { requestId, expiresMs });
      this.emit('request-ok', { requestId, requestKind: 'fetch', expiresMs } as RequestOkEvent);
    } else if (response.type === MessageTypeDraft18.REQUEST_ERROR) {
      const error = response as RequestErrorMessageDraft18;
      log.error('Received REQUEST_ERROR for FETCH (draft-18)', {
        requestId,
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
        requestId,
        responseType: response.type,
      });
    }
  }

  /**
   * Cancel an in-progress fetch
   *
   * @param requestId - Fetch request ID to cancel
   */
  async cancelFetch(requestId: number): Promise<void> {
    const fetchInfo = this.activeFetches.get(requestId);
    if (!fetchInfo) {
      log.warn('No fetch found to cancel', { requestId });
      return;
    }

    log.info('Cancelling fetch', { requestId });

    if (IS_DRAFT_18) {
      // Draft-18 has no FETCH_CANCEL message; the equivalent is REQUEST_UPDATE
      // with forwardState=false, which terminates delivery for this requestId.
      // The relay resets the fetch data stream in response; fire-and-forget.
      try {
        await this.sendRequestUpdate(requestId, false, { awaitAck: false });
        log.info('Sent REQUEST_UPDATE (forwardState=false) as FETCH cancel (draft-18)', { requestId });
      } catch (err) {
        log.error('Failed to send REQUEST_UPDATE for FETCH cancel', { error: (err as Error).message });
      }
      await this.closeRequestStream(requestId);
    } else {
      // Draft-14/16 send a dedicated FETCH_CANCEL message.
      const cancelMessage: FetchCancelMessage = {
        type: MessageType.FETCH_CANCEL,
        requestId,
      };

      try {
        const cancelBytes = this.codec.encodeControlMessage(cancelMessage);
        await this.doSendControl(cancelBytes);
        log.info('Sent FETCH_CANCEL message', { requestId });
      } catch (err) {
        log.error('Failed to send FETCH_CANCEL message', { error: (err as Error).message });
      }
    }

    // Remove from active fetches
    this.activeFetches.delete(requestId);
    this.fetchStreamBuffers.delete(requestId);
    log.info('Fetch cancelled', { requestId });
  }

  /**
   * Get active fetch info
   */
  getFetch(requestId: number): FetchInfo | undefined {
    return this.activeFetches.get(requestId);
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

    const requestId = this.getNextRequestId();

    log.info('Requesting track status', {
      namespace: namespace.join('/'),
      trackName,
      requestId,
    });

    // Build TRACK_STATUS message
    const trackStatusMessage: TrackStatusMessage = {
      type: MessageType.TRACK_STATUS,
      requestId,
      fullTrackName: { namespace, trackName },
    };

    const bytes = this.codec.encodeControlMessage(trackStatusMessage);
    await this.doSendControl(bytes);

    log.info('Sent TRACK_STATUS message', { requestId });

    // Wait for TRACK_STATUS_OK or TRACK_STATUS_ERROR
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.trackStatusCallbacks.delete(requestId);
        reject(new Error(`TRACK_STATUS request ${requestId} timed out after ${timeoutMs}ms`));
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

    const requestId = this.getNextRequestId();
    const subscriptionId = requestId;
    const prefixStr = namespacePrefix.join('/');

    log.info('Subscribing to namespace', { namespacePrefix: prefixStr, requestId });

    // Store namespace subscription
    const subscription: NamespaceSubscriptionInfo = {
      subscriptionId,
      requestId,
      namespacePrefix,
      tracks: new Map(),
      onObject: _options?.onObject,
    };
    this.namespaceSubscriptions.set(subscriptionId, subscription);
    this.namespaceSubscriptionByRequestId.set(requestId, subscriptionId);

    if (IS_DRAFT_18) {
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
      if (IS_DRAFT_16) {
        if (this.useWorker && this.transportWorker) {
          const streamId = await this.transportWorker.createBidiStream();
          this.transportWorker.writeStream(streamId, bytes, false);
          this.namespaceSubscriptionStreams.set(subscriptionId, streamId);
          log.info('Sent SUBSCRIBE_NAMESPACE on bidi stream (worker)', { namespacePrefix: prefixStr, requestId, streamId });
        } else if (this.transport) {
          const bidiStream = await this.transport.createBidirectionalStream();
          const writer = bidiStream.writable.getWriter();
          await writer.write(bytes);
          writer.releaseLock();
          this.readNamespaceSubscriptionStream(bidiStream.readable, subscriptionId).catch(err => {
            log.error('Error reading namespace subscription stream', { error: (err as Error).message });
          });
          log.info('Sent SUBSCRIBE_NAMESPACE on bidi stream', { namespacePrefix: prefixStr, requestId });
        }
      } else {
        // Draft-14: send on control stream
        await this.doSendControl(bytes);
        log.info('Sent SUBSCRIBE_NAMESPACE on control stream', { namespacePrefix: prefixStr, requestId });
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
            const [message, bytesRead] = this.codec.decodeControlMessage(view);
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
    requestId: number,
    namespacePrefix: string[],
    subscriptionId: number
  ): Promise<void> {
    const prefixStr = namespacePrefix.join('/');

    const subscribeNsMessage: SubscribeNamespaceMessageDraft18 = {
      type: MessageTypeDraft18.SUBSCRIBE_NAMESPACE,
      requestId: BigInt(requestId),
      trackNamespacePrefix: namespacePrefix,
    };

    const encoded = this.codec.encodeControlMessage(subscribeNsMessage);

    if (this.useWorker && this.transportWorker) {
      const streamId = await this.transportWorker.createBidiStream();
      this.transportWorker.writeStream(streamId, encoded);
      log.info('Sent SUBSCRIBE_NAMESPACE (draft-18) via worker', { namespacePrefix: prefixStr, requestId, streamId });

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
      log.info('Sent SUBSCRIBE_NAMESPACE (draft-18)', { namespacePrefix: prefixStr, requestId });

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
            const [message, bytesRead] = this.codec.decodeControlMessage(view);
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
        this.namespaceSubscriptions.delete(subscriptionId);
        this.emit('error', new Error(`Namespace subscription failed: ${error.reasonPhrase}`));
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

    // Check for existing subscription with same track name to use its alias
    const requestId = this.getNextRequestId();
    let trackAlias = BigInt(requestId);
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

    if (IS_DRAFT_18) {
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
        requestId,
        trackAlias: trackAlias.toString(),
        namespace: namespace.join('/'),
        trackName,
      });
      this.emitMessageSent('PUBLISH', publishBytes.length, `${namespace.join('/')}/${trackName}`, { requestId, trackAlias: trackAlias.toString() });

      // Wait for PUBLISH_OK
      const publishOkResult = await this.publicationManager.waitForPublishOk(requestId);
      log.info('Received PUBLISH_OK', {
        requestId,
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

    const requestId = this.getNextRequestId();

    if (IS_DRAFT_18) {
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
      log.info('PUBLISH_NAMESPACE bytes', { length: bytes.length, hex: hexBytes, namespace: namespaceStr, requestId });

      this.announceRequestIdToNamespace.set(requestId, namespaceStr);

      await this.doSendControl(bytes);
      log.info('Sent PUBLISH_NAMESPACE', { namespace: namespaceStr, requestId });

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
    requestId: number,
    namespace: string[],
    namespaceStr: string,
    announceInfo: AnnouncedNamespaceInfo
  ): Promise<void> {
    const publishNsMessage: PublishNamespaceMessageDraft18 = {
      type: MessageTypeDraft18.PUBLISH_NAMESPACE,
      requestId: BigInt(requestId),
      trackNamespacePrefix: namespace,
    };

    const encoded = this.codec.encodeControlMessage(publishNsMessage);

    if ((this.useWorker && this.transportWorker) || this.transport) {
      log.info('Sent PUBLISH_NAMESPACE (draft-18)', { namespace: namespaceStr, requestId });

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

    log.info('Received PUBLISH (subscribe namespace flow)', {
      requestId: message.requestId,
      namespace: namespaceStr,
      trackName,
      trackAlias: message.trackAlias.toString(),
      groupOrder: message.groupOrder,
    });

    // Check if this is our own publish (filter out self)
    if (this.ownNamespacePrefix && namespaceStr.startsWith(this.ownNamespacePrefix)) {
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
  private async sendPublishOk(requestId: number, groupOrder: GroupOrder): Promise<void> {
    const publishOk = {
      type: MessageType.PUBLISH_OK as const,
      requestId,
      forward: 1,
      subscriberPriority: 128,
      groupOrder,
      filterType: FilterType.LATEST_GROUP,
    };

    const bytes = this.codec.encodeControlMessage(publishOk);
    await this.doSendControl(bytes);
    log.info('Sent PUBLISH_OK', { requestId });
  }

  /**
   * Send SUBSCRIBE_OK response
   */
  private async sendSubscribeOk(
    requestId: number,
    trackAlias: bigint,
    groupOrder: GroupOrder
  ): Promise<void> {
    const subscribeOk: SubscribeOkMessage = {
      type: MessageType.SUBSCRIBE_OK,
      requestId,
      trackAlias,
      expires: 0,
      groupOrder,
      contentExists: false,
    };

    const bytes = this.codec.encodeControlMessage(subscribeOk);
    const hexBytes = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
    log.info('SUBSCRIBE_OK bytes', { length: bytes.length, hex: hexBytes });
    await this.doSendControl(bytes);
    log.info('Sent SUBSCRIBE_OK', { requestId, trackAlias: trackAlias.toString() });
  }

  /**
   * Send SUBSCRIBE_ERROR response
   */
  private async sendSubscribeError(
    requestId: number,
    errorCode: number,
    reasonPhrase: string
  ): Promise<void> {
    const subscribeError = {
      type: MessageType.SUBSCRIBE_ERROR,
      requestId,
      errorCode,
      reasonPhrase,
      trackAlias: 0,
    };

    const bytes = this.codec.encodeControlMessage(subscribeError as ControlMessage);
    await this.doSendControl(bytes);
    log.info('Sent SUBSCRIBE_ERROR', { requestId, errorCode, reasonPhrase });
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

    const requestId = this.getNextRequestId();
    const trackAlias = BigInt(requestId);
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
      requestId,
      trackAlias: trackAlias.toString(),
      namespace: namespace.join('/'),
      trackName,
    });

    // Wait for PUBLISH_OK
    const publishOkResult = await this.publicationManager.waitForPublishOk(requestId);
    log.info('Received PUBLISH_OK for VOD track', {
      requestId,
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
      requestId: message.requestId,
      namespace: namespace.join('/'),
      trackName,
      startGroup: message.startGroup,
      startObject: message.startObject,
      endGroup: message.endGroup,
      endObject: message.endObject,
    });

    // Find VOD track by name
    const vodCallbacks = (this as unknown as { vodCallbacks: Map<string, VODPublishOptions> }).vodCallbacks;
    const vodOptions = vodCallbacks?.get(vodKey);

    if (!vodOptions) {
      log.warn('FETCH for unknown VOD track', { fullTrackName: fullTrackNameStr });
      await this.sendFetchError(message.requestId, 0x03, 'Track not found');
      return;
    }

    // Emit event for application to handle (optional custom handling)
    this.emit('incoming-fetch', {
      requestId: message.requestId,
      namespace,
      trackName,
      range: {
        startGroup: message.startGroup,
        startObject: message.startObject,
        endGroup: message.endGroup,
        endObject: message.endObject,
      },
      priority: message.subscriberPriority,
      groupOrder: message.groupOrder,
    } as IncomingFetchEvent);

    // Send FETCH_OK first
    const fetchOk: FetchOkMessage = {
      type: MessageType.FETCH_OK,
      requestId: message.requestId,
      groupOrder: message.groupOrder,
      endOfTrack: message.endGroup >= vodOptions.metadata.totalGroups - 1,
      largestGroupId: vodOptions.metadata.totalGroups - 1,
      largestObjectId: (vodOptions.objectsPerGroup ?? 1) - 1,
    };

    const fetchOkBytes = this.codec.encodeControlMessage(fetchOk);
    await this.doSendControl(fetchOkBytes);
    log.info('Sent FETCH_OK', {
      requestId: message.requestId,
      largestGroupId: fetchOk.largestGroupId,
      largestObjectId: fetchOk.largestObjectId,
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
    const { startGroup, startObject, endGroup, endObject } = fetchMessage;
    const objectsPerGroup = vodOptions.objectsPerGroup ?? 1;

    log.info('Sending fetched objects', {
      requestId,
      startGroup,
      startObject,
      endGroup,
      endObject,
      objectsPerGroup,
      objectsPerGroupSource: vodOptions.objectsPerGroup,
    });
    console.log('[FETCH] Sending objects', {
      requestId,
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

      // Send objects in requested range
      for (let groupId = startGroup; groupId <= endGroup; groupId++) {
        const objStart = groupId === startGroup ? startObject : 0;
        const objEnd = groupId === endGroup && endObject > 0
          ? endObject
          : objectsPerGroup - 1;

        for (let objectId = objStart; objectId <= objEnd; objectId++) {
          // Check if fetch was cancelled
          if (this.pendingFetchResponses.has(requestId) === false && requestId !== fetchMessage.requestId) {
            log.info('Fetch cancelled, stopping send', { requestId });
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
            log.info('FETCH object encoded', {
              requestId,
              groupId,
              objectId,
              payloadSize: data.byteLength,
              encodedSize: objectData.byteLength,
              firstBytes: bytesHex,
            });
          }

          await this.doWriteStream(streamInfo, objectData);

          log.trace('Sent fetched object', {
            requestId,
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
      log.info('Fetch stream completed', { requestId });

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
    requestId: number,
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
    log.info('Sent FETCH_ERROR', { requestId, errorCode, reasonPhrase });
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
    if (IS_DRAFT_18) {
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
    try {
      const streamInfo = await this.doCreateStream();

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
      if (metadata.newGroup) {
        // Close existing stream — END_OF_GROUP is signaled by the header bit,
        // so just close the stream without writing a status object

        const existing = this.activeVideoStreams.get(aliasKey);
        if (existing) {
          try {
            await this.doCloseStream({ writer: existing.writer, streamId: existing.streamId });
            log.info('Closed previous GOP stream', {
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

        // Create new stream for this GOP
        const streamInfo = await this.doCreateStream();

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

        log.info('Started new GOP stream with keyframe', {
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
          log.info('No active GOP stream, opening new stream for group', {
            trackAlias: aliasKey,
            groupId: metadata.groupId,
            objectId: metadata.objectId,
          });

          const streamInfo = await this.doCreateStream();
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
            log.info('GOP stream closed by relay, reopening for same group', {
              trackAlias: aliasKey,
              groupId: metadata.groupId,
              objectId: metadata.objectId,
            });
            this.activeVideoStreams.delete(aliasKey);

            // Reopen stream and retry as if this is a new keyframe for the same group
            const streamInfo = await this.doCreateStream();
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
      try {
        await this.doCloseStream({ writer: existing.writer, streamId: existing.streamId });
        log.info('Closed video GOP stream', {
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

    if (IS_DRAFT_18) {
      await this.sendRequestUpdate(subscription.requestId, false);
      subscription.paused = true;
    } else {
      const subscribeUpdateMessage = {
        type: MessageType.SUBSCRIBE_UPDATE as const,
        requestId: this.getNextRequestId(),
        subscriptionRequestId: subscription.requestId,
        startLocation: { groupId: 0, objectId: 0 },
        endGroup: 0,
        subscriberPriority: 128,
        forward: 0,
      };

      try {
        const updateBytes = this.codec.encodeControlMessage(subscribeUpdateMessage);
        await this.doSendControl(updateBytes);
        subscription.paused = true;
        log.info('Sent SUBSCRIBE_UPDATE (pause)', { subscriptionId, requestId: subscribeUpdateMessage.requestId });
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

    if (IS_DRAFT_18) {
      await this.sendRequestUpdate(subscription.requestId, true);
      subscription.paused = false;
    } else {
      const subscribeUpdateMessage = {
        type: MessageType.SUBSCRIBE_UPDATE as const,
        requestId: this.getNextRequestId(),
        subscriptionRequestId: subscription.requestId,
        startLocation: { groupId: 0, objectId: 0 },
        endGroup: 0,
        subscriberPriority: 128,
        forward: 1,
      };

      try {
        const updateBytes = this.codec.encodeControlMessage(subscribeUpdateMessage);
        await this.doSendControl(updateBytes);
        subscription.paused = false;
        log.info('Sent SUBSCRIBE_UPDATE (resume)', { subscriptionId, requestId: subscribeUpdateMessage.requestId });
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
      requestId: this.getNextRequestId(),
      subscriptionRequestId: subscription.requestId,
      startLocation: { groupId, objectId },
      endGroup: 0,
      subscriberPriority: 128,
      forward: 1,
    };

    try {
      const updateBytes = this.codec.encodeControlMessage(subscribeUpdateMessage);
      await this.doSendControl(updateBytes);
      log.info('Sent SUBSCRIBE_UPDATE (seek)', {
        subscriptionId,
        requestId: subscribeUpdateMessage.requestId,
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
  on(event: 'request-ok', handler: (event: RequestOkEvent) => void): () => void;
  on(event: 'publish-done', handler: (event: PublishDoneEvent) => void): () => void;
  on(event: 'publish-blocked', handler: (event: PublishBlockedEvent) => void): () => void;
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
          log.debug('Received SERVER_SETUP (draft-18)', {
            version: serverSetup.selectedVersion,
            role: serverSetup.role,
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

      case MessageTypeDraft18.REQUEST_UPDATE: {
        const update = message as RequestUpdateMessageDraft18;
        if (update.forwardState) {
          this.publicationManager.resolveAllForward();
          this.emit('forward-resumed', { requestId: Number(update.requestId) });
        } else {
          this.emit('forward-paused', { subscriptionRequestId: Number(update.requestId) });
        }
        break;
      }

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
          const [decoded] = this.codec.decodeControlMessage(buffer);
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

    // Send SUBSCRIBE_OK with the track alias we'll use on data streams
    const subscribeOk: SubscribeOkMessageDraft18 = {
      type: MessageTypeDraft18.SUBSCRIBE_OK,
      requestId: message.requestId,
      trackAlias,
      largestLocation: { group: 0n, object: 0n },
    };
    const responseBytes = this.codec.encodeControlMessage(subscribeOk);
    const writer = writable.getWriter();
    await writer.write(responseBytes);
    writer.releaseLock();

    // Create publication entry
    const publication: InternalPublication = {
      trackAlias,
      namespace,
      trackName,
      priority: announceInfo.options.priority ?? 128,
      deliveryMode: announceInfo.options.deliveryMode ?? 'stream',
      audioDeliveryMode: announceInfo.options.audioDeliveryMode ?? 'datagram',
      requestId: Number(message.requestId),
      cleanupHandlers: [],
      forward: 1,
    };
    this.publicationManager.add(publication);

    // Add to subscribers map
    const subscriber: IncomingSubscriber = {
      requestId: Number(message.requestId),
      fullTrackName: { namespace, trackName },
      trackAlias,
      subscriberPriority: 128,
      groupOrder: GroupOrder.ASCENDING,
      active: true,
    };
    announceInfo.subscribers.set(Number(message.requestId), subscriber);

    // Emit event
    this.emit('incoming-subscribe', {
      requestId: Number(message.requestId),
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

    // Send REQUEST_OK to accept
    const requestOk: RequestOkMessageDraft18 = {
      type: MessageTypeDraft18.REQUEST_OK,
      requestId: message.requestId,
    };
    const responseBytes = this.codec.encodeControlMessage(requestOk);
    const writer = writable.getWriter();
    await writer.write(responseBytes);
    writer.releaseLock();

    // Register as subscription for object routing
    const subscriptionId = this.getNextRequestId();
    const subscription: InternalSubscription = {
      subscriptionId,
      requestId: Number(message.requestId),
      namespace,
      trackName,
      trackAlias: message.trackAlias,
      paused: false,
      onObject: matchingSubscription.onObject,
    };
    this.subscriptionManager.add(subscription);

    // Store track info
    const trackInfo: IncomingPublishInfo = {
      requestId: Number(message.requestId),
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
      requestId: Number(message.requestId),
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
   * Handle incoming TRACK_STATUS on bidi stream
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
    // Respond with REQUEST_ERROR - we don't track status
    await this.sendRequestErrorOnStream(
      writable,
      message.requestId,
      RequestErrorCodeDraft18.NOT_SUPPORTED,
      'Track status not available',
    );
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
    log.info('Received SUBSCRIBE_TRACKS (draft-18)', {
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

    // Emit incoming-subscribe for each track we publish under this prefix
    for (const [, pub] of this.publicationManager) {
      const pubNs = pub.namespace.join('/');
      if (pubNs.startsWith(prefix)) {
        this.emit('incoming-subscribe', {
          requestId: Number(message.requestId),
          namespace: pub.namespace,
          trackName: pub.trackName,
          trackAlias: pub.trackAlias,
        } as IncomingSubscribeEvent);
      }
    }
  }

  /**
   * Handle incoming REQUEST_UPDATE on bidi stream
   */
  private async handleIncomingRequestUpdateDraft18(
    message: RequestUpdateMessageDraft18,
    _writable: WritableStream<Uint8Array>
  ): Promise<void> {
    log.info('Received REQUEST_UPDATE (draft-18)', {
      requestId: message.requestId.toString(),
      forwardState: message.forwardState,
    });

    if (message.forwardState) {
      this.publicationManager.resolveAllForward();
      this.emit('forward-resumed', { requestId: Number(message.requestId) });
    } else {
      this.emit('forward-paused', { subscriptionRequestId: Number(message.requestId) });
    }
  }

  /**
   * Handle incoming PUBLISH_DONE
   */
  private handleIncomingPublishDoneDraft18(message: PublishDoneMessageDraft18): void {
    const requestId = Number(message.requestId);
    log.info('Received PUBLISH_DONE (draft-18)', {
      requestId: message.requestId.toString(),
      finalGroup: message.finalLocation.group.toString(),
      finalObject: message.finalLocation.object.toString(),
      statusCode: message.statusCode?.toString(),
      reasonPhrase: message.reasonPhrase,
      streamCount: message.streamCount?.toString(),
    });

    // Find and remove the subscription by requestId
    const sub = this.subscriptionManager.findByRequestId(requestId);
    this.emit('publish-done', {
      requestId,
      subscriptionId: sub?.subscriptionId,
      finalGroupId: Number(message.finalLocation.group),
      finalObjectId: Number(message.finalLocation.object),
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
   * Handle incoming GOAWAY
   */
  private handleIncomingGoAwayDraft18(message: GoAwayMessageDraft18): void {
    log.info('Received GOAWAY (draft-18)', {
      newSessionUri: message.newSessionUri,
      timeoutMs: message.timeout.toString(),
      requestId: message.requestId?.toString(),
    });
    this.emit('goaway', {
      newSessionUri: message.newSessionUri,
      timeoutMs: message.timeout,
      requestId: message.requestId,
    });
    this.setState('closing');
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
          const [message, bytesRead] = this.codec.decodeControlMessage(view);

          this.controlBufferOffset += bytesRead;
          messagesDecoded++;

          log.info('Received control message', {
            type: MessageType[message.type],
            typeNum: message.type,
            bytesRead,
            remainingBuffer: bufferLength - this.controlBufferOffset,
          });

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
        const publishOk = message as {
          requestId: number;
          trackAlias?: number;
          forward: number;
          startLocation?: { groupId: number; objectId: number };
          endGroup?: number;
        };
        log.info('Received PUBLISH_OK in handler', {
          requestId: publishOk.requestId,
          trackAlias: publishOk.trackAlias,
          forward: publishOk.forward,
          startLocation: publishOk.startLocation,
          endGroup: publishOk.endGroup,
        });
        const locationStr = publishOk.startLocation
          ? ` loc=(${publishOk.startLocation.groupId},${publishOk.startLocation.objectId})`
          : '';
        this.emitMessageReceived('PUBLISH_OK', 0, `trackAlias=${publishOk.trackAlias} forward=${publishOk.forward}${locationStr}`, { requestId: publishOk.requestId, trackAlias: publishOk.trackAlias, forward: publishOk.forward, startLocation: publishOk.startLocation });

        this.publicationManager.resolvePublishOk(publishOk.requestId, {
          forward: publishOk.forward ?? 0,
          trackAlias: publishOk.trackAlias,
        });
        break;
      }

      case MessageType.PUBLISH_ERROR: {
        const publishError = message as { requestId: number; errorCode: number; reasonPhrase: string };
        log.error('Received PUBLISH_ERROR', {
          requestId: publishError.requestId,
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
        const subscribeError = message as {
          requestId: number;
          errorCode: number;
          reasonPhrase: string;
          trackAlias: number;
        };
        log.error('Received SUBSCRIBE_ERROR', {
          requestId: subscribeError.requestId,
          errorCode: subscribeError.errorCode,
          reasonPhrase: subscribeError.reasonPhrase,
          trackAlias: subscribeError.trackAlias,
        });
        this.emitMessageReceived('SUBSCRIBE_ERROR', 0, `code=${subscribeError.errorCode} "${subscribeError.reasonPhrase}"`, { requestId: subscribeError.requestId, errorCode: subscribeError.errorCode, reasonPhrase: subscribeError.reasonPhrase });

        // Find and clean up the failed subscription
        const sub = this.subscriptionManager.findByRequestId(subscribeError.requestId);
        if (sub) {
          log.info('Cleaning up failed subscription', { subscriptionId: sub.subscriptionId });
          this.subscriptionManager.remove(sub.subscriptionId);
        }

        // Emit error
        this.emit('error', new Error(`Subscription failed: ${subscribeError.reasonPhrase} (code: ${subscribeError.errorCode})`));
        break;
      }

      case MessageType.SUBSCRIBE_UPDATE: {
        const subscribeUpdate = message as {
          requestId: number;
          subscriptionRequestId: number;
          forward: number;
          startLocation?: { groupId: number; objectId: number };
        };
        log.info('Received SUBSCRIBE_UPDATE', {
          requestId: subscribeUpdate.requestId,
          subscriptionRequestId: subscribeUpdate.subscriptionRequestId,
          forward: subscribeUpdate.forward,
          startLocation: subscribeUpdate.startLocation,
        });

        // Handle forward state change for all publications
        if (subscribeUpdate.forward === 1) {
          log.info('Forward enabled by relay, resolving all pending publishers', {
            subscriptionRequestId: subscribeUpdate.subscriptionRequestId,
            pendingCount: this.publicationManager.pendingForwardCount,
          });
          this.publicationManager.resolveAllForward();
        } else if (subscribeUpdate.forward === 0) {
          log.info('Forward disabled by relay, pausing all publications', {
            subscriptionRequestId: subscribeUpdate.subscriptionRequestId,
          });
          this.publicationManager.setAllForward(0);
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

        if (IS_DRAFT_16 && publishNamespaceOk.requestId !== undefined) {
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
        this.emit('error', new Error(`Namespace announcement failed: ${publishNamespaceError.reasonPhrase}`));
        break;
      }

      case MessageType.SUBSCRIBE_NAMESPACE_OK: {
        const subscribeNamespaceOk = message as SubscribeNamespaceOkMessage;
        let subscriptionId: number | undefined;

        if (IS_DRAFT_16 && subscribeNamespaceOk.requestId !== undefined) {
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

        if (IS_DRAFT_16 && subscribeNamespaceError.requestId !== undefined) {
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

        if (subscriptionId !== undefined) {
          const subscription = this.namespaceSubscriptions.get(subscriptionId);
          // Remove the failed subscription
          this.namespaceSubscriptions.delete(subscriptionId);
          if (subscription) {
            this.namespaceSubscriptionByRequestId.delete(subscription.requestId);
          }
        }
        this.emit('error', new Error(`Namespace subscription failed: ${subscribeNamespaceError.reasonPhrase}`));
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
        this.handleIncomingPublish(publishMessage).catch(err => {
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
   * Update session state
   */
  private setState(state: SessionState): void {
    if (this._state === state) return;
    const prev = this._state;
    this._state = state;
    log.info('Session state changed', { from: prev, to: state });
    this.emit('state-change', state);
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
