// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview SBR (Single Bitrate) Fetch Strategy
 *
 * Implements a sawtooth buffer pattern for single-bitrate VOD playback.
 * Maintains buffer between configurable low/high bounds with large batch
 * fetches for better throughput estimation and mobile performance.
 *
 * Buffer pattern:
 *   high ──┐     ┌──┐     ┌──
 *          │     │  │     │
 *          └─────┘  └─────┘
 *   low ───                ───
 *
 * - Initial fetch fills to targetBufferSec
 * - Playback starts after 1 GOP (fast start)
 * - When buffer drops to lowBufferSec, fetch enough to reach highBufferSec
 * - Larger fetches = better throughput estimates, better mobile performance
 */

import { type FetchStrategy, type FetchDecision, type FetchStrategyContext } from './fetch-strategy';

/**
 * Configuration for SBR sawtooth buffer strategy
 */
export interface SbrConfig {
  /** Target buffer duration in seconds (default: 30) */
  targetBufferSec: number;
  /** Lower buffer bound - triggers fetch when buffer drops to this (default: 20) */
  lowBufferSec: number;
  /** Upper buffer bound - fetch aims to fill buffer to this level (default: 40) */
  highBufferSec: number;
}

export const DEFAULT_SBR_CONFIG: SbrConfig = {
  targetBufferSec: 30,
  lowBufferSec: 20,
  highBufferSec: 40,
};

export class SbrFetchStrategy implements FetchStrategy {
  readonly name = 'sbr';
  private config: SbrConfig;
  private initialFetchDone = false;

  constructor(config?: Partial<SbrConfig>) {
    this.config = { ...DEFAULT_SBR_CONFIG, ...config };
  }

  getInitialFetchSize(ctx: FetchStrategyContext): number {
    // Fetch enough GOPs to fill to target buffer
    return Math.ceil(this.config.targetBufferSec / ctx.gopDurationSec);
  }

  getMinFramesForPlayback(framesPerGop: number): number {
    // Fast start: begin playback after just 1 GOP
    return framesPerGop;
  }

  getNextFetch(ctx: FetchStrategyContext): FetchDecision {
    const noFetch: FetchDecision = { shouldFetch: false, startGroup: 0, endGroup: 0 };

    // Don't fetch if at concurrency limit
    if (ctx.activeFetchCount >= ctx.maxConcurrentFetches) {
      return noFetch;
    }

    // Don't fetch if we've fetched everything
    if (ctx.highestInFlightGroup >= ctx.totalGroups - 1) {
      return noFetch;
    }

    // Track whether initial fill is complete
    if (!this.initialFetchDone) {
      if (ctx.bufferedSeconds >= this.config.targetBufferSec * 0.9) {
        this.initialFetchDone = true;
      }
      // During initial fill, don't issue additional fetches beyond the initial one
      // (the controller handles the initial fetch via getInitialFetchSize)
      return noFetch;
    }

    // Sawtooth: only fetch when buffer drops to low threshold
    if (ctx.bufferedSeconds > this.config.lowBufferSec) {
      return noFetch;
    }

    // Calculate how many GOPs to fetch to reach high buffer mark
    const secondsToFetch = this.config.highBufferSec - ctx.bufferedSeconds;
    const gopsToFetch = Math.ceil(secondsToFetch / ctx.gopDurationSec);

    const startGroup = ctx.highestInFlightGroup + 1;
    const endGroup = Math.min(
      startGroup + gopsToFetch - 1,
      ctx.totalGroups - 1
    );

    if (startGroup > endGroup) {
      return noFetch;
    }

    return {
      shouldFetch: true,
      startGroup,
      endGroup,
    };
  }
}
