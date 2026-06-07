// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Live Trick Play Controller
 *
 * Manages trick play for live streams using a hybrid approach:
 * - Near-live seeking: Uses SUBSCRIBE_UPDATE to change the subscription position
 * - Historical seeking: Uses FETCH to retrieve past content
 *
 * Integrates with LiveEdgeTracker to know the current live position.
 */

import { Logger } from '@web-moq/core';
import type { MOQTSession } from '@web-moq/session';
import { LiveEdgeTracker, type LiveEdgeInfo, type LiveEdgeTrackerConfig } from './live-edge-tracker.js';

const log = Logger.create('moqt:media:live-trick-play');

/**
 * Configuration for LiveTrickPlayController
 */
export interface LiveTrickPlayConfig extends LiveEdgeTrackerConfig {
  /** How far behind live edge (in seconds) to use SUBSCRIBE_UPDATE vs FETCH */
  subscribeUpdateThresholdSec?: number;
  /** Subscription ID for the live subscription */
  subscriptionId: number;
  /** Buffer size for FETCH catch-up (in seconds) */
  fetchCatchUpBufferSec?: number;
}

/**
 * Seek mode - how the seek will be executed
 */
export type SeekMode = 'subscribe-update' | 'fetch' | 'hybrid';

/**
 * Seek result information
 */
export interface SeekResult {
  success: boolean;
  mode: SeekMode;
  targetGroup: number;
  targetObject: number;
  error?: Error;
}

/**
 * Events emitted by LiveTrickPlayController
 */
export interface LiveTrickPlayEvents {
  /** Live edge position updated (passthrough from LiveEdgeTracker) */
  'edge-update': LiveEdgeInfo;
  /** Track has finished (passthrough from LiveEdgeTracker) */
  'track-finished': { groupId: number; objectId: number };
  /** Seek operation started */
  'seek-start': { targetGroup: number; targetObject: number; mode: SeekMode };
  /** Seek operation completed */
  'seek-complete': SeekResult;
  /** FETCH request needed for historical content */
  'fetch-request': { startGroup: number; endGroup: number; requestId: number };
  /** Jumped to live edge */
  'jump-to-live': { groupId: number; objectId: number };
  /** Error occurred */
  'error': Error;
}

/**
 * Live Trick Play Controller
 *
 * Provides trick play functionality for live streams.
 *
 * @example
 * ```typescript
 * const controller = new LiveTrickPlayController(session, {
 *   subscriptionId: liveSubId,
 *   namespace: ['live', 'channel-1'],
 *   trackName: 'video',
 *   gopDurationMs: 2000,
 * });
 *
 * controller.on('edge-update', (info) => {
 *   updateTimelineUI(info.groupId);
 * });
 *
 * controller.on('fetch-request', async ({ startGroup, endGroup }) => {
 *   await session.fetch(namespace, trackName, { startGroup, endGroup });
 * });
 *
 * controller.start();
 *
 * // Seek to 30 seconds ago
 * const edge = controller.getLiveEdge();
 * const targetGroup = edge.groupId - 15; // 15 GOPs = 30 seconds at 2s GOP
 * await controller.seek(targetGroup);
 *
 * // Jump back to live
 * await controller.jumpToLive();
 * ```
 */
export class LiveTrickPlayController {
  private session: MOQTSession;
  private edgeTracker: LiveEdgeTracker;
  private config: Required<Omit<LiveTrickPlayConfig, keyof LiveEdgeTrackerConfig>> & LiveEdgeTrackerConfig;
  private _namespace: string[];
  private _trackName: string;
  private handlers = new Map<keyof LiveTrickPlayEvents, Set<(data: unknown) => void>>();
  private nextRequestId = 1;
  private currentPosition: { groupId: number; objectId: number } | null = null;
  private isAtLiveEdge = true;

  constructor(
    session: MOQTSession,
    namespace: string[],
    trackName: string,
    config: LiveTrickPlayConfig
  ) {
    this.session = session;
    this._namespace = namespace;
    this._trackName = trackName;
    this.config = {
      subscriptionId: config.subscriptionId,
      subscribeUpdateThresholdSec: config.subscribeUpdateThresholdSec ?? 10,
      fetchCatchUpBufferSec: config.fetchCatchUpBufferSec ?? 5,
      pollIntervalMs: config.pollIntervalMs,
      gopDurationMs: config.gopDurationMs,
    };

    this.edgeTracker = new LiveEdgeTracker(session, namespace, trackName, {
      pollIntervalMs: config.pollIntervalMs,
      gopDurationMs: config.gopDurationMs,
    });

    this.setupEdgeTrackerEvents();

    log.info('LiveTrickPlayController created', {
      namespace: namespace.join('/'),
      trackName,
      subscriptionId: config.subscriptionId,
      subscribeUpdateThresholdSec: this.config.subscribeUpdateThresholdSec,
    });
  }

