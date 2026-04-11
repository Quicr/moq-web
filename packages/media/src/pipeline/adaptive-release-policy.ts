// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview AdaptiveReleasePolicy - Self-tuning release policy
 *
 * When no catalog or explicit configuration is available, this policy
 * observes frame arrival patterns and adapts its behavior:
 *
 * - Starts conservative (buffering mode)
 * - Detects VOD vs Live based on arrival patterns
 * - Adapts jitter buffer and skip behavior accordingly
 *
 * Heuristics:
 * - High arrival rate (>> realtime) → VOD behavior
 * - Regular intervals with jitter → Live behavior
 * - Out-of-order groups → VOD (parallel fetch)
 * - Sequential groups → Live (streaming)
 *
 * NO GUARANTEES - this is best-effort when proper configuration is unavailable.
 */

import { BaseReleasePolicy, type ReleasePolicyStats } from './release-policy.js';
import type { FrameEntry, GroupState } from './playout-buffer.js';

/**
 * Adaptive policy configuration
 */
export interface AdaptiveReleasePolicyConfig {
  /** Minimum frames to buffer before starting output (default: 5) */
  initialBufferFrames: number;

  /** Observation window for pattern detection (frames) */
  observationWindow: number;

  /** Threshold: if frames arrive this much faster than realtime, assume VOD */
  vodArrivalRateThreshold: number;

  /** Threshold: variance in inter-frame time that suggests live jitter */
  liveJitterVarianceThreshold: number;

  /** Base jitter delay for live mode (ms) */
  liveJitterDelayMs: number;

  /** Max latency for live mode before considering skip (ms) */
  liveMaxLatencyMs: number;

  /** Enable debug logging */
  debug: boolean;
}

/**
 * Default adaptive policy configuration
 */
export const DEFAULT_ADAPTIVE_POLICY_CONFIG: AdaptiveReleasePolicyConfig = {
  initialBufferFrames: 5,
  observationWindow: 30,
  vodArrivalRateThreshold: 2.0,  // 2x realtime = VOD
  liveJitterVarianceThreshold: 50,  // 50ms variance = live
  liveJitterDelayMs: 100,
  liveMaxLatencyMs: 500,
  debug: false,
};

/**
 * Detected content behavior mode
 */
type DetectedMode = 'buffering' | 'vod' | 'live';

/**
 * Arrival pattern observations
 */
interface ArrivalObservations {
  // Timing
  frameArrivalTimes: number[];
  interFrameDelays: number[];

  // Group patterns
  groupArrivalOrder: number[];
  groupsOutOfOrder: number;

  // Rate estimation
  estimatedFramerate: number;
  arrivalRateVsRealtime: number;  // >1 means faster than realtime

  // Variance
  interFrameVariance: number;
}

/**
 * Adaptive policy statistics
 */
export interface AdaptivePolicyStats extends ReleasePolicyStats {
  detectedMode: DetectedMode;
  framesObserved: number;
  framesOutput: number;
  modeChanges: number;
  estimatedFramerate: number;
  arrivalRateRatio: number;
  interFrameVariance: number;
}

/**
 * AdaptiveReleasePolicy - Self-tuning based on observed patterns
 *
 * Use when:
 * - No catalog available (can't read isLive)
 * - No explicit user configuration
 * - Testing/debugging unknown content
 *
 * @example
 * ```typescript
 * // Default policy when nothing else is specified
 * const buffer = new PlayoutBuffer(new AdaptiveReleasePolicy());
 *
 * // Policy will observe first N frames, then adapt behavior
 * buffer.addFrame(...);  // Observing...
 * buffer.addFrame(...);  // Observing...
 * // After observation window, switches to vod or live behavior
 * ```
 */
export class AdaptiveReleasePolicy<T> extends BaseReleasePolicy<T> {
  readonly name = 'adaptive';

