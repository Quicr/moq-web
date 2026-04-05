// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Subscribe Pipeline for MOQT Media
 *
 * Provides an integrated pipeline for receiving, unpackaging, decoding,
 * and rendering media from MOQT. Handles the full flow from network
 * reception to playback.
 *
 * @example
 * ```typescript
 * import { SubscribePipeline } from '@web-moq/media';
 *
 * const pipeline = new SubscribePipeline({
 *   video: {
 *     codec: 'avc1.4D401E',
 *     codedWidth: 1280,
 *     codedHeight: 720,
 *   },
 *   audio: {
 *     sampleRate: 48000,
 *     numberOfChannels: 2,
 *   },
 * });
 *
 * pipeline.on('video-frame', (frame) => {
 *   ctx.drawImage(frame, 0, 0);
 *   frame.close();
 * });
 *
 * await pipeline.start();
 * pipeline.pushVideo(locPacket, groupId, objectId);
 * ```
 */

import { Logger } from '@web-moq/core';
import { H264Decoder, VideoDecoderConfig } from '../webcodecs/video-decoder.js';
import { OpusDecoder, AudioDecoderConfig } from '../webcodecs/audio-decoder.js';
import { LOCUnpackager, MediaType } from '../loc/loc-container.js';
import { JitterBuffer } from './jitter-buffer.js';
import { GroupArbiter } from './group-arbiter.js';
import { CodecDecodeWorkerClient, LatencyStatsSample } from '../workers/codec-decode-worker-api.js';
import type { DecodeErrorDiagnostics } from '../workers/codec-decode-worker-types.js';

export type { LatencyStatsSample } from '../workers/codec-decode-worker-api.js';
export type { DecodeErrorDiagnostics } from '../workers/codec-decode-worker-types.js';

/**
 * Custom error class for decode errors with diagnostic information
 */
export class DecodeError extends Error {
  readonly diagnostics?: DecodeErrorDiagnostics;

  constructor(message: string, diagnostics?: DecodeErrorDiagnostics) {
    super(message);
    this.name = 'DecodeError';
    this.diagnostics = diagnostics;
  }
}

const log = Logger.create('moqt:media:subscribe-pipeline');

// Global channel ID counter for worker multiplexing
let nextChannelId = 1;

/**
 * Subscribe pipeline configuration
 */
export interface SubscribePipelineConfig {
  /** Media type to decode - if specified, only creates that decoder */
  mediaType?: 'video' | 'audio';
  /** Video decoding configuration */
  video?: VideoDecoderConfig;
  /** Audio decoding configuration */
  audio?: AudioDecoderConfig;
  /** Jitter buffer target delay in ms (default: 50) */
  jitterBufferDelay?: number;
  /** Render callback interval in ms (default: 16) */
  renderInterval?: number;
  /** Enable jitter stats collection and emission (default: false) */
  enableStats?: boolean;

  // Group-aware jitter buffer options
  /** Use GroupArbiter instead of JitterBuffer for group-aware ordering (default: false) */
  useGroupArbiter?: boolean;
  /** Maximum acceptable end-to-end latency in ms (default: 500) */
  maxLatency?: number;
  /** Initial estimated GOP duration in ms (default: 1000) */
  estimatedGopDuration?: number;
  /** Framerate hint from catalog (optional, improves GOP estimation) */
  catalogFramerate?: number;
  /** Timescale hint from catalog in units per second (optional) */
  catalogTimescale?: number;
  /** Skip to latest group when a newer group arrives (aggressive catch-up, default: false) */
  skipToLatestGroup?: boolean;
  /** Number of frames to wait before skipping to latest group (grace period, default: 3) */
  skipGraceFrames?: number;
  /** Enable catch-up mode when buffer gets too deep (default: true) */
  enableCatchUp?: boolean;
  /** Number of ready frames that triggers catch-up mode (default: 5) */
  catchUpThreshold?: number;
  /** Use latency-only deadline (true=interactive, false=streaming, default: true) */
  useLatencyDeadline?: boolean;
  /** Enable GroupArbiter debug logging (default: false) */
  arbiterDebug?: boolean;

