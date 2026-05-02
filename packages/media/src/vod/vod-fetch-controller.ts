// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview VOD Fetch Controller
 *
 * Manages smooth VOD playback using FETCH requests. Delegates fetch
 * decision-making to a pluggable FetchStrategy:
 *
 * - LegacyFetchStrategy (default): Adaptive fetch-ahead based on network speed
 * - SbrFetchStrategy: Sawtooth buffer pattern for single-bitrate content
 * - AbrFetchStrategy: Progressive quality ramp-up for multi-bitrate content
 *
 * The controller owns state management, event emission, and fetch tracking.
 * Strategies only decide what to fetch and when.
 */

import { Logger } from '@web-moq/core';
import { type FetchStrategy, type FetchStrategyContext } from './fetch-strategy';

const log = Logger.create('moqt:media:vod-fetch-controller');

/**
 * Configuration for VOD fetch controller
 */
export interface VodFetchConfig {
  /** Framerate from catalog (e.g., 60) */
  framerate: number;

  /** GOP duration in ms from catalog (e.g., 500) */
  gopDurationMs: number;

  /** Total number of groups in the VOD content */
  totalGroups: number;

  /** Target buffer duration in seconds before starting playback (default: 2) */
  initialBufferSec?: number;

  /** Minimum buffer to maintain during playback in seconds (default: 1.5) */
  minBufferSec?: number;

  /** How many seconds worth of groups to fetch per request (default: 1) */
  fetchBatchSec?: number;

  /** Maximum concurrent fetch requests (default: 1 for sequential) */
  maxConcurrentFetches?: number;

  /** Fetch strategy to use (default: LegacyFetchStrategy) */
  strategy?: FetchStrategy;
}

/**
 * Fetch request info
 */
interface FetchRequest {
  requestId: number;
  startGroup: number;
  endGroup: number;
  completed: boolean;
  objectsReceived: number;
  startTime: number;       // When fetch was issued (ms)
  bytesReceived: number;   // Total bytes received
}

/**
 * Controller state
 */
type ControllerState =
  | 'idle'
  | 'initial-buffering'
  | 'playing'
  | 'rebuffering'
  | 'completed'
  | 'error';

/**
 * Events emitted by the controller
 */
export interface VodFetchEvents {
  /** Request to fetch a range of groups */
  'fetch-request': { startGroup: number; endGroup: number; requestId: number; trackName?: string };
  /** Playback can start (initial buffer filled) */
  'ready-to-play': { bufferedGroups: number; bufferedFrames: number };
  /** Buffer is running low */
  'buffer-low': { bufferedFrames: number; threshold: number };
  /** Rebuffering started */
  'rebuffering': { currentGroup: number };
  /** Rebuffering ended, playback resumed */
  'rebuffer-ended': { bufferedFrames: number };
  /** Playback completed */
  'completed': void;
  /** State changed */
  'state-change': { from: ControllerState; to: ControllerState };
  /** Network speed update */
  'speed-update': { avgMsPerGop: number; adaptiveFetchAhead: number };
  /** Strategy-specific update (for UI/debugging) */
  'strategy-update': { strategy: string; phase?: string; bufferTarget?: number; qualityTier?: string };
}

/**
 * VOD Fetch Controller
 *
 * Coordinates FETCH requests to maintain smooth VOD playback.
 * Delegates fetch decisions to a pluggable FetchStrategy.
 *
 * @example
 * ```typescript
 * import { SbrFetchStrategy } from './sbr-fetch-strategy';
 *
 * const controller = new VodFetchController({
 *   framerate: 60,
 *   gopDurationMs: 500,
 *   totalGroups: 100,
 *   strategy: new SbrFetchStrategy({ targetBufferSec: 30, lowBufferSec: 20, highBufferSec: 40 }),
 * });
 *
 * controller.on('fetch-request', async ({ startGroup, endGroup }) => {
 *   await session.fetch(namespace, trackName, {
 *     startGroup,
 *     startObject: 0,
 *     endGroup,
 *     endObject: 0,
 *   });
 * });
 *
 * controller.on('ready-to-play', () => {
 *   // Start video playback
 * });
 *
 * controller.start();
 * ```
 */
