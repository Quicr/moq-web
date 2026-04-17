// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview VodReleasePolicy - Sequential playback for VOD content
 *
 * VOD (Video On Demand) content requires different handling than live:
 *
 * - No time pressure: wait indefinitely for missing frames
 * - Sequential output: frames must be in order, no skipping
 * - Complete GOPs: prefer outputting complete GOPs before switching
 * - No jitter buffer: frames are released as soon as sequence is complete
 *
 * Per MSF spec: "If isLive is FALSE, [latency thresholds] MUST be ignored."
 *
 * This policy is used when catalog.track.isLive === false.
 */

import { BaseReleasePolicy, type ReleasePolicyStats } from './release-policy.js';
import type { FrameEntry, GroupState } from './playout-buffer.js';

/**
 * VOD policy configuration
 */
export interface VodReleasePolicyConfig {
  /**
   * Minimum frames to buffer before starting output (default: 30, ~1 GOP)
   * Set higher for smoother start (e.g., buffer first GOP)
   */
  minBufferFrames: number;

  /**
   * Rebuffer threshold - if buffer drops below this during playback,
   * pause until minBufferFrames is reached again (default: 5)
   * Set to 0 to disable rebuffering
   */
  rebufferThreshold: number;

  /**
   * Whether to wait for complete GOP before switching groups (default: true)
   * If true, won't switch to next group until current GOP is complete or END_OF_GROUP received
   */
  waitForCompleteGop: boolean;

  /**
   * Maximum time to wait for a missing frame before giving up (ms)
   * Default: Infinity (wait forever - pure VOD behavior)
   * Set to finite value for DVR-like behavior where content may be unavailable
   */
  maxWaitTimeMs: number;

  /**
   * Target framerate for pacing (frames per second)
   * Frames are released at this rate regardless of arrival speed
   * Default: 30
   */
  targetFramerate: number;

  /**
   * Enable frame pacing (default: true for VOD)
   * When true, frames are released at targetFramerate pace
   * When false, frames are released as soon as available
   */
  enablePacing: boolean;

  /** Enable debug logging */
  debug: boolean;
}

/**
 * Default VOD policy configuration
 */
export const DEFAULT_VOD_POLICY_CONFIG: VodReleasePolicyConfig = {
  minBufferFrames: 30, // ~1 GOP at 30fps, ~0.5s at 60fps
  rebufferThreshold: 5, // Rebuffer if buffer drops below this
  waitForCompleteGop: true,
  maxWaitTimeMs: Infinity,
  targetFramerate: 30,
  enablePacing: true,
  debug: false,
};

/**
 * VOD Release Policy Statistics
 */
interface VodPolicyStats extends ReleasePolicyStats {
  /** Groups completed naturally (END_OF_GROUP or next keyframe) */
  groupsCompletedNaturally: number;

  /** Times we waited for missing frames */
  waitedForFrames: number;

  /** Frames output total */
  framesOutput: number;

  /** Current GOP being output */
  currentGopId: number;
}

/**
 * VodReleasePolicy - Sequential frame release for VOD content
 *
 * Key behaviors:
 * - Outputs frames strictly in order (groupId, objectId)
 * - Never skips frames due to time pressure
 * - Waits for missing frames indefinitely
 * - Switches groups only when current is complete
 *
 * @example
 * ```typescript
 * const policy = new VodReleasePolicy();
 * const buffer = new PlayoutBuffer(policy);
 *
 * // Frames can arrive out of order (parallel QUIC streams)
 * buffer.addFrame({ groupId: 5, objectId: 3, ... });
 * buffer.addFrame({ groupId: 5, objectId: 0, ... }); // keyframe
 * buffer.addFrame({ groupId: 5, objectId: 1, ... });
 *
 * // Policy outputs in order: 0, 1, then waits for 2
 * const ready = buffer.getReadyFrames();
 * // ready = [frame0, frame1] - stops at gap (missing frame 2)
 * ```
 */
export class VodReleasePolicy<T> extends BaseReleasePolicy<T> {
  readonly name = 'vod';

  private config: VodReleasePolicyConfig;
  private stats: VodPolicyStats;
  private waitStartTime: Map<string, number> = new Map(); // "groupId:objectId" -> wait start time
  // Track the next expected group for strict sequential ordering (VOD must be sequential)
  // Starts at -1 to indicate "not yet initialized" - will be set to first keyframe group received
  private nextExpectedGroup = -1;
  private initialized = false;