  /**
   * Optional decode worker for offloading decoding to a web worker.
   * When provided, all LOC unpackaging, jitter buffering, and WebCodecs
   * decoding happens in the worker thread.
   *
   * The worker supports multiple concurrent channels (subscriptions).
   * Each pipeline automatically gets a unique channel ID.
   *
   * @example
   * ```typescript
   * const decodeWorker = new Worker(
   *   new URL('@web-moq/media/codec-decode-worker', import.meta.url),
   *   { type: 'module' }
   * );
   * const pipeline = new SubscribePipeline({
   *   video: { codec: 'avc1.42001f', codedWidth: 1280, codedHeight: 720 },
   *   decodeWorker,
   * });
   * ```
   */
  decodeWorker?: Worker;
}

/**
 * Received media object
 */
export interface ReceivedObject {
  /** LOC-packaged data */
  data: Uint8Array;
  /** Group ID */
  groupId: number;
  /** Object ID */
  objectId: number;
  /** Presentation timestamp in microseconds */
  timestamp: number;
}

/**
 * Pipeline event types
 */
export type SubscribePipelineEvent =
  | 'video-frame'
  | 'audio-data'
  | 'jitter-sample'
  | 'latency-stats'
  | 'error'
  | 'started'
  | 'stopped';

/**
 * Jitter sample data emitted periodically
 */
export interface JitterSample {
  /** Inter-arrival times in ms (circular buffer, newest last) */
  interArrivalTimes: number[];
  /** Average jitter in ms */
  avgJitter: number;
  /** Max jitter in ms */
  maxJitter: number;
  /** Timestamp of sample */
  timestamp: number;
}

/**
 * Subscribe Pipeline
 *
 * @remarks
 * Integrates media reception, decoding, and playback into a single
 * pipeline for subscribing to media over MOQT.
 *
 * The pipeline:
 * 1. Receives LOC packets via push methods
 * 2. Unpackages LOC to extract media data
 * 3. Buffers in jitter buffer for reordering
 * 4. Decodes with WebCodecs
 * 5. Emits frames for rendering
 *
 * @example
 * ```typescript
 * const pipeline = new SubscribePipeline({
 *   video: {
 *     codec: 'avc1.4D401E',
 *     codedWidth: 1920,
 *     codedHeight: 1080,
 *   },
 *   audio: {
 *     sampleRate: 48000,
 *     numberOfChannels: 2,
 *   },
 *   jitterBufferDelay: 150,
 * });
 *
 * // Handle decoded frames
 * pipeline.on('video-frame', (frame: VideoFrame) => {
 *   canvasCtx.drawImage(frame, 0, 0);
 *   frame.close();
 * });
 *
 * pipeline.on('audio-data', (audioData: AudioData) => {
 *   processAudio(audioData);
 *   audioData.close();
 * });
 *
 * // Start pipeline
 * await pipeline.start();
 *
 * // Push received objects
 * transport.on('object', (obj) => {
 *   pipeline.push(obj.data, obj.groupId, obj.objectId, obj.timestamp);
 * });
 * ```
 */
export class SubscribePipeline {
  /** Configuration */
  private config: SubscribePipelineConfig;
  /** Unique channel ID for worker multiplexing */
  private channelId: number;
  /** Video decoder (main thread mode) */
  private videoDecoder?: H264Decoder;
  /** Audio decoder (main thread mode) */
  private audioDecoder?: OpusDecoder;
  /** LOC unpackager (main thread mode) */
  private unpackager = new LOCUnpackager();
  /** Video jitter buffer (main thread mode, legacy) */
  private videoBuffer?: JitterBuffer<Uint8Array>;
  /** Audio jitter buffer (main thread mode, legacy) */
  private audioBuffer?: JitterBuffer<Uint8Array>;
  /** Video group arbiter (main thread mode, group-aware) */
  private videoArbiter?: GroupArbiter<Uint8Array>;
  /** Audio group arbiter (main thread mode, group-aware) */
  private audioArbiter?: GroupArbiter<Uint8Array>;
  /** Whether using GroupArbiter instead of JitterBuffer */
  private useGroupArbiter = false;
  /** Event handlers */
  private handlers = new Map<SubscribePipelineEvent, Set<(data: unknown) => void>>();
  /** Pipeline state */
  private _state: 'idle' | 'running' | 'stopped' = 'idle';
  /** Render timer */
  private renderTimer?: ReturnType<typeof setInterval>;
  /** Video sequence counter for timestamp generation */
  private videoSequence = 0;
  /** Audio sequence counter for timestamp generation */
  private audioSequence = 0;
  /** Whether using worker mode */
  private useWorker = false;
  /** Decode worker client (worker mode) */
  private decodeWorkerClient?: CodecDecodeWorkerClient;
  /** Whether stats collection is enabled */
  private enableStats = false;
  /** Last arrival timestamp for jitter calculation */
  private lastArrivalTime = 0;
  /** Circular buffer of inter-arrival times (ms) */
  private interArrivalTimes: number[] = [];
  /** Max samples to keep in jitter buffer */
  private readonly maxJitterSamples = 100;
  /** Timer for periodic jitter sample emission */
  private jitterEmitTimer?: ReturnType<typeof setInterval>;
  /** Time when pipeline started */
  private pipelineStartTime = 0;
  /** Whether first object has been received */
  private firstObjectReceived = false;

