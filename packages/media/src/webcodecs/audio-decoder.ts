// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Opus Audio Decoder using WebCodecs
 *
 * Provides a high-level wrapper around the WebCodecs AudioDecoder API
 * for decoding Opus audio frames received via MOQT.
 *
 * @example
 * ```typescript
 * import { OpusDecoder } from '@web-moq/media';
 *
 * const decoder = new OpusDecoder();
 *
 * decoder.on('frame', (audioData) => {
 *   // Process audio data
 *   audioContext.decodeAudioData(audioData);
 *   audioData.close();
 * });
 *
 * await decoder.start({
 *   sampleRate: 48000,
 *   numberOfChannels: 2,
 * });
 *
 * // Decode received frames
 * decoder.decode(encodedData, timestamp);
 * ```
 */

import { Logger } from '@web-moq/core';

const log = Logger.create('moqt:media:audio-decoder');

/**
 * Audio decoder configuration
 */
export interface AudioDecoderConfig {
  /** Sample rate in Hz */
  sampleRate: number;
  /** Number of audio channels */
  numberOfChannels: number;
  /** Codec description (optional) */
  description?: Uint8Array;
}

/**
 * Decoder event types
 */
export type AudioDecoderEvent = 'frame' | 'error' | 'closed';

/**
 * Opus Audio Decoder
 *
 * @remarks
 * Wraps the WebCodecs AudioDecoder API to decode Opus audio frames.
 * Outputs AudioData objects that can be played back or processed.
 *
 * @example
 * ```typescript
 * const decoder = new OpusDecoder();
 *
 * // Listen for decoded audio
 * decoder.on('frame', (audioData) => {
 *   // Copy to AudioBuffer for playback
 *   const buffer = audioContext.createBuffer(
 *     audioData.numberOfChannels,
 *     audioData.numberOfFrames,
 *     audioData.sampleRate
 *   );
 *   // ... copy data ...
 *   audioData.close();
 * });
 *
 * // Configure and start
 * await decoder.start({
 *   sampleRate: 48000,
 *   numberOfChannels: 2,
 * });
 *
 * // Decode frames as they arrive
 * transport.on('audioObject', (obj) => {
 *   decoder.decode(obj.payload, obj.timestamp);
 * });
 * ```
 */
export class OpusDecoder {
  /** Underlying WebCodecs decoder */
  private decoder?: AudioDecoder;
  /** Current configuration */
  private config?: AudioDecoderConfig;
  /** Event handlers */
  private handlers = new Map<AudioDecoderEvent, Set<(data: unknown) => void>>();
  /** Decoder state */
  private _state: 'idle' | 'running' | 'closed' = 'idle';
  /** Statistics */
  private stats = {
    framesDecoded: 0,
    errors: 0,
  };

  /**
   * Create a new OpusDecoder
   */
  constructor() {
    log.debug('OpusDecoder created');
  }

  /**
   * Get decoder state
   */
  get state(): 'idle' | 'running' | 'closed' {
    return this._state;
  }

  /**
   * Check if decoder is running
   */
  get isRunning(): boolean {
    return this._state === 'running';
  }

