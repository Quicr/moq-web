// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Opus Audio Encoder using WebCodecs
 *
 * Provides a high-level wrapper around the WebCodecs AudioEncoder API
 * for encoding audio to Opus format suitable for MOQT transmission.
 *
 * @see https://www.w3.org/TR/webcodecs/
 *
 * @example
 * ```typescript
 * import { OpusEncoder } from '@web-moq/media';
 *
 * const encoder = new OpusEncoder({
 *   sampleRate: 48000,
 *   numberOfChannels: 2,
 *   bitrate: 128000,
 * });
 *
 * encoder.on('frame', (encodedFrame) => {
 *   // Send to MOQT transport
 * });
 *
 * await encoder.start();
 * await encoder.encode(audioData);
 * ```
 */

import { Logger, acquireBufferForChunk } from '@web-moq/core';

const log = Logger.create('moqt:media:audio-encoder');

/**
 * Audio encoder configuration
 */
export interface OpusEncoderOptions {
  /** Sample rate in Hz (default: 48000) */
  sampleRate?: number;
  /** Number of audio channels (default: 2) */
  numberOfChannels?: number;
  /** Target bitrate in bits per second (default: 128000) */
  bitrate?: number;
  /** Opus application mode (default: 'audio') */
  application?: 'voip' | 'audio' | 'lowdelay';
}

/**
 * Encoded audio frame output
 */
export interface EncodedAudioFrame {
  /** Encoded data */
  data: Uint8Array;
  /** Presentation timestamp in microseconds */
  timestamp: number;
  /** Duration in microseconds */
  duration: number;
  /** Number of samples */
  numberOfFrames: number;
  /** Sample rate */
  sampleRate: number;
  /** Number of channels */
  numberOfChannels: number;
}

/**
 * Encoder event types
 */
export type AudioEncoderEvent = 'frame' | 'error' | 'closed';

/**
 * Opus Audio Encoder
 *
 * @remarks
 * Wraps the WebCodecs AudioEncoder API to encode audio data
 * to Opus format. Opus is well-suited for both speech and music,
 * and provides good quality at low bitrates.
 *
 * @example
 * ```typescript
 * const encoder = new OpusEncoder({
 *   sampleRate: 48000,
 *   numberOfChannels: 2,
 *   bitrate: 128000,
 * });
 *
 * // Listen for encoded frames
 * encoder.on('frame', (frame) => {
 *   sendToTransport(frame);
 * });
 *
 * // Start encoding
 * await encoder.start();
 *
 * // Encode audio from microphone
 * const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
 * const audioTrack = stream.getAudioTracks()[0];
 * const reader = new MediaStreamTrackProcessor({ track: audioTrack }).readable.getReader();
 *
 * while (true) {
 *   const { value: audioData, done } = await reader.read();
 *   if (done) break;
 *   await encoder.encode(audioData);
 *   audioData.close();
 * }
 * ```
 */
export class OpusEncoder {
  /** Underlying WebCodecs encoder */
  private encoder?: AudioEncoder;
  /** Configuration */
  private config: Required<OpusEncoderOptions>;
  /** Event handlers */
  private handlers = new Map<AudioEncoderEvent, Set<(data: unknown) => void>>();
  /** Encoder state */
  private _state: 'idle' | 'running' | 'closed' = 'idle';
  /** Statistics */
  private stats = {
    framesEncoded: 0,
    bytesEncoded: 0,
    errors: 0,
  };

