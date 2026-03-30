// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Voice Activity Detection Types
 *
 * Common types and interfaces for VAD implementations.
 */

/**
 * VAD provider type
 */
export type VADProvider = 'libfvad' | 'silero';

/**
 * VAD result from processing audio
 */
export interface VADResult {
  /** Whether speech is detected */
  isSpeech: boolean;
  /** Confidence/probability of speech (0-1) */
  probability: number;
  /** Timestamp of the result */
  timestamp: number;
}

/**
 * VAD configuration options
 */
export interface VADConfig {
  /** VAD provider to use */
  provider: VADProvider;
  /** Sample rate of audio input (default: 48000) */
  sampleRate?: number;
  /** Frame size in samples (default: 480 for 10ms at 48kHz) */
  frameSize?: number;
  /** Aggressiveness mode for libfvad (0-3, higher = more aggressive) */
  aggressiveness?: number;
  /** Speech probability threshold for Silero (0-1, default: 0.5) */
  threshold?: number;
}

/**
 * VAD event types
 */
export interface VADEvents {
  /** Fired when speech starts */
  'speech-start': () => void;
  /** Fired when speech ends */
  'speech-end': () => void;
  /** Fired on each VAD frame with result */
  'vad-result': (result: VADResult) => void;
}

/**
 * Voice Activity Detector interface
 */
export interface VAD {
  /**
   * Initialize the VAD
   */
  init(): Promise<void>;

  /**
   * Process audio samples and detect voice activity
   * @param samples - Float32 audio samples (-1 to 1)
   * @returns VAD result
   */
  process(samples: Float32Array): VADResult;

  /**
   * Reset VAD state
   */
  reset(): void;

  /**
   * Destroy and clean up resources
   */
  destroy(): void;

  /**
   * Register event handler
   */
  on<K extends keyof VADEvents>(event: K, handler: VADEvents[K]): void;

  /**
   * Unregister event handler
   */
  off<K extends keyof VADEvents>(event: K, handler: VADEvents[K]): void;

  /**
   * Get current speech state
   */
  isSpeaking(): boolean;
}