  /**
   * Check if Opus decoding is supported
   *
   * @param config - Configuration to check
   * @returns Support status
   */
  static async isSupported(config: AudioDecoderConfig): Promise<boolean> {
    try {
      const result = await AudioDecoder.isConfigSupported({
        codec: 'opus',
        sampleRate: config.sampleRate,
        numberOfChannels: config.numberOfChannels,
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
  async start(config: AudioDecoderConfig): Promise<void> {
    if (this._state === 'running') {
      throw new Error('Decoder already running');
    }

    if (this._state === 'closed') {
      throw new Error('Decoder is closed');
    }

    if (!('AudioDecoder' in globalThis)) {
      throw new Error('WebCodecs AudioDecoder not supported');
    }

    this.config = config;

    log.info('Starting Opus decoder', {
      sampleRate: config.sampleRate,
      channels: config.numberOfChannels,
    });

    // Check support
    const supported = await OpusDecoder.isSupported(config);
    if (!supported) {
      throw new Error('Opus decoding configuration not supported');
    }

    // Create decoder
    this.decoder = new AudioDecoder({
      output: this.handleOutput.bind(this),
      error: this.handleError.bind(this),
    });

    // Configure decoder
    this.decoder.configure({
      codec: 'opus',
      sampleRate: config.sampleRate,
      numberOfChannels: config.numberOfChannels,
      description: config.description,
    });

    this._state = 'running';
    log.info('Opus decoder started');
  }

  /**
   * Decode an encoded audio frame
   *
   * @param data - Encoded frame data
   * @param timestamp - Presentation timestamp in microseconds
   * @param duration - Duration in microseconds (optional)
   *
   * @example
   * ```typescript
   * decoder.decode(opusFrame, timestamp);
   * ```
   */
  decode(data: Uint8Array, timestamp: number, duration?: number): void {
    if (!this.decoder || this._state !== 'running') {
      throw new Error('Decoder not running');
    }

    // Check if the underlying WebCodecs decoder was closed unexpectedly
    if (this.decoder.state === 'closed') {
      log.warn('Audio decoder was closed unexpectedly, attempting to recreate');

      if (this.config) {
        try {
          this.decoder = new AudioDecoder({
            output: this.handleOutput.bind(this),
            error: this.handleError.bind(this),
          });

          this.decoder.configure({
            codec: 'opus',
            sampleRate: this.config.sampleRate,
            numberOfChannels: this.config.numberOfChannels,
            description: this.config.description,
          });

          log.info('Audio decoder recreated successfully');
        } catch (err) {
          log.error('Failed to recreate audio decoder', err as Error);
          this._state = 'closed';
          throw new Error('Audio decoder closed and could not be recreated');
        }
      } else {
        this._state = 'closed';
        throw new Error('Audio decoder closed and no config available for recreation');
      }
    }

    log.info('Decoding audio frame', {
      size: data.byteLength,
      timestamp,
      duration,
    });

    const chunk = new EncodedAudioChunk({
      type: 'key', // Opus frames are always key frames
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

    log.debug('Flushing audio decoder');
    await this.decoder.flush();
  }

  /**
   * Reset the decoder
   */
  async reset(): Promise<void> {
    if (!this.decoder || this._state !== 'running') {
      return;
    }

    log.debug('Resetting audio decoder');
    this.decoder.reset();

    // Reconfigure
    if (this.config) {
      this.decoder.configure({
        codec: 'opus',
        sampleRate: this.config.sampleRate,
        numberOfChannels: this.config.numberOfChannels,
        description: this.config.description,
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

    log.info('Closing Opus decoder');

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
  private handleOutput(audioData: AudioData): void {
    this.stats.framesDecoded++;

    log.info('Audio frame decoded', {
      numberOfFrames: audioData.numberOfFrames,
      numberOfChannels: audioData.numberOfChannels,
      sampleRate: audioData.sampleRate,
      duration: audioData.duration,
      timestamp: audioData.timestamp,
      framesDecoded: this.stats.framesDecoded,
    });

    this.emit('frame', audioData);
  }

  /**
   * Handle decoder error
   */
  private handleError(error: DOMException): void {
    log.error('Audio decoder error', error);
    this.stats.errors++;
    this.emit('error', error);
  }

  /**
   * Register an event handler
   */
  on(event: 'frame', handler: (audioData: AudioData) => void): () => void;
  on(event: 'error', handler: (error: Error) => void): () => void;
  on(event: 'closed', handler: () => void): () => void;
  on(
    event: AudioDecoderEvent,
    handler: ((audioData: AudioData) => void) | ((error: Error) => void) | (() => void)
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
  private emit(event: AudioDecoderEvent, data: unknown): void {
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
      framesDecoded: 0,
      errors: 0,
    };
  }
}