export class VodFetchController {
  private config: Required<Omit<VodFetchConfig, 'strategy'>>;
  private strategy: FetchStrategy;
  private state: ControllerState = 'idle';
  private handlers = new Map<keyof VodFetchEvents, Set<(data: unknown) => void>>();

  // Tracking positions
  private playbackGroup = 0;          // Current group being played
  private playbackObject = 0;         // Current object being played
  private fetchedUpToGroup = -1;      // Last group we've fetched (inclusive)
  private bufferedUpToGroup = -1;     // Last group fully received
  private bufferedFrames = 0;         // Total frames in buffer

  // Fetch tracking
  private activeFetches = new Map<number, FetchRequest>();
  private nextRequestId = 1;

  // Timing
  private framesPerGop: number;
  private gopsForInitialBuffer: number;
  private gopsForMinBuffer: number;
  private gopsPerFetch: number;

  // Adaptive fetch-ahead tracking (used by LegacyFetchStrategy and for stats)
  private downloadHistory: { durationMs: number; groupCount: number; bytesReceived: number }[] = [];
  private avgGroupDownloadMs = 0;
  private adaptiveFetchAhead: number;

  constructor(config: VodFetchConfig) {
    // Extract strategy before applying defaults
    this.strategy = config.strategy ?? new LegacyFetchStrategy({
      initialBufferSec: config.initialBufferSec,
      minBufferSec: config.minBufferSec,
      fetchBatchSec: config.fetchBatchSec,
      gopDurationSec: config.gopDurationMs ? config.gopDurationMs / 1000 : undefined,
    });

    // Apply defaults
    this.config = {
      framerate: config.framerate,
      gopDurationMs: config.gopDurationMs,
      totalGroups: config.totalGroups,
      initialBufferSec: config.initialBufferSec ?? 2,
      minBufferSec: config.minBufferSec ?? 1.5,
      fetchBatchSec: config.fetchBatchSec ?? 1,
      maxConcurrentFetches: config.maxConcurrentFetches ?? 1,
    };

    // Calculate derived values
    const gopDurationSec = this.config.gopDurationMs / 1000;
    this.framesPerGop = Math.round(this.config.framerate * gopDurationSec);
    this.gopsForInitialBuffer = Math.ceil(this.config.initialBufferSec / gopDurationSec);
    this.gopsForMinBuffer = Math.ceil(this.config.minBufferSec / gopDurationSec);
    this.gopsPerFetch = Math.ceil(this.config.fetchBatchSec / gopDurationSec);

    // Start adaptive fetch-ahead at initial buffer size
    this.adaptiveFetchAhead = this.gopsForInitialBuffer;

    log.info('VodFetchController created', {
      strategy: this.strategy.name,
      framerate: this.config.framerate,
      gopDurationMs: this.config.gopDurationMs,
      totalGroups: this.config.totalGroups,
      framesPerGop: this.framesPerGop,
      gopsForInitialBuffer: this.gopsForInitialBuffer,
      gopsForMinBuffer: this.gopsForMinBuffer,
      gopsPerFetch: this.gopsPerFetch,
      initialBufferFrames: this.gopsForInitialBuffer * this.framesPerGop,
      minBufferFrames: this.gopsForMinBuffer * this.framesPerGop,
      adaptiveFetchAhead: this.adaptiveFetchAhead,
    });
  }

  /**
   * Get the active fetch strategy
   */
  getStrategy(): FetchStrategy {
    return this.strategy;
  }

  /**
   * Start the fetch controller
   * Begins initial buffering phase
   * @param startGroup - Optional starting group (default: 0)
   */
  start(startGroup: number = 0): void {
    if (this.state !== 'idle') {
      log.warn('Controller already started', { state: this.state });
      return;
    }

    // Set starting position
    this.playbackGroup = startGroup;
    this.fetchedUpToGroup = startGroup - 1;
    this.bufferedUpToGroup = startGroup - 1;

    log.info('Starting fetch controller', { startGroup, totalGroups: this.config.totalGroups, strategy: this.strategy.name });
    console.log('[VodFetchController] START called', {
      startGroup,
      strategy: this.strategy.name,
      playbackGroup: this.playbackGroup,
      fetchedUpToGroup: this.fetchedUpToGroup,
      totalGroups: this.config.totalGroups,
    });

    this.setState('initial-buffering');
    this.fetchInitialBuffer();
  }