  /**
   * Create a new SubscribePipeline
   *
   * @param config - Pipeline configuration
   */
  constructor(config: SubscribePipelineConfig) {
    this.config = config;
    this.channelId = nextChannelId++;
    this.enableStats = config.enableStats ?? false;
    log.info('SubscribePipeline created', {
      channelId: this.channelId,
      mediaType: config.mediaType,
      hasDecodeWorker: !!config.decodeWorker,
      videoConfig: config.video,
      enableStats: this.enableStats,
    });
  }

  /**
   * Get pipeline state
   */
  get state(): 'idle' | 'running' | 'stopped' {
    return this._state;
  }

  /**
   * Check if pipeline is running
   */
  get isRunning(): boolean {
    return this._state === 'running';
  }

  /**
   * Start the pipeline
   */
  async start(): Promise<void> {
    if (this._state === 'running') {
      throw new Error('Pipeline already running');
    }

    const mediaType = this.config.mediaType;
    this.useWorker = !!this.config.decodeWorker;

    log.info('Starting subscribe pipeline', {
      mediaType: mediaType ?? 'both',
      hasVideoConfig: !!this.config.video,
      hasAudioConfig: !!this.config.audio,
      useWorker: this.useWorker,
    });

    if (this.useWorker) {
      await this.startWorkerMode();
    } else {
      await this.startMainThreadMode();
    }

    // Start render loop (in worker mode, this polls the worker)
    const interval = this.config.renderInterval ?? 16;
    this.renderTimer = setInterval(() => this.processBuffers(), interval);

    // Start jitter stats emission if enabled (1s interval - sufficient for visual display)
    if (this.enableStats) {
      this.jitterEmitTimer = setInterval(() => this.emitJitterSample(), 1000);
    }

    this._state = 'running';
    this.pipelineStartTime = performance.now();
    this.firstObjectReceived = false;
    this.emit('started', undefined);
    log.info(`Pipeline STARTED at ${Math.round(this.pipelineStartTime)} (ch=${this.channelId})`);
  }

