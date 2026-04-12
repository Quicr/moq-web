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
  ObjectCodec,
  MessageType,
  Version,
  GroupOrder,
  FilterType,
  ObjectStatus,
  RequestParameter,
  SetupParameter,
  BufferWriter,
  Logger,
  IS_DRAFT_16,
  getCurrentALPNProtocol,
  DataStreamType,
  type ClientSetupMessage,
  type ServerSetupMessage,
  type PublishMessage,
  type SubscribeMessage,
  type SubscribeOkMessage,
  type PublishNamespaceMessage,
  type PublishNamespaceOkMessage,
  type SubscribeNamespaceOkMessage,
  type SubscribeNamespaceErrorMessage,
  type MOQTMessage,
  type ControlMessage,
  type ObjectHeader,
  type FetchMessage,
  type FetchOkMessage,
  type FetchErrorMessage,
  type FetchCancelMessage,
} from '@web-moq/core';
import { SubscriptionManager, type InternalSubscription } from './subscription-manager.js';
import { PublicationManager, type InternalPublication } from './publication-manager.js';
import { ObjectRouter } from './object-router.js';
import { TransportWorkerClient } from './workers/index.js';
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
  FetchOptions,
  FetchRange,
  FetchInfo,
  FetchObjectEvent,
  FetchCompleteEvent,
  FetchErrorEvent,
  VODPublishOptions,
  VODTrackInfo,
  IncomingFetchEvent,
} from './types.js';

