// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview libfvad VAD Implementation
 *
 * Voice Activity Detection using libfvad (WebRTC VAD) compiled to WASM.
 * libfvad is a lightweight, CPU-efficient VAD based on GMM.
 *
 * WASM module must export:
 * - fvad_new(): number (pointer to instance)
 * - fvad_free(inst: number): void
 * - fvad_reset(inst: number): void
 * - fvad_set_mode(inst: number, mode: number): number
 * - fvad_set_sample_rate(inst: number, rate: number): number
 * - fvad_process(inst: number, frame: number, length: number): number
 * - malloc(size: number): number
 * - free(ptr: number): void
 */

import { BaseVAD } from './base-vad.js';
import type { VADConfig, VADResult } from './types.js';

/**
 * libfvad WASM module interface
 */
export interface LibfvadModule {
  fvad_new(): number;
  fvad_free(inst: number): void;
  fvad_reset(inst: number): void;
  fvad_set_mode(inst: number, mode: number): number;
  fvad_set_sample_rate(inst: number, rate: number): number;
  fvad_process(inst: number, frame: number, length: number): number;
  _malloc(size: number): number;
  _free(ptr: number): void;
  HEAP16: Int16Array;
}

/** Valid sample rates for libfvad */
const VALID_SAMPLE_RATES = [8000, 16000, 32000, 48000];

/** Valid frame durations in ms */
const VALID_FRAME_DURATIONS = [10, 20, 30];

/**
 * libfvad-based Voice Activity Detector
 *
 * Uses WebRTC's VAD algorithm compiled to WASM. Lightweight and CPU-efficient,
 * but may be less accurate than neural network approaches.
 */
export class LibfvadVAD extends BaseVAD {
  private module: LibfvadModule | null = null;
  private instance = 0;
  private framePtr = 0;
  private frameSize: number;
  private internalSampleRate: number;

  /** WASM module loader function */
  private moduleLoader: () => Promise<LibfvadModule>;

  constructor(config: VADConfig, moduleLoader: () => Promise<LibfvadModule>) {
    super(config);
    this.moduleLoader = moduleLoader;

    // libfvad works best at 16kHz internally
    this.internalSampleRate = 16000;

    // Frame size at internal sample rate (10ms = 160 samples at 16kHz)
    const frameDurationMs = ((config.frameSize ?? 480) / (config.sampleRate ?? 48000)) * 1000;
    if (!VALID_FRAME_DURATIONS.includes(Math.round(frameDurationMs))) {
      console.warn(`libfvad: frame duration ${frameDurationMs}ms not optimal, using 10ms`);
    }
    this.frameSize = Math.round((this.internalSampleRate * 10) / 1000); // 160 samples
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    this.module = await this.moduleLoader();

    // Create VAD instance
    this.instance = this.module.fvad_new();
    if (this.instance === 0) {
      throw new Error('Failed to create libfvad instance');
    }

    // Set sample rate
    if (!VALID_SAMPLE_RATES.includes(this.internalSampleRate)) {
      throw new Error(`Invalid sample rate: ${this.internalSampleRate}`);
    }
    const rateResult = this.module.fvad_set_sample_rate(this.instance, this.internalSampleRate);
    if (rateResult !== 0) {
      throw new Error('Failed to set libfvad sample rate');
    }

    // Set aggressiveness mode (0-3, higher = more aggressive filtering)
    const mode = this.config.aggressiveness ?? 2;
    const modeResult = this.module.fvad_set_mode(this.instance, mode);
    if (modeResult !== 0) {
      throw new Error('Failed to set libfvad mode');
    }

    // Allocate frame buffer (int16)
    this.framePtr = this.module._malloc(this.frameSize * 2);
    if (this.framePtr === 0) {
      throw new Error('Failed to allocate libfvad frame buffer');
    }

    this.initialized = true;
  }

  protected processFrame(samples: Float32Array): VADResult {
    if (!this.module || this.instance === 0) {
      throw new Error('libfvad not initialized');
    }

    // Resample if needed (simple decimation for 48kHz -> 16kHz)
    const inputSampleRate = this.config.sampleRate ?? 48000;
    const decimationFactor = inputSampleRate / this.internalSampleRate;

    // Convert float32 to int16 and resample
    const frameOffset = this.framePtr >> 1; // Divide by 2 for int16 index
    for (let i = 0; i < this.frameSize; i++) {
      const srcIndex = Math.floor(i * decimationFactor);
      const sample = samples[srcIndex] ?? 0;
      // Clamp and convert to int16
      const int16 = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
      this.module.HEAP16[frameOffset + i] = int16;
    }

    // Process frame
    const result = this.module.fvad_process(this.instance, this.framePtr, this.frameSize);

    // result: -1 = error, 0 = silence, 1 = speech
    const isSpeech = result === 1;

    return {
      isSpeech,
      probability: isSpeech ? 1.0 : 0.0, // libfvad doesn't provide probability
      timestamp: performance.now(),
    };
  }

  reset(): void {
    super.reset();
    if (this.module && this.instance !== 0) {
      this.module.fvad_reset(this.instance);
    }
  }

  destroy(): void {
    if (this.module) {
      if (this.framePtr !== 0) {
        this.module._free(this.framePtr);
        this.framePtr = 0;
      }
      if (this.instance !== 0) {
        this.module.fvad_free(this.instance);
        this.instance = 0;
      }
    }
    this.module = null;
    this.initialized = false;
  }
}