  private config: AdaptiveReleasePolicyConfig;
  private stats: AdaptivePolicyStats;
  private observations: ArrivalObservations;
  private detectedMode: DetectedMode = 'buffering';
  private lastGroupId = -1;
  private modeChangeCount = 0;

  // Deadline tracking for live mode
  private groupDeadlines: Map<number, number> = new Map(); // groupId -> deadline time

  constructor(config: Partial<AdaptiveReleasePolicyConfig> = {}) {
    super();
    this.config = { ...DEFAULT_ADAPTIVE_POLICY_CONFIG, ...config };
    // Enable debug by default to trace issues
    this.debug = this.config.debug || true;
    this.stats = this.createInitialStats();
    this.observations = this.createInitialObservations();
    console.log('[AdaptiveReleasePolicy] Created - will auto-detect VOD vs Live from arrival patterns');
  }

  onFrameAdded(frame: FrameEntry<T>, group: GroupState<T>): void {
    const now = performance.now();

    // Record arrival time
    this.observations.frameArrivalTimes.push(now);
    if (this.observations.frameArrivalTimes.length > this.config.observationWindow) {
      this.observations.frameArrivalTimes.shift();
    }

    // Calculate inter-frame delay
    const arrivalTimes = this.observations.frameArrivalTimes;
    if (arrivalTimes.length >= 2) {
      const delay = arrivalTimes[arrivalTimes.length - 1] - arrivalTimes[arrivalTimes.length - 2];
      this.observations.interFrameDelays.push(delay);
      if (this.observations.interFrameDelays.length > this.config.observationWindow) {
        this.observations.interFrameDelays.shift();
      }
    }

    // Track group order
    if (frame.groupId !== this.lastGroupId) {
      this.observations.groupArrivalOrder.push(frame.groupId);
      if (this.observations.groupArrivalOrder.length > this.config.observationWindow) {
        this.observations.groupArrivalOrder.shift();
      }

      // Check if out of order
      if (this.lastGroupId >= 0 && frame.groupId < this.lastGroupId) {
        this.observations.groupsOutOfOrder++;
      }
      this.lastGroupId = Math.max(this.lastGroupId, frame.groupId);
    }

    this.stats.framesObserved++;

    // Set up deadline for live mode
    if (!this.groupDeadlines.has(frame.groupId)) {
      this.groupDeadlines.set(frame.groupId, now + this.config.liveMaxLatencyMs);
    }

    // Activate first group
    if (this.buffer.getActiveGroupId() < 0) {
      this.buffer.setActiveGroupId(frame.groupId);
      group.status = 'active';
    }

    // After observation window, analyze and adapt
    if (this.detectedMode === 'buffering' && this.stats.framesObserved >= this.config.initialBufferFrames) {
      this.analyzeAndAdapt();
    }
  }

  onEndOfGroup(groupId: number, group: GroupState<T>): void {
    if (groupId === this.buffer.getActiveGroupId() && group.frames.size === 0) {
      this.buffer.completeGroup(groupId, 'finished');
      this.promoteToNextGroup();
    }
  }

  getReadyFrames(maxFrames: number): FrameEntry<T>[] {
    // Periodically re-evaluate mode
    if (this.stats.framesObserved % 60 === 0 && this.detectedMode !== 'buffering') {
      this.analyzeAndAdapt();
    }

    // Dispatch to appropriate behavior
    switch (this.detectedMode) {
      case 'buffering':
        return this.getBufferingFrames(maxFrames);
      case 'vod':
        return this.getVodFrames(maxFrames);
      case 'live':
        return this.getLiveFrames(maxFrames);
    }
  }

  tick(nowMs: number): void {
    // In live mode, check deadlines
    if (this.detectedMode === 'live') {
      const activeGroupId = this.buffer.getActiveGroupId();
      const deadline = this.groupDeadlines.get(activeGroupId);
      const group = this.buffer.getGroup(activeGroupId);

      if (deadline && group && nowMs > deadline && group.frames.size === 0) {
        // Deadline expired, try to move to next group
        const nextGroup = this.buffer.findNextKeyframeGroup(activeGroupId);
        if (nextGroup) {
          this.buffer.completeGroup(activeGroupId, 'skipped');
          this.buffer.setActiveGroupId(nextGroup.groupId);
          nextGroup.status = 'active';
        }
      }
    }
  }