const log = Logger.create('moqt:session');

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
 * const worker = new Worker(new URL('@web-moq/session/worker', import.meta.url));
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
   * Draft-16: Clients use even IDs (0, 2, 4, ...), servers use odd (1, 3, 5, ...)
   */
  private nextRequestId = IS_DRAFT_16 ? 0 : 1;
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

  // ============================================================================
  // FETCH / DVR State
  // ============================================================================

  /** Active fetch requests (we are the fetcher/subscriber) */
  private activeFetches = new Map<number, FetchInfo>();
  /** Request ID to fetch stream mapping for receiving fetch data */
  private fetchStreamBuffers = new Map<number, Uint8Array[]>();

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
    log.debug('MOQTSession created', { isDraft16: IS_DRAFT_16, useWorker: this.useWorker });
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
   * Get next request ID (handles draft-14/16 parity rules)
   * Draft-14: Increment by 1 (1, 2, 3, ...)
   * Draft-16: Clients use even, increment by 2 (0, 2, 4, ...)
   */
  private getNextRequestId(): number {
    const id = this.nextRequestId;
    this.nextRequestId += IS_DRAFT_16 ? 2 : 1;
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

    // Set up control message handler
    const controlCleanup = this.transport.on('control-message', (data) => {
      this.handleControlMessage(data);
    });
    this.transportCleanup.push(controlCleanup);

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

    // Control messages from worker
    this.transportWorker.on('control-message', ({ data }) => {
      this.handleControlMessage(data);
    });

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
    this.workerStreamReaders.delete(streamId);
    this.bidiStreamChunks.delete(streamId);
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
        const [message, bytesRead] = MessageCodec.decode(view);
        consumed += bytesRead;

        log.info('Received message on namespace subscription stream (worker)', {
          type: MessageType[message.type],
          subscriptionId,
          streamId,
        });

        this.routeMessage(message);
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

    log.info('Setting up MOQT session', { useWorker: this.useWorker });
    this.setState('setup');

    // Set up event handlers based on mode
    if (this.useWorker) {
      this.setupWorkerHandlers();
    } else {
      this.setupTransportHandlers();
    }

    // Send CLIENT_SETUP
    // Draft-14: Include version list
    // Draft-16: Version negotiated via ALPN, no version list
    const setupParams = new Map<SetupParameter, number | string>();
    // Set max request ID to allow up to 1000 concurrent requests
    setupParams.set(SetupParameter.MAX_REQUEST_ID, 1000);

    const clientSetup: ClientSetupMessage = {
      type: MessageType.CLIENT_SETUP,
      supportedVersions: IS_DRAFT_16
        ? [Version.DRAFT_16]
        : [Version.DRAFT_14, Version.DRAFT_15],
      parameters: setupParams,
    };

    const setupBytes = MessageCodec.encode(clientSetup);

    const hexBytes = Array.from(setupBytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
    log.info('CLIENT_SETUP bytes', {
      length: setupBytes.length,
      hex: hexBytes,
      isDraft16: IS_DRAFT_16,
      alpnProtocol: getCurrentALPNProtocol(),
    });

    await this.doSendControl(setupBytes);
    log.info('Sent CLIENT_SETUP');
    this.emitMessageSent('CLIENT_SETUP', setupBytes.length, IS_DRAFT_16 ? 'draft-16' : 'draft-14', { isDraft16: IS_DRAFT_16 });

    // Wait for SERVER_SETUP
    await this.waitForServerSetup();
    log.info('MOQT session ready');
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

    // Send SUBSCRIBE message
    const subscribeMessage: SubscribeMessage = {
      type: MessageType.SUBSCRIBE,
      requestId,
      trackAlias,
      fullTrackName: { namespace, trackName },
      subscriberPriority: options?.priority ?? 128,
      groupOrder: options?.groupOrder ?? GroupOrder.ASCENDING,
      filterType: FilterType.LATEST_GROUP,
      parameters: new Map(),
    };

    const subscribeBytes = MessageCodec.encode(subscribeMessage);

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

    log.info('Subscription started', { subscriptionId });
    return subscriptionId;
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

    // Send UNSUBSCRIBE message
    const unsubscribeMessage = {
      type: MessageType.UNSUBSCRIBE as const,
      requestId: subscription.requestId,
    };

    try {
      const unsubscribeBytes = MessageCodec.encode(unsubscribeMessage);
      await this.doSendControl(unsubscribeBytes);
      log.info('Sent UNSUBSCRIBE message', { requestId: subscription.requestId });
    } catch (err) {
      log.error('Failed to send UNSUBSCRIBE message', { error: (err as Error).message });
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

    // Build FETCH message
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

    const fetchBytes = MessageCodec.encode(fetchMessage);
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

    // Store object callback if provided
    if (onObject) {
      const handler = (event: FetchObjectEvent) => {
        if (event.requestId === requestId) {
          onObject(event.data, event.groupId, event.objectId);
        }
      };
      this.on('fetch-object', handler);
    }

    return requestId;
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

    // Send FETCH_CANCEL message
    const cancelMessage: FetchCancelMessage = {
      type: MessageType.FETCH_CANCEL,
      requestId,
    };

    try {
      const cancelBytes = MessageCodec.encode(cancelMessage);
      await this.doSendControl(cancelBytes);
      log.info('Sent FETCH_CANCEL message', { requestId });
    } catch (err) {
      log.error('Failed to send FETCH_CANCEL message', { error: (err as Error).message });
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

    // Build SUBSCRIBE_NAMESPACE message
    // Note: In draft-16, subscriber priority is not a valid parameter for SUBSCRIBE_NAMESPACE
    const message = {
      type: MessageType.SUBSCRIBE_NAMESPACE as const,
      requestId,
      namespacePrefix,
      subscribeOptions: 0x00, // Request PUBLISH messages
    };

    const bytes = MessageCodec.encode(message);

    // Draft-16: SUBSCRIBE_NAMESPACE must be sent on a new bidirectional stream
    if (IS_DRAFT_16) {
      if (this.useWorker && this.transportWorker) {
        // Worker mode: create bidi stream via worker
        const streamId = await this.transportWorker.createBidiStream();
        this.transportWorker.writeStream(streamId, bytes, false);

        // Store stream ID for receiving responses
        this.namespaceSubscriptionStreams.set(subscriptionId, streamId);

        log.info('Sent SUBSCRIBE_NAMESPACE on bidi stream (worker)', { namespacePrefix: prefixStr, requestId, streamId });
      } else if (this.transport) {
        // Main thread mode: create bidi stream directly
        const bidiStream = await this.transport.createBidirectionalStream();
        const writer = bidiStream.writable.getWriter();
        await writer.write(bytes);
        writer.releaseLock();

        // Start reading responses on this bidi stream
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
            const [message, bytesRead] = MessageCodec.decode(view);
            consumed += bytesRead;

            log.info('Received message on namespace subscription stream', {
              type: MessageType[message.type],
              subscriptionId,
            });

            this.routeMessage(message);
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
      const bytes = MessageCodec.encode(message);
      await this.doSendControl(bytes);
      log.info('Sent UNSUBSCRIBE_NAMESPACE', { namespacePrefix: prefixStr });
    } catch (err) {
      log.error('Failed to send UNSUBSCRIBE_NAMESPACE', { error: (err as Error).message });
    }

    // Clean up
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

    // Create publication
    const publication: InternalPublication = {
      trackAlias,
      namespace,
      trackName,
      priority,
      deliveryMode,
      audioDeliveryMode,
      requestId,
      cleanupHandlers: [],
    };
    this.publicationManager.add(publication);

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

    const publishBytes = MessageCodec.encode(publishMessage);

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

    // If forward=0, wait for SUBSCRIBE_UPDATE
    if (publishOkResult.forward === 0) {
      log.info('Forward=0, waiting for subscriber (SUBSCRIBE_UPDATE with forward=1)');
      await this.publicationManager.waitForForward(requestId);
      log.info('Forward enabled by subscriber, can start sending data');
    } else {
      log.info('Forward=1, subscriber already exists - starting immediately');
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

    // Send PUBLISH_NAMESPACE message
    const requestId = this.getNextRequestId();
    const publishNamespaceMessage: PublishNamespaceMessage = {
      type: MessageType.PUBLISH_NAMESPACE,
      requestId,
      namespace,
    };

    const bytes = MessageCodec.encode(publishNamespaceMessage);
    const hexBytes = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
    log.info('PUBLISH_NAMESPACE bytes', { length: bytes.length, hex: hexBytes, namespace: namespaceStr, requestId });

    // Store requestId -> namespace mapping for draft-16 response handling
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
    const bytes = MessageCodec.encode(cancelMessage as ControlMessage);
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

    // Create a publication entry for this track
    const publication: InternalPublication = {
      trackAlias,
      namespace,
      trackName,
      priority: announceInfo.options.priority ?? 128,
      deliveryMode: announceInfo.options.deliveryMode ?? 'stream',
      audioDeliveryMode: announceInfo.options.audioDeliveryMode ?? 'datagram',
      requestId: message.requestId,
      cleanupHandlers: [],
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
      log.warn('PUBLISH does not match any namespace subscription', {
        publishNamespace: namespaceStr,
        subscriptions: Array.from(this.namespaceSubscriptions.values()).map(s => s.namespacePrefix.join('/')),
      });
      return;
    }

    // Check for trackAlias collision - this will cause routing issues
    const existingSubscription = this.subscriptionManager.getByAlias(BigInt(message.trackAlias));
    if (existingSubscription) {
      const existingTrackName = [...existingSubscription.namespace, existingSubscription.trackName].join('/');
      log.error('TrackAlias collision detected - multiple tracks using same alias will cause data corruption', {
        trackAlias: message.trackAlias.toString(),
        newTrack: fullTrackNameStr,
        existingTrack: existingTrackName,
        existingSubscriptionId: existingSubscription.subscriptionId,
      });

      // Emit error event so UI can warn the user
      this.emit('error', new Error(
        `TrackAlias collision: "${fullTrackNameStr}" and "${existingTrackName}" both use alias ${message.trackAlias}. Video/audio data may be corrupted.`
      ));

      // Continue anyway - we'll accept the PUBLISH but routing will be broken
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

    const bytes = MessageCodec.encode(publishOk);
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

    const bytes = MessageCodec.encode(subscribeOk);
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

    const bytes = MessageCodec.encode(subscribeError as ControlMessage);
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

    const publishBytes = MessageCodec.encode(publishMessage);
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

    // Create publication entry
    const publication: InternalPublication = {
      trackAlias,
      namespace,
      trackName,
      priority: options.priority ?? 128,
      deliveryMode: options.deliveryMode ?? 'stream',
      audioDeliveryMode: options.audioDeliveryMode ?? 'datagram',
      requestId,
      cleanupHandlers: [],
    };
    this.publicationManager.add(publication);

    // If relay tells us to forward (subscribers waiting), start streaming VOD content
    if (publishOkResult.forward === 1) {
      log.info('VOD track has subscribers, starting auto-stream', { trackAlias: trackAlias.toString() });
      this.startVODAutoStream(trackAlias, options);
    }

    log.info('VOD publishing started', { trackAlias: trackAlias.toString() });
    return trackAlias;
  }

  /**
   * Auto-stream VOD content to subscribers at realtime pace
   */
  private async startVODAutoStream(trackAlias: bigint, options: VODPublishOptions): Promise<void> {
    const { metadata, getObject, objectsPerGroup = 30 } = options;
    const frameDuration = 1000 / (metadata.framerate ?? 30); // ms per frame
    const totalGroups = Math.min(metadata.totalGroups, Number.MAX_SAFE_INTEGER);

    log.info('Starting VOD auto-stream', {
      trackAlias: trackAlias.toString(),
      totalGroups,
      framerate: metadata.framerate,
      frameDuration,
    });

    const publication = this.publicationManager.get(trackAlias);
    if (!publication) {
      log.warn('No publication found for VOD auto-stream', { trackAlias: trackAlias.toString() });
      return;
    }

    // Stream VOD content in realtime
    const streamLoop = async () => {
      let groupId = 0;

      // Wait for subscriber to set up decode pipeline
      // This gives time for incoming-publish event to be processed
      await new Promise(resolve => setTimeout(resolve, 500));
      log.info('VOD auto-stream starting after subscriber setup delay');

      while (true) {
        // Check if publication still exists
        if (!this.publicationManager.get(trackAlias)) {
          log.info('VOD publication ended, stopping auto-stream');
          break;
        }

        // Loop group ID for looping content
        const effectiveGroupId = groupId % (totalGroups || 1);

        // Stream all objects in this group
        for (let objectId = 0; objectId < objectsPerGroup; objectId++) {
          const data = await getObject(effectiveGroupId, objectId);
          if (!data) {
            // No more objects in this group
            break;
          }

          try {
            // Send object using normal publish flow
            await this.sendObject(trackAlias, data, {
              groupId,
              objectId,
              type: 'video',
              isKeyframe: objectId === 0, // First object in group is keyframe
            });
          } catch (err) {
            log.warn('Failed to send VOD object', { groupId, objectId, error: err });
          }

          // Wait for frame duration to maintain realtime playback
          await new Promise(resolve => setTimeout(resolve, frameDuration));
        }

        groupId++;

        // For non-looping content, stop at end
        if (groupId >= totalGroups && totalGroups !== Number.MAX_SAFE_INTEGER) {
          log.info('VOD auto-stream completed', { totalGroups: groupId });
          break;
        }
      }
    };

    // Start streaming in background
    streamLoop().catch(err => {
      log.error('VOD auto-stream error', { error: err });
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

    const fetchOkBytes = MessageCodec.encode(fetchOk);
    await this.doSendControl(fetchOkBytes);
    log.info('Sent FETCH_OK', { requestId: message.requestId });

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
      const fetchState = ObjectCodec.createFetchEncoderState();

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
          const objectData = ObjectCodec.encodeFetchObject(
            groupId,
            0, // subgroupId
            objectId,
            data,
            fetchState,
            128 // priority
          );

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
      errorCode: errorCode as import('@web-moq/core').RequestErrorCode,
      reasonPhrase,
    };

    const bytes = MessageCodec.encode(fetchError);
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
      // Video with keyframe info uses GOP batching (one stream per group)
      if (metadata.type === 'video' && metadata.isKeyframe !== undefined) {
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

    const datagram = ObjectCodec.encodeDatagramObject({
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
      const [subgroupHeader, hasExtensions] = ObjectCodec.encodeSubgroupHeader({
        trackAlias,
        groupId: metadata.groupId,
        subgroupId: 0,
        publisherPriority: priority ?? 128,
      }, true /* endOfGroup */);

      const objectData = ObjectCodec.encodeStreamObject(
        metadata.objectId,
        data,
        ObjectStatus.NORMAL,
        -1, // previousObjectId (first object)
        hasExtensions
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
      if (metadata.isKeyframe) {
        // Close existing stream with END_OF_GROUP marker
        const existing = this.activeVideoStreams.get(aliasKey);
        if (existing) {
          try {
            // Send END_OF_GROUP marker as the last object
            const endOfGroupObject = ObjectCodec.encodeStreamObject(
              existing.previousObjectId + 1, // Next object ID
              new Uint8Array(0), // Empty payload
              ObjectStatus.END_OF_GROUP,
              existing.previousObjectId,
              existing.hasExtensions
            );
            await this.doWriteStream({ writer: existing.writer, streamId: existing.streamId }, endOfGroupObject);

            await this.doCloseStream({ writer: existing.writer, streamId: existing.streamId });
            log.info('Closed previous GOP stream with END_OF_GROUP', {
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
        const [subgroupHeader, hasExtensions] = ObjectCodec.encodeSubgroupHeader({
          trackAlias,
          groupId: metadata.groupId,
          subgroupId: 0,
          publisherPriority: priority,
        }, true /* endOfGroup */);

        const objectData = ObjectCodec.encodeStreamObject(
          metadata.objectId,
          data,
          ObjectStatus.NORMAL,
          -1, // previousObjectId (first object)
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
          previousObjectId: metadata.objectId, // For delta encoding
          hasExtensions,
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
          log.warn('No active GOP stream for P-frame, creating new stream', {
            trackAlias: aliasKey,
            groupId: metadata.groupId,
            objectId: metadata.objectId,
          });
          await this.sendObjectViaStream(trackAlias, data, metadata, priority);
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

        const objectData = ObjectCodec.encodeStreamObject(
          metadata.objectId,
          data,
          ObjectStatus.NORMAL,
          existing.previousObjectId, // Delta encoding from previous object
          existing.hasExtensions
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
          // Stream was closed (STOP_SENDING or not found) - clean up and drop this P-frame
          // Next keyframe will start a fresh GOP stream
          if (errMsg.includes('not found') || errMsg.includes('STOP_SENDING')) {
            log.debug('GOP stream closed by relay, dropping P-frame until next keyframe', {
              trackAlias: aliasKey,
              groupId: metadata.groupId,
              objectId: metadata.objectId,
            });
            this.activeVideoStreams.delete(aliasKey);
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
        isKeyframe: metadata.isKeyframe,
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
      const updateBytes = MessageCodec.encode(subscribeUpdateMessage);
      await this.doSendControl(updateBytes);
      subscription.paused = true;
      log.info('Sent SUBSCRIBE_UPDATE (pause)', { subscriptionId, requestId: subscribeUpdateMessage.requestId });
    } catch (err) {
      log.error('Failed to send SUBSCRIBE_UPDATE (pause)', { error: (err as Error).message });
      throw err;
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
      const updateBytes = MessageCodec.encode(subscribeUpdateMessage);
      await this.doSendControl(updateBytes);
      subscription.paused = false;
      log.info('Sent SUBSCRIBE_UPDATE (resume)', { subscriptionId, requestId: subscribeUpdateMessage.requestId });
    } catch (err) {
      log.error('Failed to send SUBSCRIBE_UPDATE (resume)', { error: (err as Error).message });
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
  on(event: 'incoming-subscribe', handler: (event: IncomingSubscribeEvent) => void): () => void;
  on(event: 'incoming-publish', handler: (event: IncomingPublishEvent) => void): () => void;
  on(event: 'namespace-acknowledged', handler: (data: { namespace: string[] }) => void): () => void;
  // FETCH / DVR events
  on(event: 'fetch-object', handler: (event: FetchObjectEvent) => void): () => void;
  on(event: 'fetch-complete', handler: (event: FetchCompleteEvent) => void): () => void;
  on(event: 'fetch-error', handler: (event: FetchErrorEvent) => void): () => void;
  on(event: 'incoming-fetch', handler: (event: IncomingFetchEvent) => void): () => void;
  // Message logging events
  on(event: 'message-sent', handler: (event: MessageLogEvent) => void): () => void;
  on(event: 'message-received', handler: (event: MessageLogEvent) => void): () => void;
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
   * Wait for SERVER_SETUP message
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
          const [message, bytesRead] = MessageCodec.decode(view);

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
          this.routeMessage(message);
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

        // When forward=1, resolve all pending forward promises
        if (subscribeUpdate.forward === 1) {
          log.info('Forward enabled by relay, resolving all pending publishers', {
            subscriptionRequestId: subscribeUpdate.subscriptionRequestId,
            pendingCount: this.publicationManager.pendingForwardCount,
          });
          this.publicationManager.resolveAllForward();
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