  /**
   * Notify controller that a group has been fully received
   */
  onGroupReceived(groupId: number, frameCount: number): void {
    log.debug('Group received', { groupId, frameCount, state: this.state });

    // Update buffer tracking
    if (groupId > this.bufferedUpToGroup) {
      this.bufferedUpToGroup = groupId;
    }
    this.bufferedFrames += frameCount;

    // Check state transitions
    if (this.state === 'initial-buffering') {
      this.checkInitialBufferReady();
    } else if (this.state === 'rebuffering') {
      this.checkRebufferComplete();
    }

    // Check if we need to fetch more
    this.maybeIssueFetch();
  }

  /**
   * Notify controller that data was received for a fetch
   */
  onFetchData(requestId: number, bytesReceived: number): void {
    const fetch = this.activeFetches.get(requestId);
    if (fetch) {
      fetch.bytesReceived += bytesReceived;
    }
  }

  /**
   * Notify controller that a fetch request completed
   * @param requestId - The fetch request ID
   * @param actualLastGroup - The actual last group received (may be less than requested endGroup)
   */
  onFetchComplete(requestId: number, actualLastGroup?: number): void {
    const fetch = this.activeFetches.get(requestId);
    if (fetch) {
      fetch.completed = true;
      const durationMs = performance.now() - fetch.startTime;

      // Use actualLastGroup if provided, otherwise fall back to requested endGroup
      const receivedEndGroup = actualLastGroup ?? fetch.endGroup;
      const groupCount = receivedEndGroup - fetch.startGroup + 1;

      // Update fetchedUpToGroup based on what was actually received
      if (actualLastGroup !== undefined && actualLastGroup < fetch.endGroup) {
        log.warn('Fetch received fewer groups than requested', {
          requestId,
          requestedEndGroup: fetch.endGroup,
          actualLastGroup,
        });
      }
      this.fetchedUpToGroup = Math.max(this.fetchedUpToGroup, receivedEndGroup);

      // Track download performance
      this.downloadHistory.push({
        durationMs,
        groupCount,
        bytesReceived: fetch.bytesReceived,
      });

      // Keep last 10 samples for rolling average
      if (this.downloadHistory.length > 10) {
        this.downloadHistory.shift();
      }

      // Update average download time per GOP
      this.updateAvgGroupDownloadMs();

      log.info('Fetch completed', {
        requestId,
        startGroup: fetch.startGroup,
        endGroup: fetch.endGroup,
        durationMs: Math.round(durationMs),
        bytesReceived: fetch.bytesReceived,
        msPerGop: Math.round(durationMs / groupCount),
        strategy: this.strategy.name,
      });

      this.activeFetches.delete(requestId);
    }

    // Issue next fetch if needed
    this.maybeIssueFetch();
  }

  /**
   * Update rolling average download time per GOP
   */
  private updateAvgGroupDownloadMs(): void {
    if (this.downloadHistory.length === 0) return;

    // Calculate weighted average (recent samples weighted more)
    let totalWeight = 0;
    let weightedSum = 0;
    this.downloadHistory.forEach((sample, i) => {
      const weight = i + 1;
      const msPerGop = sample.durationMs / sample.groupCount;
      weightedSum += msPerGop * weight;
      totalWeight += weight;
    });

    this.avgGroupDownloadMs = weightedSum / totalWeight;

    // For legacy strategy, also update adaptiveFetchAhead
    if (this.strategy.name === 'legacy') {
      this.updateAdaptiveFetchAhead();
    }

    this.emit('speed-update', {
      avgMsPerGop: this.avgGroupDownloadMs,
      adaptiveFetchAhead: this.adaptiveFetchAhead,
    });
  }

