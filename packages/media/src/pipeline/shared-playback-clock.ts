// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview SharedPlaybackClock - Shared timing reference for A/V sync
 *
 * Per MSF spec, tracks with the same `renderGroup` should be rendered simultaneously.
 * This clock provides a shared timing reference that multiple release policies can
 * use to coordinate frame release.
 *
 * Design (Option B):
 * - Video policy drives the clock (video is typically the master)
 * - Audio policy follows the clock, holding frames if ahead
 * - Each policy keeps its own buffering/jitter handling
 * - Clock only coordinates the "release gate"
 *
 * Usage:
 * ```typescript
 * const clock = new SharedPlaybackClock();
 *
 * // Video policy updates clock when releasing frames
 * clock.updateMasterTime(videoFramePtsMs);
 *
 * // Audio policy checks before releasing
 * if (clock.canRelease(audioFramePtsMs)) {
 *   // release audio frame
 * }
 * ```
 */

export interface SharedPlaybackClockConfig {
  /**
   * Maximum time audio can be ahead of video before holding (ms)
   * Default: 50ms - tight sync for lip sync quality
   */
  maxAheadMs: number;

  /**
   * Maximum time audio can be behind video before dropping (ms)
   * Default: 500ms - drop frames that are too late
   */
  maxBehindMs: number;

  /**
   * Enable debug logging
   */
  debug: boolean;
}

const DEFAULT_CONFIG: SharedPlaybackClockConfig = {
  maxAheadMs: 50,
  maxBehindMs: 500,
  debug: false,
};

export type ClockDecision = 'release' | 'hold' | 'drop';

export interface ClockCheckResult {
  decision: ClockDecision;
  /** Difference: framePts - masterTime (positive = ahead, negative = behind) */
  deltaMs: number;
}

/**
 * SharedPlaybackClock - Coordinates frame release across tracks with same renderGroup
 */
export class SharedPlaybackClock {
  private config: SharedPlaybackClockConfig;

  /** Current master playback time in milliseconds (PTS) */
  private masterTimeMs = 0;

  /** Whether the clock has been initialized with first frame */
  private initialized = false;

  /** Callbacks for slave tracks to be notified of time updates */
  private listeners: Set<(timeMs: number) => void> = new Set();

  /** Render group this clock is associated with */
  readonly renderGroup: number;

  constructor(renderGroup: number, config: Partial<SharedPlaybackClockConfig> = {}) {
    this.renderGroup = renderGroup;
    this.config = { ...DEFAULT_CONFIG, ...config };

    if (this.config.debug) {
      console.log('[SharedPlaybackClock] Created for renderGroup', renderGroup, this.config);
    }
  }

  /**
   * Update the master playback time (called by video/master track)
   *
   * @param ptsMs - Presentation timestamp in milliseconds of the frame being released
   */
  updateMasterTime(ptsMs: number): void {
    // Only move forward (avoid jumps backward from reordering)
    if (ptsMs > this.masterTimeMs || !this.initialized) {
      this.masterTimeMs = ptsMs;
      this.initialized = true;

      // Notify listeners
      for (const listener of this.listeners) {
        try {
          listener(ptsMs);
        } catch (e) {
          console.error('[SharedPlaybackClock] Listener error:', e);
        }
      }
    }
  }

  /**
   * Check if a frame with given PTS can be released
   *
   * @param ptsMs - Presentation timestamp of the frame to check
   * @returns Decision and timing info
   */
  canRelease(ptsMs: number): ClockCheckResult {
    // Not initialized yet - allow release to bootstrap
    if (!this.initialized) {
      return { decision: 'release', deltaMs: 0 };
    }

    const deltaMs = ptsMs - this.masterTimeMs;

    // Frame is too far behind - drop it
    if (deltaMs < -this.config.maxBehindMs) {
      if (this.config.debug) {
        console.log('[SharedPlaybackClock] DROP frame', {
          framePtsMs: ptsMs,
          masterTimeMs: this.masterTimeMs,
          deltaMs,
          threshold: -this.config.maxBehindMs,
        });
      }
      return { decision: 'drop', deltaMs };
    }

    // Frame is too far ahead - hold it
    if (deltaMs > this.config.maxAheadMs) {
      if (this.config.debug) {
        console.log('[SharedPlaybackClock] HOLD frame', {
          framePtsMs: ptsMs,
          masterTimeMs: this.masterTimeMs,
          deltaMs,
          threshold: this.config.maxAheadMs,
        });
      }
      return { decision: 'hold', deltaMs };
    }

    // Frame is within acceptable range - release
    return { decision: 'release', deltaMs };
  }

  /**
   * Get current master time
   */
  getMasterTime(): number {
    return this.masterTimeMs;
  }

  /**
   * Check if clock is initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Subscribe to time updates
   */
  subscribe(listener: (timeMs: number) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Reset the clock (e.g., on seek)
   */
  reset(): void {
    this.masterTimeMs = 0;
    this.initialized = false;
    if (this.config.debug) {
      console.log('[SharedPlaybackClock] Reset');
    }
  }

  /**
   * Get stats for debugging
   */
  getStats(): { masterTimeMs: number; initialized: boolean; listenerCount: number } {
    return {
      masterTimeMs: this.masterTimeMs,
      initialized: this.initialized,
      listenerCount: this.listeners.size,
    };
  }
}

/**
 * Registry for SharedPlaybackClocks by renderGroup
 *
 * Ensures tracks with the same renderGroup share the same clock instance.
 */
export class PlaybackClockRegistry {
  private clocks: Map<number, SharedPlaybackClock> = new Map();
  private config: Partial<SharedPlaybackClockConfig>;

  constructor(config: Partial<SharedPlaybackClockConfig> = {}) {
    this.config = config;
  }

  /**
   * Get or create a clock for a renderGroup
   */
  getOrCreate(renderGroup: number): SharedPlaybackClock {
    let clock = this.clocks.get(renderGroup);
    if (!clock) {
      clock = new SharedPlaybackClock(renderGroup, this.config);
      this.clocks.set(renderGroup, clock);
    }
    return clock;
  }

  /**
   * Get clock for a renderGroup if it exists
   */
  get(renderGroup: number): SharedPlaybackClock | undefined {
    return this.clocks.get(renderGroup);
  }

  /**
   * Check if a clock exists for a renderGroup
   */
  has(renderGroup: number): boolean {
    return this.clocks.has(renderGroup);
  }

  /**
   * Reset all clocks
   */
  resetAll(): void {
    for (const clock of this.clocks.values()) {
      clock.reset();
    }
  }

  /**
   * Clear all clocks
   */
  clear(): void {
    this.clocks.clear();
  }
}