  /**
   * Start in worker mode - decoding happens in web worker
   */
  private async startWorkerMode(): Promise<void> {
    const worker = this.config.decodeWorker!;
    // Create worker client with unique channel ID for this pipeline
    log.debug('Creating worker client', {
      channelId: this.channelId,
      hasWorker: !!worker,
    });
    this.decodeWorkerClient = new CodecDecodeWorkerClient(worker, this.channelId);

    // Set up event handlers for decoded frames
    this.decodeWorkerClient.on('video-frame', (response) => {
      log.trace('Pipeline received video-frame from worker', {
        pipelineChannelId: this.channelId,
        responseChannelId: response.channelId,
        width: response.result.frame.displayWidth,
        height: response.result.frame.displayHeight,
      });
      this.emit('video-frame', response.result.frame);
    });

    this.decodeWorkerClient.on('audio-data', (response) => {
      this.emit('audio-data', response.result.data);
    });

    this.decodeWorkerClient.on('error', (response) => {
      log.error('Decode worker error', {
        channelId: this.channelId,
        message: response.message,
        diagnostics: response.diagnostics,
      });
      this.emit('error', new DecodeError(response.message, response.diagnostics));
    });

    // Forward latency stats if enabled
    if (this.enableStats) {
      this.decodeWorkerClient.on('latency-stats', (response) => {
        this.emit('latency-stats', response.stats);
      });
    }

    // Forward arbiter debug logs from worker to main thread logger
    // Using INFO level so they appear in console (DEBUG often filtered)
    this.decodeWorkerClient.on('arbiter-debug', (response) => {
      if (response.data) {
        log.info(response.message, response.data);
      } else {
        log.info(response.message);
      }
    });

    // Initialize worker channel with decoder configs
    const mediaType = this.config.mediaType;
    await this.decodeWorkerClient.init({
      video: this.config.video && (mediaType === 'video' || !mediaType)
        ? {
            codec: this.config.video.codec,
            codedWidth: this.config.video.codedWidth,
            codedHeight: this.config.video.codedHeight,
            description: this.config.video.description as Uint8Array | undefined,
          }
        : undefined,
      audio: this.config.audio && (mediaType === 'audio' || !mediaType)
        ? {
            codec: 'opus',
            sampleRate: this.config.audio.sampleRate,
            numberOfChannels: this.config.audio.numberOfChannels,
          }
        : undefined,
      jitterBufferDelay: this.config.jitterBufferDelay ?? 100,
      enableStats: this.enableStats,
      // GroupArbiter configuration (passed through to worker)
      useGroupArbiter: this.config.useGroupArbiter,
      maxLatency: this.config.maxLatency,
      estimatedGopDuration: this.config.estimatedGopDuration,
      catalogFramerate: this.config.catalogFramerate,
      catalogTimescale: this.config.catalogTimescale,
      skipToLatestGroup: this.config.skipToLatestGroup,
      skipGraceFrames: this.config.skipGraceFrames,
      enableCatchUp: this.config.enableCatchUp,
      catchUpThreshold: this.config.catchUpThreshold,
      useLatencyDeadline: this.config.useLatencyDeadline,
      arbiterDebug: this.config.arbiterDebug,
    });

    log.info('Decode worker channel initialized', { channelId: this.channelId });
  }