  /**
   * Update adaptive fetch-ahead (used by LegacyFetchStrategy)
   */
  private updateAdaptiveFetchAhead(): void {
    const gopDurationMs = this.config.gopDurationMs;
    const downloadToPlayRatio = this.avgGroupDownloadMs / gopDurationMs;

    const safetyMargin = 1.5;
    const minFetchAhead = this.gopsForInitialBuffer;
    const maxFetchAhead = Math.min(
      this.gopsForInitialBuffer * 4,
      this.config.totalGroups - this.playbackGroup
    );

    if (downloadToPlayRatio > 1) {
      this.adaptiveFetchAhead = Math.min(
        Math.ceil(minFetchAhead * downloadToPlayRatio * safetyMargin),
        maxFetchAhead
      );
    } else {
      this.adaptiveFetchAhead = minFetchAhead;
    }

    log.info('Adaptive fetch-ahead updated', {
      avgGroupDownloadMs: Math.round(this.avgGroupDownloadMs),
      gopDurationMs,
      downloadToPlayRatio: downloadToPlayRatio.toFixed(2),
      adaptiveFetchAhead: this.adaptiveFetchAhead,
      sampleCount: this.downloadHistory.length,
    });
  }

  /**
   * Notify controller that playback consumed a frame
   */
  onFramePlayed(groupId: number, objectId: number): void {
    this.playbackGroup = groupId;
    this.playbackObject = objectId;
    this.bufferedFrames = Math.max(0, this.bufferedFrames - 1);

    // Check for buffer underrun
    const minBufferFrames = this.gopsForMinBuffer * this.framesPerGop;
    if (this.bufferedFrames < minBufferFrames / 2 && this.state === 'playing') {
      this.emit('buffer-low', {
        bufferedFrames: this.bufferedFrames,
        threshold: minBufferFrames
      });
    }

    // Check if we need to rebuffer
    if (this.bufferedFrames <= 0 && this.state === 'playing') {
      if (this.playbackGroup < this.config.totalGroups - 1) {
        this.setState('rebuffering');
        this.emit('rebuffering', { currentGroup: this.playbackGroup });
      } else {
        this.setState('completed');
        this.emit('completed', undefined);
      }
    }

    // Check if we need to fetch more
    this.maybeIssueFetch();
  }

  /**
   * Notify controller that a frame was consumed/rendered (simpler version without position tracking)
   * Use this when you don't have groupId/objectId but need to decrement buffer count
   */
  onFrameConsumed(): void {
    this.bufferedFrames = Math.max(0, this.bufferedFrames - 1);

    // Log every 30 frames (roughly once per second at 30fps)
    if (this.bufferedFrames % 30 === 0) {
      log.info('Frame consumed (periodic)', {
        bufferedFrames: this.bufferedFrames,
        state: this.state,
        bufferedUpToGroup: this.bufferedUpToGroup,
        fetchedUpToGroup: this.fetchedUpToGroup,
      });
    }

    // Check for buffer underrun
    const minBufferFrames = this.gopsForMinBuffer * this.framesPerGop;
    if (this.bufferedFrames < minBufferFrames / 2 && this.state === 'playing') {
      this.emit('buffer-low', {
        bufferedFrames: this.bufferedFrames,
        threshold: minBufferFrames
      });
    }

    // Check if we need to rebuffer
    if (this.bufferedFrames <= 0 && this.state === 'playing') {
      if (this.playbackGroup < this.config.totalGroups - 1) {
        this.setState('rebuffering');
        this.emit('rebuffering', { currentGroup: this.playbackGroup });
      } else {
        this.setState('completed');
        this.emit('completed', undefined);
      }
    }

    // Check if we need to fetch more
    this.maybeIssueFetch();
  }

  /**
   * Seek to a specific position
   */
  seek(groupId: number, objectId: number = 0): void {
    log.info('Seeking', { groupId, objectId, currentGroup: this.playbackGroup });

    // Reset state
    this.playbackGroup = groupId;
    this.playbackObject = objectId;
    this.fetchedUpToGroup = groupId - 1;
    this.bufferedUpToGroup = groupId - 1;
    this.bufferedFrames = 0;
    this.activeFetches.clear();

    // Start rebuffering from new position
    this.setState('rebuffering');
    this.fetchFromPosition(groupId);
  }