  getStats(): AdaptivePolicyStats {
    return {
      ...this.stats,
      detectedMode: this.detectedMode,
      modeChanges: this.modeChangeCount,
      estimatedFramerate: this.observations.estimatedFramerate,
      arrivalRateRatio: this.observations.arrivalRateVsRealtime,
      interFrameVariance: this.observations.interFrameVariance,
    };
  }

  reset(): void {
    this.stats = this.createInitialStats();
    this.observations = this.createInitialObservations();
    this.detectedMode = 'buffering';
    this.lastGroupId = -1;
    this.modeChangeCount = 0;
    this.groupDeadlines.clear();
  }

  /** Get the currently detected mode */
  getDetectedMode(): DetectedMode {
    return this.detectedMode;
  }

  // ============================================================
  // Mode-specific frame retrieval
  // ============================================================

  private getBufferingFrames(maxFrames: number): FrameEntry<T>[] {
    // In buffering mode, wait for enough frames
    const activeGroupId = this.buffer.getActiveGroupId();
    const group = this.buffer.getGroup(activeGroupId);

    if (!group || group.frameCount < this.config.initialBufferFrames) {
      return [];
    }

    // Have enough frames, analyze and switch mode
    this.analyzeAndAdapt();
    return this.getReadyFrames(maxFrames);
  }

  private getVodFrames(maxFrames: number): FrameEntry<T>[] {
    // VOD: Sequential output, no jitter delay, wait for gaps
    const activeGroupId = this.buffer.getActiveGroupId();
    const group = this.buffer.getGroup(activeGroupId);

    if (!group || group.status !== 'active') {
      if (!this.promoteToNextGroup()) {
        return [];
      }
      return this.getVodFrames(maxFrames);
    }

    const result: FrameEntry<T>[] = [];
    const startObjectId = group.outputObjectId < 0 ? 0 : group.outputObjectId;

    for (let objId = startObjectId; objId <= group.highestObjectId && result.length < maxFrames; objId++) {
      const frame = group.frames.get(objId);
      if (!frame) {
        break; // Gap - wait (VOD behavior)
      }

      result.push(frame);
      group.frames.delete(objId);
      group.outputObjectId = objId + 1;
      this.stats.framesOutput++;
    }

    // Check group completion
    if (group.frames.size === 0 && group.outputObjectId > 0) {
      const nextGroup = this.buffer.findNextKeyframeGroup(group.groupId);
      if (group.endOfGroupReceived || nextGroup) {
        this.buffer.completeGroup(group.groupId, 'finished');
        if (nextGroup) {
          this.buffer.setActiveGroupId(nextGroup.groupId);
          nextGroup.status = 'active';
        }
      }
    }

    return result;
  }

