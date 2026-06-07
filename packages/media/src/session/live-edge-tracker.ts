// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Live Edge Tracker
 *
 * Tracks the live edge position of a stream by periodically polling
 * TRACK_STATUS. Used for DVR/trick play to know the current live position.
 */

import { Logger, TrackStatusCode } from '@web-moq/core';
import type { MOQTSession } from '@web-moq/session';

const log = Logger.create('moqt:media:live-edge-tracker');

/**
 * Live edge position info
 */
export interface LiveEdgeInfo {
  /** Last known group ID at the live edge */
  groupId: number;
  /** Last known object ID at the live edge */
  objectId: number;
  /** Timestamp when this info was last updated */
  updatedAt: number;
  /** Track status code */
  statusCode: TrackStatusCode;
}

/**
 * Events emitted by LiveEdgeTracker
 */
export interface LiveEdgeTrackerEvents {
  /** Live edge position updated */
  'edge-update': LiveEdgeInfo;
  /** Track status indicates track has finished */
  'track-finished': { groupId: number; objectId: number };
  /** Error occurred during polling */
  'error': Error;
}

/**
 * Configuration for LiveEdgeTracker
 */
export interface LiveEdgeTrackerConfig {
  /** Polling interval in milliseconds (default: 500) */
  pollIntervalMs?: number;
  /** GOP duration in milliseconds (for time estimation) */
  gopDurationMs?: number;
}

/**
 * Live Edge Tracker
 *
 * Periodically polls TRACK_STATUS to track the live edge position.
 * Emits events when the edge moves forward.
 *
 * @example
 * ```typescript
 * const tracker = new LiveEdgeTracker(session, namespace, trackName);
 * tracker.on('edge-update', (info) => {
 *   console.log('Live edge at group', info.groupId);
 * });
 * tracker.start();
 *
 * // Later:
 * const edge = tracker.getLiveEdge();
 * tracker.stop();
 * ```
 */
export class LiveEdgeTracker {
  private session: MOQTSession;
  private namespace: string[];
  private trackName: string;
  private config: Required<LiveEdgeTrackerConfig>;

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastEdge: LiveEdgeInfo | null = null;
  private handlers = new Map<keyof LiveEdgeTrackerEvents, Set<(data: unknown) => void>>();
  private isPolling = false;

  constructor(
    session: MOQTSession,
    namespace: string[],
    trackName: string,
    config: LiveEdgeTrackerConfig = {}
  ) {
    this.session = session;
    this.namespace = namespace;
    this.trackName = trackName;
    this.config = {
      pollIntervalMs: config.pollIntervalMs ?? 500,
      gopDurationMs: config.gopDurationMs ?? 1000,
    };

    log.info('LiveEdgeTracker created', {
      namespace: namespace.join('/'),
      trackName,
      pollIntervalMs: this.config.pollIntervalMs,
    });
  }

  /**
   * Start tracking the live edge
   */
  start(): void {
    if (this.pollTimer) {
      log.warn('LiveEdgeTracker already started');
      return;
    }

    log.info('Starting live edge tracking', {
      namespace: this.namespace.join('/'),
      trackName: this.trackName,
      pollIntervalMs: this.config.pollIntervalMs,
    });

    // Do an initial poll immediately
    this.poll();

    // Set up periodic polling
    this.pollTimer = setInterval(() => this.poll(), this.config.pollIntervalMs);
  }

  /**
   * Stop tracking the live edge
   */
  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
      log.info('Live edge tracking stopped');
    }
  }

  /**
   * Get the last known live edge position
   */
  getLiveEdge(): LiveEdgeInfo | null {
    return this.lastEdge;
  }

  /**
   * Get the estimated live edge time in milliseconds
   * (based on groupId and gopDuration)
   */
  getLiveEdgeTimeMs(): number | null {
    if (!this.lastEdge) return null;
    return this.lastEdge.groupId * this.config.gopDurationMs;
  }

  /**
   * Check if tracking is active
   */
  isActive(): boolean {
    return this.pollTimer !== null;
  }

  /**
   * Register an event handler
   */
  on<K extends keyof LiveEdgeTrackerEvents>(
    event: K,
    handler: (data: LiveEdgeTrackerEvents[K]) => void
  ): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler as (data: unknown) => void);

    return () => {
      this.handlers.get(event)?.delete(handler as (data: unknown) => void);
    };
  }

  private emit<K extends keyof LiveEdgeTrackerEvents>(event: K, data: LiveEdgeTrackerEvents[K]): void {
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

  private async poll(): Promise<void> {
    // Avoid overlapping polls
    if (this.isPolling) return;
    this.isPolling = true;

    try {
      const status = await this.session.requestTrackStatus(this.namespace, this.trackName);

      const newEdge: LiveEdgeInfo = {
        groupId: status.lastGroupId ?? 0,
        objectId: status.lastObjectId ?? 0,
        updatedAt: Date.now(),
        statusCode: status.statusCode,
      };

      // Check if edge has moved
      const edgeMoved = !this.lastEdge ||
        newEdge.groupId > this.lastEdge.groupId ||
        (newEdge.groupId === this.lastEdge.groupId && newEdge.objectId > this.lastEdge.objectId);

      if (edgeMoved) {
        log.debug('Live edge updated', {
          groupId: newEdge.groupId,
          objectId: newEdge.objectId,
          statusCode: newEdge.statusCode,
        });
      }

      this.lastEdge = newEdge;

      // Emit appropriate events
      if (status.statusCode === TrackStatusCode.IN_PROGRESS) {
        this.emit('edge-update', newEdge);
      } else if (status.statusCode === TrackStatusCode.FINISHED) {
        this.emit('track-finished', { groupId: newEdge.groupId, objectId: newEdge.objectId });
        // Stop polling when track is finished
        this.stop();
      }
    } catch (err) {
      log.error('Failed to get track status', { error: (err as Error).message });
      this.emit('error', err as Error);
    } finally {
      this.isPolling = false;
    }
  }
}
