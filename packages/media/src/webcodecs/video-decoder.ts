// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview H.264 Video Decoder using WebCodecs
 *
 * Provides a high-level wrapper around the WebCodecs VideoDecoder API
 * for decoding H.264 video frames received via MOQT.
 *
 * @example
 * ```typescript
 * import { H264Decoder } from '@web-moq/media';
 *
 * const decoder = new H264Decoder();
 *
 * decoder.on('frame', (videoFrame) => {
 *   // Render the frame
 *   ctx.drawImage(videoFrame, 0, 0);
 *   videoFrame.close();
 * });
 *
 * await decoder.start({
 *   codec: 'avc1.4D401E',
 *   codedWidth: 1280,
 *   codedHeight: 720,
 * });
 *
 * // Decode received frames
 * decoder.decode(encodedData, isKeyframe, timestamp);
 * ```
 */

import { Logger } from '@web-moq/core';

const log = Logger.create('moqt:media:video-decoder');

/**
 * Video decoder configuration
 */
export interface VideoDecoderConfig {
  /** H.264 codec string (e.g., 'avc1.4D401E') */
  codec: string;
  /** Coded video width */
  codedWidth: number;
  /** Coded video height */
  codedHeight: number;
  /** Codec description (AVC decoder configuration record) */
  description?: Uint8Array;
  /** Hardware acceleration preference */
  hardwareAcceleration?: 'prefer-hardware' | 'prefer-software' | 'no-preference';
  /** Optimize for latency */
  optimizeForLatency?: boolean;
}

/**
 * Decoder event types
 */
export type VideoDecoderEvent = 'frame' | 'error' | 'closed';

/**
 * H.264 Video Decoder
 *
 * @remarks
 * Wraps the WebCodecs VideoDecoder API to decode H.264 video frames.
 * Outputs VideoFrame objects that can be rendered to canvas or
 * used with other Web APIs.
 *
 * @example
 * ```typescript
 * const decoder = new H264Decoder();
 *
 * // Listen for decoded frames
 * decoder.on('frame', (frame) => {
 *   // Draw to canvas
 *   ctx.drawImage(frame, 0, 0);
 *   // Important: close frame to release resources
 *   frame.close();
 * });
 *
 * // Configure and start
 * await decoder.start({
 *   codec: 'avc1.4D401E',
 *   codedWidth: 1920,
 *   codedHeight: 1080,
 * });
 *
 * // Decode frames as they arrive
 * transport.on('object', (obj) => {
 *   if (isVideoObject(obj)) {
 *     decoder.decode(obj.payload, obj.header.objectId === 0, obj.header.timestamp);
 *   }
 * });
 * ```
 */
/** Instance counter for debugging */
let decoderInstanceCounter = 0;

export class H264Decoder {
  /** Unique instance ID for debugging */
  private instanceId: number;
  /** Underlying WebCodecs decoder */
  private decoder?: VideoDecoder;
  /** Current configuration */
  private config?: VideoDecoderConfig;
  /** Event handlers */
  private handlers = new Map<VideoDecoderEvent, Set<(data: unknown) => void>>();
  /** Decoder state */
  private _state: 'idle' | 'running' | 'closed' = 'idle';
  /** Statistics */
  private stats = {
    framesDecoded: 0,
    keyframes: 0,
    errors: 0,
    droppedFrames: 0,
  };
  /** Whether we've received a keyframe */
  private hasKeyframe = false;
  /** Current group ID being decoded */
  private currentGroupId = -1;

  /**
   * Create a new H264Decoder
   */
  constructor() {
    this.instanceId = ++decoderInstanceCounter;
    log.info('H264Decoder created', { instanceId: this.instanceId });
  }

  /**
   * Get decoder state
   */
  get state(): 'idle' | 'running' | 'closed' {
    return this._state;
  }

  /**
   * Get instance ID for debugging
   */
  get id(): number {
    return this.instanceId;
  }

  /**
   * Check if decoder is running
   */
  get isRunning(): boolean {
    return this._state === 'running';
  }

  /**
   * Check if H.264 decoding is supported
   *
   * @param config - Configuration to check
   * @returns Support status
   */
  static async isSupported(config: VideoDecoderConfig): Promise<boolean> {
    try {
      const result = await VideoDecoder.isConfigSupported({
        codec: config.codec,
        codedWidth: config.codedWidth,
        codedHeight: config.codedHeight,
        description: config.description,
      });
      return result.supported ?? false;
    } catch {
      return false;
    }
  }

