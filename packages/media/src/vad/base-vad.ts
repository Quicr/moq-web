// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Base VAD Implementation
 *
 * Abstract base class for VAD implementations with event handling
 * and speech state tracking.
 */

import type { VAD, VADConfig, VADEvents, VADResult } from './types.js';

/**
 * Abstract base class for VAD implementations
 */
export abstract class BaseVAD implements VAD {
  protected config: VADConfig;
  protected speaking = false;
  protected initialized = false;

  /** Event handlers */
  private speechStartHandlers = new Set<() => void>();
  private speechEndHandlers = new Set<() => void>();
  private vadResultHandlers = new Set<(result: VADResult) => void>();

  /** Hysteresis counters for smoothing */
  private speechFrameCount = 0;
  private silenceFrameCount = 0;

  /** Frames needed to trigger state change (prevents flickering) */
  protected speechFramesRequired = 3;
  protected silenceFramesRequired = 15;

  constructor(config: VADConfig) {
    this.config = {
      sampleRate: 48000,
      frameSize: 480, // 10ms at 48kHz
      ...config,
    };
  }

  abstract init(): Promise<void>;
  abstract destroy(): void;
  protected abstract processFrame(samples: Float32Array): VADResult;

  /**
   * Process audio samples with hysteresis for smooth state transitions
   */
  process(samples: Float32Array): VADResult {
    if (!this.initialized) {
      throw new Error('VAD not initialized. Call init() first.');
    }

    const result = this.processFrame(samples);

    // Apply hysteresis to prevent rapid flickering
    if (result.isSpeech) {
      this.speechFrameCount++;
      this.silenceFrameCount = 0;

      if (!this.speaking && this.speechFrameCount >= this.speechFramesRequired) {
        this.speaking = true;
        this.emit('speech-start');
      }
    } else {
      this.silenceFrameCount++;
      this.speechFrameCount = 0;

      if (this.speaking && this.silenceFrameCount >= this.silenceFramesRequired) {
        this.speaking = false;
        this.emit('speech-end');
      }
    }

    this.emit('vad-result', result);
    return result;
  }

  reset(): void {
    this.speaking = false;
    this.speechFrameCount = 0;
    this.silenceFrameCount = 0;
  }

  isSpeaking(): boolean {
    return this.speaking;
  }

  on<K extends keyof VADEvents>(event: K, handler: VADEvents[K]): void {
    switch (event) {
      case 'speech-start':
        this.speechStartHandlers.add(handler as () => void);
        break;
      case 'speech-end':
        this.speechEndHandlers.add(handler as () => void);
        break;
      case 'vad-result':
        this.vadResultHandlers.add(handler as (result: VADResult) => void);
        break;
    }
  }

  off<K extends keyof VADEvents>(event: K, handler: VADEvents[K]): void {
    switch (event) {
      case 'speech-start':
        this.speechStartHandlers.delete(handler as () => void);
        break;
      case 'speech-end':
        this.speechEndHandlers.delete(handler as () => void);
        break;
      case 'vad-result':
        this.vadResultHandlers.delete(handler as (result: VADResult) => void);
        break;
    }
  }

  protected emit(event: 'speech-start' | 'speech-end'): void;
  protected emit(event: 'vad-result', result: VADResult): void;
  protected emit(event: keyof VADEvents, result?: VADResult): void {
    switch (event) {
      case 'speech-start':
        for (const handler of this.speechStartHandlers) {
          handler();
        }
        break;
      case 'speech-end':
        for (const handler of this.speechEndHandlers) {
          handler();
        }
        break;
      case 'vad-result':
        for (const handler of this.vadResultHandlers) {
          handler(result!);
        }
        break;
    }
  }
}
