// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Three-level audio activity state machine for top-N active speaker detection.
 *
 * Converts noisy boolean VAD samples into stable activity states using
 * configurable timing thresholds. The numeric values are ordered so that
 * a new speaker (SPEECH_START=2) outranks an ongoing one (CONTINUOUS_SPEECH=1),
 * enabling responsive relay-side switching.
 *
 * @see quicr-mac/docs/top-n-active-speaker-design.md §1.2
 */

export enum AudioActivityValue {
  SPEECH_END = 0,
  CONTINUOUS_SPEECH = 1,
  SPEECH_START = 2,
}

export interface AudioActivityConfig {
  /** Duration of continuous voice before entering SPEECH_START (ms) */
  timeToSpeechStart: number;
  /** Duration in SPEECH_START before promoting to CONTINUOUS_SPEECH (ms) */
  timeToContinuous: number;
  /** Duration of silence to drop from SPEECH_START to SPEECH_END (ms) */
  timeToDropStart: number;
  /** Duration of silence to drop from CONTINUOUS_SPEECH to SPEECH_END (ms) */
  timeToDropContinuous: number;
}

const DEFAULT_CONFIG: AudioActivityConfig = {
  timeToSpeechStart: 150,
  timeToContinuous: 1000,
  timeToDropStart: 300,
  timeToDropContinuous: 2000,
};

export class AudioActivityStateMachine {
  private state = AudioActivityValue.SPEECH_END;
  private config: AudioActivityConfig;

  /** Timestamp when continuous voice began (null when silent) */
  private voiceOnset: number | null = null;
  /** Timestamp when continuous silence began (null when voice) */
  private silenceOnset: number | null = null;

  constructor(config?: Partial<AudioActivityConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Update the state machine with a new VAD sample.
   *
   * @param voiceActive - Boolean from the VAD (true = voice detected)
   * @param now - Current timestamp in milliseconds (e.g. performance.now())
   * @returns The current activity value (0, 1, or 2)
   */
  update(voiceActive: boolean, now: number): AudioActivityValue {
    // Track onset timestamps
    if (voiceActive) {
      this.silenceOnset = null;
      if (this.voiceOnset === null) {
        this.voiceOnset = now;
      }
    } else {
      this.voiceOnset = null;
      if (this.silenceOnset === null) {
        this.silenceOnset = now;
      }
    }

    // State transitions
    switch (this.state) {
      case AudioActivityValue.SPEECH_END:
        if (this.voiceOnset !== null && (now - this.voiceOnset) >= this.config.timeToSpeechStart) {
          this.state = AudioActivityValue.SPEECH_START;
          this.voiceOnset = now; // Reset for timeToContinuous
        }
        break;

      case AudioActivityValue.SPEECH_START:
        if (this.voiceOnset !== null && (now - this.voiceOnset) >= this.config.timeToContinuous) {
          this.state = AudioActivityValue.CONTINUOUS_SPEECH;
        } else if (this.silenceOnset !== null && (now - this.silenceOnset) >= this.config.timeToDropStart) {
          this.state = AudioActivityValue.SPEECH_END;
        }
        break;

      case AudioActivityValue.CONTINUOUS_SPEECH:
        if (this.silenceOnset !== null && (now - this.silenceOnset) >= this.config.timeToDropContinuous) {
          this.state = AudioActivityValue.SPEECH_END;
        }
        break;
    }

    return this.state;
  }

  /** Get the current activity value without updating */
  get value(): AudioActivityValue {
    return this.state;
  }

  /** Reset to SPEECH_END */
  reset(): void {
    this.state = AudioActivityValue.SPEECH_END;
    this.voiceOnset = null;
    this.silenceOnset = null;
  }
}