  /**
   * Start the decoder
   *
   * @param config - Decoder configuration
   */
  async start(config: VideoDecoderConfig): Promise<void> {
    if (this._state === 'running') {
      throw new Error('Decoder already running');
    }

    if (this._state === 'closed') {
      throw new Error('Decoder is closed');
    }

    if (!('VideoDecoder' in globalThis)) {
      throw new Error('WebCodecs VideoDecoder not supported');
    }

    this.config = {
      ...config,
      hardwareAcceleration: config.hardwareAcceleration ?? 'prefer-hardware',
      optimizeForLatency: config.optimizeForLatency ?? true,
    };

    log.info('Starting H264 decoder', {
      codec: this.config.codec,
      resolution: `${this.config.codedWidth}x${this.config.codedHeight}`,
    });

    // Check support
    const supported = await H264Decoder.isSupported(this.config);
    if (!supported) {
      throw new Error('H.264 decoding configuration not supported');
    }

    // Create decoder
    this.decoder = new VideoDecoder({
      output: this.handleOutput.bind(this),
      error: this.handleError.bind(this),
    });

    // Configure decoder
    this.decoder.configure({
      codec: this.config.codec,
      codedWidth: this.config.codedWidth,
      codedHeight: this.config.codedHeight,
      description: this.config.description,
      hardwareAcceleration: this.config.hardwareAcceleration,
      optimizeForLatency: this.config.optimizeForLatency,
    });

    this._state = 'running';
    this.hasKeyframe = false;
    this.currentGroupId = -1;
    log.info('H264 decoder started');
  }

  /**
   * Reconfigure the decoder
   *
   * @param config - New configuration
   */
  async reconfigure(config: Partial<VideoDecoderConfig>): Promise<void> {
    if (!this.decoder || !this.config) {
      throw new Error('Decoder not running');
    }

    this.config = { ...this.config, ...config };

    log.info('Reconfiguring decoder', this.config);

    await this.flush();

    this.decoder.configure({
      codec: this.config.codec,
      codedWidth: this.config.codedWidth,
      codedHeight: this.config.codedHeight,
      description: this.config.description,
      hardwareAcceleration: this.config.hardwareAcceleration,
      optimizeForLatency: this.config.optimizeForLatency,
    });

    this.hasKeyframe = false;
    this.currentGroupId = -1;
  }

  /**
   * Decode an encoded video frame
   *
   * @param data - Encoded frame data
   * @param isKeyframe - Whether this is a keyframe
   * @param timestamp - Presentation timestamp in microseconds
   * @param duration - Duration in microseconds (optional)
   *
   * @example
   * ```typescript
   * // Decode a keyframe
   * decoder.decode(keyframeData, true, timestamp);
   *
   * // Decode a delta frame
   * decoder.decode(deltaData, false, timestamp);
   * ```
   */
  decode(
    data: Uint8Array,
    isKeyframe: boolean,
    timestamp: number,
    duration?: number,
    groupId?: number
  ): void {
    if (!this.decoder || this._state !== 'running') {
      throw new Error('Decoder not running');
    }

    // Check if the underlying WebCodecs decoder was closed unexpectedly
    if (this.decoder.state === 'closed') {
      log.warn('Decoder was closed unexpectedly, attempting to recreate', {
        instanceId: this.instanceId,
      });

      // Try to recreate the decoder
      if (this.config) {
        try {
          this.decoder = new VideoDecoder({
            output: this.handleOutput.bind(this),
            error: this.handleError.bind(this),
          });

          this.decoder.configure({
            codec: this.config.codec,
            codedWidth: this.config.codedWidth,
            codedHeight: this.config.codedHeight,
            description: this.config.description,
            hardwareAcceleration: this.config.hardwareAcceleration,
            optimizeForLatency: this.config.optimizeForLatency,
          });

          this.hasKeyframe = false;
          this.currentGroupId = -1;
          log.info('Decoder recreated successfully', { instanceId: this.instanceId });
        } catch (err) {
          log.error('Failed to recreate decoder', err as Error);
          this._state = 'closed';
          throw new Error('Decoder closed and could not be recreated');
        }
      } else {
        this._state = 'closed';
        throw new Error('Decoder closed and no config available for recreation');
      }
    }

    // Check for group change - if new group, we need to wait for its keyframe
    if (groupId !== undefined && groupId !== this.currentGroupId) {
      if (!isKeyframe) {
        // Delta frame from new group - need to wait for keyframe
        this.stats.droppedFrames++;
        if (this.stats.droppedFrames % 30 === 1) {
          log.debug('Dropping delta frame - waiting for keyframe of new group', {
            currentGroupId: this.currentGroupId,
            frameGroupId: groupId,
            droppedCount: this.stats.droppedFrames,
          });
        }
        return;
      }
      // Keyframe from new group - update current group
      this.currentGroupId = groupId;
      this.hasKeyframe = false; // Reset to ensure we process this keyframe
      log.debug('New group started', { groupId, previousGroupId: this.currentGroupId });
    }

    // Wait for keyframe to start decoding
    if (!this.hasKeyframe && !isKeyframe) {
      this.stats.droppedFrames++;
      // Only log occasionally to reduce overhead
      if (this.stats.droppedFrames % 30 === 1) {
        log.debug('Dropping frames - waiting for keyframe', {
          droppedCount: this.stats.droppedFrames,
        });
      }
      return;
    }

    if (isKeyframe) {
      this.hasKeyframe = true;
      this.stats.keyframes++;
      if (groupId !== undefined) {
        this.currentGroupId = groupId;
      }
      log.debug('Received keyframe', { keyframeCount: this.stats.keyframes, groupId });
    }

    const chunk = new EncodedVideoChunk({
      type: isKeyframe ? 'key' : 'delta',
      data,
      timestamp,
      duration,
    });

    this.decoder.decode(chunk);
  }

