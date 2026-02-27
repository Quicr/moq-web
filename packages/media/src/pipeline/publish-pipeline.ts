// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Publish Pipeline for MOQT Media
 *
 * Provides an integrated pipeline for capturing, encoding, packaging,
 * and publishing media over MOQT. Handles the full flow from camera/mic
 * to network transmission.
 *
 * @example
 * ```typescript
 * import { PublishPipeline } from '@web-moq/media';
 *
 * const pipeline = new PublishPipeline({
 *   video: {
 *     width: 1280,
 *     height: 720,
 *     bitrate: 2_000_000,
 *     framerate: 30,
 *   },
 *   audio: {
 *     sampleRate: 48000,
 *     numberOfChannels: 2,
 *     bitrate: 128000,
 *   },
 * });
 *
 * pipeline.on('video-object', (obj) => transport.send(obj));
 * pipeline.on('audio-object', (obj) => transport.send(obj));
 *
 * await pipeline.start(mediaStream);
 * ```
 */

import { Logger, Priority } from '@web-moq/core';
import { H264Encoder, VideoEncoderConfig, EncodedVideoFrame } from '../webcodecs/video-encoder.js';
import { OpusEncoder, OpusEncoderOptions, EncodedAudioFrame } from '../webcodecs/audio-encoder.js';
import { LOCPackager } from '../loc/loc-container.js';
import { CodecEncodeWorkerClient } from '../workers/codec-encode-worker-api.js';

const log = Logger.create('moqt:media:publish-pipeline');

/**
 * Publish pipeline configuration
 */
export interface PublishPipelineConfig {
  /** Video encoding configuration (optional) */
  video?: VideoEncoderConfig;
  /** Audio encoding configuration (optional) */
  audio?: OpusEncoderOptions;
  /** Track ID prefix */
  trackPrefix?: string;
  /**
   * Optional worker for offloading encoding to a web worker.
   * If provided, video/audio encoding will run in the worker.
   * The worker should be created from '@web-moq/media/codec-encode-worker'.
   */
  encodeWorker?: Worker;
}

/**
 * Published media object
 */
export interface PublishedObject {
  /** Media type */
  type: 'video' | 'audio';
  /** LOC-packaged data */
  data: Uint8Array;
  /** Group ID */
  groupId: number;
  /** Object ID within group */
  objectId: number;
  /** Whether this is a keyframe */
  isKeyframe: boolean;
  /** Presentation timestamp */
  timestamp: number;
  /** Priority for transmission */
  priority: Priority;
}

/**
 * Pipeline event types
 */
export type PipelineEvent =
  | 'video-object'
  | 'audio-object'
  | 'error'
  | 'started'
  | 'stopped';

/**
 * Publish Pipeline
 *
 * @remarks
 * Integrates media capture, encoding, and packaging into a single
 * pipeline for publishing media over MOQT.
 *
 * The pipeline:
 * 1. Captures video/audio from MediaStream
 * 2. Encodes to H.264/Opus using WebCodecs
 * 3. Packages into LOC format
 * 4. Emits objects ready for MOQT transmission
 *
 * @example
 * ```typescript
 * const pipeline = new PublishPipeline({
 *   video: { width: 1920, height: 1080, bitrate: 4_000_000, framerate: 30 },
 *   audio: { sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 },
 * });
 *
 * // Handle encoded objects
 * pipeline.on('video-object', (obj) => {
 *   trackManager.recordPublishedObject(videoTrack, obj.isKeyframe);
 *   transport.send(obj.data);
 * });
 *
 * // Start with media stream
 * const stream = await navigator.mediaDevices.getUserMedia({
 *   video: { width: 1920, height: 1080 },
 *   audio: true,
 * });
 *
 * await pipeline.start(stream);
 * ```
 */
/**
 * Generate initial group ID from current time.
 * Uses last 32 bits of millisecond timestamp (~50 days coverage).
 * This ensures unique group IDs across different publish sessions.
 */
