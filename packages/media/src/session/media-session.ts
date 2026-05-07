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
  type IncomingFetchEvent,
  type SubscribeNamespaceOptions,
  type NamespaceSubscriptionInfo,
  type FetchCompleteEvent,
  type FetchErrorEvent,
  type VODPublishOptions,
  type ForwardStateChangeEvent,
} from '@web-moq/session';
import {
  SecureObjectsContext,
  CipherSuite,
  type TrackIdentifier,
} from '@web-moq/secure-objects';
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
  /**
   * Connection timeout in milliseconds (default: 300000 = 5 minutes).
   */
  connectionTimeout?: number;
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
  /** Secure Objects context for encryption (if enabled) */
  secureContext?: SecureObjectsContext;
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
  /** Secure Objects context for decryption (if enabled) */
  secureContext?: SecureObjectsContext;
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
          connectionTimeout: opts.connectionTimeout,
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
   * Get the underlying MOQT session for advanced operations
   */
  getMOQTSession(): MOQTSession {
    return this.session;
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
   * Create a SecureObjectsContext from MediaConfig if encryption is enabled
   *
   * @param config - Media configuration
   * @param track - Track identifier (namespace + trackName)
   * @returns SecureObjectsContext or undefined if encryption is disabled
   */
  private async createSecureContext(
    config: MediaConfig,
    track: TrackIdentifier
  ): Promise<SecureObjectsContext | undefined> {
    if (!config.secureObjectsEnabled || !config.secureObjectsBaseKey) {
      return undefined;
    }

    // Parse cipher suite from hex string (e.g., "0x0004" -> 4)
    const cipherSuiteValue = parseInt(config.secureObjectsCipherSuite || '0x0004', 16);
    const cipherSuite = cipherSuiteValue as CipherSuite;

    // Parse base key from hex string
    const baseKeyHex = config.secureObjectsBaseKey.replace(/^0x/i, '');
    const baseKey = new Uint8Array(baseKeyHex.length / 2);
    for (let i = 0; i < baseKey.length; i++) {
      baseKey[i] = parseInt(baseKeyHex.substring(i * 2, i * 2 + 2), 16);
    }

    log.info('Creating SecureObjectsContext', {
      track: `${track.namespace.join('/')}/${track.trackName}`,
      cipherSuite: `0x${cipherSuiteValue.toString(16).padStart(4, '0')}`,
      keyLength: baseKey.length,
    });

    return SecureObjectsContext.create({
      trackBaseKey: baseKey,
      track,
      cipherSuite,
    });
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

    // Check what tracks the stream actually has
    const hasVideoTracks = stream.getVideoTracks().length > 0;
    const hasAudioTracks = stream.getAudioTracks().length > 0;

    // Only enable video/audio if both config allows AND stream has those tracks
    const videoEnabled = (config.videoEnabled ?? true) && hasVideoTracks;
    const audioEnabled = (config.audioEnabled ?? true) && hasAudioTracks;

    log.info('Creating publish pipeline', {
      videoEnabled,
      audioEnabled,
      hasVideoTracks,
      hasAudioTracks,
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
      // QuicR-Mac interop settings
      quicrInteropEnabled: config.quicrInteropEnabled,
      quicrParticipantId: config.quicrParticipantId,
    });

    // Build publish options
    const publishOptions: PublishOptions = {
      priority: config.priority ?? 128,
      deliveryTimeout: config.deliveryTimeout ?? 5000,
      deliveryMode: config.deliveryMode ?? 'stream',
      audioDeliveryMode: config.audioDeliveryMode ?? 'datagram',
    };

    // Publish to the session (get track alias)
    const trackAlias = await this.session.publish(namespace, trackName, publishOptions);

    // Create secure context if encryption is enabled
    const secureContext = await this.createSecureContext(config, { namespace, trackName });

    const cleanupHandlers: Array<() => void> = [];

    // Handle video objects (with optional encryption)
    const videoCleanup = pipeline.on('video-object', (obj: PublishedObject) => {
      if (secureContext) {
        // Encrypt before sending
        secureContext.encrypt(obj.data, {
          groupId: BigInt(obj.groupId),
          objectId: obj.objectId,
        }).then(({ ciphertext }) => {
          this.session.sendObject(trackAlias, ciphertext, {
            groupId: obj.groupId,
            objectId: obj.objectId,
            isKeyframe: obj.isKeyframe,
            type: 'video',
          });
        }).catch((err) => {
          log.error('Encryption failed for video object', err as Error);
        });
      } else {
        this.session.sendObject(trackAlias, obj.data, {
          groupId: obj.groupId,
          objectId: obj.objectId,
          isKeyframe: obj.isKeyframe,
          type: 'video',
        });
      }
    });
    cleanupHandlers.push(videoCleanup);

    // Handle audio objects (with optional encryption)
    const audioCleanup = pipeline.on('audio-object', (obj: PublishedObject) => {
      if (secureContext) {
        // Encrypt before sending
        secureContext.encrypt(obj.data, {
          groupId: BigInt(obj.groupId),
          objectId: obj.objectId,
        }).then(({ ciphertext }) => {
          this.session.sendObject(trackAlias, ciphertext, {
            groupId: obj.groupId,
            objectId: obj.objectId,
            isKeyframe: obj.isKeyframe,
            type: 'audio',
          });
        }).catch((err) => {
          log.error('Encryption failed for audio object', err as Error);
        });
      } else {
        this.session.sendObject(trackAlias, obj.data, {
          groupId: obj.groupId,
          objectId: obj.objectId,
          isKeyframe: obj.isKeyframe,
          type: 'audio',
        });
      }
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
      secureContext,
    });

    // Start the pipeline
    await pipeline.start(stream);
    log.info('Publishing started', { trackAlias: trackAlias.toString(), encrypted: !!secureContext });

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
   * Publish VOD content for DVR/rewind playback
   *
   * VOD content is served via FETCH requests rather than continuous streaming.
   * The content provider supplies a getObject callback to serve individual objects.
   *
   * @param namespace - Track namespace
   * @param trackName - Track name
   * @param options - VOD publish options including metadata and object callback
   * @returns Track alias
   *
   * @example
   * ```typescript
   * // Using with VODLoader
   * const loader = new VODLoader({ framerate: 30 });
   * await loader.load('https://example.com/video.mp4');
   *
   * const trackAlias = await session.publishVOD(
   *   ['vod', 'my-video'],
   *   'video',
   *   {
   *     ...loader.getPublishOptions(),
   *     priority: 128,
   *     deliveryTimeout: 5000,
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

    log.info('Publishing VOD content', {
      namespace: namespace.join('/'),
      trackName,
      duration: options.metadata.duration,
      totalGroups: options.metadata.totalGroups,
    });

    // Delegate to underlying session's publishVOD
    return this.session.publishVOD(namespace, trackName, options);
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

    // Use explicit video decoder config if provided (e.g., from catalog track info)
    // Otherwise fall back to resolution preset
    const videoDecoderConfig = config.videoDecoderConfig && (config.videoDecoderConfig.codec || config.videoDecoderConfig.codedWidth) ? {
      codec: config.videoDecoderConfig.codec ?? resolution.codec,
      codedWidth: config.videoDecoderConfig.codedWidth ?? resolution.width,
      codedHeight: config.videoDecoderConfig.codedHeight ?? resolution.height,
    } : {
      codec: resolution.codec,
      codedWidth: resolution.width,
      codedHeight: resolution.height,
    };

    log.info('Video decoder config', {
      fromCatalog: !!(config.videoDecoderConfig?.codec || config.videoDecoderConfig?.codedWidth),
      codec: videoDecoderConfig.codec,
      width: videoDecoderConfig.codedWidth,
      height: videoDecoderConfig.codedHeight,
    });

    // Build audio decoder config - use explicit config if provided (e.g., AAC from VOD),
    // otherwise default to Opus
    const audioDecoderConfig = config.audioDecoderConfig && config.audioDecoderConfig.codec ? {
      codec: config.audioDecoderConfig.codec,
      sampleRate: config.audioDecoderConfig.sampleRate ?? 48000,
      numberOfChannels: config.audioDecoderConfig.numberOfChannels ?? 2,
      description: config.audioDecoderConfig.description,
    } : {
      codec: 'opus',
      sampleRate: 48000,
      numberOfChannels: 2,
    };

    if (config.audioDecoderConfig?.codec) {
      log.info('Audio decoder config (from catalog)', {
        codec: audioDecoderConfig.codec,
        sampleRate: audioDecoderConfig.sampleRate,
        numberOfChannels: audioDecoderConfig.numberOfChannels,
        hasDescription: !!audioDecoderConfig.description,
      });
    }

    // Create subscribe pipeline with shared decode worker
    // The worker supports multiplexing via channelId - each pipeline gets its own channel
    const pipeline = new SubscribePipeline({
      mediaType,
      video: mediaType !== 'audio' ? videoDecoderConfig : undefined,
      audio: mediaType !== 'video' ? audioDecoderConfig : undefined,
      jitterBufferDelay: config.jitterBufferDelay ?? 100,
      decodeWorker: this.workers?.decodeWorker,
      enableStats: config.enableStats,
      // GroupArbiter options for parallel QUIC stream handling
      useGroupArbiter: config.useGroupArbiter,
      // New PlayoutBuffer architecture options
      policyType: config.policyType,
      isLive: config.isLive,
      maxLatency: config.maxLatency,
      estimatedGopDuration: config.estimatedGopDuration,
      catalogFramerate: config.catalogFramerate,
      catalogTimescale: config.catalogTimescale,
      // QuicR-Mac interop mode
      quicrInteropEnabled: config.quicrInteropEnabled,
      minBufferFrames: config.minBufferFrames,
    });

    log.info('Created subscribe pipeline', {
      mediaType: mediaType ?? 'both',
      hasVideoConfig: mediaType !== 'audio',
      hasAudioConfig: mediaType !== 'video',
      useDecodeWorker: !!this.workers?.decodeWorker,
      useGroupArbiter: config.useGroupArbiter,
      policyType: config.policyType,
      isLive: config.isLive,
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

    // Create secure context if encryption is enabled
    const secureContext = await this.createSecureContext(config, { namespace, trackName });

    // Merge filterType from config and options (options take precedence)
    // Default to 'absolute' for VOD, 'latest' for live
    const effectiveFilterType = options?.filterType ?? config.filterType ?? (config.policyType === 'vod' ? 'absolute' : 'latest');
    const mergedOptions = {
      ...options,
      filterType: effectiveFilterType,
      startGroup: options?.startGroup ?? config.startGroup ?? 0,
    };

    // Subscribe via session with object callback and end-of-group handler
    const subscriptionId = await this.session.subscribe(
      namespace,
      trackName,
      mergedOptions,
      (data, groupId, objectId, timestamp) => {
        log.info('MediaSession onObject callback invoked', {
          namespace: namespace.join('/'),
          trackName,
          groupId,
          objectId,
          dataSize: data.length,
          hasSecureContext: !!secureContext,
        });
        if (secureContext) {
          // Decrypt before pushing to pipeline
          secureContext.decrypt(data, {
            groupId: BigInt(groupId),
            objectId,
          }).then(({ plaintext }) => {
            pipeline.push(plaintext, groupId, objectId, timestamp);
          }).catch((err) => {
            log.error('Decryption failed', { groupId, objectId, error: (err as Error).message });
          });
        } else {
          pipeline.push(data, groupId, objectId, timestamp);
        }
      },
      (groupId) => {
        pipeline.markGroupComplete(groupId);
      }
    );

    // Store subscription and reverse mapping
    this.subscriptions.set(subscriptionId, {
      subscriptionId,
      namespace,
      trackName,
      pipeline,
      mediaType,
      secureContext,
    });
    this.pipelineToSubscriptionId.set(pipeline, subscriptionId);

    log.info('Subscription started', { subscriptionId, namespace, trackName, encrypted: !!secureContext });
    return subscriptionId;
  }

  /**
   * Create a VOD playback pipeline without subscribing
   *
   * This sets up the decode pipeline for VOD content that will be fetched
   * using FETCH requests rather than SUBSCRIBE. Use this with VodFetchController
   * for adaptive buffer-aware VOD playback.
   *
   * @param namespace - Track namespace
   * @param trackName - Track name
   * @param config - Media configuration
   * @param mediaType - Media type ('video' or 'audio')
   * @returns Object with subscriptionId and pushData function
   *
   * @example
   * ```typescript
   * const { subscriptionId, pushData, markGroupComplete } = await session.createVodPipeline(
   *   ['vod', 'video'],
   *   'video',
   *   config,
   *   'video'
   * );
   *
   * // Use with VodFetchController
   * controller.on('fetch-request', async ({ startGroup, endGroup }) => {
   *   await session.getMOQTSession().fetch(namespace, trackName, {
   *     startGroup, startObject: 0, endGroup, endObject: 0
   *   }, {}, (data, groupId, objectId) => {
   *     pushData(data, groupId, objectId, Date.now() * 1000);
   *   });
   * });
   * ```
   */
  async createVodPipeline(
    namespace: string[],
    trackName: string,
    config: MediaConfig,
    mediaType?: 'video' | 'audio'
  ): Promise<{
    subscriptionId: number;
    pushData: (data: Uint8Array, groupId: number, objectId: number, timestamp: number) => void;
    markGroupComplete: (groupId: number) => void;
    skipGroup: (groupId: number) => void;
  }> {
    if (!this.isReady) {
      throw new Error('Session not ready');
    }

    const resolution = getResolutionConfig(config.videoResolution);

    // Use explicit video decoder config if provided (e.g., from catalog track info)
    const videoDecoderConfig = config.videoDecoderConfig && (config.videoDecoderConfig.codec || config.videoDecoderConfig.codedWidth) ? {
      codec: config.videoDecoderConfig.codec ?? resolution.codec,
      codedWidth: config.videoDecoderConfig.codedWidth ?? resolution.width,
      codedHeight: config.videoDecoderConfig.codedHeight ?? resolution.height,
    } : {
      codec: resolution.codec,
      codedWidth: resolution.width,
      codedHeight: resolution.height,
    };

    // Build audio decoder config - use explicit config if provided (e.g., AAC from VOD)
    const audioDecoderConfig = config.audioDecoderConfig && config.audioDecoderConfig.codec ? {
      codec: config.audioDecoderConfig.codec,
      sampleRate: config.audioDecoderConfig.sampleRate ?? 48000,
      numberOfChannels: config.audioDecoderConfig.numberOfChannels ?? 2,
      description: config.audioDecoderConfig.description,
    } : {
      codec: 'opus',
      sampleRate: 48000,
      numberOfChannels: 2,
    };

    log.info('Creating VOD pipeline (FETCH-only)', {
      namespace: namespace.join('/'),
      trackName,
      videoCodec: videoDecoderConfig.codec,
      width: videoDecoderConfig.codedWidth,
      height: videoDecoderConfig.codedHeight,
      audioCodec: audioDecoderConfig.codec,
      hasAudioDescription: !!audioDecoderConfig.description,
    });

    // Create subscribe pipeline for decoding
    const pipeline = new SubscribePipeline({
      mediaType,
      video: mediaType !== 'audio' ? videoDecoderConfig : undefined,
      audio: mediaType !== 'video' ? audioDecoderConfig : undefined,
      jitterBufferDelay: config.jitterBufferDelay ?? 100,
      decodeWorker: this.workers?.decodeWorker,
      enableStats: config.enableStats,
      // VOD-specific settings
      policyType: 'vod',
      isLive: false,
      maxLatency: config.maxLatency,
      estimatedGopDuration: config.estimatedGopDuration,
      catalogFramerate: config.catalogFramerate,
      catalogTimescale: config.catalogTimescale,
      minBufferFrames: config.minBufferFrames,
    });

    // Generate a unique subscription ID for this VOD pipeline
    const subscriptionId = Date.now() + Math.floor(Math.random() * 1000);

    // Set up reverse mapping for event emission
    this.pipelineToSubscriptionId.set(pipeline, subscriptionId);

    // Handle video frames
    pipeline.on('video-frame', (frame: VideoFrame) => {
      const subId = this.pipelineToSubscriptionId.get(pipeline);
      if (subId !== undefined) {
        this.emit('video-frame', { subscriptionId: subId, frame });
      }
    });

    // Handle audio data
    pipeline.on('audio-data', (audioData: AudioData) => {
      const subId = this.pipelineToSubscriptionId.get(pipeline);
      if (subId !== undefined) {
        this.emit('audio-data', { subscriptionId: subId, audioData });
      }
    });

    // Handle jitter samples
    pipeline.on('jitter-sample', (sample: JitterSample) => {
      const subId = this.pipelineToSubscriptionId.get(pipeline);
      if (subId !== undefined) {
        this.emit('jitter-sample', { subscriptionId: subId, sample });
      }
    });

    // Handle latency stats
    pipeline.on('latency-stats', (stats: LatencyStatsSample) => {
      const subId = this.pipelineToSubscriptionId.get(pipeline);
      if (subId !== undefined) {
        this.emit('latency-stats', { subscriptionId: subId, stats });
      }
    });

    // Handle errors
    pipeline.on('error', (err: Error) => {
      log.error('VOD pipeline error', err);
      this.emit('error', err);
    });

    // Start pipeline (ready to receive data)
    await pipeline.start();

    // Create secure context if encryption is enabled
    const secureContext = await this.createSecureContext(config, { namespace, trackName });

    // Store subscription (without actual MOQT subscription)
    this.subscriptions.set(subscriptionId, {
      subscriptionId,
      namespace,
      trackName,
      pipeline,
      mediaType,
      secureContext,
    });

    log.info('VOD pipeline created', { subscriptionId, namespace, trackName });

    // Return functions to push data and mark groups complete
    return {
      subscriptionId,
      pushData: (data: Uint8Array, groupId: number, objectId: number, timestamp: number) => {
        if (secureContext) {
          secureContext.decrypt(data, {
            groupId: BigInt(groupId),
            objectId,
          }).then(({ plaintext }) => {
            pipeline.push(plaintext, groupId, objectId, timestamp);
          }).catch((err) => {
            log.error('VOD decryption failed', { groupId, objectId, error: (err as Error).message });
          });
        } else {
          pipeline.push(data, groupId, objectId, timestamp);
        }
      },
      markGroupComplete: (groupId: number) => {
        pipeline.markGroupComplete(groupId);
      },
      skipGroup: (groupId: number) => {
        pipeline.skipGroup(groupId);
      },
    };
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

    // Check what tracks the stream actually has
    const hasVideoTracks = stream.getVideoTracks().length > 0;
    const hasAudioTracks = stream.getAudioTracks().length > 0;

    // Only enable video/audio if both config allows AND stream has those tracks
    const videoEnabled = (config.videoEnabled ?? true) && hasVideoTracks;
    const audioEnabled = (config.audioEnabled ?? true) && hasAudioTracks;

    log.info('Creating publish pipeline for announced track', {
      trackAlias: trackAlias.toString(),
      videoEnabled,
      audioEnabled,
      hasVideoTracks,
      hasAudioTracks,
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
      // QuicR-Mac interop settings
      quicrInteropEnabled: config.quicrInteropEnabled,
      quicrParticipantId: config.quicrParticipantId,
    });

    // Create secure context if encryption is enabled
    const secureContext = await this.createSecureContext(config, { namespace, trackName });

    const cleanupHandlers: Array<() => void> = [];

    // Handle video objects (with optional encryption)
    const videoCleanup = pipeline.on('video-object', (obj: PublishedObject) => {
      if (secureContext) {
        secureContext.encrypt(obj.data, {
          groupId: BigInt(obj.groupId),
          objectId: obj.objectId,
        }).then(({ ciphertext }) => {
          this.session.sendObject(trackAlias, ciphertext, {
            groupId: obj.groupId,
            objectId: obj.objectId,
            isKeyframe: obj.isKeyframe,
            type: 'video',
          });
        }).catch((err) => {
          log.error('Encryption failed for video object', err as Error);
        });
      } else {
        this.session.sendObject(trackAlias, obj.data, {
          groupId: obj.groupId,
          objectId: obj.objectId,
          isKeyframe: obj.isKeyframe,
          type: 'video',
        });
      }
    });
    cleanupHandlers.push(videoCleanup);

    // Handle audio objects (with optional encryption)
    const audioCleanup = pipeline.on('audio-object', (obj: PublishedObject) => {
      if (secureContext) {
        secureContext.encrypt(obj.data, {
          groupId: BigInt(obj.groupId),
          objectId: obj.objectId,
        }).then(({ ciphertext }) => {
          this.session.sendObject(trackAlias, ciphertext, {
            groupId: obj.groupId,
            objectId: obj.objectId,
            isKeyframe: obj.isKeyframe,
            type: 'audio',
          });
        }).catch((err) => {
          log.error('Encryption failed for audio object', err as Error);
        });
      } else {
        this.session.sendObject(trackAlias, obj.data, {
          groupId: obj.groupId,
          objectId: obj.objectId,
          isKeyframe: obj.isKeyframe,
          type: 'audio',
        });
      }
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
      secureContext,
    });

    // Start the pipeline
    await pipeline.start(stream);
    log.info('Announce publish started', { trackAlias: trackAlias.toString(), encrypted: !!secureContext });
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
   * Stops frame output and sends forward=0 to relay (for live content)
   */
  async pauseSubscription(subscriptionId: number): Promise<void> {
    // Pause the decode pipeline to stop frame output immediately
    const subscription = this.subscriptions.get(subscriptionId);
    if (subscription?.pipeline) {
      subscription.pipeline.pause();
    }

    // Send SUBSCRIBE_UPDATE with forward=0 (stops data from relay for live)
    await this.session.pauseSubscription(subscriptionId);
  }

  /**
   * Resume a subscription
   * Resumes frame output and sends forward=1 to relay (for live content)
   */
  async resumeSubscription(subscriptionId: number): Promise<void> {
    // Send SUBSCRIBE_UPDATE with forward=1 first (resumes data from relay)
    await this.session.resumeSubscription(subscriptionId);

    // Resume the decode pipeline to allow frame output
    const subscription = this.subscriptions.get(subscriptionId);
    if (subscription?.pipeline) {
      subscription.pipeline.resume();
    }
  }

  /**
   * Check if a subscription is paused
   */
  isSubscriptionPaused(subscriptionId: number): boolean {
    return this.session.isSubscriptionPaused(subscriptionId);
  }

  // ============================================================================
  // DVR / Seek Support
  // ============================================================================

  /**
   * Seek to a specific time position in a subscription (DVR/Rewind)
   *
   * This uses FETCH to request historical content from the specified time.
   * The subscription pipeline will buffer and decode the fetched content.
   *
   * @param subscriptionId - Active subscription to seek
   * @param timeMs - Target time in milliseconds from start
   * @param durationMs - Duration to fetch in milliseconds (optional, default 5000ms)
   * @returns Fetch request ID
   *
   * @example
   * ```typescript
   * // Seek to 30 seconds into the video
   * await session.seek(subscriptionId, 30000);
   *
   * // Seek to 1 minute and fetch 10 seconds of content
   * await session.seek(subscriptionId, 60000, 10000);
   * ```
   */
  async seek(
    subscriptionId: number,
    timeMs: number,
    durationMs = 5000
  ): Promise<number> {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) {
      throw new Error(`Subscription ${subscriptionId} not found`);
    }

    // Calculate group range from time
    // Assume 1 second per group by default (can be configured via track metadata)
    const gopDuration = 1000; // TODO: Get from track metadata
    const startGroup = Math.floor(timeMs / gopDuration);
    const endGroup = Math.floor((timeMs + durationMs) / gopDuration);

    log.info('Seeking subscription', {
      subscriptionId,
      timeMs,
      durationMs,
      startGroup,
      endGroup,
    });

    // Use FETCH to request the range
    const fetchId = await this.session.fetch(
      subscription.namespace,
      subscription.trackName,
      {
        startGroup,
        startObject: 0,
        endGroup,
        endObject: 0, // 0 = all objects in group
      },
      {},
      (data, groupId, objectId) => {
        // Push fetched data into the subscription pipeline for decoding
        // Use current time as timestamp since we're seeking
        subscription.pipeline.push(data, groupId, objectId, Date.now() * 1000);
      }
    );

    log.info('Seek fetch started', {
      subscriptionId,
      fetchId,
      startGroup,
      endGroup,
    });

    return fetchId;
  }

  /**
   * Fetch a specific range of content from a track
   *
   * Lower-level method for DVR - fetches specific groups/objects.
   * Use `seek()` for time-based seeking.
   *
   * @param namespace - Track namespace
   * @param trackName - Track name
   * @param startGroup - Start group ID
   * @param endGroup - End group ID
   * @param config - Media configuration for decoding
   * @param mediaType - Optional media type for decoder
   * @returns Fetch request ID
   */
  async fetchRange(
    namespace: string[],
    trackName: string,
    startGroup: number,
    endGroup: number,
    config: MediaConfig,
    mediaType?: 'video' | 'audio'
  ): Promise<number> {
    if (!this.isReady) {
      throw new Error('Session not ready');
    }

    log.info('Fetching range', {
      namespace: namespace.join('/'),
      trackName,
      startGroup,
      endGroup,
      mediaType,
    });

    // Create a temporary pipeline for decoding fetched content
    const resolution = getResolutionConfig(config.videoResolution);
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
      useGroupArbiter: config.useGroupArbiter,
      policyType: config.policyType,
      isLive: config.isLive,
      maxLatency: config.maxLatency,
      estimatedGopDuration: config.estimatedGopDuration,
    });

    // Track the fetch pipeline separately
    const fetchId = Date.now(); // Temporary ID for tracking

    // Forward events from pipeline
    pipeline.on('video-frame', (frame: VideoFrame) => {
      this.emit('video-frame', { subscriptionId: -fetchId, frame });
    });

    pipeline.on('audio-data', (audioData: AudioData) => {
      this.emit('audio-data', { subscriptionId: -fetchId, audioData });
    });

    pipeline.on('error', (err: Error) => {
      log.error('Fetch pipeline error', err);
      this.emit('error', err);
    });

    // Start the fetch
    const actualFetchId = await this.session.fetch(
      namespace,
      trackName,
      {
        startGroup,
        startObject: 0,
        endGroup,
        endObject: 0,
      },
      {},
      (data, groupId, objectId) => {
        pipeline.push(data, groupId, objectId, Date.now() * 1000);
      }
    );

    log.info('Range fetch started', {
      fetchId: actualFetchId,
      startGroup,
      endGroup,
    });

    return actualFetchId;
  }

  /**
   * Cancel an in-progress fetch/seek operation
   *
   * @param fetchId - Fetch request ID to cancel
   */
  async cancelFetch(fetchId: number): Promise<void> {
    await this.session.cancelFetch(fetchId);
  }

  /**
   * Get track info for DVR (available range, duration, etc.)
   *
   * This information comes from FETCH_OK responses or track metadata.
   *
   * @param subscriptionId - Subscription to get info for
   * @returns Track DVR info or undefined if not available
   */
  getTrackDVRInfo(subscriptionId: number): {
    largestGroupId?: number;
    largestObjectId?: number;
    estimatedDuration?: number;
  } | undefined {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) {
      return undefined;
    }

    // Get info from any completed fetches
    const fetches = this.session.getActiveFetches();
    const completedFetch = fetches.find(f =>
      f.namespace.join('/') === subscription.namespace.join('/') &&
      f.trackName === subscription.trackName &&
      f.completed
    );

    if (completedFetch) {
      return {
        largestGroupId: completedFetch.largestGroupId,
        largestObjectId: completedFetch.largestObjectId,
        // Estimate duration assuming 1 second per group
        estimatedDuration: completedFetch.largestGroupId !== undefined
          ? (completedFetch.largestGroupId + 1) * 1000
          : undefined,
      };
    }

    return undefined;
  }

  // ============================================================================
  // End DVR Support
  // ============================================================================

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
  on(event: 'incoming-fetch', handler: (event: IncomingFetchEvent) => void): () => void;
  on(event: 'namespace-acknowledged', handler: (data: { namespace: string[] }) => void): () => void;
  // DVR/FETCH events
  on(event: 'fetch-complete', handler: (event: FetchCompleteEvent) => void): () => void;
  on(event: 'fetch-error', handler: (event: FetchErrorEvent) => void): () => void;
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

    // Forward FETCH/DVR events
    const incomingFetchCleanup = this.session.on('incoming-fetch', (event) => {
      this.emit('incoming-fetch', event);
    });
    this.sessionCleanup.push(incomingFetchCleanup);

    const fetchCompleteCleanup = this.session.on('fetch-complete', (event: FetchCompleteEvent) => {
      this.emit('fetch-complete', event);
    });
    this.sessionCleanup.push(fetchCompleteCleanup);

    const fetchErrorCleanup = this.session.on('fetch-error', (event: FetchErrorEvent) => {
      this.emit('fetch-error', event);
    });
    this.sessionCleanup.push(fetchErrorCleanup);

    // Handle forward state changes for live/interactive publish pipelines
    const forwardStateCleanup = this.session.on('forward-state-change', (event: ForwardStateChangeEvent) => {
      const key = event.trackAlias.toString();
      const publication = this.publications.get(key);
      if (publication) {
        if (event.forward === 0) {
          log.info('Forward=0, pausing publish pipeline', { trackAlias: key });
          publication.pipeline.pause();
        } else if (event.forward === 1) {
          log.info('Forward=1, resuming publish pipeline', { trackAlias: key });
          publication.pipeline.resume();
        }
      }
    });
    this.sessionCleanup.push(forwardStateCleanup);
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
      // GroupArbiter options for parallel QUIC stream handling
      useGroupArbiter: config.useGroupArbiter,
      // New PlayoutBuffer architecture options
      policyType: config.policyType,
      isLive: config.isLive,
      maxLatency: config.maxLatency,
      estimatedGopDuration: config.estimatedGopDuration,
      catalogFramerate: config.catalogFramerate,
      catalogTimescale: config.catalogTimescale,
      // QuicR-Mac interop mode
      quicrInteropEnabled: config.quicrInteropEnabled,
      minBufferFrames: config.minBufferFrames,
    });

    log.info('Created decode pipeline for discovered track', {
      namespaceSubscriptionId: event.namespaceSubscriptionId,
      trackName: event.trackName,
      mediaType,
      useGroupArbiter: config.useGroupArbiter,
      quicrInteropEnabled: config.quicrInteropEnabled,
      policyType: config.policyType,
      isLive: config.isLive,
    });

    // Use the subscriptionId from the event (added in the session when creating the subscription)
    const subscriptionId = event.subscriptionId;
    log.info('Setting up pipeline for subscription', {
      subscriptionId,
      trackAlias: event.trackAlias.toString(),
      trackName: event.trackName,
    });

    // Set up event handlers
    pipeline.on('video-frame', (frame: VideoFrame) => {
      this.emit('video-frame', { subscriptionId, frame });
    });

    pipeline.on('audio-data', (audioData: AudioData) => {
      this.emit('audio-data', { subscriptionId, audioData });
    });

    pipeline.on('jitter-sample', (sample: JitterSample) => {
      this.emit('jitter-sample', { subscriptionId, sample });
    });

    pipeline.on('latency-stats', (stats: LatencyStatsSample) => {
      this.emit('latency-stats', { subscriptionId, stats });
    });

    pipeline.on('error', (err: Error) => {
      log.error('Subscribe pipeline error', err);
      this.emit('error', err);
    });

    // Start pipeline
    await pipeline.start();

    // Create secure context if encryption is enabled
    const secureContext = await this.createSecureContext(config, {
      namespace: event.namespace,
      trackName: event.trackName,
    });

    // Store subscription with pipeline
    this.subscriptions.set(subscriptionId, {
      subscriptionId,
      namespace: event.namespace,
      trackName: event.trackName,
      pipeline,
      mediaType,
      secureContext,
    });
    this.pipelineToSubscriptionId.set(pipeline, subscriptionId);

    // Update the subscription's onObject callback to push to pipeline (with optional decryption)
    this.session.setSubscriptionCallback(subscriptionId, (data, groupId, objectId, timestamp) => {
      if (secureContext) {
        // Decrypt before pushing to pipeline
        secureContext.decrypt(data, {
          groupId: BigInt(groupId),
          objectId,
        }).then(({ plaintext }) => {
          pipeline.push(plaintext, groupId, objectId, timestamp);
        }).catch((err) => {
          log.error('Decryption failed', { groupId, objectId, error: (err as Error).message });
        });
      } else {
        pipeline.push(data, groupId, objectId, timestamp);
      }
    });

    log.info('Pipeline attached to discovered track', {
      subscriptionId,
      trackName: event.trackName,
      mediaType,
      encrypted: !!secureContext,
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
