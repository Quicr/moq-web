// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview H.264 Video Encoder using WebCodecs
 *
 * Provides a high-level wrapper around the WebCodecs VideoEncoder API
 * for encoding video frames to H.264 format suitable for MOQT transmission.
 *
 * @see https://www.w3.org/TR/webcodecs/
 *
 * @example
 * ```typescript
 * import { H264Encoder } from '@web-moq/media';
 *
 * const encoder = new H264Encoder({
 *   width: 1280,
 *   height: 720,
 *   bitrate: 2_000_000,
 *   framerate: 30,
 * });
 *
 * encoder.on('frame', (encodedFrame) => {
 *   // Send to MOQT transport
 * });
 *
 * await encoder.start();
 * await encoder.encode(videoFrame);
 * ```
 */

import { Logger, acquireBufferForChunk } from '@web-moq/core';

const log = Logger.create('moqt:media:video-encoder');

/**
 * H.264 Profile identifiers
 * Format: avc1.PPCCLL where PP=profile, CC=constraints, LL=level
 * Level 3.0 (1E) supports 480p@30fps
 * Level 3.1 (1F) supports 720p@30fps
 * Level 4.0 (28) supports 1080p@30fps
 * Level 5.1 (33) supports 4K@30fps
 * Level 5.2 (34) supports 4K@60fps
 */
export const H264Profiles = {
  /** Constrained Baseline Profile Level 3.1 (720p) - best compatibility */
  CONSTRAINED_BASELINE: 'avc1.42001f',
  /** Constrained Baseline Profile Level 4.0 (1080p) */
  CONSTRAINED_BASELINE_L40: 'avc1.420028',
  /** Constrained Baseline Profile Level 3.0 (480p) */
  CONSTRAINED_BASELINE_L30: 'avc1.42001e',
  /** Baseline Profile Level 3.1 (720p) - good compatibility */
  BASELINE: 'avc1.42E01f',
  /** Baseline Profile Level 4.0 (1080p) */
  BASELINE_L40: 'avc1.42E028',
  /** Main Profile Level 3.1 (720p) - balance of compression and compatibility */
  MAIN: 'avc1.4D001f',
  /** Main Profile Level 4.0 (1080p) */
  MAIN_L40: 'avc1.4D0028',
  /** Main Profile Level 3.0 (480p) */
  MAIN_L30: 'avc1.4D001e',
  /** High Profile Level 3.1 (720p) - best compression */
  HIGH: 'avc1.64001f',
  /** High Profile Level 4.0 (1080p) */
  HIGH_L40: 'avc1.640028',
  /** High Profile Level 5.1 (4K@30fps) */
  HIGH_L51: 'avc1.640033',
  /** High Profile Level 5.2 (4K@60fps) */
  HIGH_L52: 'avc1.640034',
} as const;

/**
 * Get appropriate H.264 codec string for resolution
 * @param width - Video width
 * @param height - Video height
 * @param framerate - Optional framerate (default 30)
 * @returns Codec string with appropriate level
 */
export function getCodecForResolution(width: number, height: number, framerate = 30): string {
  const pixels = width * height;
  if (pixels > 1920 * 1080) {
    // 4K - Level 5.1 or 5.2 (High profile required)
    return framerate > 30 ? H264Profiles.HIGH_L52 : H264Profiles.HIGH_L51;
  } else if (pixels > 1280 * 720) {
    // 1080p - Level 4.0
    return H264Profiles.CONSTRAINED_BASELINE_L40;
  } else if (pixels > 854 * 480) {
    // 720p - Level 3.1
    return H264Profiles.CONSTRAINED_BASELINE;
  } else {
    // 480p or lower - Level 3.0
    return H264Profiles.CONSTRAINED_BASELINE_L30;
  }
}

/**
 * Fallback profile order for 4K (High profile required for this resolution)
 */
const PROFILE_FALLBACK_ORDER_4K = [
  H264Profiles.HIGH_L51,
  H264Profiles.HIGH_L52,
];

/**
 * Fallback profile order for 720p (most to least compatible)
 */
const PROFILE_FALLBACK_ORDER_720P = [
  H264Profiles.CONSTRAINED_BASELINE,
  H264Profiles.BASELINE,
  H264Profiles.MAIN,
  H264Profiles.HIGH,
];

/**
 * Fallback profile order for 1080p (most to least compatible)
 */
const PROFILE_FALLBACK_ORDER_1080P = [
  H264Profiles.CONSTRAINED_BASELINE_L40,
  H264Profiles.BASELINE_L40,
  H264Profiles.MAIN_L40,
  H264Profiles.HIGH_L40,
];

