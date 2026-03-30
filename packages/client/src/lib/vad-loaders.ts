// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview VAD Loaders
 *
 * Factory functions for loading VAD implementations.
 */

import type { LibfvadModule, SileroVADFactory } from '@web-moq/media';

/**
 * Load libfvad WASM module using @echogarden/fvad-wasm
 */
export async function loadLibfvadModule(): Promise<LibfvadModule> {
  // Dynamic import to avoid bundling if not used
  const fvadFactory = (await import('@echogarden/fvad-wasm')).default;
  const module = await fvadFactory();

  // Adapt the echogarden module to our interface
  return {
    fvad_new: module._fvad_new,
    fvad_free: module._fvad_free,
    fvad_reset: module._fvad_reset,
    fvad_set_mode: module._fvad_set_mode,
    fvad_set_sample_rate: module._fvad_set_sample_rate,
    fvad_process: module._fvad_process,
    _malloc: module._malloc,
    _free: module._free,
    HEAP16: module.HEAP16,
  };
}

/**
 * Create Silero VAD instance using @ricky0123/vad-web
 *
 * Note: For production, you'd want to use the full ONNX-based implementation.
 * The @ricky0123/vad-web package provides MicVAD which handles the full pipeline,
 * but integrating just the model requires more setup with onnxruntime-web.
 * This is a simplified energy-based implementation that provides similar behavior.
 */
export const createSileroVAD: SileroVADFactory = async (options) => {
  const threshold = options.threshold ?? 0.5;

  return {
    async process(samples: Float32Array): Promise<{ isSpeech: boolean; probability: number }> {
      // Energy-based VAD as a placeholder for the full Silero neural network
      // Calculates RMS energy and applies a threshold
      let energy = 0;
      for (let i = 0; i < samples.length; i++) {
        energy += samples[i] * samples[i];
      }
      energy = Math.sqrt(energy / samples.length);

      // Convert energy to probability-like value (scaled for typical speech levels)
      const probability = Math.min(1, energy * 10);
      const isSpeech = probability > threshold;

      return { isSpeech, probability };
    },
    reset() {
      // No state to reset in energy-based implementation
    },
    destroy() {
      // No resources to cleanup
    },
  };
};
