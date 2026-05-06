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
  /** Initial buffer before starting playback in seconds (default: 3) */
  initialBufferSec: number;
  /** Maximum concurrent fetch requests (default: 2) */
  maxConcurrentFetches: number;
}

export const DEFAULT_SBR_CONFIG: SbrConfig = {
  targetBufferSec: 30,
  lowBufferSec: 20,
  highBufferSec: 40,
  initialBufferSec: 3,
  maxConcurrentFetches: 2,
};

export class SbrFetchStrategy implements FetchStrategy {
  readonly name = 'sbr';
  private config: SbrConfig;
  private initialFetchDone = false;

  constructor(config?: Partial<SbrConfig>) {
    this.config = { ...DEFAULT_SBR_CONFIG, ...config };
  }

  getInitialFetchSize(ctx: FetchStrategyContext): number {
    // Fetch enough GOPs to fill to target buffer, but cap at 4 GOPs per request
    // Smaller batches are more reliable over congested networks and relays
    const idealGops = Math.ceil(this.config.targetBufferSec / ctx.gopDurationSec);
    return Math.min(idealGops, 4);
  }

  getMinFramesForPlayback(framesPerGop: number, gopDurationSec: number): number {
    // Buffer at least 2 GOPs before starting playback to absorb decode stalls
    // during high-motion scenes (4K frames can take 20-30ms to decode)
    const minGops = Math.max(2, Math.ceil(this.config.initialBufferSec / gopDurationSec));
    return minGops * framesPerGop;
  }

  getMaxConcurrentFetches(): number {
    return this.config.maxConcurrentFetches;
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
      } else if (ctx.activeFetchCount === 0) {
        // Initial fetch completed but didn't fill buffer (relay had limited data).
        // Continue fetching from where we left off rather than deadlocking.
        const startGroup = ctx.highestInFlightGroup + 1;
        const gopsNeeded = Math.ceil(this.config.targetBufferSec / ctx.gopDurationSec);
        const endGroup = Math.min(
          startGroup + gopsNeeded - 1,
          ctx.totalGroups - 1
        );

        if (startGroup > endGroup) {
          this.initialFetchDone = true;
          return noFetch;
        }

        return { shouldFetch: true, startGroup, endGroup };
      } else if (ctx.activeFetchCount < ctx.maxConcurrentFetches && ctx.bufferedSeconds < this.config.initialBufferSec * 2) {
        // Buffer is critically low during initial fetch - issue concurrent fetch to avoid starvation
        // This handles slow networks where the initial fetch can't keep up with playback
        const startGroup = ctx.highestInFlightGroup + 1;
        if (startGroup < ctx.totalGroups) {
          const gopsToFetch = Math.min(
            Math.ceil((this.config.highBufferSec - ctx.bufferedSeconds) / ctx.gopDurationSec),
            4 // Cap at 4 GOPs per request for reliability
          );
          const endGroup = Math.min(startGroup + gopsToFetch - 1, ctx.totalGroups - 1);
          if (startGroup <= endGroup) {
            return { shouldFetch: true, startGroup, endGroup };
          }
        }
        return noFetch;
      } else {
        // Initial fetch still in flight and buffer is healthy, wait for it
        return noFetch;
      }
    }

    // Sawtooth: only fetch when buffer drops to low threshold
    if (ctx.bufferedSeconds > this.config.lowBufferSec) {
      return noFetch;
    }

    // Calculate how many GOPs to fetch to reach high buffer mark
    const secondsToFetch = this.config.highBufferSec - ctx.bufferedSeconds;
    const gopsToFetch = Math.min(
      Math.ceil(secondsToFetch / ctx.gopDurationSec),
      4 // Cap at 4 GOPs per request for reliability
    );

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