  /**
   * Start in main thread mode - decoding happens on main thread
   */
  private async startMainThreadMode(): Promise<void> {
    const mediaType = this.config.mediaType;
    this.useGroupArbiter = this.config.useGroupArbiter ?? false;
    const jitterDelay = this.config.jitterBufferDelay ?? 100;

    log.info('Starting main thread mode', {
      useGroupArbiter: this.useGroupArbiter,
      jitterDelay,
    });

    // Set up video decoding (only if mediaType is 'video' or not specified)
    const shouldCreateVideoDecoder = this.config.video && (mediaType === 'video' || !mediaType);
    if (shouldCreateVideoDecoder) {
      this.videoDecoder = new H264Decoder();
      log.info('Registering frame handler on video decoder', {
        decoderInstanceId: this.videoDecoder.id,
      });
      const unsubscribe = this.videoDecoder.on('frame', (frame) => {
        log.trace('Pipeline emitting video-frame event', {
          decoderInstanceId: this.videoDecoder?.id,
          width: frame.displayWidth,
          height: frame.displayHeight,
        });
        this.emit('video-frame', frame);
      });
      log.debug('Frame handler registered', {
        decoderInstanceId: this.videoDecoder.id,
        unsubscribe: typeof unsubscribe,
      });
      this.videoDecoder.on('error', (error) => {
        log.error('Video decoder error', error);
        this.emit('error', error);
      });

      await this.videoDecoder.start(this.config.video!);

      // Create buffer based on configuration
      if (this.useGroupArbiter) {
        this.videoArbiter = new GroupArbiter<Uint8Array>({
          jitterDelay,
          maxLatency: this.config.maxLatency ?? 500,
          estimatedGopDuration: this.config.estimatedGopDuration ?? 1000,
          catalogFramerate: this.config.catalogFramerate,
          catalogTimescale: this.config.catalogTimescale,
          allowPartialGroupDecode: true,
          skipOnlyToKeyframe: true,
          skipToLatestGroup: this.config.skipToLatestGroup ?? false,
          skipGraceFrames: this.config.skipGraceFrames ?? 3,
          enableCatchUp: this.config.enableCatchUp ?? true,
          catchUpThreshold: this.config.catchUpThreshold ?? 5,
          useLatencyDeadline: this.config.useLatencyDeadline ?? true,
          debug: this.config.arbiterDebug ?? false,
        });
        log.info('Using GroupArbiter for video', {
          skipToLatestGroup: this.config.skipToLatestGroup,
          skipGraceFrames: this.config.skipGraceFrames,
          enableCatchUp: this.config.enableCatchUp,
          catchUpThreshold: this.config.catchUpThreshold,
          useLatencyDeadline: this.config.useLatencyDeadline,
        });
      } else {
        this.videoBuffer = new JitterBuffer({
          targetDelay: jitterDelay,
          maxDelay: 300,
          maxFramesPerCall: 5, // Allow more frames per cycle to reduce delay
        });
      }
    }

    // Set up audio decoding (only if mediaType is 'audio' or not specified)
    const shouldCreateAudioDecoder = this.config.audio && (mediaType === 'audio' || !mediaType);
    if (shouldCreateAudioDecoder) {
      this.audioDecoder = new OpusDecoder();
      this.audioDecoder.on('frame', (audioData) => {
        this.emit('audio-data', audioData);
      });
      this.audioDecoder.on('error', (error) => {
        log.error('Audio decoder error', error);
        this.emit('error', error);
      });

      await this.audioDecoder.start(this.config.audio!);

      // Create buffer based on configuration
      if (this.useGroupArbiter) {
        this.audioArbiter = new GroupArbiter<Uint8Array>({
          jitterDelay,
          maxLatency: this.config.maxLatency ?? 500,
          estimatedGopDuration: 20, // Audio frames are typically ~20ms
          allowPartialGroupDecode: true,
          skipOnlyToKeyframe: false, // Audio doesn't need keyframes (Opus)
          skipToLatestGroup: this.config.skipToLatestGroup ?? false,
          skipGraceFrames: this.config.skipGraceFrames ?? 3,
          enableCatchUp: this.config.enableCatchUp ?? true,
          catchUpThreshold: this.config.catchUpThreshold ?? 5,
          useLatencyDeadline: this.config.useLatencyDeadline ?? true,
          debug: this.config.arbiterDebug ?? false,
        });
        log.info('Using GroupArbiter for audio');
      } else {
        this.audioBuffer = new JitterBuffer({
          targetDelay: jitterDelay,
          maxDelay: 300,
          maxFramesPerCall: 5, // Allow more frames per cycle to reduce delay
        });
      }
    }
  }

  /**
   * Push a received media object
   *
   * @param data - LOC-packaged data
   * @param groupId - Group ID
   * @param objectId - Object ID
   * @param timestamp - Presentation timestamp in microseconds
   */
  push(
    data: Uint8Array,
    groupId: number,
    objectId: number,
    timestamp: number
  ): void {
    if (this._state !== 'running') {
      log.warn('Pipeline not running, ignoring object');
      return;
    }

    // Record arrival time for jitter stats (lightweight - just performance.now())
    if (this.enableStats) {
      const now = performance.now();
      if (this.lastArrivalTime > 0) {
        const interArrival = now - this.lastArrivalTime;
        this.interArrivalTimes.push(interArrival);
        if (this.interArrivalTimes.length > this.maxJitterSamples) {
          this.interArrivalTimes.shift();
        }
      }
      this.lastArrivalTime = now;
    }

    // Skip empty payloads (END_OF_TRACK/END_OF_GROUP signaling)
    if (data.length === 0) {
      log.trace('Skipping empty payload', { groupId, objectId });
      return;
    }

    // Log first object timing
    if (!this.firstObjectReceived) {
      this.firstObjectReceived = true;
      const now = performance.now();
      const sinceStart = Math.round(now - this.pipelineStartTime);
      log.info(`FIRST OBJECT received: g${groupId}/o${objectId} after ${sinceStart}ms (ch=${this.channelId})`)
    }

    // Worker mode: forward data to worker for processing
    if (this.useWorker && this.decodeWorkerClient) {
      log.trace('Pushing to decode worker', { groupId, objectId, dataSize: data.length });
      this.decodeWorkerClient.push(data, groupId, objectId, timestamp);
      return;
    }

    // Main thread mode: process locally
    try {
      const mediaType = this.unpackager.getMediaType(data);
      log.trace('Pipeline received object', {
        mediaType: mediaType === MediaType.VIDEO ? 'video' : 'audio',
        groupId,
        objectId,
        dataSize: data.length,
      });

      if (mediaType === MediaType.VIDEO) {
        this.pushVideo(data, groupId, objectId, timestamp);
      } else {
        this.pushAudio(data, groupId, objectId, timestamp);
      }
    } catch (err) {
      log.error('Error processing received object', {
        dataSize: data.length,
        groupId,
        objectId,
        error: (err as Error).message,
      });
    }
  }

