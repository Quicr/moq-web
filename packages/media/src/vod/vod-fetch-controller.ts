// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview VOD Fetch Controller
 *
 * Manages smooth VOD playback using FETCH requests. Implements a buffer-aware
 * fetching strategy that:
 *
 * 1. Pre-fills buffer before starting playback
 * 2. Continuously fetches ahead during playback to maintain buffer
 * 3. Uses catalog metadata (GOP duration, framerate) for optimal fetch sizing
 *
 * This approach avoids the parallel stream delivery issue of SUBSCRIBE,
 * ensuring groups arrive in order for smooth sequential playback.
 */

import { Logger } from '@web-moq/core';

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
  'fetch-request': { startGroup: number; endGroup: number; requestId: number };
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
}

/**
 * VOD Fetch Controller
 *
 * Coordinates FETCH requests to maintain smooth VOD playback.
 *
 * @example
 * ```typescript
 * const controller = new VodFetchController({
 *   framerate: 60,
 *   gopDurationMs: 500,
 *   totalGroups: 100,
 * });
 *
 * controller.on('fetch-request', async ({ startGroup, endGroup }) => {
 *   await session.fetch(namespace, trackName, {
 *     startGroup,
 *     startObject: 0,
 *     endGroup,
 *     endObject: 0, // 0 = entire group
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
  private config: Required<VodFetchConfig>;
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

  // Adaptive fetch-ahead tracking
  private downloadHistory: { durationMs: number; groupCount: number; bytesReceived: number }[] = [];
  private avgGroupDownloadMs = 0;  // Rolling average time to download one GOP
  private adaptiveFetchAhead: number;  // Dynamic fetch-ahead in GOPs

  constructor(config: VodFetchConfig) {
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

    // Start adaptive fetch-ahead at initial buffer size, will adjust based on network
    this.adaptiveFetchAhead = this.gopsForInitialBuffer;

    log.info('VodFetchController created', {
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

    log.info('Starting fetch controller', { startGroup, totalGroups: this.config.totalGroups });

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
   */
  onFetchComplete(requestId: number): void {
    const fetch = this.activeFetches.get(requestId);
    if (fetch) {
      fetch.completed = true;
      const durationMs = performance.now() - fetch.startTime;
      const groupCount = fetch.endGroup - fetch.startGroup + 1;

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
      this.updateAdaptiveFetchAhead();

      log.info('Fetch completed', {
        requestId,
        startGroup: fetch.startGroup,
        endGroup: fetch.endGroup,
        durationMs: Math.round(durationMs),
        bytesReceived: fetch.bytesReceived,
        msPerGop: Math.round(durationMs / groupCount),
        adaptiveFetchAhead: this.adaptiveFetchAhead,
      });

      this.activeFetches.delete(requestId);
    }

    // Issue next fetch if needed
    this.maybeIssueFetch();
  }

  /**
   * Update adaptive fetch-ahead based on download performance
   */
  private updateAdaptiveFetchAhead(): void {
    if (this.downloadHistory.length === 0) return;

    // Calculate weighted average (recent samples weighted more)
    let totalWeight = 0;
    let weightedSum = 0;
    this.downloadHistory.forEach((sample, i) => {
      const weight = i + 1; // Later samples have higher weight
      const msPerGop = sample.durationMs / sample.groupCount;
      weightedSum += msPerGop * weight;
      totalWeight += weight;
    });

    this.avgGroupDownloadMs = weightedSum / totalWeight;

    // Calculate how many GOPs we need to fetch ahead to maintain buffer
    // If GOP duration is 500ms and download takes 200ms/GOP, we're OK
    // If download takes 800ms/GOP, we're falling behind and need more prefetch
    const gopDurationMs = this.config.gopDurationMs;
    const downloadToPlayRatio = this.avgGroupDownloadMs / gopDurationMs;

    // Adaptive fetch-ahead:
    // - Ratio < 1: Downloads faster than playback, keep initial buffer
    // - Ratio > 1: Downloads slower, need to fetch further ahead
    // - Add safety margin of 1.5x
    const safetyMargin = 1.5;
    const minFetchAhead = this.gopsForInitialBuffer;
    const maxFetchAhead = Math.min(
      this.gopsForInitialBuffer * 4,  // Cap at 4x initial buffer
      this.config.totalGroups - this.playbackGroup
    );

    // If slow network, increase fetch-ahead proportionally
    if (downloadToPlayRatio > 1) {
      // E.g., if download is 2x slower than playback, fetch 2x more ahead
      this.adaptiveFetchAhead = Math.min(
        Math.ceil(minFetchAhead * downloadToPlayRatio * safetyMargin),
        maxFetchAhead
      );
    } else {
      // Fast network - can reduce fetch-ahead (but keep minimum)
      this.adaptiveFetchAhead = minFetchAhead;
    }

    log.info('Adaptive fetch-ahead updated', {
      avgGroupDownloadMs: Math.round(this.avgGroupDownloadMs),
      gopDurationMs,
      downloadToPlayRatio: downloadToPlayRatio.toFixed(2),
      adaptiveFetchAhead: this.adaptiveFetchAhead,
      sampleCount: this.downloadHistory.length,
    });

    this.emit('speed-update', {
      avgMsPerGop: this.avgGroupDownloadMs,
      adaptiveFetchAhead: this.adaptiveFetchAhead,
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

  private fetchInitialBuffer(): void {
    // Fetch enough groups for initial buffer
    const endGroup = Math.min(
      this.gopsForInitialBuffer - 1,
      this.config.totalGroups - 1
    );

    log.info('Fetching initial buffer', {
      startGroup: 0,
      endGroup,
      gopsForInitialBuffer: this.gopsForInitialBuffer,
    });

    this.issueFetch(0, endGroup);
  }

  private fetchFromPosition(startGroup: number): void {
    const endGroup = Math.min(
      startGroup + this.gopsForInitialBuffer - 1,
      this.config.totalGroups - 1
    );

    log.info('Fetching from position', { startGroup, endGroup });
    this.issueFetch(startGroup, endGroup);
  }

  private maybeIssueFetch(): void {
    // Don't fetch if we're already fetching enough
    if (this.activeFetches.size >= this.config.maxConcurrentFetches) {
      return;
    }

    // Don't fetch if we've fetched everything
    if (this.fetchedUpToGroup >= this.config.totalGroups - 1) {
      return;
    }

    // Calculate how far ahead we should be (use adaptive value)
    const targetFetchGroup = this.playbackGroup + this.adaptiveFetchAhead;

    // If we haven't fetched up to target, issue fetch
    if (this.fetchedUpToGroup < targetFetchGroup) {
      const startGroup = this.fetchedUpToGroup + 1;
      // Fetch more groups at once if network is slow
      const fetchBatch = this.avgGroupDownloadMs > this.config.gopDurationMs
        ? Math.min(this.gopsPerFetch * 2, 8)  // Double batch size, cap at 8 GOPs
        : this.gopsPerFetch;
      const endGroup = Math.min(
        startGroup + fetchBatch - 1,
        this.config.totalGroups - 1
      );

      if (startGroup <= endGroup) {
        this.issueFetch(startGroup, endGroup);
      }
    }
  }

  private issueFetch(startGroup: number, endGroup: number): void {
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
    this.fetchedUpToGroup = Math.max(this.fetchedUpToGroup, endGroup);

    log.info('Issuing FETCH', {
      requestId,
      startGroup,
      endGroup,
      groupCount: endGroup - startGroup + 1,
      activeFetches: this.activeFetches.size,
      adaptiveFetchAhead: this.adaptiveFetchAhead,
    });

    this.emit('fetch-request', { startGroup, endGroup, requestId });
  }

  private checkInitialBufferReady(): void {
    const requiredFrames = this.gopsForInitialBuffer * this.framesPerGop;

    if (this.bufferedFrames >= requiredFrames) {
      log.info('Initial buffer ready', {
        bufferedFrames: this.bufferedFrames,
        requiredFrames,
        bufferedGroups: this.bufferedUpToGroup + 1,
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

/**
 * Create a VOD fetch controller from catalog track info
 */
/**
 * Create a VOD fetch controller from catalog track info
 *
 * @param trackInfo - Track info from catalog (framerate, gopDuration, totalGroups)
 * @param options - Override default buffer settings
 *
 * Note: Default gopDuration is 2000ms (2 seconds) which is typical for H.264 VOD content.
 * For low-latency live, use explicit gopDuration from catalog (e.g., 500ms).
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
  }
): VodFetchController {
  const framerate = trackInfo.framerate ?? 30;
  // Default to 2 seconds GOP for typical H.264 VOD (Big Buck Bunny, etc.)
  // Most encoders use 2-second keyframe intervals by default
  const gopDurationMs = trackInfo.gopDuration ?? 2000;
  const totalGroups = trackInfo.totalGroups ?? 100;

  return new VodFetchController({
    framerate,
    gopDurationMs,
    totalGroups,
    ...options,
  });
}
