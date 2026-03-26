// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Media Session
 *
 * High-level media session that wraps MOQTSession with media
 * encoding/decoding pipelines. Use this for video/audio streaming.
 */

import { MOQTransport, Logger } from '@web-moq/core';
import {
  MOQTSession,
  type SessionState,
  type PublishOptions,
  type AnnounceOptions,
  type AnnouncedNamespaceInfo,
  type IncomingSubscriber,
  type IncomingSubscribeEvent,
  type IncomingPublishEvent,
  type SubscribeNamespaceOptions,
  type NamespaceSubscriptionInfo,
} from '@web-moq/session';
import { PublishPipeline, type PublishedObject } from '../pipeline/publish-pipeline.js';
import { SubscribePipeline, type JitterSample, type LatencyStatsSample } from '../pipeline/subscribe-pipeline.js';
import type {
  MediaConfig,
  MediaSessionEventType,
  MediaSubscribeOptions,
  WorkerConfig,
} from './types.js';
import { getResolutionConfig } from './types.js';

/**
 * MediaSession configuration options
 */
export interface MediaSessionOptions {
  /**
   * Optional worker configuration for offloading processing to web workers.
   * When workers are provided, encoding/decoding happens off the main thread.
   */
  workers?: WorkerConfig;
  /**
   * Server certificate hashes for self-signed certs (worker mode only).
   */
  serverCertificateHashes?: ArrayBuffer[];
}

const log = Logger.create('moqt:media:session');

/**
 * Active publication with pipeline
 */
interface ActivePublication {
  trackAlias: bigint;
  namespace: string[];
  trackName: string;
  pipeline: PublishPipeline;
  cleanupHandlers: Array<() => void>;
}

/**
 * Active subscription with pipeline
 */
interface ActiveSubscription {
  subscriptionId: number;
  namespace: string[];
  trackName: string;
  pipeline: SubscribePipeline;
  mediaType?: 'video' | 'audio';
}

/**
 * Media Session
 *
 * Wraps MOQTSession with media-specific functionality:
 * - Video/audio encoding pipelines for publishing
 * - Video/audio decoding pipelines for subscribing
 * - MediaConfig-based configuration
 * - Media-specific events (video-frame, audio-data)
 *
 * @example
 * ```typescript
 * import { MediaSession } from '@web-moq/media';
 * import { MOQTransport } from '@web-moq/core';
 *
 * // Create transport and session
 * const transport = new MOQTransport();
 * await transport.connect('https://relay.example.com/moq');
 *
 * const session = new MediaSession(transport);
 * await session.setup();
 *
 * // Subscribe to video
 * session.on('video-frame', ({ subscriptionId, frame }) => {
 *   ctx.drawImage(frame, 0, 0);
 *   frame.close();
 * });
 *
 * const config: MediaConfig = {
 *   videoBitrate: 2_000_000,
 *   audioBitrate: 128000,
 *   videoResolution: '720p',
 * };
 *
 * await session.subscribe(['conference', 'room-1'], 'video', config, 'video');
 *
 * // Publish video
 * const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
 * await session.publish(['conference', 'room-1'], 'video', stream, config);
 * ```
 */
/** Namespace subscription config for auto-creating pipelines */
interface NamespaceSubscriptionConfig {
  subscriptionId: number;
  config: MediaConfig;
}

export class MediaSession {
  /** Underlying generic session */
  private session: MOQTSession;
  /** Active publications by track alias */
  private publications = new Map<string, ActivePublication>();
  /** Active subscriptions by subscription ID */
  private subscriptions = new Map<number, ActiveSubscription>();
  /** Reverse lookup: pipeline to subscription ID for O(1) access */
  private pipelineToSubscriptionId = new Map<SubscribePipeline, number>();
  /** Namespace subscription configs for auto-creating pipelines */
  private namespaceConfigs = new Map<number, NamespaceSubscriptionConfig>();
  /** Event handlers */
  private handlers = new Map<MediaSessionEventType, Set<(data: unknown) => void>>();
  /** Session event cleanup handlers */
  private sessionCleanup: Array<() => void> = [];
  /** Optional worker configuration */
  private workers?: WorkerConfig;
  /** Whether using transport worker mode */
  private useTransportWorker = false;