  /**
   * Push a video object
   */
  private pushVideo(
    data: Uint8Array,
    groupId: number,
    objectId: number,
    timestamp: number
  ): void {
    if (!this.videoBuffer && !this.videoArbiter) {
      // Silently ignore video on audio-only subscriptions
      return;
    }

    const frame = this.unpackager.unpackage(data);
    const isKeyframe = frame.header.isKeyframe;

    log.trace('Unpacked video frame', {
      groupId,
      objectId,
      isKeyframe,
      payloadSize: frame.payload.byteLength,
      hasCodecDescription: !!frame.codecDescription,
      mediaType: frame.header.mediaType,
    });

    // Handle codec description from keyframe
    if (isKeyframe && frame.codecDescription && this.videoDecoder) {
      log.info('Reconfiguring decoder with codec description', {
        descriptionSize: frame.codecDescription.byteLength,
      });
      this.videoDecoder.reconfigure({
        ...this.config.video!,
        description: frame.codecDescription,
      });
    }

    if (this.videoArbiter) {
      // Use GroupArbiter for group-aware ordering
      const accepted = this.videoArbiter.addFrame({
        groupId,
        objectId,
        data: frame.payload,
        isKeyframe,
        locTimestamp: frame.captureTimestamp ? Math.floor(frame.captureTimestamp * 1000) : undefined,
      });

      log.trace('Pushed to video arbiter', {
        accepted,
        activeGroup: this.videoArbiter.getActiveGroupId(),
        groupCount: this.videoArbiter.getGroupCount(),
      });
    } else if (this.videoBuffer) {
      // Use legacy JitterBuffer
      const pushed = this.videoBuffer.push({
        data: frame.payload,
        timestamp: timestamp / 1000, // Convert to ms
        sequence: this.videoSequence++,
        groupId,
        objectId,
        isKeyframe,
        receivedAt: performance.now(),
      });

      log.trace('Pushed to video buffer', {
        pushed,
        bufferSize: this.videoBuffer.size,
        sequence: this.videoSequence - 1,
      });
    }
  }

  /**
   * Push an audio object
   */
  private pushAudio(
    data: Uint8Array,
    groupId: number,
    objectId: number,
    timestamp: number
  ): void {
    if (!this.audioBuffer && !this.audioArbiter) {
      // Silently ignore audio on video-only subscriptions
      // This happens when track contains mixed media or multiple tracks share an alias
      return;
    }

    const frame = this.unpackager.unpackage(data);

    log.trace('Unpacked audio frame', {
      groupId,
      objectId,
      payloadSize: frame.payload.byteLength,
      mediaType: frame.header.mediaType,
      hasAudioLevel: !!frame.audioLevel,
    });

    if (this.audioArbiter) {
      // Use GroupArbiter for group-aware ordering
      const accepted = this.audioArbiter.addFrame({
        groupId,
        objectId,
        data: frame.payload,
        isKeyframe: true, // Opus is always key
        locTimestamp: frame.captureTimestamp ? Math.floor(frame.captureTimestamp * 1000) : undefined,
      });

      log.trace('Pushed to audio arbiter', {
        accepted,
        activeGroup: this.audioArbiter.getActiveGroupId(),
      });
    } else if (this.audioBuffer) {
      // Use legacy JitterBuffer
      const pushed = this.audioBuffer.push({
        data: frame.payload,
        timestamp: timestamp / 1000, // Convert to ms
        sequence: this.audioSequence++,
        groupId,
        objectId,
        isKeyframe: true, // Opus is always key
        receivedAt: performance.now(),
      });

      log.trace('Pushed to audio buffer', {
        pushed,
        bufferSize: this.audioBuffer.size,
        sequence: this.audioSequence - 1,
      });
    }
  }