  /**
   * Create a new OpusEncoder
   *
   * @param config - Encoder configuration
   */
  constructor(config: OpusEncoderOptions = {}) {
    this.config = {
      sampleRate: config.sampleRate ?? 48000,
      numberOfChannels: config.numberOfChannels ?? 2,
      bitrate: config.bitrate ?? 128000,
      application: config.application ?? 'audio',
    };

    log.debug('OpusEncoder created', this.config);
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
  get currentConfig(): Readonly<Required<OpusEncoderOptions>> {
    return this.config;
  }

  /**
   * Check if Opus encoding is supported
   *
   * @param config - Configuration to check
   * @returns Support status
   */
  static async isSupported(config: OpusEncoderOptions = {}): Promise<boolean> {
    try {
      const result = await AudioEncoder.isConfigSupported({
        codec: 'opus',
        sampleRate: config.sampleRate ?? 48000,
        numberOfChannels: config.numberOfChannels ?? 2,
        bitrate: config.bitrate ?? 128000,
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

    if (!('AudioEncoder' in globalThis)) {
      throw new Error('WebCodecs AudioEncoder not supported');
    }

    log.info('Starting Opus encoder', {
      sampleRate: this.config.sampleRate,
      channels: this.config.numberOfChannels,
      bitrate: this.config.bitrate,
    });

    // Check support with detailed logging
    try {
      const supportResult = await AudioEncoder.isConfigSupported({
        codec: 'opus',
        sampleRate: this.config.sampleRate,
        numberOfChannels: this.config.numberOfChannels,
        bitrate: this.config.bitrate,
      });
      log.info('Opus encoder support check', {
        supported: supportResult.supported,
        config: supportResult.config,
      });
      if (!supportResult.supported) {
        throw new Error(`Opus encoding not supported: sampleRate=${this.config.sampleRate}, channels=${this.config.numberOfChannels}, bitrate=${this.config.bitrate}`);
      }
    } catch (err) {
      log.error('Opus support check failed', err as Error);
      throw err;
    }

    // Create encoder
    this.encoder = new AudioEncoder({
      output: this.handleOutput.bind(this),
      error: this.handleError.bind(this),
    });

    // Configure encoder
    try {
      this.encoder.configure({
        codec: 'opus',
        sampleRate: this.config.sampleRate,
        numberOfChannels: this.config.numberOfChannels,
        bitrate: this.config.bitrate,
      } as AudioEncoderConfig);
      log.info('Opus encoder configured successfully');
    } catch (err) {
      log.error('Opus encoder configure failed', err as Error);
      throw err;
    }

    this._state = 'running';
    log.info('Opus encoder started');
  }

  /**
   * Encode audio data
   *
   * @param audioData - AudioData to encode
   *
   * @example
   * ```typescript
   * await encoder.encode(audioData);
   * ```
   */
  async encode(audioData: AudioData): Promise<void> {
    if (!this.encoder || this._state !== 'running') {
      log.warn('Cannot encode: encoder not running', { state: this._state });
      return; // Silently skip instead of throwing to avoid crashing processing loop
    }

    log.trace('Encoding audio', {
      timestamp: audioData.timestamp,
      numberOfFrames: audioData.numberOfFrames,
    });

    try {
      this.encoder.encode(audioData);
    } catch (err) {
      // WebCodecs encoder may have closed externally
      log.error('Encode failed', err as Error);
      this._state = 'closed';
      this.encoder = undefined;
      this.emit('error', err as Error);
    }
  }

  /**
   * Flush pending audio
   */
  async flush(): Promise<void> {
    if (!this.encoder || this._state !== 'running') {
      return;
    }

    log.debug('Flushing audio encoder');
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
    this.encoder.configure({
      codec: 'opus',
      sampleRate: this.config.sampleRate,
      numberOfChannels: this.config.numberOfChannels,
      bitrate,
    } as AudioEncoderConfig);

    log.info('Audio bitrate updated', { bitrate });
  }

  /**
   * Close the encoder
   */
  async close(): Promise<void> {
    if (this._state === 'closed') {
      return;
    }

    log.info('Closing Opus encoder');

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
    chunk: EncodedAudioChunk,
    _metadata?: EncodedAudioChunkMetadata
  ): void {
    // Use pooled buffer to reduce allocations
    const data = acquireBufferForChunk(chunk);

    const frame: EncodedAudioFrame = {
      data,
      timestamp: chunk.timestamp,
      duration: chunk.duration ?? 0,
      numberOfFrames: 0, // Not directly available from chunk
      sampleRate: this.config.sampleRate,
      numberOfChannels: this.config.numberOfChannels,
    };

    this.stats.framesEncoded++;
    this.stats.bytesEncoded += data.byteLength;

    log.trace('Audio frame encoded', {
      size: data.byteLength,
      timestamp: chunk.timestamp,
    });

    this.emit('frame', frame);
  }

  /**
   * Handle encoder error
   */
  private handleError(error: DOMException): void {
    log.error('Audio encoder error', error);
    this.stats.errors++;

    // WebCodecs encoder may close itself on error - update our state
    this._state = 'closed';
    this.encoder = undefined;

    this.emit('error', error);
  }

  /**
   * Register an event handler
   */
  on(event: 'frame', handler: (frame: EncodedAudioFrame) => void): () => void;
  on(event: 'error', handler: (error: Error) => void): () => void;
  on(event: 'closed', handler: () => void): () => void;
  on(
    event: AudioEncoderEvent,
    handler: ((frame: EncodedAudioFrame) => void) | ((error: Error) => void) | (() => void)
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
  private emit(event: AudioEncoderEvent, data: unknown): void {
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
      bytesEncoded: 0,
      errors: 0,
    };
  }
}