  /**
   * Get current state
   */
  getState(): ControllerState {
    return this.state;
  }

  /**
   * Get buffer statistics
   */
  getStats(): {
    state: ControllerState;
    strategy: string;
    playbackGroup: number;
    playbackObject: number;
    bufferedUpToGroup: number;
    fetchedUpToGroup: number;
    bufferedFrames: number;
    bufferedSeconds: number;
    activeFetches: number;
    avgMsPerGop: number;
    adaptiveFetchAhead: number;
    downloadSamples: number;
  } {
    const bufferedSeconds = this.bufferedFrames / this.config.framerate;
    return {
      state: this.state,
      strategy: this.strategy.name,
      playbackGroup: this.playbackGroup,
      playbackObject: this.playbackObject,
      bufferedUpToGroup: this.bufferedUpToGroup,
      fetchedUpToGroup: this.fetchedUpToGroup,
      bufferedFrames: this.bufferedFrames,
      bufferedSeconds,
      activeFetches: this.activeFetches.size,
      avgMsPerGop: this.avgGroupDownloadMs,
      adaptiveFetchAhead: this.adaptiveFetchAhead,
      downloadSamples: this.downloadHistory.length,
    };
  }

  // ============================================================
  // Event handling
  // ============================================================

  on<K extends keyof VodFetchEvents>(
    event: K,
    handler: (data: VodFetchEvents[K]) => void
  ): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler as (data: unknown) => void);

    return () => {
      this.handlers.get(event)?.delete(handler as (data: unknown) => void);
    };
  }

  private emit<K extends keyof VodFetchEvents>(event: K, data: VodFetchEvents[K]): void {
    const handlers = this.handlers.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(data);
        } catch (err) {
          log.error('Event handler error', { event, error: (err as Error).message });
        }
      }
    }
  }

  // ============================================================
  // Internal methods
  // ============================================================

  private setState(newState: ControllerState): void {
    if (this.state !== newState) {
      const from = this.state;
      this.state = newState;
      log.info('State change', { from, to: newState });
      this.emit('state-change', { from, to: newState });
    }
  }

  /**
   * Build context snapshot for the fetch strategy
   */
  private buildContext(): FetchStrategyContext {
    // Find highest in-flight group
    let highestInFlightGroup = this.fetchedUpToGroup;
    for (const fetch of this.activeFetches.values()) {
      if (!fetch.completed) {
        highestInFlightGroup = Math.max(highestInFlightGroup, fetch.endGroup);
      }
    }

    return {
      playbackGroup: this.playbackGroup,
      fetchedUpToGroup: this.fetchedUpToGroup,
      bufferedSeconds: this.bufferedFrames / this.config.framerate,
      bufferedFrames: this.bufferedFrames,
      totalGroups: this.config.totalGroups,
      gopDurationSec: this.config.gopDurationMs / 1000,
      activeFetchCount: this.activeFetches.size,
      maxConcurrentFetches: this.config.maxConcurrentFetches,
      highestInFlightGroup,
      avgGroupDownloadMs: this.avgGroupDownloadMs,
      downloadHistory: this.downloadHistory,
    };
  }

  private fetchInitialBuffer(): void {
    const ctx = this.buildContext();
    const gopsToFetch = this.strategy.getInitialFetchSize(ctx);
    const startGroup = this.playbackGroup;
    const endGroup = Math.min(
      startGroup + gopsToFetch - 1,
      this.config.totalGroups - 1
    );

    log.info('Fetching initial buffer', {
      strategy: this.strategy.name,
      startGroup,
      endGroup,
      gopsToFetch,
    });

    this.issueFetch(startGroup, endGroup);
  }

  private fetchFromPosition(startGroup: number): void {
    const ctx = this.buildContext();
    const gopsToFetch = this.strategy.getInitialFetchSize(ctx);
    const endGroup = Math.min(
      startGroup + gopsToFetch - 1,
      this.config.totalGroups - 1
    );

    log.info('Fetching from position', { startGroup, endGroup });
    this.issueFetch(startGroup, endGroup);
  }

  private maybeIssueFetch(): void {
    const ctx = this.buildContext();
    const decision = this.strategy.getNextFetch(ctx);

    // Log occasionally to see fetch decision state
    if (this.bufferedFrames % 30 === 0 || decision.shouldFetch) {
      log.info('maybeIssueFetch decision', {
        shouldFetch: decision.shouldFetch,
        bufferedSeconds: ctx.bufferedSeconds.toFixed(1),
        bufferedFrames: ctx.bufferedFrames,
        activeFetchCount: ctx.activeFetchCount,
        highestInFlightGroup: ctx.highestInFlightGroup,
        fetchedUpToGroup: ctx.fetchedUpToGroup,
        totalGroups: ctx.totalGroups,
        startGroup: decision.startGroup,
        endGroup: decision.endGroup,
      });
    }

    if (decision.shouldFetch) {
      this.issueFetch(decision.startGroup, decision.endGroup, decision.trackName);
    }
  }

  private issueFetch(startGroup: number, endGroup: number, trackName?: string): void {
    const requestId = this.nextRequestId++;

    const fetchRequest: FetchRequest = {
      requestId,
      startGroup,
      endGroup,
      completed: false,
      objectsReceived: 0,
      startTime: performance.now(),
      bytesReceived: 0,
    };

    this.activeFetches.set(requestId, fetchRequest);

    log.info('Issuing FETCH', {
      requestId,
      startGroup,
      endGroup,
      groupCount: endGroup - startGroup + 1,
      activeFetches: this.activeFetches.size,
      strategy: this.strategy.name,
      trackName,
    });
    console.log('[VodFetchController] ISSUE FETCH', {
      requestId,
      startGroup,
      endGroup,
      trackName,
      playbackGroup: this.playbackGroup,
      fetchedUpToGroup: this.fetchedUpToGroup,
    });

    this.emit('fetch-request', { startGroup, endGroup, requestId, trackName });
  }

  private checkInitialBufferReady(): void {
    const requiredFrames = this.strategy.getMinFramesForPlayback(this.framesPerGop);

    if (this.bufferedFrames >= requiredFrames) {
      log.info('Initial buffer ready', {
        bufferedFrames: this.bufferedFrames,
        requiredFrames,
        bufferedGroups: this.bufferedUpToGroup + 1,
        strategy: this.strategy.name,
      });

      this.setState('playing');
      this.emit('ready-to-play', {
        bufferedGroups: this.bufferedUpToGroup + 1,
        bufferedFrames: this.bufferedFrames,
      });
    } else {
      log.debug('Initial buffering progress', {
        bufferedFrames: this.bufferedFrames,
        requiredFrames,
        percent: Math.round((this.bufferedFrames / requiredFrames) * 100),
      });
    }
  }

  private checkRebufferComplete(): void {
    const requiredFrames = this.gopsForMinBuffer * this.framesPerGop;

    if (this.bufferedFrames >= requiredFrames) {
      log.info('Rebuffer complete', { bufferedFrames: this.bufferedFrames });
      this.setState('playing');
      this.emit('rebuffer-ended', { bufferedFrames: this.bufferedFrames });
    }
  }
}