/**
 * Fallback profile order for 480p (most to least compatible)
 */
const PROFILE_FALLBACK_ORDER_480P = [
  H264Profiles.CONSTRAINED_BASELINE_L30,
  H264Profiles.MAIN_L30,
  H264Profiles.CONSTRAINED_BASELINE, // Fall back to 720p level
  H264Profiles.MAIN,
];

/**
 * Get fallback profile order based on resolution
 */
function getProfileFallbackOrder(width: number, height: number): string[] {
  const pixels = width * height;
  if (pixels > 1920 * 1080) {
    return PROFILE_FALLBACK_ORDER_4K;
  } else if (pixels > 1280 * 720) {
    return PROFILE_FALLBACK_ORDER_1080P;
  } else if (pixels > 854 * 480) {
    return PROFILE_FALLBACK_ORDER_720P;
  } else {
    return PROFILE_FALLBACK_ORDER_480P;
  }
}

/**
 * Video encoder configuration
 */
export interface VideoEncoderConfig {
  /** Video width in pixels */
  width: number;
  /** Video height in pixels */
  height: number;
  /** Target bitrate in bits per second */
  bitrate: number;
  /** Target framerate */
  framerate: number;
  /** H.264 profile (default: MAIN) */
  profile?: string;
  /** Keyframe interval in seconds (default: 2) */
  keyframeInterval?: number;
  /** Hardware acceleration preference (default: 'prefer-hardware') */
  hardwareAcceleration?: 'prefer-hardware' | 'prefer-software' | 'no-preference';
  /** Latency mode (default: 'realtime') */
  latencyMode?: 'quality' | 'realtime';
  /** AVC format (default: 'annexb') */
  avcFormat?: 'annexb' | 'avc';
}

/**
 * Encoded video frame output
 */
export interface EncodedVideoFrame {
  /** Encoded data */
  data: Uint8Array;
  /** Whether this is a keyframe */
  isKeyframe: boolean;
  /** Presentation timestamp in microseconds */
  timestamp: number;
  /** Duration in microseconds */
  duration: number;
  /** Frame width */
  width: number;
  /** Frame height */
  height: number;
  /** Codec description (for first keyframe) */
  codecDescription?: Uint8Array;
}

/**
 * Encoder event types
 */
export type VideoEncoderEvent = 'frame' | 'error' | 'closed';

/**
 * H.264 Video Encoder
 *
 * @remarks
 * Wraps the WebCodecs VideoEncoder API to encode video frames
 * to H.264 format. Automatically handles keyframe generation,
 * bitrate control, and codec configuration.
 *
 * @example
 * ```typescript
 * const encoder = new H264Encoder({
 *   width: 1920,
 *   height: 1080,
 *   bitrate: 4_000_000,
 *   framerate: 30,
 *   keyframeInterval: 2,
 * });
 *
 * // Listen for encoded frames
 * encoder.on('frame', (frame) => {
 *   if (frame.isKeyframe) {
 *     console.log('Keyframe:', frame.data.byteLength, 'bytes');
 *   }
 *   sendToTransport(frame);
 * });
 *
 * // Start encoding
 * await encoder.start();
 *
 * // Encode video frames from canvas or camera
 * const stream = canvas.captureStream(30);
 * const videoTrack = stream.getVideoTracks()[0];
 * const reader = new MediaStreamTrackProcessor({ track: videoTrack }).readable.getReader();
 *
 * while (true) {
 *   const { value: frame, done } = await reader.read();
 *   if (done) break;
 *   await encoder.encode(frame);
 *   frame.close();
 * }
 * ```
 */
export class H264Encoder {
  /** Underlying WebCodecs encoder */
  private encoder?: VideoEncoder;
  /** Configuration */
  private config: Required<VideoEncoderConfig>;
  /** Event handlers */
  private handlers = new Map<VideoEncoderEvent, Set<(data: unknown) => void>>();
  /** Encoder state */
  private _state: 'idle' | 'running' | 'closed' = 'idle';
  /** Frame counter for keyframe timing */
  private frameCount = 0;
  /** Keyframe interval in frames */
  private keyframeIntervalFrames: number;
  /** Statistics */
  private stats = {
    framesEncoded: 0,
    keyframes: 0,
    bytesEncoded: 0,
    errors: 0,
  };
  /** Pending codec description */
  private pendingDescription?: Uint8Array;