  /**
   * Create a new MediaSession
   *
   * Supports two modes:
   * - **Main thread mode**: Pass a connected `MOQTransport` instance
   * - **Worker mode**: Pass `MediaSessionOptions` with `workers.transportWorker`
   *
   * @example
   * ```typescript
   * // Main thread mode (transport on main thread)
   * const transport = new MOQTransport();
   * await transport.connect('https://relay.example.com/moq');
   * const session = new MediaSession(transport, { workers: { encodeWorker, decodeWorker } });
   *
   * // Full worker mode (transport + encoding/decoding in workers)
   * const session = new MediaSession({
   *   workers: { transportWorker, encodeWorker, decodeWorker },
   *   serverCertificateHashes: [hash],
   * });
   * await session.connect('https://relay.example.com/moq');
   * ```
   *
   * @param transportOrOptions - Connected MOQTransport instance OR MediaSessionOptions with transportWorker
   * @param options - Optional configuration (only used when first arg is MOQTransport)
   */
  constructor(transportOrOptions: MOQTransport | MediaSessionOptions, options?: MediaSessionOptions) {
    // Determine which mode we're in
    if (transportOrOptions instanceof MOQTransport) {
      // Main thread mode: transport provided directly
      this.session = new MOQTSession(transportOrOptions);
      this.workers = options?.workers;
      this.useTransportWorker = false;
    } else {
      // Worker mode: transport worker provided in options
      const opts = transportOrOptions;
      this.workers = opts.workers;
      this.useTransportWorker = !!opts.workers?.transportWorker;

      if (this.useTransportWorker && opts.workers?.transportWorker) {
        // Create session with worker config
        this.session = new MOQTSession({
          worker: opts.workers.transportWorker,
          serverCertificateHashes: opts.serverCertificateHashes,
        });
      } else {
        throw new Error('MediaSession requires either a MOQTransport or workers.transportWorker');
      }
    }

    this.setupSessionEvents();
    log.debug('MediaSession created', {
      useTransportWorker: this.useTransportWorker,
      hasEncodeWorker: !!this.workers?.encodeWorker,
      hasDecodeWorker: !!this.workers?.decodeWorker,
    });
  }

  /**
   * Connect to a relay server (worker mode only)
   *
   * This method is only needed when using transport worker mode.
   * In main thread mode, the transport should already be connected.
   *
   * @param url - WebTransport URL to connect to
   */
  async connect(url: string): Promise<void> {
    if (!this.useTransportWorker) {
      throw new Error('connect() is only available in worker mode. In main thread mode, connect the transport before creating MediaSession.');
    }
    await this.session.connect(url);
    log.info('Connected via transport worker', { url });
  }

  /**
   * Get current session state
   */
  get state(): SessionState {
    return this.session.state;
  }

  /**
   * Check if session is ready
   */
  get isReady(): boolean {
    return this.session.isReady;
  }

  /**
   * Set up the MOQT session
   *
   * Sends CLIENT_SETUP and waits for SERVER_SETUP
   */
  async setup(): Promise<void> {
    await this.session.setup();
  }

  /**
   * Close the session
   */
  async close(): Promise<void> {
    log.info('Closing media session');

    // Stop all publications
    for (const [trackAlias] of this.publications) {
      await this.unpublish(trackAlias);
    }

    // Stop all subscriptions
    for (const [subscriptionId] of this.subscriptions) {
      await this.unsubscribe(subscriptionId);
    }

    // Clean up session events
    for (const cleanup of this.sessionCleanup) {
      cleanup();
    }
    this.sessionCleanup = [];

    // Close underlying session
    await this.session.close();

    log.info('Media session closed');
  }