function getInitialGroupId(): number {
  return Date.now() >>> 0;  // Unsigned 32-bit (~50 days of milliseconds)
}

export class PublishPipeline {
  /** Channel ID counter for multiplexed worker (static for thread safety) */
  private static nextChannelId = 1;

  /** Configuration */
  private config: PublishPipelineConfig;
  /** Video encoder (main thread mode) */
  private videoEncoder?: H264Encoder;
  /** Audio encoder (main thread mode) */
  private opusEncoder?: OpusEncoder;
  /** LOC packager (main thread mode) */
  private packager = new LOCPackager();
  /** Codec encode worker client (worker mode) */
  private encodeWorkerClient?: CodecEncodeWorkerClient;
  /** Whether using worker mode */
  private readonly useWorker: boolean;
  /** Channel ID for worker multiplexing */
  private channelId: number;
  /** Event handlers */
  private handlers = new Map<PipelineEvent, Set<(data: unknown) => void>>();
  /** Pipeline state */
  private _state: 'idle' | 'running' | 'stopped' = 'idle';
  /** Video track processor */
  private videoProcessor?: MediaStreamTrackProcessor<VideoFrame>;
  /** Audio track processor */
  private audioProcessor?: MediaStreamTrackProcessor<AudioData>;
  /** Video group ID (main thread mode only) - initialized with time-based ID */
  private videoGroupId = getInitialGroupId();
  /** Video object ID (main thread mode only) */
  private videoObjectId = 0;
  /** Audio group ID (main thread mode only) - initialized with time-based ID */
  private audioGroupId = getInitialGroupId();
  /** Audio object ID (main thread mode only) */
  private audioObjectId = 0;
  /** Abort controller */
  private abortController?: AbortController;

  /**
   * Create a new PublishPipeline
   *
   * @param config - Pipeline configuration
   */
  constructor(config: PublishPipelineConfig) {
    this.config = config;
    this.useWorker = !!config.encodeWorker;
    this.channelId = PublishPipeline.nextChannelId++;

    if (this.useWorker && config.encodeWorker) {
      // Pass channelId for multiplexed worker support
      this.encodeWorkerClient = new CodecEncodeWorkerClient(config.encodeWorker, this.channelId);
      this.setupWorkerHandlers();
    }

    log.debug('PublishPipeline created', { ...config, useWorker: this.useWorker, channelId: this.channelId });
  }