  // Frame pacing state - uses accumulated time for smooth pacing
  private lastFrameReleaseTime = 0;
  private frameDurationMs = 33.33; // Default 30fps = 33.33ms per frame
  private accumulatedTimeMs = 0; // Accumulated time for fractional frame tracking

  // Rebuffering state - pause output when buffer runs low
  private isRebuffering = false;
  private playbackStarted = false;

  constructor(config: Partial<VodReleasePolicyConfig> = {}) {
    super();
    this.config = { ...DEFAULT_VOD_POLICY_CONFIG, ...config };

    // Auto-scale rebufferThreshold if not explicitly set and minBufferFrames is high
    // For 60fps with 180 minBufferFrames, default rebufferThreshold of 5 is too aggressive (only 83ms)
    // Scale to ~1/6 of minBufferFrames (1 GOP worth) but at least 1 GOP at target framerate
    if (config.rebufferThreshold === undefined && this.config.minBufferFrames > 30) {
      const framesPerGop = Math.ceil(this.config.targetFramerate * 0.5); // Assume ~500ms GOPs for VOD
      this.config.rebufferThreshold = Math.max(framesPerGop, Math.ceil(this.config.minBufferFrames / 6));
    }

    // Enable debug by default for VOD to trace issues
    this.debug = this.config.debug || true;
    this.stats = this.createInitialStats();
    // Calculate frame duration from framerate
    this.frameDurationMs = 1000 / this.config.targetFramerate;
    console.log('[VodReleasePolicy] Created with config:', this.config, 'frameDurationMs:', this.frameDurationMs);
  }

  onFrameAdded(frame: FrameEntry<T>, group: GroupState<T>): void {
    // Clear wait timer if this frame was waited for
    const waitKey = `${frame.groupId}:${frame.objectId}`;
    if (this.waitStartTime.has(waitKey)) {
      this.waitStartTime.delete(waitKey);
      this.log('WAIT RESOLVED', { groupId: frame.groupId, objectId: frame.objectId });
    }

    // VOD: Initialize nextExpectedGroup from first keyframe received
    // This handles cases where playback starts mid-stream (e.g., seek, DVR, late join)
    if (!this.initialized && frame.isKeyframe && frame.objectId === 0) {
      this.nextExpectedGroup = frame.groupId;
      this.initialized = true;
      this.log('INITIALIZED from first keyframe', { startingGroup: frame.groupId });
    }

    // VOD: Only activate the EXPECTED group (strict sequential order)
    // Don't just activate any keyframe that arrives - wait for the right one
    if (frame.isKeyframe && frame.objectId === 0 && frame.groupId === this.nextExpectedGroup) {
      const activeGroupId = this.buffer.getActiveGroupId();
      if (activeGroupId < 0 || activeGroupId < frame.groupId) {
        this.buffer.setActiveGroupId(frame.groupId);
        group.status = 'active';
        this.log('ACTIVATED EXPECTED GROUP', {
          groupId: frame.groupId,
          nextExpected: this.nextExpectedGroup
        });
      }
    }
  }

  onEndOfGroup(groupId: number, group: GroupState<T>): void {
    this.log('END_OF_GROUP received', {
      groupId,
      framesInGroup: group.frameCount,
      outputObjectId: group.outputObjectId,
    });

    // If this is the active group and buffer is empty, complete and promote
    if (groupId === this.buffer.getActiveGroupId() && group.frames.size === 0) {
      this.completeAndPromote(groupId, 'end_of_group');
    }
  }