// ============================================================
// Legacy Fetch Strategy (preserves original behavior)
// ============================================================

/**
 * Legacy fetch strategy that preserves the original VodFetchController behavior.
 * Uses adaptive fetch-ahead based on download-to-play ratio.
 *
 * This is the default strategy when no explicit strategy is provided.
 */
export class LegacyFetchStrategy implements FetchStrategy {
  readonly name = 'legacy';

  private initialBufferSec: number;
  private fetchBatchSec: number;
  private gopDurationSec: number;

  constructor(options?: { initialBufferSec?: number; minBufferSec?: number; fetchBatchSec?: number; gopDurationSec?: number }) {
    this.initialBufferSec = options?.initialBufferSec ?? 2;
    this.fetchBatchSec = options?.fetchBatchSec ?? 1;
    this.gopDurationSec = options?.gopDurationSec ?? 2;
  }

  getInitialFetchSize(ctx: FetchStrategyContext): number {
    return Math.ceil(this.initialBufferSec / ctx.gopDurationSec);
  }

  getMinFramesForPlayback(framesPerGop: number): number {
    // Original behavior: wait for the full initial buffer
    const gopsForInitialBuffer = Math.ceil(this.initialBufferSec / this.gopDurationSec);
    return gopsForInitialBuffer * framesPerGop;
  }