  /**
   * Process jitter buffers and decode ready frames
   */
  private processBuffers(): void {
    // Worker mode: poll the worker for decoded frames
    if (this.useWorker && this.decodeWorkerClient) {
      this.decodeWorkerClient.poll();
      return;
    }

    // Main thread mode: process buffers locally
    // Process video - GroupArbiter path
    if (this.videoArbiter && this.videoDecoder) {
      const readyFrames = this.videoArbiter.getReadyFrames(5);
      if (readyFrames.length > 0) {
        log.trace('Processing video frames from arbiter', {
          count: readyFrames.length,
          activeGroup: this.videoArbiter.getActiveGroupId(),
        });
      }
      for (const frame of readyFrames) {
        try {
          const activeGroupId = this.videoArbiter.getActiveGroupId();
          log.trace('Decoding video frame from arbiter', {
            decoderInstanceId: this.videoDecoder.id,
            groupId: activeGroupId,
            objectId: frame.objectId,
            isKeyframe: frame.isKeyframe,
            dataSize: frame.data.byteLength,
          });
          this.videoDecoder.decode(
            frame.data,
            frame.isKeyframe ?? false,
            frame.receivedTick * 1000, // Use receivedTick as timestamp proxy
            undefined, // duration
            activeGroupId
          );
        } catch (err) {
          log.error('Video decode error', err as Error);
        }
      }

      // Log arbiter stats periodically
      if (readyFrames.length > 0 && this.videoSequence % 30 === 0) {
        const stats = this.videoArbiter.getStats();
        log.debug('Video arbiter stats', {
          activeGroup: this.videoArbiter.getActiveGroupId(),
          groupCount: this.videoArbiter.getGroupCount(),
          framesOutput: stats.framesOutput,
          groupsCompleted: stats.groupsCompleted,
          groupsSkipped: stats.groupsSkipped,
        });
      }
      this.videoSequence += readyFrames.length;
    }
    // Process video - JitterBuffer path (legacy)
    else if (this.videoBuffer && this.videoDecoder) {
      const videoFrames = this.videoBuffer.getReadyFrames();
      if (videoFrames.length > 0) {
        log.trace('Processing video frames from buffer', {
          count: videoFrames.length,
          bufferRemaining: this.videoBuffer.size,
        });
      }
      for (const frame of videoFrames) {
        try {
          log.trace('Decoding video frame', {
            decoderInstanceId: this.videoDecoder.id,
            groupId: frame.groupId,
            objectId: frame.objectId,
            isKeyframe: frame.isKeyframe,
            dataSize: frame.data.byteLength,
          });
          this.videoDecoder.decode(
            frame.data,
            frame.isKeyframe,
            frame.timestamp * 1000, // Back to microseconds
            undefined, // duration
            frame.groupId
          );
        } catch (err) {
          log.error('Video decode error', err as Error);
        }
      }
    }

    // Process audio - GroupArbiter path
    if (this.audioArbiter && this.audioDecoder) {
      const readyFrames = this.audioArbiter.getReadyFrames(5);
      for (const frame of readyFrames) {
        try {
          this.audioDecoder.decode(
            frame.data,
            frame.receivedTick * 1000 // Use receivedTick as timestamp proxy
          );
        } catch (err) {
          log.error('Audio decode error', err as Error);
        }
      }
    }
    // Process audio - JitterBuffer path (legacy)
    else if (this.audioBuffer && this.audioDecoder) {
      const audioFrames = this.audioBuffer.getReadyFrames();
      for (const frame of audioFrames) {
        try {
          this.audioDecoder.decode(
            frame.data,
            frame.timestamp * 1000 // Back to microseconds
          );
        } catch (err) {
          log.error('Audio decode error', err as Error);
        }
      }
    }
  }