  getReadyFrames(maxFrames: number): FrameEntry<T>[] {
    // Check if paused - return no frames while paused
    if (this.paused) {
      return [];
    }

    const activeGroupId = this.buffer.getActiveGroupId();

    // VOD: If no active group, try to activate the expected sequential group
    if (activeGroupId < 0) {
      if (!this.tryActivateNextSequentialGroup()) {
        return [];
      }
    }

    const group = this.buffer.getGroup(this.buffer.getActiveGroupId());
    if (!group || group.status !== 'active') {
      // Try to activate the expected sequential group
      if (!this.tryActivateNextSequentialGroup()) {
        return [];
      }
      return this.getReadyFrames(maxFrames); // Retry with new active group
    }

    // Count total buffered frames across all groups
    const totalBufferedFrames = this.countTotalBufferedFrames();

    // Check minimum buffer requirement for initial playback
    if (!this.playbackStarted) {
      if (totalBufferedFrames < this.config.minBufferFrames) {
        this.log('INITIAL BUFFERING', {
          groupId: activeGroupId,
          bufferedFrames: totalBufferedFrames,
          required: this.config.minBufferFrames,
        });
        return [];
      }
      this.playbackStarted = true;
      this.log('PLAYBACK STARTED', { bufferedFrames: totalBufferedFrames });
    }

    // Rebuffering check - if buffer drops too low during playback, pause until recovered
    if (this.config.rebufferThreshold > 0) {
      if (this.isRebuffering) {
        // Wait until buffer recovers to minBufferFrames
        if (totalBufferedFrames < this.config.minBufferFrames) {
          this.log('REBUFFERING', {
            bufferedFrames: totalBufferedFrames,
            required: this.config.minBufferFrames,
          });
          return [];
        }
        // Buffer recovered
        this.isRebuffering = false;
        this.log('REBUFFER COMPLETE', { bufferedFrames: totalBufferedFrames });
        // Reset pacing to avoid frame burst after rebuffer
        this.lastFrameReleaseTime = 0;
        this.accumulatedTimeMs = 0;
      } else if (totalBufferedFrames <= this.config.rebufferThreshold) {
        // Buffer running low - start rebuffering
        this.isRebuffering = true;
        this.log('REBUFFER TRIGGERED', {
          bufferedFrames: totalBufferedFrames,
          threshold: this.config.rebufferThreshold,
        });
        return [];
      }
    }

    // Frame pacing: only release frames at the target framerate
    // Uses accumulated time to handle fractional frame timing correctly
    // (e.g., 60fps = 16.67ms/frame with 16ms poll interval)
    if (this.config.enablePacing) {
      const now = performance.now();

      // First frame - initialize timing
      if (this.lastFrameReleaseTime === 0) {
        this.lastFrameReleaseTime = now;
        this.accumulatedTimeMs = this.frameDurationMs; // Allow first frame immediately
      }

      // Accumulate elapsed time since last poll
      const elapsedMs = now - this.lastFrameReleaseTime;
      this.accumulatedTimeMs += elapsedMs;
      this.lastFrameReleaseTime = now;

      // Calculate how many whole frames we can release
      const framesToRelease = Math.floor(this.accumulatedTimeMs / this.frameDurationMs);

      if (framesToRelease === 0) {
        // Not enough accumulated time for a frame yet
        return [];
      }

      // Consume time for frames we'll release (keep fractional remainder)
      const timeToConsume = framesToRelease * this.frameDurationMs;

      // Limit actual release to available frames and maxFrames
      const actualFramesToRelease = Math.min(maxFrames, framesToRelease);

      // Output sequential frames (paced)
      const result = this.outputSequentialFrames(group, actualFramesToRelease);

      if (result.length > 0) {
        // Only consume time for frames actually released
        this.accumulatedTimeMs -= result.length * this.frameDurationMs;
        this.stats.framesOutput += result.length;
        this.stats.currentGopId = this.buffer.getActiveGroupId();
        this.log('OUTPUT FRAMES (paced)', {
          count: result.length,
          groupId: this.buffer.getActiveGroupId(),
          objectIds: result.map(f => f.objectId),
          totalOutput: this.stats.framesOutput,
          elapsedMs: elapsedMs.toFixed(1),
          accumulatedMs: this.accumulatedTimeMs.toFixed(1),
          frameDurationMs: this.frameDurationMs.toFixed(2),
        });
      } else {
        // No frames available - don't consume time (wait for data)
        this.accumulatedTimeMs -= timeToConsume;
        // Cap accumulated time to prevent runaway buildup when starved
        if (this.accumulatedTimeMs < 0) {
          this.accumulatedTimeMs = 0;
        }
      }

      // Check if we should complete this group and move to next
      this.checkGroupCompletion(group);

      return result;
    }

    // Non-paced output (original behavior)
    const result = this.outputSequentialFrames(group, maxFrames);

    if (result.length > 0) {
      this.stats.framesOutput += result.length;
      this.stats.currentGopId = activeGroupId;
      this.log('OUTPUT FRAMES', {
        count: result.length,
        groupId: activeGroupId,
        objectIds: result.map(f => f.objectId),
        totalOutput: this.stats.framesOutput,
      });
    }

    // Check if we should complete this group and move to next
    this.checkGroupCompletion(group);

    return result;
  }

