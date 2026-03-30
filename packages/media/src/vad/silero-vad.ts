// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Silero VAD Implementation
 *
 * Voice Activity Detection using Silero VAD neural network model.
 * More accurate than GMM-based approaches, but more CPU intensive.
 *
 * Uses @ricky0123/vad-web for the ONNX runtime and model loading.
 */

import { BaseVAD } from './base-vad.js';
import type { VADConfig, VADResult } from './types.js';

/**
 * Silero VAD interface (from @ricky0123/vad-web)
 */
interface SileroInstance {
  process(samples: Float32Array): Promise<{ isSpeech: boolean; probability: number }>;
  reset(): void;
  destroy(): void;
}

/**
 * Factory function type for creating Silero VAD instances
 */
export type SileroVADFactory = (options: {
  sampleRate: number;
  threshold: number;
}) => Promise<SileroInstance>;

/**
 * Silero VAD-based Voice Activity Detector
 *
 * Uses a neural network model for high-accuracy speech detection.
 * More CPU intensive than libfvad but significantly more accurate,
 * especially for non-speech sounds.
 */
export class SileroVAD extends BaseVAD {
  private silero: SileroInstance | null = null;
  private factory: SileroVADFactory;
  private lastResult: VADResult | null = null;

  /** Silero expects 16kHz audio */
  private readonly sileroSampleRate = 16000;

  constructor(config: VADConfig, factory: SileroVADFactory) {
    super(config);
    this.factory = factory;

    // Silero is more accurate, can use tighter hysteresis
    this.speechFramesRequired = 2;
    this.silenceFramesRequired = 10;
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    const threshold = this.config.threshold ?? 0.5;

    this.silero = await this.factory({
      sampleRate: this.sileroSampleRate,
      threshold,
    });

    this.initialized = true;
  }

  protected processFrame(samples: Float32Array): VADResult {
    // Silero process is async, but our interface is sync
    // We use the last result and kick off async processing
    if (!this.silero) {
      throw new Error('Silero VAD not initialized');
    }

    // Resample if needed (simple decimation for 48kHz -> 16kHz)
    const inputSampleRate = this.config.sampleRate ?? 48000;
    const resampledSamples = this.resample(samples, inputSampleRate, this.sileroSampleRate);

    // Start async processing (fire and forget, result used next frame)
    this.processAsync(resampledSamples);

    // Return last known result or default
    return (
      this.lastResult ?? {
        isSpeech: false,
        probability: 0,
        timestamp: performance.now(),
      }
    );
  }

  private async processAsync(samples: Float32Array): Promise<void> {
    if (!this.silero) return;

    try {
      const result = await this.silero.process(samples);
      this.lastResult = {
        isSpeech: result.isSpeech,
        probability: result.probability,
        timestamp: performance.now(),
      };
    } catch (e) {
      console.error('Silero VAD processing error:', e);
    }
  }

  /**
   * Simple resampling via linear interpolation
   */
  private resample(
    samples: Float32Array,
    fromRate: number,
    toRate: number
  ): Float32Array {
    if (fromRate === toRate) {
      return samples;
    }

    const ratio = fromRate / toRate;
    const newLength = Math.floor(samples.length / ratio);
    const resampled = new Float32Array(newLength);

    for (let i = 0; i < newLength; i++) {
      const srcIndex = i * ratio;
      const srcIndexFloor = Math.floor(srcIndex);
      const srcIndexCeil = Math.min(srcIndexFloor + 1, samples.length - 1);
      const t = srcIndex - srcIndexFloor;

      // Linear interpolation
      resampled[i] = samples[srcIndexFloor] * (1 - t) + samples[srcIndexCeil] * t;
    }

    return resampled;
  }

  reset(): void {
    super.reset();
    this.lastResult = null;
    this.silero?.reset();
  }

  destroy(): void {
    this.silero?.destroy();
    this.silero = null;
    this.lastResult = null;
    this.initialized = false;
  }
}
