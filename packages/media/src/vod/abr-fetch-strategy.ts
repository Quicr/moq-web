// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview ABR (Adaptive Bitrate) Fetch Strategy
 *
 * Implements client-side ABR for multi-bitrate VOD playback.
 * Two phases:
 *
 * 1. RAMP-UP: Start at lowest quality, fetch small batches (1-2 GOPs),
 *    estimate throughput, switch up progressively until max quality reached.
 *
 * 2. STEADY: Buffer target depends on quality tier:
 *    - Lowest/switching: small buffer (4s) - stay nimble for switches
 *    - Intermediate: medium buffer (30s) with sawtooth - ready to switch
 *    - Highest: deep buffer (60s) - fill with best quality while possible
 */

import { type FetchStrategy, type FetchDecision, type FetchStrategyContext } from './fetch-strategy';
import { type ABRController } from '../abr/abr-controller';

/**
 * Configuration for ABR fetch strategy
 */
export interface AbrFetchConfig {
  /** ABRController instance for quality decisions */
  abrController: ABRController;
  /** altGroup identifier for the video tracks */
  altGroup: number;
  /** Buffer target while switching/ramping up in seconds (default: 4) */
  switchingBufferSec: number;
  /** Buffer target at intermediate quality in seconds (default: 30) */
  intermediateBufferSec: number;
  /** Buffer target at highest quality in seconds (default: 60) */
  topBufferSec: number;
  /** Number of groups to fetch per ramp-up probe (default: 2) */
  probeGroupCount: number;
}

export const DEFAULT_ABR_FETCH_CONFIG: Omit<AbrFetchConfig, 'abrController' | 'altGroup'> = {
  switchingBufferSec: 4,
  intermediateBufferSec: 30,
  topBufferSec: 60,
  probeGroupCount: 2,
};

type AbrPhase = 'ramp-up' | 'steady';

export class AbrFetchStrategy implements FetchStrategy {
  readonly name = 'abr';
  private config: AbrFetchConfig;
  private phase: AbrPhase = 'ramp-up';
  private lastReportedBandwidth = 0;

  constructor(config: Pick<AbrFetchConfig, 'abrController' | 'altGroup'> & Partial<Omit<AbrFetchConfig, 'abrController' | 'altGroup'>>) {
    this.config = {
      ...DEFAULT_ABR_FETCH_CONFIG,
      ...config,
    };
  }

  getInitialFetchSize(_ctx: FetchStrategyContext): number {
    // Start small during ramp-up: just a few groups to estimate throughput quickly
    return this.config.probeGroupCount;
  }

  getMinFramesForPlayback(framesPerGop: number, _gopDurationSec?: number): number {
    // Fast start: begin playback after 1 GOP
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

    // Feed throughput data to ABRController from download history
    this.feedThroughputToAbr(ctx);

    // Feed buffer level to ABRController
    this.config.abrController.reportBufferLevel(ctx.bufferedSeconds);

    // Get current quality tier
    const tier = this.config.abrController.getQualityTier(this.config.altGroup);
    const currentTrack = this.config.abrController.getCurrentTrack(this.config.altGroup);
    const trackName = currentTrack?.name;

    if (this.phase === 'ramp-up') {
      return this.getRampUpFetch(ctx, tier, trackName);
    }

    return this.getSteadyFetch(ctx, tier, trackName);
  }

  /**
   * Get current phase for debugging/UI
   */
  getPhase(): AbrPhase {
    return this.phase;
  }

  /**
   * Get the buffer target for the current quality tier
   */
  getBufferTarget(tier: 'lowest' | 'intermediate' | 'highest'): number {
    switch (tier) {
      case 'lowest': return this.config.switchingBufferSec;
      case 'intermediate': return this.config.intermediateBufferSec;
      case 'highest': return this.config.topBufferSec;
    }
  }

  // ============================================================
  // Private methods
  // ============================================================

  private getRampUpFetch(
    ctx: FetchStrategyContext,
    tier: 'lowest' | 'intermediate' | 'highest',
    trackName?: string
  ): FetchDecision {
    const noFetch: FetchDecision = { shouldFetch: false, startGroup: 0, endGroup: 0 };

    // If we've reached the highest tier, transition to steady state
    if (tier === 'highest') {
      this.phase = 'steady';
      return this.getSteadyFetch(ctx, tier, trackName);
    }

    // During ramp-up, wait until current fetches complete before probing next level
    // This ensures we have throughput data for the ABR decision
    if (ctx.activeFetchCount > 0) {
      return noFetch;
    }

    // Fetch small probe batches for throughput estimation
    const startGroup = ctx.highestInFlightGroup + 1;
    const endGroup = Math.min(
      startGroup + this.config.probeGroupCount - 1,
      ctx.totalGroups - 1
    );

    if (startGroup > endGroup) {
      return noFetch;
    }

    // If ABR can't switch up anymore (intermediate is the max), go to steady
    if (tier === 'intermediate') {
      // Check if there are higher tracks available
      const qualityLevels = this.config.abrController.getQualityLevels(this.config.altGroup);
      const currentTrack = this.config.abrController.getCurrentTrack(this.config.altGroup);
      if (currentTrack) {
        const currentIdx = qualityLevels.findIndex(t => t.name === currentTrack.name);
        // If we're not at the top but ABR chose not to switch up, settle here
        if (currentIdx >= 0 && ctx.downloadHistory.length >= 2) {
          this.phase = 'steady';
          return this.getSteadyFetch(ctx, tier, trackName);
        }
      }
    }

    return {
      shouldFetch: true,
      startGroup,
      endGroup,
      trackName,
    };
  }

  private getSteadyFetch(
    ctx: FetchStrategyContext,
    tier: 'lowest' | 'intermediate' | 'highest',
    trackName?: string
  ): FetchDecision {
    const noFetch: FetchDecision = { shouldFetch: false, startGroup: 0, endGroup: 0 };

    // If we got downgraded, go back to ramp-up
    if (tier === 'lowest' && this.phase === 'steady') {
      const qualityLevels = this.config.abrController.getQualityLevels(this.config.altGroup);
      if (qualityLevels.length > 1) {
        // Only re-enter ramp-up if there are multiple quality levels
        // and we're at the lowest (indicates a downgrade happened)
        this.phase = 'ramp-up';
        return this.getRampUpFetch(ctx, tier, trackName);
      }
    }

    const bufferTarget = this.getBufferTarget(tier);

    // Sawtooth low threshold: 2/3 of target
    const lowThreshold = bufferTarget * 0.67;

    // Don't fetch if buffer is above low threshold
    if (ctx.bufferedSeconds > lowThreshold) {
      return noFetch;
    }

    // Calculate fetch size to reach buffer target
    const secondsToFetch = bufferTarget - ctx.bufferedSeconds;
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
      trackName,
    };
  }

  private feedThroughputToAbr(ctx: FetchStrategyContext): void {
    if (ctx.downloadHistory.length === 0) return;

    // Use the most recent sample to estimate bandwidth
    const latest = ctx.downloadHistory[ctx.downloadHistory.length - 1];
    if (latest.durationMs > 0 && latest.bytesReceived > 0) {
      const bps = (latest.bytesReceived * 8) / (latest.durationMs / 1000);
      // Only report if it's a new measurement
      if (bps !== this.lastReportedBandwidth) {
        this.config.abrController.reportBandwidth(bps);
        this.lastReportedBandwidth = bps;
      }
    }
  }
}