  private getLiveFrames(maxFrames: number): FrameEntry<T>[] {
    // Live: Jitter delay, can skip gaps under pressure
    const activeGroupId = this.buffer.getActiveGroupId();
    const group = this.buffer.getGroup(activeGroupId);

    if (!group || group.status !== 'active') {
      if (!this.promoteToNextGroup()) {
        return [];
      }
      return this.getLiveFrames(maxFrames);
    }

    const now = performance.now();
    const result: FrameEntry<T>[] = [];
    const startObjectId = group.outputObjectId < 0 ? 0 : group.outputObjectId;
    const deadline = this.groupDeadlines.get(activeGroupId) ?? (now + this.config.liveMaxLatencyMs);
    const underPressure = now > deadline - this.config.liveJitterDelayMs;

    for (let objId = startObjectId; objId <= group.highestObjectId && result.length < maxFrames; objId++) {
      const frame = group.frames.get(objId);

      if (!frame) {
        if (underPressure && objId > 0) {
          continue; // Skip gap under pressure (unless keyframe)
        }
        break; // Wait for gap
      }

      // Check jitter delay
      const jitterRemaining = (frame.receivedAt + this.config.liveJitterDelayMs) - now;
      if (jitterRemaining > 0 && !underPressure) {
        break;
      }

      result.push(frame);
      group.frames.delete(objId);
      group.outputObjectId = objId + 1;
      this.stats.framesOutput++;
    }

    // Check group completion
    if (group.frames.size === 0 && group.outputObjectId > 0) {
      const nextGroup = this.buffer.findNextKeyframeGroup(group.groupId);
      if (group.endOfGroupReceived || nextGroup) {
        this.buffer.completeGroup(group.groupId, 'finished');
        if (nextGroup) {
          this.buffer.setActiveGroupId(nextGroup.groupId);
          nextGroup.status = 'active';
        }
      }
    }

    return result;
  }

  // ============================================================
  // Pattern analysis
  // ============================================================

  private analyzeAndAdapt(): void {
    this.updateObservationMetrics();

    const previousMode = this.detectedMode;

    // Decision logic
    if (this.observations.arrivalRateVsRealtime > this.config.vodArrivalRateThreshold) {
      // Frames arriving much faster than realtime → VOD
      this.detectedMode = 'vod';
    } else if (this.observations.interFrameVariance > this.config.liveJitterVarianceThreshold) {
      // High variance in arrival times → Live with jitter
      this.detectedMode = 'live';
    } else if (this.observations.groupsOutOfOrder > 2) {
      // Groups arriving out of order → Likely VOD parallel fetch
      this.detectedMode = 'vod';
    } else {
      // Default to live (safer - has jitter buffer)
      this.detectedMode = 'live';
    }

    if (previousMode !== this.detectedMode) {
      this.modeChangeCount++;
      this.log('MODE CHANGED', {
        from: previousMode,
        to: this.detectedMode,
        arrivalRate: this.observations.arrivalRateVsRealtime.toFixed(2),
        variance: this.observations.interFrameVariance.toFixed(1),
        outOfOrder: this.observations.groupsOutOfOrder,
      });
    }
  }

  private updateObservationMetrics(): void {
    const delays = this.observations.interFrameDelays;

    if (delays.length < 2) {
      return;
    }

    // Calculate average inter-frame delay
    const avgDelay = delays.reduce((a, b) => a + b, 0) / delays.length;

    // Estimate framerate
    this.observations.estimatedFramerate = avgDelay > 0 ? 1000 / avgDelay : 30;

    // Calculate expected delay for realtime (assume 30fps if unknown)
    const expectedDelay = 1000 / Math.max(this.observations.estimatedFramerate, 1);

    // Arrival rate vs realtime (< 1 means slower, > 1 means faster)
    this.observations.arrivalRateVsRealtime = avgDelay > 0 ? expectedDelay / avgDelay : 1;

    // Calculate variance
    const squaredDiffs = delays.map(d => Math.pow(d - avgDelay, 2));
    this.observations.interFrameVariance = Math.sqrt(squaredDiffs.reduce((a, b) => a + b, 0) / delays.length);
  }

  private createInitialStats(): AdaptivePolicyStats {
    return {
      policyName: this.name,
      detectedMode: 'buffering',
      framesObserved: 0,
      framesOutput: 0,
      modeChanges: 0,
      estimatedFramerate: 0,
      arrivalRateRatio: 1,
      interFrameVariance: 0,
    };
  }

  private createInitialObservations(): ArrivalObservations {
    return {
      frameArrivalTimes: [],
      interFrameDelays: [],
      groupArrivalOrder: [],
      groupsOutOfOrder: 0,
      estimatedFramerate: 30,
      arrivalRateVsRealtime: 1,
      interFrameVariance: 0,
    };
  }
}