  /**
   * Create a new H264Encoder
   *
   * @param config - Encoder configuration
   */
  constructor(config: VideoEncoderConfig) {
    this.config = {
      width: config.width,
      height: config.height,
      bitrate: config.bitrate,
      framerate: config.framerate,
      profile: config.profile ?? H264Profiles.CONSTRAINED_BASELINE,
      keyframeInterval: config.keyframeInterval ?? 2,
      hardwareAcceleration: config.hardwareAcceleration ?? 'no-preference',
      latencyMode: config.latencyMode ?? 'realtime',
      avcFormat: config.avcFormat ?? 'annexb',
    };

    this.keyframeIntervalFrames = Math.round(
      this.config.keyframeInterval * this.config.framerate
    );

    log.debug('H264Encoder created', {
      ...this.config,
      keyframeIntervalFrames: this.keyframeIntervalFrames,
    });
  }

  /**
   * Get encoder state
   */
  get state(): 'idle' | 'running' | 'closed' {
    return this._state;
  }

  /**
   * Check if encoder is running
   */
  get isRunning(): boolean {
    return this._state === 'running';
  }

  /**
   * Get current configuration
   */
  get currentConfig(): Readonly<Required<VideoEncoderConfig>> {
    return this.config;
  }

  /**
   * Check if H.264 encoding is supported
   *
   * @param config - Configuration to check
   * @returns Support status
   */
  static async isSupported(config: VideoEncoderConfig): Promise<boolean> {
    try {
      const result = await VideoEncoder.isConfigSupported({
        codec: config.profile ?? H264Profiles.MAIN,
        width: config.width,
        height: config.height,
        bitrate: config.bitrate,
        framerate: config.framerate,
      });
      return result.supported ?? false;
    } catch {
      return false;
    }
  }

  /**
   * Start the encoder
   *
   * @throws Error if encoder is already running or WebCodecs unavailable
   */
  async start(): Promise<void> {
    if (this._state === 'running') {
      throw new Error('Encoder already running');
    }

    if (this._state === 'closed') {
      throw new Error('Encoder is closed');
    }

    if (!('VideoEncoder' in globalThis)) {
      throw new Error('WebCodecs VideoEncoder not supported');
    }

    log.info('Starting H264 encoder', {
      resolution: `${this.config.width}x${this.config.height}`,
      bitrate: this.config.bitrate,
      framerate: this.config.framerate,
    });

    // Try to find a supported profile
    let workingProfile: string | null = null;

    // First, try the configured profile
    if (await H264Encoder.isSupported(this.config)) {
      workingProfile = this.config.profile;
    } else {
      // Try fallback profiles based on resolution
      log.warn('Configured profile not supported, trying fallbacks', {
        profile: this.config.profile,
      });

      const fallbackOrder = getProfileFallbackOrder(this.config.width, this.config.height);
      for (const profile of fallbackOrder) {
        const testConfig = { ...this.config, profile };
        if (await H264Encoder.isSupported(testConfig)) {
          workingProfile = profile;
          log.info('Found supported profile', { profile });
          break;
        }
      }
    }

    if (!workingProfile) {
      throw new Error('No H.264 encoding configuration supported by this browser');
    }

    // Update config with working profile
    this.config.profile = workingProfile;

    // Create encoder
    this.encoder = new VideoEncoder({
      output: this.handleOutput.bind(this),
      error: this.handleError.bind(this),
    });

    // Configure encoder
    const codecConfig: VideoEncoderConfig_WebCodecs = {
      codec: this.config.profile,
      width: this.config.width,
      height: this.config.height,
      bitrate: this.config.bitrate,
      framerate: this.config.framerate,
      hardwareAcceleration: this.config.hardwareAcceleration,
      latencyMode: this.config.latencyMode,
      avc: { format: this.config.avcFormat },
    };

    this.encoder.configure(codecConfig);
    this._state = 'running';

    log.info('H264 encoder started', { profile: this.config.profile });
  }

  /**
   * Encode a video frame
   *
   * @param frame - VideoFrame to encode
   * @param forceKeyframe - Force this frame to be a keyframe
   *
   * @example
   * ```typescript
   * // Encode with automatic keyframe timing
   * await encoder.encode(frame);
   *
   * // Force a keyframe
   * await encoder.encode(frame, true);
   * ```
   */
  async encode(frame: VideoFrame, forceKeyframe = false): Promise<void> {
    if (!this.encoder || this._state !== 'running') {
      log.warn('Cannot encode: encoder not running', { state: this._state });
      return; // Silently skip instead of throwing to avoid crashing processing loop
    }

    const keyFrame = forceKeyframe ||
      this.frameCount % this.keyframeIntervalFrames === 0;

    log.trace('Encoding frame', {
      timestamp: frame.timestamp,
      keyFrame,
      frameCount: this.frameCount,
    });

    try {
      this.encoder.encode(frame, { keyFrame });
      this.frameCount++;
    } catch (err) {
      // WebCodecs encoder may have closed externally
      log.error('Encode failed', err as Error);
      this._state = 'closed';
      this.encoder = undefined;
      this.emit('error', err as Error);
    }
  }

