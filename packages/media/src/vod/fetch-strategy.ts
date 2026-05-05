// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview VOD Fetch Strategy Interface
 *
 * Defines the strategy pattern for VOD fetch decision-making.
 * Strategies control how much to fetch and when, while the
 * VodFetchController manages state, events, and fetch execution.
 */

/**
 * Decision returned by a fetch strategy
 */
export interface FetchDecision {
  /** Whether a fetch should be issued */
  shouldFetch: boolean;
  /** First group to fetch (inclusive) */
  startGroup: number;
  /** Last group to fetch (inclusive) */
  endGroup: number;
  /** For ABR: which track to fetch from (undefined = current track) */
  trackName?: string;
}

/**
 * Read-only snapshot of controller state provided to strategies
 */
export interface FetchStrategyContext {
  /** Current group being played */
  playbackGroup: number;
  /** Last group fully fetched (inclusive) */
  fetchedUpToGroup: number;
  /** Buffered content in seconds */
  bufferedSeconds: number;
  /** Buffered frame count */
  bufferedFrames: number;
  /** Total groups in the VOD content */
  totalGroups: number;
  /** GOP duration in seconds */
  gopDurationSec: number;
  /** Number of currently active (in-flight) fetches */
  activeFetchCount: number;
  /** Maximum concurrent fetches allowed */
  maxConcurrentFetches: number;
  /** Highest endGroup among active (in-flight) fetches */
  highestInFlightGroup: number;
  /** Rolling average ms to download one GOP */
  avgGroupDownloadMs: number;
  /** Recent download performance samples */
  downloadHistory: ReadonlyArray<{
    durationMs: number;
    groupCount: number;
    bytesReceived: number;
  }>;
}

/**
 * Strategy interface for VOD fetch decisions
 *
 * Implementations control:
 * - How many GOPs to fetch initially
 * - When and how much to fetch during playback
 * - When playback can start (fast-start threshold)
 */
export interface FetchStrategy {
  /** Strategy name for logging */
  readonly name: string;

  /**
   * How many GOPs to fetch for the initial buffer fill
   */
  getInitialFetchSize(ctx: FetchStrategyContext): number;

  /**
   * Decide whether to issue a fetch and what range to request.
   * Called on each tick: group received, fetch complete, frame played.
   */
  getNextFetch(ctx: FetchStrategyContext): FetchDecision;

  /**
   * Minimum number of buffered frames before playback can start.
   * Lower values = faster start (e.g., 1 GOP for fast start).
   * @param framesPerGop - Number of frames per GOP
   * @param gopDurationSec - GOP duration in seconds (optional, for buffer-based strategies)
   */
  getMinFramesForPlayback(framesPerGop: number, gopDurationSec?: number): number;

  /**
   * Maximum concurrent fetch requests allowed.
   * Optional - if not provided, defaults to controller's config.
   */
  getMaxConcurrentFetches?(): number;
}