  getNextFetch(ctx: FetchStrategyContext): { shouldFetch: boolean; startGroup: number; endGroup: number } {
    const noFetch = { shouldFetch: false, startGroup: 0, endGroup: 0 };

    if (ctx.activeFetchCount >= ctx.maxConcurrentFetches) {
      return noFetch;
    }

    if (ctx.highestInFlightGroup >= ctx.totalGroups - 1) {
      return noFetch;
    }

    // Calculate adaptive fetch-ahead from download history
    const adaptiveFetchAhead = this.calculateAdaptiveFetchAhead(ctx);
    const targetFetchGroup = ctx.playbackGroup + adaptiveFetchAhead;

    if (ctx.highestInFlightGroup < targetFetchGroup) {
      const startGroup = ctx.highestInFlightGroup + 1;
      const fetchBatchGops = Math.ceil(this.fetchBatchSec / ctx.gopDurationSec);
      const fetchBatch = ctx.avgGroupDownloadMs > (ctx.gopDurationSec * 1000)
        ? Math.min(fetchBatchGops * 2, 8)
        : fetchBatchGops;
      const endGroup = Math.min(
        startGroup + fetchBatch - 1,
        ctx.totalGroups - 1
      );

      if (startGroup <= endGroup) {
        return { shouldFetch: true, startGroup, endGroup };
      }
    }

    return noFetch;
  }

  private calculateAdaptiveFetchAhead(ctx: FetchStrategyContext): number {
    const gopsForInitialBuffer = Math.ceil(this.initialBufferSec / ctx.gopDurationSec);

    if (ctx.downloadHistory.length === 0) {
      return gopsForInitialBuffer;
    }

    const gopDurationMs = ctx.gopDurationSec * 1000;
    const downloadToPlayRatio = ctx.avgGroupDownloadMs / gopDurationMs;

    const safetyMargin = 1.5;
    const minFetchAhead = gopsForInitialBuffer;
    const maxFetchAhead = Math.min(
      gopsForInitialBuffer * 4,
      ctx.totalGroups - ctx.playbackGroup
    );

    if (downloadToPlayRatio > 1) {
      return Math.min(
        Math.ceil(minFetchAhead * downloadToPlayRatio * safetyMargin),
        maxFetchAhead
      );
    }

    return minFetchAhead;
  }
}

// ============================================================
// Factory
// ============================================================

/**
 * Create a VOD fetch controller from catalog track info
 *
 * @param trackInfo - Track info from catalog (framerate, gopDuration, totalGroups)
 * @param options - Override default buffer settings and choose fetch strategy
 *
 * Note: Default gopDuration is 2000ms (2 seconds) which is typical for H.264 VOD content.
 */
export function createVodFetchController(
  trackInfo: {
    framerate?: number;
    gopDuration?: number;
    totalGroups?: number;
  },
  options?: {
    initialBufferSec?: number;
    minBufferSec?: number;
    fetchBatchSec?: number;
    /** Fetch strategy to use. If not provided, uses LegacyFetchStrategy. */
    strategy?: FetchStrategy;
  }
): VodFetchController {
  const framerate = trackInfo.framerate ?? 30;
  const gopDurationMs = trackInfo.gopDuration ?? 2000;
  const totalGroups = trackInfo.totalGroups ?? 100;

  return new VodFetchController({
    framerate,
    gopDurationMs,
    totalGroups,
    ...options,
  });
}