  /**
   * Stop the pipeline
   */
  async stop(): Promise<void> {
    if (this._state !== 'running') {
      return;
    }

    log.info('Stopping subscribe pipeline');
    this._state = 'stopped';

    // Stop render timer
    if (this.renderTimer) {
      clearInterval(this.renderTimer);
      this.renderTimer = undefined;
    }

    // Stop jitter stats timer
    if (this.jitterEmitTimer) {
      clearInterval(this.jitterEmitTimer);
      this.jitterEmitTimer = undefined;
    }

    // Worker mode: close worker
    if (this.useWorker && this.decodeWorkerClient) {
      this.decodeWorkerClient.close();
      this.decodeWorkerClient = undefined;
    }

    // Main thread mode: close decoders
    if (this.videoDecoder) {
      await this.videoDecoder.close();
      this.videoDecoder = undefined;
    }

    if (this.audioDecoder) {
      await this.audioDecoder.close();
      this.audioDecoder = undefined;
    }

    // Clear buffers (main thread mode only)
    this.videoBuffer?.reset();
    this.audioBuffer?.reset();
    this.videoArbiter?.reset();
    this.audioArbiter?.reset();

    this.emit('stopped', undefined);
    log.info('Subscribe pipeline stopped');
  }

  /**
   * Reset to wait for new keyframe
   */
  async reset(): Promise<void> {
    log.info('Resetting subscribe pipeline');

    // Worker mode: reset worker
    if (this.useWorker && this.decodeWorkerClient) {
      this.decodeWorkerClient.reset();
      return;
    }

    // Main thread mode: reset local state
    this.videoBuffer?.reset();
    this.audioBuffer?.reset();
    this.videoArbiter?.reset();
    this.audioArbiter?.reset();

    if (this.videoDecoder) {
      await this.videoDecoder.reset();
    }

    if (this.audioDecoder) {
      await this.audioDecoder.reset();
    }

    this.videoSequence = 0;
    this.audioSequence = 0;

    // Reset jitter stats
    this.interArrivalTimes = [];
    this.lastArrivalTime = 0;
  }

  /**
   * Emit jitter sample (called periodically when stats enabled)
   */
  private emitJitterSample(): void {
    if (this.interArrivalTimes.length === 0) return;

    // Calculate stats
    const times = this.interArrivalTimes;
    const sum = times.reduce((a, b) => a + b, 0);
    const avg = sum / times.length;
    const max = Math.max(...times);

    const sample: JitterSample = {
      interArrivalTimes: [...times], // Copy to avoid mutation
      avgJitter: avg,
      maxJitter: max,
      timestamp: performance.now(),
    };

    this.emit('jitter-sample', sample);
  }

  /**
   * Get pipeline statistics
   */
  getStats(): {
    state: string;
    video: { buffer?: object; arbiter?: object; decoder?: object };
    audio: { buffer?: object; arbiter?: object; decoder?: object };
  } {
    return {
      state: this._state,
      video: {
        buffer: this.videoBuffer?.getStats(),
        arbiter: this.videoArbiter?.getStats(),
        decoder: this.videoDecoder?.getStats(),
      },
      audio: {
        buffer: this.audioBuffer?.getStats(),
        arbiter: this.audioArbiter?.getStats(),
        decoder: this.audioDecoder?.getStats(),
      },
    };
  }

  /**
   * Register an event handler
   */
  on(event: 'video-frame', handler: (frame: VideoFrame) => void): () => void;
  on(event: 'audio-data', handler: (audioData: AudioData) => void): () => void;
  on(event: 'jitter-sample', handler: (sample: JitterSample) => void): () => void;
  on(event: 'latency-stats', handler: (stats: LatencyStatsSample) => void): () => void;
  on(event: 'error', handler: (error: Error) => void): () => void;
  on(event: 'started' | 'stopped', handler: () => void): () => void;
  on(
    event: SubscribePipelineEvent,
    handler:
      | ((frame: VideoFrame) => void)
      | ((audioData: AudioData) => void)
      | ((sample: JitterSample) => void)
      | ((stats: LatencyStatsSample) => void)
      | ((error: Error) => void)
      | (() => void)
  ): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler as (data: unknown) => void);

    return () => {
      this.handlers.get(event)?.delete(handler as (data: unknown) => void);
    };
  }

  /**
   * Emit an event
   */
  private emit(event: SubscribePipelineEvent, data: unknown): void {
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
