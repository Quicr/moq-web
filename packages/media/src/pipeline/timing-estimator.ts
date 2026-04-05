// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Timing Estimator for GOP Duration
 *
 * Estimates GOP (Group of Pictures) duration from multiple sources:
 * 1. LOC timestamps (most accurate, runtime detection)
 * 2. Catalog hints (framerate, initial estimate)
 * 3. Configuration defaults (fallback)
 *
 * Adapts to dynamic GOP sizes automatically by tracking keyframe intervals.
 */

import type { TimingConfig, GroupState } from './group-arbiter-types';
import type { TickProvider } from './tick-provider';

/**
 * Configuration for TimingEstimator
 */
export interface TimingEstimatorConfig {
  /** Initial estimated GOP duration in ms */
  initialGopDuration: number;

  /** Framerate hint from catalog (optional) */
  catalogFramerate?: number;

  /** Timescale hint from catalog (optional) */
  catalogTimescale?: number;

  /** Maximum samples to keep for averaging */
  maxSamples?: number;

  /** Smoothing factor for EMA (0-1) */
  smoothingFactor?: number;

  /** Minimum valid GOP duration in ms */
  minGopDuration?: number;

  /** Maximum valid GOP duration in ms */
  maxGopDuration?: number;
}

/**
 * Estimates and tracks GOP duration for deadline calculation
 *
 * @remarks
 * Uses exponential moving average (EMA) to smooth GOP duration estimates
 * from observed keyframe intervals. Handles variable-length GOPs gracefully.
 *
 * @example
 * ```typescript
 * const estimator = new TimingEstimator({
 *   initialGopDuration: 1000,
 *   catalogFramerate: 30,
 * });
 *
 * // Update on each keyframe
 * estimator.onKeyframe(groupId, locTimestamp, locTimescale);
 *
 * // Get current estimate
 * const gopMs = estimator.getEstimatedGopDuration();
 * ```
 */
export class TimingEstimator {
  private config: Required<TimingEstimatorConfig>;
  private estimatedGopDuration: number;
  private lastKeyframeTimestamp = -1;
  private lastKeyframeGroupId = -1;
  private gopDurationSamples: number[] = [];
  private sampleCount = 0;

  constructor(config: TimingEstimatorConfig) {
    this.config = {
      initialGopDuration: config.initialGopDuration,
      catalogFramerate: config.catalogFramerate ?? 0,
      catalogTimescale: config.catalogTimescale ?? 0,
      maxSamples: config.maxSamples ?? 5,
      smoothingFactor: config.smoothingFactor ?? 0.3,
      minGopDuration: config.minGopDuration ?? 100,
      maxGopDuration: config.maxGopDuration ?? 10000,
    };

    this.estimatedGopDuration = this.calculateInitialEstimate();
  }

  /**
   * Calculate initial GOP duration estimate from available hints
   */
  private calculateInitialEstimate(): number {
    // If we have framerate, assume 1-second GOP as starting point
    // (common for real-time streaming)
    if (this.config.catalogFramerate > 0) {
      return 1000; // 1 second default for live streaming
    }

    return this.config.initialGopDuration;
  }

  /**
   * Called when a keyframe is received to update GOP duration estimate
   *
   * @param groupId - Group ID of the keyframe
   * @param locTimestamp - LOC timestamp in timescale units (optional)
   * @param locTimescale - LOC timescale, units per second (optional, default 1,000,000)
   */
  onKeyframe(
    groupId: number,
    locTimestamp?: number,
    locTimescale?: number
  ): void {
    // Skip if no timestamp or this is the first keyframe
    if (locTimestamp === undefined || this.lastKeyframeTimestamp < 0) {
      this.lastKeyframeTimestamp = locTimestamp ?? -1;
      this.lastKeyframeGroupId = groupId;
      return;
    }

    // Handle non-sequential groups (gaps are OK)
    if (groupId <= this.lastKeyframeGroupId) {
      // Old or duplicate keyframe, ignore
      return;
    }

    // Calculate duration from timestamps
    const scale = locTimescale ?? 1_000_000;
    const durationMs =
      ((locTimestamp - this.lastKeyframeTimestamp) / scale) * 1000;

    // Validate duration
    if (
      durationMs >= this.config.minGopDuration &&
      durationMs <= this.config.maxGopDuration
    ) {
      this.addSample(durationMs);
    }

    // Update last keyframe tracking
    this.lastKeyframeTimestamp = locTimestamp;
    this.lastKeyframeGroupId = groupId;
  }

  /**
   * Add a GOP duration sample and update estimate
   */
  private addSample(durationMs: number): void {
    this.gopDurationSamples.push(durationMs);
    this.sampleCount++;

    // Keep only recent samples
    if (this.gopDurationSamples.length > this.config.maxSamples) {
      this.gopDurationSamples.shift();
    }

    // Update estimate using EMA
    const avg =
      this.gopDurationSamples.reduce((a, b) => a + b, 0) /
      this.gopDurationSamples.length;

    this.estimatedGopDuration =
      (1 - this.config.smoothingFactor) * this.estimatedGopDuration +
      this.config.smoothingFactor * avg;
  }

  /**
   * Calculate deadline tick for a group
   *
   * @param group - Group state
   * @param tickProvider - Tick provider for time conversion
   * @param maxLatency - Maximum acceptable latency in ms
   * @returns Deadline tick value
   */
  calculateDeadline<T>(
    group: GroupState<T>,
    tickProvider: TickProvider,
    maxLatency: number
  ): number {
    const gopMs = this.estimatedGopDuration;

    // Deadline = arrival time + GOP duration + max latency
    const deadlineMs =
      tickProvider.ticksToMs(group.firstFrameReceivedTick) + gopMs + maxLatency;

    return tickProvider.msToTicks(deadlineMs);
  }

  /**
   * Get current estimated GOP duration in milliseconds
   */
  getEstimatedGopDuration(): number {
    return this.estimatedGopDuration;
  }

  /**
   * Get number of GOP duration samples collected
   */
  getSampleCount(): number {
    return this.sampleCount;
  }

  /**
   * Check if we have enough samples for reliable estimation
   */
  hasReliableEstimate(): boolean {
    return this.gopDurationSamples.length >= 2;
  }

  /**
   * Reset the estimator to initial state
   */
  reset(): void {
    this.estimatedGopDuration = this.calculateInitialEstimate();
    this.lastKeyframeTimestamp = -1;
    this.lastKeyframeGroupId = -1;
    this.gopDurationSamples = [];
    this.sampleCount = 0;
  }

  /**
   * Get statistics about the estimator
   */
  getStats(): {
    estimatedGopDuration: number;
    sampleCount: number;
    hasReliableEstimate: boolean;
    samples: number[];
  } {
    return {
      estimatedGopDuration: this.estimatedGopDuration,
      sampleCount: this.sampleCount,
      hasReliableEstimate: this.hasReliableEstimate(),
      samples: [...this.gopDurationSamples],
    };
  }
}

/**
 * Create a TimingEstimator from TimingConfig
 */
export function createTimingEstimator(config: TimingConfig): TimingEstimator {
  return new TimingEstimator({
    initialGopDuration: config.estimatedGopDuration,
    catalogFramerate: config.catalogFramerate,
    catalogTimescale: config.catalogTimescale,
  });
}