  /**
   * Start publishing a track
   *
   * @param namespace - Track namespace
   * @param trackName - Track name
   * @param stream - MediaStream to publish
   * @param config - Media configuration
   * @returns Track alias
   */
  async publish(
    namespace: string[],
    trackName: string,
    stream: MediaStream,
    config: MediaConfig
  ): Promise<bigint> {
    if (!this.isReady) {
      throw new Error('Session not ready');
    }

    const resolution = getResolutionConfig(config.videoResolution);
    const videoEnabled = config.videoEnabled ?? true;
    const audioEnabled = config.audioEnabled ?? true;

    log.info('Creating publish pipeline', {
      videoEnabled,
      audioEnabled,
      resolution: config.videoResolution,
      useEncodeWorker: !!this.workers?.encodeWorker,
    });

    // Create publish pipeline with shared encode worker
    // The worker supports multiplexing via channelId - each pipeline gets its own channel
    const pipeline = new PublishPipeline({
      video: videoEnabled ? {
        width: resolution.width,
        height: resolution.height,
        bitrate: config.videoBitrate,
        framerate: 30,
        keyframeInterval: config.keyframeInterval ?? 1,
      } : undefined,
      audio: audioEnabled ? {
        sampleRate: 48000,
        numberOfChannels: 2,
        bitrate: config.audioBitrate,
      } : undefined,
      encodeWorker: this.workers?.encodeWorker,
    });

    // Build publish options
    const publishOptions: PublishOptions = {
      priority: config.priority ?? 128,
      deliveryTimeout: config.deliveryTimeout ?? 5000,
      deliveryMode: config.deliveryMode ?? 'stream',
    };

    // Publish to the session (get track alias)
    const trackAlias = await this.session.publish(namespace, trackName, publishOptions);

    const cleanupHandlers: Array<() => void> = [];

    // Handle video objects
    const videoCleanup = pipeline.on('video-object', (obj: PublishedObject) => {
      this.session.sendObject(trackAlias, obj.data, {
        groupId: obj.groupId,
        objectId: obj.objectId,
        isKeyframe: obj.isKeyframe,
        type: 'video',
      });
    });
    cleanupHandlers.push(videoCleanup);

    // Handle audio objects
    const audioCleanup = pipeline.on('audio-object', (obj: PublishedObject) => {
      this.session.sendObject(trackAlias, obj.data, {
        groupId: obj.groupId,
        objectId: obj.objectId,
        isKeyframe: obj.isKeyframe,
        type: 'audio',
      });
    });
    cleanupHandlers.push(audioCleanup);

    // Handle pipeline errors
    const errorCleanup = pipeline.on('error', (err: Error) => {
      log.error('Pipeline error', err);
      this.emit('error', err);
    });
    cleanupHandlers.push(errorCleanup);

    // Store publication
    this.publications.set(trackAlias.toString(), {
      trackAlias,
      namespace,
      trackName,
      pipeline,
      cleanupHandlers,
    });

    // Start the pipeline
    await pipeline.start(stream);
    log.info('Publishing started', { trackAlias: trackAlias.toString() });

    return trackAlias;
  }

  /**
   * Stop publishing a track
   *
   * @param trackAlias - Track alias to unpublish
   */
  async unpublish(trackAlias: bigint | string): Promise<void> {
    const key = trackAlias.toString();
    const publication = this.publications.get(key);
    if (!publication) {
      log.warn('No publication found for track alias', { trackAlias: key });
      return;
    }

    log.info('Stopping publish', { trackAlias: key });

    // Stop pipeline
    await publication.pipeline.stop();

    // Clean up handlers
    for (const cleanup of publication.cleanupHandlers) {
      cleanup();
    }

    // Remove from publications
    this.publications.delete(key);

    // Unpublish from session
    await this.session.unpublish(trackAlias);

    log.info('Publishing stopped', { trackAlias: key });
  }