  /**
   * Flush pending frames
   */
  async flush(): Promise<void> {
    if (!this.encoder || this._state !== 'running') {
      return;
    }

    log.debug('Flushing encoder');
    await this.encoder.flush();
  }

  /**
   * Update bitrate
   *
   * @param bitrate - New bitrate in bits per second
   */
  async updateBitrate(bitrate: number): Promise<void> {
    if (!this.encoder || this._state !== 'running') {
      return;
    }

    this.config.bitrate = bitrate;

    // Reconfigure with new bitrate
    const codecConfig: VideoEncoderConfig_WebCodecs = {
      codec: this.config.profile,
      width: this.config.width,
      height: this.config.height,
      bitrate,
      framerate: this.config.framerate,
      hardwareAcceleration: this.config.hardwareAcceleration,
      latencyMode: this.config.latencyMode,
      avc: { format: this.config.avcFormat },
    };

    this.encoder.configure(codecConfig);
    log.info('Bitrate updated', { bitrate });
  }

  /**
   * Close the encoder
   */
  async close(): Promise<void> {
    if (this._state === 'closed') {
      return;
    }

    log.info('Closing H264 encoder');

    if (this.encoder) {
      try {
        await this.encoder.flush();
        this.encoder.close();
      } catch (err) {
        log.warn('Error closing encoder', err as Error);
      }
    }

    this.encoder = undefined;
    this._state = 'closed';
    this.emit('closed', undefined);
  }

  /**
   * Handle encoder output
   */
  private handleOutput(
    chunk: EncodedVideoChunk,
    metadata?: EncodedVideoChunkMetadata
  ): void {
    // Use pooled buffer to reduce allocations
    const data = acquireBufferForChunk(chunk);

    const isKeyframe = chunk.type === 'key';

    // Capture codec description from first keyframe
    if (isKeyframe && metadata?.decoderConfig?.description && !this.pendingDescription) {
      const desc = metadata.decoderConfig.description;
      if (desc instanceof ArrayBuffer) {
        this.pendingDescription = new Uint8Array(desc);
      } else if (ArrayBuffer.isView(desc)) {
        this.pendingDescription = new Uint8Array(desc.buffer, desc.byteOffset, desc.byteLength);
      }
    }

    const frame: EncodedVideoFrame = {
      data,
      isKeyframe,
      timestamp: chunk.timestamp,
      duration: chunk.duration ?? 0,
      width: this.config.width,
      height: this.config.height,
      codecDescription: isKeyframe ? this.pendingDescription : undefined,
    };

    this.stats.framesEncoded++;
    this.stats.bytesEncoded += data.byteLength;
    if (isKeyframe) {
      this.stats.keyframes++;
    }

    log.info('Frame encoded', {
      isKeyframe,
      size: data.byteLength,
      timestamp: chunk.timestamp,
      framesEncoded: this.stats.framesEncoded,
    });

    this.emit('frame', frame);
  }

  /**
   * Handle encoder error
   */
  private handleError(error: DOMException): void {
    log.error('Encoder error', error);
    this.stats.errors++;

    // WebCodecs encoder may close itself on error - update our state
    this._state = 'closed';
    this.encoder = undefined;

    this.emit('error', error);
  }

  /**
   * Register an event handler
   *
   * @param event - Event type
   * @param handler - Handler function
   * @returns Unsubscribe function
   */
  on(event: 'frame', handler: (frame: EncodedVideoFrame) => void): () => void;
  on(event: 'error', handler: (error: Error) => void): () => void;
  on(event: 'closed', handler: () => void): () => void;
  on(
    event: VideoEncoderEvent,
    handler: ((frame: EncodedVideoFrame) => void) | ((error: Error) => void) | (() => void)
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
  private emit(event: VideoEncoderEvent, data: unknown): void {
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
   * Get encoder statistics
   */
  getStats(): {
    framesEncoded: number;
    keyframes: number;
    bytesEncoded: number;
    errors: number;
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
      framesEncoded: 0,
      keyframes: 0,
      bytesEncoded: 0,
      errors: 0,
    };
  }
}

// Type for WebCodecs VideoEncoderConfig
interface VideoEncoderConfig_WebCodecs {
  codec: string;
  width: number;
  height: number;
  bitrate: number;
  framerate: number;
  hardwareAcceleration: 'prefer-hardware' | 'prefer-software' | 'no-preference';
  latencyMode: 'quality' | 'realtime';
  avc?: { format: 'annexb' | 'avc' };
}