  /**
   * Flush the decoder
   */
  async flush(): Promise<void> {
    if (!this.decoder || this._state !== 'running') {
      return;
    }

    log.debug('Flushing decoder');
    await this.decoder.flush();
  }

  /**
   * Reset the decoder (clears internal state)
   */
  async reset(): Promise<void> {
    if (!this.decoder || this._state !== 'running') {
      return;
    }

    log.debug('Resetting decoder');
    this.decoder.reset();
    this.hasKeyframe = false;
    this.currentGroupId = -1;

    // Reconfigure
    if (this.config) {
      this.decoder.configure({
        codec: this.config.codec,
        codedWidth: this.config.codedWidth,
        codedHeight: this.config.codedHeight,
        description: this.config.description,
        hardwareAcceleration: this.config.hardwareAcceleration,
        optimizeForLatency: this.config.optimizeForLatency,
      });
    }
  }

  /**
   * Close the decoder
   */
  async close(): Promise<void> {
    if (this._state === 'closed') {
      return;
    }

    log.info('Closing H264 decoder');

    if (this.decoder) {
      try {
        await this.decoder.flush();
        this.decoder.close();
      } catch (err) {
        log.warn('Error closing decoder', err as Error);
      }
    }

    this.decoder = undefined;
    this.config = undefined;
    this._state = 'closed';
    this.emit('closed', undefined);
  }

  /**
   * Handle decoder output
   */
  private handleOutput(frame: VideoFrame): void {
    this.stats.framesDecoded++;

    // Log stats every 30 frames to reduce overhead
    if (this.stats.framesDecoded % 30 === 0) {
      log.debug('Video decode stats', {
        instanceId: this.instanceId,
        framesDecoded: this.stats.framesDecoded,
        width: frame.displayWidth,
        height: frame.displayHeight,
      });
    }

    this.emit('frame', frame);
  }

  /**
   * Handle decoder error
   */
  private handleError(error: DOMException): void {
    log.error('Decoder error', error);
    this.stats.errors++;
    // Reset keyframe state to force waiting for new keyframe after error
    // This helps recover from corrupted frame sequences
    this.hasKeyframe = false;
    this.emit('error', error);
  }

  /**
   * Register an event handler
   */
  on(event: 'frame', handler: (frame: VideoFrame) => void): () => void;
  on(event: 'error', handler: (error: Error) => void): () => void;
  on(event: 'closed', handler: () => void): () => void;
  on(
    event: VideoDecoderEvent,
    handler: ((frame: VideoFrame) => void) | ((error: Error) => void) | (() => void)
  ): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler as (data: unknown) => void);

    log.debug('Handler registered for event', {
      instanceId: this.instanceId,
      event,
      totalHandlers: this.handlers.get(event)!.size,
    });

    return () => {
      this.handlers.get(event)?.delete(handler as (data: unknown) => void);
      log.debug('Handler unregistered for event', {
        event,
        totalHandlers: this.handlers.get(event)?.size ?? 0,
      });
    };
  }

  /**
   * Emit an event
   */
  private emit(event: VideoDecoderEvent, data: unknown): void {
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

  /**
   * Get decoder statistics
   */
  getStats(): {
    framesDecoded: number;
    keyframes: number;
    errors: number;
    droppedFrames: number;
    state: string;
  } {
    return {
      ...this.stats,
      state: this._state,
    };
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    this.stats = {
      framesDecoded: 0,
      keyframes: 0,
      errors: 0,
      droppedFrames: 0,
    };
  }
}