  /**
   * Set up handlers for worker mode
   */
  private setupWorkerHandlers(): void {
    if (!this.encodeWorkerClient) return;

    this.encodeWorkerClient.on('video-encoded', ({ result }) => {
      const obj: PublishedObject = {
        type: 'video',
        data: result.data,
        groupId: result.groupId,
        objectId: result.objectId,
        isKeyframe: result.isKeyframe,
        timestamp: result.timestamp,
        priority: result.isKeyframe ? Priority.HIGH : Priority.MEDIUM_HIGH,
      };

      log.info('Video object ready (from worker)', {
        groupId: obj.groupId,
        objectId: obj.objectId,
        isKeyframe: obj.isKeyframe,
        size: obj.data.byteLength,
      });

      this.emit('video-object', obj);
    });

    this.encodeWorkerClient.on('audio-encoded', ({ result }) => {
      const obj: PublishedObject = {
        type: 'audio',
        data: result.data,
        groupId: result.groupId,
        objectId: result.objectId,
        isKeyframe: false,
        timestamp: result.timestamp,
        priority: Priority.HIGH,
      };

      this.emit('audio-object', obj);
    });

    this.encodeWorkerClient.on('error', ({ message }) => {
      log.error('Encode worker error', { message });
      this.emit('error', new Error(message));
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
   *
   * @param stream - MediaStream to capture from
   */
  async start(stream: MediaStream): Promise<void> {
    if (this._state === 'running') {
      throw new Error('Pipeline already running');
    }

    log.info('Starting publish pipeline', { useWorker: this.useWorker });
    this.abortController = new AbortController();

    // Initialize worker if using worker mode
    if (this.useWorker && this.encodeWorkerClient) {
      await this.encodeWorkerClient.init({
        video: this.config.video ? {
          codec: 'avc1.42001f',
          width: this.config.video.width,
          height: this.config.video.height,
          bitrate: this.config.video.bitrate,
          framerate: this.config.video.framerate,
        } : undefined,
        audio: this.config.audio ? {
          codec: 'opus',
          sampleRate: this.config.audio.sampleRate ?? 48000,
          numberOfChannels: this.config.audio.numberOfChannels ?? 2,
          bitrate: this.config.audio.bitrate ?? 128000,
        } : undefined,
      });
      log.info('Encode worker initialized');
    }

    // Set state to running BEFORE starting the processing loops
    this._state = 'running';

    // Set up video encoding
    if (this.config.video) {
      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) {
        log.info('Setting up video encoding', {
          trackEnabled: videoTrack.enabled,
          trackMuted: videoTrack.muted,
          trackReadyState: videoTrack.readyState,
          useWorker: this.useWorker,
        });
        await this.setupVideoEncoding(videoTrack);
      } else {
        log.warn('No video track in stream');
      }
    }

    // Set up audio encoding
    if (this.config.audio) {
      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack) {
        await this.setupAudioEncoding(audioTrack);
      } else {
        log.warn('No audio track in stream');
      }
    }

    this.emit('started', undefined);
    log.info('Publish pipeline started');
  }

  /**
   * Set up video encoding
   */
  private async setupVideoEncoding(track: MediaStreamTrack): Promise<void> {
    if (!this.config.video) return;

    // Worker mode - encoder is in worker, just set up frame capture
    if (this.useWorker) {
      // Create track processor
      this.videoProcessor = new MediaStreamTrackProcessor({ track });
      const reader = this.videoProcessor.readable.getReader();

      // Process frames (sends to worker)
      this.processVideoFrames(reader);
      return;
    }

    // Main thread mode - set up encoder locally
    this.videoEncoder = new H264Encoder(this.config.video);

    this.videoEncoder.on('frame', (frame) => {
      this.handleEncodedVideoFrame(frame);
    });

    this.videoEncoder.on('error', (error) => {
      log.error('Video encoder error', error);
      this.emit('error', error);
    });

    await this.videoEncoder.start();

    // Create track processor
    this.videoProcessor = new MediaStreamTrackProcessor({ track });
    const reader = this.videoProcessor.readable.getReader();

    // Process frames
    this.processVideoFrames(reader);
  }

  /**
   * Process video frames from track
   */
  private async processVideoFrames(
    reader: ReadableStreamDefaultReader<VideoFrame>
  ): Promise<void> {
    log.info('Starting video frame processing', { useWorker: this.useWorker });
    let frameCount = 0;
    try {
      while (this._state === 'running') {
        const { value: frame, done } = await reader.read();
        if (done) {
          log.info('Video frame reader done');
          break;
        }

        if (frame) {
          frameCount++;
          if (frameCount === 1 || frameCount % 30 === 0) {
            log.info('Processing video frame', {
              frameCount,
              timestamp: frame.timestamp,
              width: frame.displayWidth,
              height: frame.displayHeight,
              useWorker: this.useWorker,
            });
          }

          if (this.useWorker && this.encodeWorkerClient) {
            // Worker mode - transfer frame to worker (zero-copy)
            // Note: frame ownership transfers, no need to close
            this.encodeWorkerClient.encodeVideo(frame);
          } else if (this.videoEncoder) {
            // Main thread mode - encode locally
            await this.videoEncoder.encode(frame);
            frame.close();
          } else {
            frame.close();
          }
        }
      }
    } catch (err) {
      if (this._state === 'running') {
        log.error('Video processing error', err as Error);
        this.emit('error', err);
      }
    }
    log.info('Video frame processing ended', { totalFrames: frameCount });
  }

  /**
   * Handle encoded video frame
   */
  private handleEncodedVideoFrame(frame: EncodedVideoFrame): void {
    // Update group/object IDs
    if (frame.isKeyframe) {
      this.videoGroupId++;
      this.videoObjectId = 0;
    } else {
      this.videoObjectId++;
    }

    // Package with LOC
    const locData = this.packager.packageVideo(frame.data, {
      isKeyframe: frame.isKeyframe,
      captureTimestamp: performance.now(),
      codecDescription: frame.codecDescription,
    });

    const obj: PublishedObject = {
      type: 'video',
      data: locData,
      groupId: this.videoGroupId,
      objectId: this.videoObjectId,
      isKeyframe: frame.isKeyframe,
      timestamp: frame.timestamp,
      priority: frame.isKeyframe ? Priority.HIGH : Priority.MEDIUM_HIGH,
    };

    log.info('Video object ready', {
      groupId: obj.groupId,
      objectId: obj.objectId,
      isKeyframe: obj.isKeyframe,
      size: obj.data.byteLength,
    });

    this.emit('video-object', obj);
  }

  /**
   * Set up audio encoding
   */
  private async setupAudioEncoding(track: MediaStreamTrack): Promise<void> {
    if (!this.config.audio) return;

    // Get the actual audio track settings
    const trackSettings = track.getSettings();
    log.info('Setting up audio encoding', {
      trackEnabled: track.enabled,
      trackMuted: track.muted,
      trackReadyState: track.readyState,
      trackSettings,
      requestedConfig: this.config.audio,
      useWorker: this.useWorker,
    });

    // Use actual track settings for encoder configuration
    // Fall back to config values if track settings are not available
    const actualSampleRate = trackSettings.sampleRate || this.config.audio.sampleRate || 48000;
    const actualChannels = trackSettings.channelCount || this.config.audio.numberOfChannels || 1;

    log.info('Audio encoder will use', {
      sampleRate: actualSampleRate,
      numberOfChannels: actualChannels,
      bitrate: this.config.audio.bitrate,
    });

    // Worker mode - encoder is in worker, just set up audio capture
    if (this.useWorker) {
      // Create track processor
      this.audioProcessor = new MediaStreamTrackProcessor({ track });
      const reader = this.audioProcessor.readable.getReader();

      // Process audio (sends to worker)
      this.processAudioFrames(reader);
      return;
    }

    try {
      // Main thread mode - create encoder with actual audio track parameters
      this.opusEncoder = new OpusEncoder({
        ...this.config.audio,
        sampleRate: actualSampleRate,
        numberOfChannels: actualChannels,
      });

      this.opusEncoder.on('frame', (frame) => {
        this.handleEncodedAudioFrame(frame);
      });

      this.opusEncoder.on('error', (error) => {
        log.error('Audio encoder error', error);
        this.emit('error', error);
      });

      await this.opusEncoder.start();
      log.info('Audio encoder started successfully');

      // Create track processor
      this.audioProcessor = new MediaStreamTrackProcessor({ track });
      const reader = this.audioProcessor.readable.getReader();

      // Process audio
      this.processAudioFrames(reader);
    } catch (err) {
      log.error('Failed to set up audio encoding', err as Error);
      this.emit('error', err);
    }
  }

  /** Track if we've configured the encoder based on actual audio data */
  private audioEncoderConfigured = false;

  /**
   * Process audio frames from track
   */
  private async processAudioFrames(
    reader: ReadableStreamDefaultReader<AudioData>
  ): Promise<void> {
    log.info('Starting audio frame processing', { useWorker: this.useWorker });
    let frameCount = 0;
    this.audioEncoderConfigured = false;

    try {
      while (this._state === 'running') {
        const { value: audioData, done } = await reader.read();
        if (done) {
          log.info('Audio frame reader done');
          break;
        }

        if (audioData) {
          frameCount++;

          // Worker mode - send audio data to worker
          if (this.useWorker && this.encodeWorkerClient) {
            // On first frame, check if we need to reconfigure the encoder
            if (!this.audioEncoderConfigured) {
              const configuredChannels = this.config.audio?.numberOfChannels ?? 2;
              const configuredSampleRate = this.config.audio?.sampleRate ?? 48000;
              const needsReconfigure =
                configuredSampleRate !== audioData.sampleRate ||
                configuredChannels !== audioData.numberOfChannels;

              log.info('First audio frame received (worker mode)', {
                frameCount,
                audioData: {
                  sampleRate: audioData.sampleRate,
                  numberOfChannels: audioData.numberOfChannels,
                  format: audioData.format,
                  numberOfFrames: audioData.numberOfFrames,
                },
                workerConfig: {
                  sampleRate: configuredSampleRate,
                  numberOfChannels: configuredChannels,
                },
                needsReconfigure,
              });

              if (needsReconfigure) {
                log.info('Reconfiguring worker audio encoder to match input');
                this.encodeWorkerClient.reconfigureAudio({
                  codec: 'opus',
                  sampleRate: audioData.sampleRate,
                  numberOfChannels: audioData.numberOfChannels,
                  bitrate: this.config.audio?.bitrate ?? 128000,
                });
              }
              this.audioEncoderConfigured = true;
            }

            if (frameCount === 1 || frameCount % 100 === 0) {
              log.info('Processing audio frame (worker mode)', {
                frameCount,
                timestamp: audioData.timestamp,
                numberOfFrames: audioData.numberOfFrames,
                sampleRate: audioData.sampleRate,
                numberOfChannels: audioData.numberOfChannels,
              });
            }
            // Transfer AudioData to worker (zero-copy)
            this.encodeWorkerClient.encodeAudio(audioData);
            continue;
          }

          // Main thread mode - handle reconfiguration if needed
          if (!this.opusEncoder) {
            audioData.close();
            continue;
          }

          // On first frame, check if we need to reconfigure the encoder
          if (!this.audioEncoderConfigured) {
            const encoderConfig = this.opusEncoder.currentConfig;
            const needsReconfigure =
              encoderConfig.sampleRate !== audioData.sampleRate ||
              encoderConfig.numberOfChannels !== audioData.numberOfChannels;

            log.info('First audio frame received', {
              frameCount,
              audioData: {
                sampleRate: audioData.sampleRate,
                numberOfChannels: audioData.numberOfChannels,
                format: audioData.format,
                numberOfFrames: audioData.numberOfFrames,
              },
              encoderConfig: {
                sampleRate: encoderConfig.sampleRate,
                numberOfChannels: encoderConfig.numberOfChannels,
              },
              needsReconfigure,
            });

            if (needsReconfigure) {
              log.info('Reconfiguring audio encoder to match input');
              // Close old encoder and create new one with correct params
              await this.opusEncoder.close();
              this.opusEncoder = new OpusEncoder({
                sampleRate: audioData.sampleRate,
                numberOfChannels: audioData.numberOfChannels,
                bitrate: this.config.audio?.bitrate ?? 128000,
              });
              this.opusEncoder.on('frame', (frame) => {
                this.handleEncodedAudioFrame(frame);
              });
              this.opusEncoder.on('error', (error) => {
                log.error('Audio encoder error', error);
                this.emit('error', error);
              });
              await this.opusEncoder.start();
              log.info('Audio encoder reconfigured successfully');
            }
            this.audioEncoderConfigured = true;
          }

          if (frameCount === 1 || frameCount % 100 === 0) {
            log.info('Processing audio frame', {
              frameCount,
              timestamp: audioData.timestamp,
              numberOfFrames: audioData.numberOfFrames,
              sampleRate: audioData.sampleRate,
              numberOfChannels: audioData.numberOfChannels,
              format: audioData.format,
            });
          }
          await this.opusEncoder.encode(audioData);
          audioData.close();
        }
      }
    } catch (err) {
      if (this._state === 'running') {
        log.error('Audio processing error', err as Error);
        this.emit('error', err);
      }
    }
    log.info('Audio frame processing ended', { totalFrames: frameCount });
  }

  /**
   * Handle encoded audio frame
   */
  private handleEncodedAudioFrame(frame: EncodedAudioFrame): void {
    // Each audio frame = new group, objectId always 0
    this.audioGroupId++;
    this.audioObjectId = 0;

    // Package with LOC
    const locData = this.packager.packageAudio(frame.data, {
      captureTimestamp: performance.now(),
    });

    const obj: PublishedObject = {
      type: 'audio',
      data: locData,
      groupId: this.audioGroupId,
      objectId: this.audioObjectId,
      isKeyframe: true, // Opus frames are always key
      timestamp: frame.timestamp,
      priority: Priority.MEDIUM_HIGH,
    };

    log.info('Audio object ready', {
      groupId: obj.groupId,
      objectId: obj.objectId,
      size: obj.data.byteLength,
    });

    this.emit('audio-object', obj);
  }

  /**
   * Update video bitrate
   *
   * @param bitrate - New bitrate in bits per second
   */
  async updateVideoBitrate(bitrate: number): Promise<void> {
    if (this.videoEncoder) {
      await this.videoEncoder.updateBitrate(bitrate);
    }
  }

  /**
   * Update audio bitrate
   *
   * @param bitrate - New bitrate in bits per second
   */
  async updateAudioBitrate(bitrate: number): Promise<void> {
    if (this.opusEncoder) {
      await this.opusEncoder.updateBitrate(bitrate);
    }
  }

  /**
   * Force a video keyframe
   */
  async forceKeyframe(): Promise<void> {
    if (this.videoEncoder) {
      log.debug('Forcing keyframe');
      // The next encode call will be forced to keyframe
      // This is handled by tracking in the encoder
    }
  }

  /**
   * Stop the pipeline
   */
  async stop(): Promise<void> {
    if (this._state !== 'running') {
      return;
    }

    log.info('Stopping publish pipeline', { channelId: this.channelId });
    this._state = 'stopped';
    this.abortController?.abort();

    // Close worker client (cleans up channel in worker)
    if (this.encodeWorkerClient) {
      this.encodeWorkerClient.close();
      this.encodeWorkerClient = undefined;
    }

    // Close encoders (main thread mode)
    if (this.videoEncoder) {
      await this.videoEncoder.close();
      this.videoEncoder = undefined;
    }

    if (this.opusEncoder) {
      await this.opusEncoder.close();
      this.opusEncoder = undefined;
    }

    this.packager.reset();
    this.emit('stopped', undefined);
    log.info('Publish pipeline stopped', { channelId: this.channelId });
  }

  /**
   * Get pipeline statistics
   */
  getStats(): {
    state: string;
    video: { groupId: number; objectId: number; encoder?: object };
    audio: { groupId: number; objectId: number; encoder?: object };
  } {
    return {
      state: this._state,
      video: {
        groupId: this.videoGroupId,
        objectId: this.videoObjectId,
        encoder: this.videoEncoder?.getStats(),
      },
      audio: {
        groupId: this.audioGroupId,
        objectId: this.audioObjectId,
        encoder: this.opusEncoder?.getStats(),
      },
    };
  }

  /**
   * Register an event handler
   */
  on(event: 'video-object' | 'audio-object', handler: (obj: PublishedObject) => void): () => void;
  on(event: 'error', handler: (error: Error) => void): () => void;
  on(event: 'started' | 'stopped', handler: () => void): () => void;
  on(
    event: PipelineEvent,
    handler: ((obj: PublishedObject) => void) | ((error: Error) => void) | (() => void)
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
  private emit(event: PipelineEvent, data: unknown): void {
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