  /**
   * Subscribe to a track
   *
   * @param namespace - Track namespace
   * @param trackName - Track name
   * @param config - Media configuration for decoding
   * @param mediaType - Optional media type ('video' or 'audio') to only create specific decoder
   * @param options - Subscribe options
   * @returns Subscription ID
   */
  async subscribe(
    namespace: string[],
    trackName: string,
    config: MediaConfig,
    mediaType?: 'video' | 'audio',
    options?: MediaSubscribeOptions
  ): Promise<number> {
    if (!this.isReady) {
      throw new Error('Session not ready');
    }

    const resolution = getResolutionConfig(config.videoResolution);

    // Create subscribe pipeline with shared decode worker
    // The worker supports multiplexing via channelId - each pipeline gets its own channel
    const pipeline = new SubscribePipeline({
      mediaType,
      video: mediaType !== 'audio' ? {
        codec: resolution.codec,
        codedWidth: resolution.width,
        codedHeight: resolution.height,
      } : undefined,
      audio: mediaType !== 'video' ? {
        sampleRate: 48000,
        numberOfChannels: 2,
      } : undefined,
      jitterBufferDelay: config.jitterBufferDelay ?? 100,
      decodeWorker: this.workers?.decodeWorker,
      enableStats: config.enableStats,
    });

    log.info('Created subscribe pipeline', {
      mediaType: mediaType ?? 'both',
      hasVideoConfig: mediaType !== 'audio',
      hasAudioConfig: mediaType !== 'video',
      useDecodeWorker: !!this.workers?.decodeWorker,
    });

    // Handle video frames - O(1) lookup using reverse map
    pipeline.on('video-frame', (frame: VideoFrame) => {
      const subscriptionId = this.pipelineToSubscriptionId.get(pipeline);
      if (subscriptionId !== undefined) {
        this.emit('video-frame', { subscriptionId, frame });
      }
    });

    // Handle audio data - O(1) lookup using reverse map
    pipeline.on('audio-data', (audioData: AudioData) => {
      const subscriptionId = this.pipelineToSubscriptionId.get(pipeline);
      if (subscriptionId !== undefined) {
        this.emit('audio-data', { subscriptionId, audioData });
      }
    });

    // Handle jitter samples (only when stats enabled)
    pipeline.on('jitter-sample', (sample: JitterSample) => {
      const subscriptionId = this.pipelineToSubscriptionId.get(pipeline);
      if (subscriptionId !== undefined) {
        this.emit('jitter-sample', { subscriptionId, sample });
      }
    });

    // Handle latency stats (only when stats enabled)
    pipeline.on('latency-stats', (stats: LatencyStatsSample) => {
      const subscriptionId = this.pipelineToSubscriptionId.get(pipeline);
      if (subscriptionId !== undefined) {
        this.emit('latency-stats', { subscriptionId, stats });
      }
    });

    // Handle errors
    pipeline.on('error', (err: Error) => {
      log.error('Subscribe pipeline error', err);
      this.emit('error', err);
    });

    // Start pipeline before subscribing (so it's ready to receive)
    await pipeline.start();

    // Subscribe via session with object callback
    const subscriptionId = await this.session.subscribe(
      namespace,
      trackName,
      options,
      (data, groupId, objectId, timestamp) => {
        pipeline.push(data, groupId, objectId, timestamp);
      }
    );

    // Store subscription and reverse mapping
    this.subscriptions.set(subscriptionId, {
      subscriptionId,
      namespace,
      trackName,
      pipeline,
      mediaType,
    });
    this.pipelineToSubscriptionId.set(pipeline, subscriptionId);

    log.info('Subscription started', { subscriptionId, namespace, trackName });
    return subscriptionId;
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
   */
  async announceNamespace(
    namespace: string[],
    options?: AnnounceOptions
  ): Promise<void> {
    if (!this.isReady) {
      throw new Error('Session not ready');
    }
    await this.session.announceNamespace(namespace, options);
  }

  /**
   * Cancel a namespace announcement
   *
   * @param namespace - Namespace to cancel
   */
  async cancelAnnounce(namespace: string[]): Promise<void> {
    await this.session.cancelAnnounce(namespace);
  }

  /**
   * Get announced namespaces
   */
  getAnnouncedNamespaces(): AnnouncedNamespaceInfo[] {
    return this.session.getAnnouncedNamespaces();
  }

  /**
   * Get subscribers for an announced namespace
   *
   * @param namespace - Namespace to get subscribers for
   */
  getSubscribers(namespace: string[]): IncomingSubscriber[] {
    return this.session.getSubscribers(namespace);
  }

  // =========================================================================
  // Subscribe Namespace (discover tracks from publishers)
  // =========================================================================

  /**
   * Subscribe to a namespace prefix to discover tracks from publishers
   *
   * When tracks are discovered via PUBLISH messages, pipelines are automatically
   * created to decode video/audio if a config is provided.
   *
   * @param namespacePrefix - Namespace prefix to subscribe to
   * @param config - Optional media config for auto-creating decode pipelines
   * @param options - Subscribe options
   * @returns Namespace subscription ID
   */
  async subscribeNamespace(
    namespacePrefix: string[],
    config?: MediaConfig,
    options?: SubscribeNamespaceOptions
  ): Promise<number> {
    const subscriptionId = await this.session.subscribeNamespace(namespacePrefix, options);

    // Store config for auto-creating pipelines when tracks are discovered
    if (config) {
      this.namespaceConfigs.set(subscriptionId, { subscriptionId, config });
      log.info('Stored namespace config for auto-pipeline creation', {
        subscriptionId,
        namespacePrefix: namespacePrefix.join('/'),
      });
    }

    return subscriptionId;
  }

  /**
   * Unsubscribe from a namespace
   *
   * @param subscriptionId - Namespace subscription ID
   */
  async unsubscribeNamespace(subscriptionId: number): Promise<void> {
    this.namespaceConfigs.delete(subscriptionId);
    return this.session.unsubscribeNamespace(subscriptionId);
  }

  /**
   * Set own namespace prefix for filtering out self-publishes
   */
  setOwnNamespacePrefix(prefix: string): void {
    this.session.setOwnNamespacePrefix(prefix);
  }

  /**
   * Get all namespace subscriptions
   */
  getNamespaceSubscriptions(): NamespaceSubscriptionInfo[] {
    return this.session.getNamespaceSubscriptions();
  }

  /**
   * Start publish pipeline for an announced track (when subscriber connects)
   *
   * @param trackAlias - Track alias from incoming-subscribe event
   * @param stream - MediaStream to publish
   * @param config - Media configuration
   */
  async startAnnouncePublish(
    trackAlias: bigint,
    namespace: string[],
    trackName: string,
    stream: MediaStream,
    config: MediaConfig
  ): Promise<void> {
    const resolution = getResolutionConfig(config.videoResolution);
    const videoEnabled = config.videoEnabled ?? true;
    const audioEnabled = config.audioEnabled ?? true;

    log.info('Creating publish pipeline for announced track', {
      trackAlias: trackAlias.toString(),
      videoEnabled,
      audioEnabled,
      resolution: config.videoResolution,
      useEncodeWorker: !!this.workers?.encodeWorker,
    });

    // Create publish pipeline
    const pipeline = new PublishPipeline({
      video: videoEnabled ? {
        width: resolution.width,
        height: resolution.height,
        bitrate: config.videoBitrate,
        framerate: 30,
        keyframeInterval: config.keyframeInterval ?? 1,
      } : undefined,
      audio: audioEnabled ? {
        sampleRate: 48000,
        numberOfChannels: 2,
        bitrate: config.audioBitrate,
      } : undefined,
      encodeWorker: this.workers?.encodeWorker,
    });

    const cleanupHandlers: Array<() => void> = [];

    // Handle video objects
    const videoCleanup = pipeline.on('video-object', (obj: PublishedObject) => {
      this.session.sendObject(trackAlias, obj.data, {
        groupId: obj.groupId,
        objectId: obj.objectId,
        isKeyframe: obj.isKeyframe,
        type: 'video',
      });
    });
    cleanupHandlers.push(videoCleanup);

    // Handle audio objects
    const audioCleanup = pipeline.on('audio-object', (obj: PublishedObject) => {
      this.session.sendObject(trackAlias, obj.data, {
        groupId: obj.groupId,
        objectId: obj.objectId,
        isKeyframe: obj.isKeyframe,
        type: 'audio',
      });
    });
    cleanupHandlers.push(audioCleanup);

    // Handle pipeline errors
    const errorCleanup = pipeline.on('error', (err: Error) => {
      log.error('Pipeline error', err);
      this.emit('error', err);
    });
    cleanupHandlers.push(errorCleanup);

    // Store publication
    this.publications.set(trackAlias.toString(), {
      trackAlias,
      namespace,
      trackName,
      pipeline,
      cleanupHandlers,
    });

    // Start the pipeline
    await pipeline.start(stream);
    log.info('Announce publish started', { trackAlias: trackAlias.toString() });
  }

  // ============================================================================
  // End Announce Flow
  // ============================================================================

  /**
   * Unsubscribe from a track
   *
   * @param subscriptionId - Subscription ID to cancel
   */
  async unsubscribe(subscriptionId: number): Promise<void> {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) {
      log.warn('No subscription found', { subscriptionId });
      return;
    }

    log.info('Unsubscribing', { subscriptionId });

    // Stop pipeline
    await subscription.pipeline.stop();

    // Remove from subscriptions and reverse map
    this.pipelineToSubscriptionId.delete(subscription.pipeline);
    this.subscriptions.delete(subscriptionId);

    // Unsubscribe from session
    await this.session.unsubscribe(subscriptionId);

    log.info('Unsubscribed', { subscriptionId });
  }