  /**
   * Get the namespace being tracked
   */
  get namespace(): string[] {
    return this._namespace;
  }

  /**
   * Get the track name being tracked
   */
  get trackName(): string {
    return this._trackName;
  }

  /**
   * Start tracking the live edge and enable trick play
   */
  start(): void {
    this.edgeTracker.start();
    log.info('Live trick play started');
  }

  /**
   * Stop tracking and clean up
   */
  stop(): void {
    this.edgeTracker.stop();
    log.info('Live trick play stopped');
  }

  /**
   * Check if controller is active
   */
  isActive(): boolean {
    return this.edgeTracker.isActive();
  }

  /**
   * Get the current live edge position
   */
  getLiveEdge(): LiveEdgeInfo | null {
    return this.edgeTracker.getLiveEdge();
  }

  /**
   * Get the live edge time in milliseconds
   */
  getLiveEdgeTimeMs(): number | null {
    return this.edgeTracker.getLiveEdgeTimeMs();
  }

  /**
   * Get GOP duration in milliseconds
   */
  getGopDurationMs(): number {
    return this.config.gopDurationMs ?? 1000;
  }

  /**
   * Check if currently at the live edge
   */
  isLive(): boolean {
    return this.isAtLiveEdge;
  }

  /**
   * Get current playback position
   */
  getCurrentPosition(): { groupId: number; objectId: number } | null {
    return this.currentPosition;
  }

  /**
   * Seek to a specific position in the stream
   * Uses SUBSCRIBE_UPDATE for near-live content, FETCH for historical
   */
  async seek(groupId: number, objectId: number = 0): Promise<SeekResult> {
    const edge = this.getLiveEdge();
    if (!edge) {
      const error = new Error('Cannot seek: live edge not available');
      this.emit('error', error);
      return { success: false, mode: 'subscribe-update', targetGroup: groupId, targetObject: objectId, error };
    }

    const gopDurationMs = this.getGopDurationMs();
    const thresholdGroups = Math.ceil((this.config.subscribeUpdateThresholdSec * 1000) / gopDurationMs);
    const groupsBehindLive = edge.groupId - groupId;
    const mode = this.determineSeekMode(groupsBehindLive, thresholdGroups);

    log.info('Seeking', {
      targetGroup: groupId,
      targetObject: objectId,
      liveEdgeGroup: edge.groupId,
      groupsBehindLive,
      thresholdGroups,
      mode,
    });

    this.emit('seek-start', { targetGroup: groupId, targetObject: objectId, mode });

    try {
      if (mode === 'subscribe-update') {
        await this.seekViaSubscribeUpdate(groupId, objectId);
      } else if (mode === 'fetch') {
        await this.seekViaFetch(groupId, objectId, edge.groupId);
      } else {
        await this.seekViaHybrid(groupId, objectId, edge.groupId);
      }

      this.currentPosition = { groupId, objectId };
      this.isAtLiveEdge = groupId >= edge.groupId;

      const result: SeekResult = { success: true, mode, targetGroup: groupId, targetObject: objectId };
      this.emit('seek-complete', result);
      return result;
    } catch (err) {
      const error = err as Error;
      log.error('Seek failed', { error: error.message });
      this.emit('error', error);
      const result: SeekResult = { success: false, mode, targetGroup: groupId, targetObject: objectId, error };
      this.emit('seek-complete', result);
      return result;
    }
  }

  /**
   * Seek to a specific time in milliseconds
   */
  async seekToTimeMs(timeMs: number): Promise<SeekResult> {
    const gopDurationMs = this.getGopDurationMs();
    const groupId = Math.floor(timeMs / gopDurationMs);
    return this.seek(groupId, 0);
  }

  /**
   * Jump back to live edge
   */
  async jumpToLive(): Promise<SeekResult> {
    const edge = this.getLiveEdge();
    if (!edge) {
      const error = new Error('Cannot jump to live: live edge not available');
      this.emit('error', error);
      return { success: false, mode: 'subscribe-update', targetGroup: 0, targetObject: 0, error };
    }

    log.info('Jumping to live', { groupId: edge.groupId, objectId: edge.objectId });

    try {
      await this.session.seekSubscription(
        this.config.subscriptionId,
        edge.groupId,
        edge.objectId
      );

      this.currentPosition = { groupId: edge.groupId, objectId: edge.objectId };
      this.isAtLiveEdge = true;

      this.emit('jump-to-live', { groupId: edge.groupId, objectId: edge.objectId });
      return { success: true, mode: 'subscribe-update', targetGroup: edge.groupId, targetObject: edge.objectId };
    } catch (err) {
      const error = err as Error;
      log.error('Jump to live failed', { error: error.message });
      this.emit('error', error);
      return { success: false, mode: 'subscribe-update', targetGroup: edge.groupId, targetObject: edge.objectId, error };
    }
  }

