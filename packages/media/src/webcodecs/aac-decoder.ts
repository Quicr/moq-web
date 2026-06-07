// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview AAC Audio Decoder using WebCodecs
 *
 * Provides a high-level wrapper around the WebCodecs AudioDecoder API
 * for decoding AAC audio frames from MP4 containers.
 *
 * @example
 * ```typescript
 * import { AACDecoder } from '@web-moq/media';
 *
 * const decoder = new AACDecoder();
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
 *   description: aacConfig, // AudioSpecificConfig from esds box
 * });
 *
 * // Decode received frames
 * decoder.decode(encodedData, timestamp);
 * ```
 */

import { Logger } from '@web-moq/core';

const log = Logger.create('moqt:media:aac-decoder');

/**
 * AAC decoder configuration
 */
export interface AACDecoderConfig {
  /** Sample rate in Hz */
  sampleRate: number;
  /** Number of audio channels */
  numberOfChannels: number;
  /** AudioSpecificConfig from MP4 esds box (required for AAC) */
  description: Uint8Array;
}

/**
 * Decoder event types
 */
export type AACDecoderEvent = 'frame' | 'error' | 'closed';

/**
 * AAC Audio Decoder
 *
 * @remarks
 * Wraps the WebCodecs AudioDecoder API to decode AAC audio frames.
 * Outputs AudioData objects that can be played back or processed.
 *
 * AAC requires an AudioSpecificConfig (from MP4 esds box) to be provided
 * in the `description` field of the config.
 *
 * @example
 * ```typescript
 * const decoder = new AACDecoder();
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
 * // Configure and start (description is required for AAC)
 * await decoder.start({
 *   sampleRate: 48000,
 *   numberOfChannels: 2,
 *   description: audioSpecificConfig,
 * });
 *
 * // Decode frames as they arrive
 * transport.on('audioObject', (obj) => {
 *   decoder.decode(obj.payload, obj.timestamp);
 * });
 * ```
 */
export class AACDecoder {
  /** Underlying WebCodecs decoder */
  private decoder?: AudioDecoder;
  /** Current configuration */
  private config?: AACDecoderConfig;
  /** Event handlers */
  private handlers = new Map<AACDecoderEvent, Set<(data: unknown) => void>>();
  /** Decoder state */
  private _state: 'idle' | 'running' | 'closed' = 'idle';
  /** Statistics */
  private stats = {
    framesDecoded: 0,
    errors: 0,
  };

  /**
   * Create a new AACDecoder
   */
  constructor() {
    log.debug('AACDecoder created');
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
   * Check if AAC decoding is supported
   *
   * @param config - Configuration to check
   * @returns Support status
   */
  static async isSupported(config: AACDecoderConfig): Promise<boolean> {
    try {
      const result = await AudioDecoder.isConfigSupported({
        codec: 'mp4a.40.2', // AAC-LC
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
   * @param config - Decoder configuration (description is required for AAC)
   */
  async start(config: AACDecoderConfig): Promise<void> {
    if (this._state === 'running') {
      throw new Error('Decoder already running');
    }

    if (this._state === 'closed') {
      throw new Error('Decoder is closed');
    }

    if (!('AudioDecoder' in globalThis)) {
      throw new Error('WebCodecs AudioDecoder not supported');
    }

    if (!config.description || config.description.byteLength === 0) {
      throw new Error('AAC decoder requires AudioSpecificConfig in description');
    }

    this.config = config;

    log.info('Starting AAC decoder', {
      sampleRate: config.sampleRate,
      channels: config.numberOfChannels,
      descriptionSize: config.description.byteLength,
    });

    // Check support
    const supported = await AACDecoder.isSupported(config);
    if (!supported) {
      throw new Error('AAC decoding configuration not supported');
    }

    // Create decoder
    this.decoder = new AudioDecoder({
      output: this.handleOutput.bind(this),
      error: this.handleError.bind(this),
    });

    // Configure decoder
    this.decoder.configure({
      codec: 'mp4a.40.2', // AAC-LC
      sampleRate: config.sampleRate,
      numberOfChannels: config.numberOfChannels,
      description: config.description,
    });

    this._state = 'running';
    log.info('AAC decoder started');
  }

  /**
   * Decode an encoded audio frame
   *
   * @param data - Encoded frame data (raw AAC frame, no ADTS header)
   * @param timestamp - Presentation timestamp in microseconds
   * @param duration - Duration in microseconds (optional)
   *
   * @example
   * ```typescript
   * decoder.decode(aacFrame, timestamp);
   * ```
   */
  decode(data: Uint8Array, timestamp: number, duration?: number): void {
    if (!this.decoder || this._state !== 'running') {
      throw new Error('Decoder not running');
    }

    // Check if the underlying WebCodecs decoder was closed unexpectedly
    if (this.decoder.state === 'closed') {
      log.warn('AAC decoder was closed unexpectedly, attempting to recreate');

      if (this.config) {
        try {
          this.decoder = new AudioDecoder({
            output: this.handleOutput.bind(this),
            error: this.handleError.bind(this),
          });

          this.decoder.configure({
            codec: 'mp4a.40.2',
            sampleRate: this.config.sampleRate,
            numberOfChannels: this.config.numberOfChannels,
            description: this.config.description,
          });

          log.info('AAC decoder recreated successfully');
        } catch (err) {
          log.error('Failed to recreate AAC decoder', err as Error);
          this._state = 'closed';
          throw new Error('AAC decoder closed and could not be recreated');
        }
      } else {
        this._state = 'closed';
        throw new Error('AAC decoder closed and no config available for recreation');
      }
    }

    log.debug('Decoding AAC frame', {
      size: data.byteLength,
      timestamp,
      duration,
    });

    const chunk = new EncodedAudioChunk({
      type: 'key', // AAC frames are always key frames (like Opus)
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

    log.debug('Flushing AAC decoder');
    await this.decoder.flush();
  }

  /**
   * Reset the decoder
   */
  async reset(): Promise<void> {
    if (!this.decoder || this._state !== 'running') {
      return;
    }

    log.debug('Resetting AAC decoder');
    this.decoder.reset();

    // Reconfigure
    if (this.config) {
      this.decoder.configure({
        codec: 'mp4a.40.2',
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

    log.info('Closing AAC decoder');

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

    log.debug('AAC frame decoded', {
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
    log.error('AAC decoder error', error);
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
    event: AACDecoderEvent,
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
  private emit(event: AACDecoderEvent, data: unknown): void {
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