  /**
   * Pause a subscription
   */
  async pauseSubscription(subscriptionId: number): Promise<void> {
    await this.session.pauseSubscription(subscriptionId);
  }

  /**
   * Resume a subscription
   */
  async resumeSubscription(subscriptionId: number): Promise<void> {
    await this.session.resumeSubscription(subscriptionId);
  }

  /**
   * Check if a subscription is paused
   */
  isSubscriptionPaused(subscriptionId: number): boolean {
    return this.session.isSubscriptionPaused(subscriptionId);
  }

  /**
   * Register an event handler
   */
  on(event: 'state-change', handler: (state: SessionState) => void): () => void;
  on(event: 'video-frame', handler: (data: { subscriptionId: number; frame: VideoFrame }) => void): () => void;
  on(event: 'audio-data', handler: (data: { subscriptionId: number; audioData: AudioData }) => void): () => void;
  on(event: 'jitter-sample', handler: (data: { subscriptionId: number; sample: JitterSample }) => void): () => void;
  on(event: 'latency-stats', handler: (data: { subscriptionId: number; stats: LatencyStatsSample }) => void): () => void;
  on(event: 'error', handler: (err: Error) => void): () => void;
  on(event: 'publish-stats', handler: (stats: { trackAlias: string; type: string; groupId: number; objectId: number; bytes: number }) => void): () => void;
  on(event: 'subscribe-stats', handler: (stats: { subscriptionId: number; groupId: number; objectId: number; bytes: number }) => void): () => void;
  on(event: 'incoming-subscribe', handler: (event: IncomingSubscribeEvent) => void): () => void;
  on(event: 'incoming-publish', handler: (event: IncomingPublishEvent) => void): () => void;
  on(event: 'namespace-acknowledged', handler: (data: { namespace: string[] }) => void): () => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: MediaSessionEventType, handler: (data: any) => void): () => void {
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
   * Set up session event forwarding
   */
  private setupSessionEvents(): void {
    // Forward state changes
    const stateCleanup = this.session.on('state-change', (state: SessionState) => {
      this.emit('state-change', state);
    });
    this.sessionCleanup.push(stateCleanup);

    // Forward errors
    const errorCleanup = this.session.on('error', (err: Error) => {
      this.emit('error', err);
    });
    this.sessionCleanup.push(errorCleanup);

    // Forward publish stats
    const publishStatsCleanup = this.session.on('publish-stats', (stats) => {
      this.emit('publish-stats', stats);
    });
    this.sessionCleanup.push(publishStatsCleanup);

    // Forward subscribe stats
    const subscribeStatsCleanup = this.session.on('subscribe-stats', (stats) => {
      this.emit('subscribe-stats', stats);
    });
    this.sessionCleanup.push(subscribeStatsCleanup);

    // Forward incoming-subscribe events (announce flow)
    const incomingSubscribeCleanup = this.session.on('incoming-subscribe', (event) => {
      this.emit('incoming-subscribe', event);
    });
    this.sessionCleanup.push(incomingSubscribeCleanup);

    // Forward namespace-acknowledged events (announce flow)
    const namespaceAckCleanup = this.session.on('namespace-acknowledged', (data) => {
      this.emit('namespace-acknowledged', data);
    });
    this.sessionCleanup.push(namespaceAckCleanup);

    // Handle incoming-publish events to auto-create decode pipelines
    const incomingPublishCleanup = this.session.on('incoming-publish', (event: IncomingPublishEvent) => {
      this.handleIncomingPublish(event).catch((err) => {
        log.error('Failed to handle incoming publish', err as Error);
      });
      // Forward the event to app
      this.emit('incoming-publish', event);
    });
    this.sessionCleanup.push(incomingPublishCleanup);
  }

  /**
   * Handle incoming PUBLISH by creating a decode pipeline if config is available
   */
  private async handleIncomingPublish(event: IncomingPublishEvent): Promise<void> {
    const nsConfig = this.namespaceConfigs.get(event.namespaceSubscriptionId);
    if (!nsConfig) {
      log.debug('No config for namespace subscription, skipping pipeline creation', {
        namespaceSubscriptionId: event.namespaceSubscriptionId,
      });
      return;
    }

    // Determine media type from track name
    const trackNameLower = event.trackName.toLowerCase();
    let mediaType: 'video' | 'audio' | undefined;
    if (trackNameLower.includes('video')) {
      mediaType = 'video';
    } else if (trackNameLower.includes('audio')) {
      mediaType = 'audio';
    } else {
      log.debug('Unknown media type for track, skipping pipeline', { trackName: event.trackName });
      return;
    }

    const config = nsConfig.config;
    const resolution = getResolutionConfig(config.videoResolution);

    // Create decode pipeline
    const pipeline = new SubscribePipeline({
      mediaType,
      video: mediaType === 'video' ? {
        codec: resolution.codec,
        codedWidth: resolution.width,
        codedHeight: resolution.height,
      } : undefined,
      audio: mediaType === 'audio' ? {
        sampleRate: 48000,
        numberOfChannels: 2,
      } : undefined,
      jitterBufferDelay: config.jitterBufferDelay ?? 100,
      decodeWorker: this.workers?.decodeWorker,
      enableStats: config.enableStats,
    });

    log.info('Created decode pipeline for discovered track', {
      namespaceSubscriptionId: event.namespaceSubscriptionId,
      trackName: event.trackName,
      mediaType,
    });

    // Find the subscription created for this track and attach the pipeline
    // The subscription was created in session.handleIncomingPublish with trackAlias
    const subscriptions = this.session.getSubscriptions();
    const trackSub = subscriptions.find(s =>
      s.trackAlias === event.trackAlias
    );

    if (!trackSub) {
      log.warn('Could not find subscription for incoming publish', {
        trackAlias: event.trackAlias.toString(),
      });
      return;
    }

    // Set up event handlers
    pipeline.on('video-frame', (frame: VideoFrame) => {
      this.emit('video-frame', { subscriptionId: trackSub.subscriptionId, frame });
    });

    pipeline.on('audio-data', (audioData: AudioData) => {
      this.emit('audio-data', { subscriptionId: trackSub.subscriptionId, audioData });
    });

    pipeline.on('jitter-sample', (sample: JitterSample) => {
      this.emit('jitter-sample', { subscriptionId: trackSub.subscriptionId, sample });
    });

    pipeline.on('latency-stats', (stats: LatencyStatsSample) => {
      this.emit('latency-stats', { subscriptionId: trackSub.subscriptionId, stats });
    });

    pipeline.on('error', (err: Error) => {
      log.error('Subscribe pipeline error', err);
      this.emit('error', err);
    });

    // Start pipeline
    await pipeline.start();

    // Store subscription with pipeline
    this.subscriptions.set(trackSub.subscriptionId, {
      subscriptionId: trackSub.subscriptionId,
      namespace: event.namespace,
      trackName: event.trackName,
      pipeline,
      mediaType,
    });
    this.pipelineToSubscriptionId.set(pipeline, trackSub.subscriptionId);

    // Update the subscription's onObject callback to push to pipeline
    this.session.setSubscriptionCallback(trackSub.subscriptionId, (data, groupId, objectId, timestamp) => {
      pipeline.push(data, groupId, objectId, timestamp);
    });

    log.info('Pipeline attached to discovered track', {
      subscriptionId: trackSub.subscriptionId,
      trackName: event.trackName,
      mediaType,
    });
  }

  /**
   * Emit an event
   */
  private emit(event: MediaSessionEventType, data: unknown): void {
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