  /**
   * Skip forward by a number of seconds
   */
  async skipForward(seconds: number): Promise<SeekResult> {
    const current = this.currentPosition ?? this.getLiveEdge();
    if (!current) {
      const error = new Error('Cannot skip: position not available');
      return { success: false, mode: 'subscribe-update', targetGroup: 0, targetObject: 0, error };
    }

    const gopDurationMs = this.getGopDurationMs();
    const groupsToSkip = Math.ceil((seconds * 1000) / gopDurationMs);
    const targetGroup = current.groupId + groupsToSkip;

    const edge = this.getLiveEdge();
    if (edge && targetGroup >= edge.groupId) {
      return this.jumpToLive();
    }

    return this.seek(targetGroup, 0);
  }

  /**
   * Skip backward by a number of seconds
   */
  async skipBackward(seconds: number): Promise<SeekResult> {
    const current = this.currentPosition ?? this.getLiveEdge();
    if (!current) {
      const error = new Error('Cannot skip: position not available');
      return { success: false, mode: 'fetch', targetGroup: 0, targetObject: 0, error };
    }

    const gopDurationMs = this.getGopDurationMs();
    const groupsToSkip = Math.ceil((seconds * 1000) / gopDurationMs);
    const targetGroup = Math.max(0, current.groupId - groupsToSkip);

    return this.seek(targetGroup, 0);
  }

  /**
   * Convert time in milliseconds to group ID
   */
  timeToGroup(timeMs: number): number {
    const gopDurationMs = this.getGopDurationMs();
    return Math.floor(timeMs / gopDurationMs);
  }

  /**
   * Convert group ID to time in milliseconds
   */
  groupToTime(groupId: number): number {
    const gopDurationMs = this.getGopDurationMs();
    return groupId * gopDurationMs;
  }

  /**
   * Register an event handler
   */
  on<K extends keyof LiveTrickPlayEvents>(
    event: K,
    handler: (data: LiveTrickPlayEvents[K]) => void
  ): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler as (data: unknown) => void);

    return () => {
      this.handlers.get(event)?.delete(handler as (data: unknown) => void);
    };
  }

  private emit<K extends keyof LiveTrickPlayEvents>(event: K, data: LiveTrickPlayEvents[K]): void {
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

  private setupEdgeTrackerEvents(): void {
    this.edgeTracker.on('edge-update', (info) => {
      this.emit('edge-update', info);
      if (this.isAtLiveEdge && this.currentPosition) {
        this.currentPosition = { groupId: info.groupId, objectId: info.objectId };
      }
    });

    this.edgeTracker.on('track-finished', (data) => {
      this.emit('track-finished', data);
    });

    this.edgeTracker.on('error', (err) => {
      this.emit('error', err);
    });
  }

  private determineSeekMode(groupsBehindLive: number, thresholdGroups: number): SeekMode {
    if (groupsBehindLive <= 0) {
      return 'subscribe-update';
    }
    if (groupsBehindLive <= thresholdGroups) {
      return 'subscribe-update';
    }
    return 'fetch';
  }

  private async seekViaSubscribeUpdate(groupId: number, objectId: number): Promise<void> {
    log.debug('Seeking via SUBSCRIBE_UPDATE', { groupId, objectId });
    await this.session.seekSubscription(this.config.subscriptionId, groupId, objectId);
  }

  private async seekViaFetch(startGroup: number, startObject: number, liveEdgeGroup: number): Promise<void> {
    log.debug('Seeking via FETCH', { startGroup, startObject, liveEdgeGroup });

    const gopDurationMs = this.getGopDurationMs();
    const catchUpGroups = Math.ceil((this.config.fetchCatchUpBufferSec * 1000) / gopDurationMs);
    const endGroup = Math.min(startGroup + catchUpGroups, liveEdgeGroup);

    const requestId = this.nextRequestId++;
    this.emit('fetch-request', { startGroup, endGroup, requestId });
  }

  private async seekViaHybrid(startGroup: number, startObject: number, liveEdgeGroup: number): Promise<void> {
    log.debug('Seeking via hybrid (FETCH + SUBSCRIBE_UPDATE)', { startGroup, startObject, liveEdgeGroup });

    const gopDurationMs = this.getGopDurationMs();
    const thresholdGroups = Math.ceil((this.config.subscribeUpdateThresholdSec * 1000) / gopDurationMs);
    const subscribeStartGroup = liveEdgeGroup - thresholdGroups;

    if (startGroup < subscribeStartGroup) {
      const requestId = this.nextRequestId++;
      this.emit('fetch-request', { startGroup, endGroup: subscribeStartGroup - 1, requestId });
    }

    await this.session.seekSubscription(
      this.config.subscriptionId,
      Math.max(startGroup, subscribeStartGroup),
      startObject
    );
  }
}