  tick(_nowMs: number): void {
    // VOD has no time-based logic by default
    // However, if maxWaitTimeMs is finite, we could check for stalled waits here

    if (this.config.maxWaitTimeMs !== Infinity) {
      const now = performance.now();
      for (const [key, startTime] of this.waitStartTime) {
        if (now - startTime > this.config.maxWaitTimeMs) {
          // Waited too long - this would be DVR-like behavior
          // For pure VOD, this path is not taken
          this.log('WAIT TIMEOUT', { key, waitedMs: now - startTime });
          this.waitStartTime.delete(key);
        }
      }
    }
  }

  getStats(): VodPolicyStats {
    return { ...this.stats };
  }

  reset(): void {
    this.stats = this.createInitialStats();
    this.waitStartTime.clear();
    this.nextExpectedGroup = -1;
    this.initialized = false;
    this.lastFrameReleaseTime = 0;
    this.accumulatedTimeMs = 0;
    this.isRebuffering = false;
    this.playbackStarted = false;
  }

  /**
   * Resume from pause - reset timing state to avoid accumulated time issues
   */
  override resume(): void {
    super.resume();
    // Reset pacing state so we don't have stale timing from before pause
    this.lastFrameReleaseTime = 0;
    this.accumulatedTimeMs = 0;
  }

  // ============================================================
  // Private helpers
  // ============================================================

  private checkGroupCompletion(group: GroupState<T>): void {
    // Group is complete when:
    // 1. Buffer is empty AND
    // 2. Either END_OF_GROUP received OR (waitForCompleteGop=false and next group ready)
    //
    // IMPORTANT: Do NOT assume "next keyframe arrived = current group complete"
    // With parallel QUIC streams, objects from different groups arrive out of order.
    // Group N+2's keyframe can arrive before Group N's remaining frames.

    if (group.frames.size > 0) {
      return; // Still have frames to output
    }

    if (group.outputObjectId < 0) {
      return; // Haven't started outputting
    }

    if (group.endOfGroupReceived) {
      // Explicit end signal - safe to complete
      this.completeAndPromote(group.groupId, 'end_of_group');
    } else if (!this.config.waitForCompleteGop) {
      // Not waiting for complete GOP - check if next group is ready
      const nextGroup = this.buffer.findNextKeyframeGroup(group.groupId);
      if (nextGroup) {
        this.completeAndPromote(group.groupId, 'next_group_ready');
      }
    }
    // Otherwise, wait for END_OF_GROUP signal (required for VOD with parallel streams)
  }

  private completeAndPromote(groupId: number, reason: string): void {
    this.buffer.completeGroup(groupId, 'finished');
    this.stats.groupsCompletedNaturally++;

    this.log('GROUP COMPLETED', { groupId, reason });

    // VOD: Move to next SEQUENTIAL group (groupId + 1), not just any available group
    this.nextExpectedGroup = groupId + 1;
    this.tryActivateNextSequentialGroup();
  }

  private tryActivateNextSequentialGroup(): boolean {
    // Not yet initialized - wait for first keyframe
    if (!this.initialized || this.nextExpectedGroup < 0) {
      this.log('WAITING FOR FIRST KEYFRAME', {
        availableGroups: Array.from(this.buffer.getGroupIds()),
      });
      return false;
    }

    // VOD: Only activate the next sequential group, never skip or go backward
    const expectedGroup = this.buffer.getGroup(this.nextExpectedGroup);

    if (expectedGroup && expectedGroup.hasKeyframe) {
      this.buffer.setActiveGroupId(this.nextExpectedGroup);
      expectedGroup.status = 'active';
      this.log('ACTIVATED NEXT SEQUENTIAL GROUP', {
        groupId: this.nextExpectedGroup,
      });
      return true;
    }

    // Expected group not ready yet - wait for it
    this.log('WAITING FOR SEQUENTIAL GROUP', {
      expected: this.nextExpectedGroup,
      availableGroups: Array.from(this.buffer.getGroupIds()),
    });
    return false;
  }

  /**
   * Count total frames buffered across all groups
   */
  private countTotalBufferedFrames(): number {
    let total = 0;
    for (const groupId of this.buffer.getGroupIds()) {
      const group = this.buffer.getGroup(groupId);
      if (group) {
        total += group.frames.size;
      }
    }
    return total;
  }

  private createInitialStats(): VodPolicyStats {
    return {
      policyName: this.name,
      groupsCompletedNaturally: 0,
      waitedForFrames: 0,
      framesOutput: 0,
      currentGopId: -1,
    };
  }
}
