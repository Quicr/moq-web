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
   * Minimum frames to buffer before starting output (default: 1)
   * Set higher for smoother start (e.g., buffer first GOP)
   */
  minBufferFrames: number;

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

  /** Enable debug logging */
  debug: boolean;
}

/**
 * Default VOD policy configuration
 */
export const DEFAULT_VOD_POLICY_CONFIG: VodReleasePolicyConfig = {
  minBufferFrames: 1,
  waitForCompleteGop: true,
  maxWaitTimeMs: Infinity,
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
  private nextExpectedGroup = 0;

  constructor(config: Partial<VodReleasePolicyConfig> = {}) {
    super();
    this.config = { ...DEFAULT_VOD_POLICY_CONFIG, ...config };
    // Enable debug by default for VOD to trace issues
    this.debug = this.config.debug || true;
    this.stats = this.createInitialStats();
    console.log('[VodReleasePolicy] Created with config:', this.config);
  }

  onFrameAdded(frame: FrameEntry<T>, group: GroupState<T>): void {
    // Clear wait timer if this frame was waited for
    const waitKey = `${frame.groupId}:${frame.objectId}`;
    if (this.waitStartTime.has(waitKey)) {
      this.waitStartTime.delete(waitKey);
      this.log('WAIT RESOLVED', { groupId: frame.groupId, objectId: frame.objectId });
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

    // Check minimum buffer requirement for initial playback
    if (group.outputObjectId < 0 && group.frameCount < this.config.minBufferFrames) {
      this.log('BUFFERING', {
        groupId: activeGroupId,
        frames: group.frameCount,
        required: this.config.minBufferFrames,
      });
      return [];
    }

    // Output sequential frames
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
    this.nextExpectedGroup = 0;
  }

  // ============================================================
  // Private helpers
  // ============================================================

  private checkGroupCompletion(group: GroupState<T>): void {
    // Group is complete when:
    // 1. Buffer is empty AND
    // 2. Either END_OF_GROUP received OR next group with keyframe exists

    if (group.frames.size > 0) {
      return; // Still have frames to output
    }

    if (group.outputObjectId < 0) {
      return; // Haven't started outputting
    }

    const nextGroup = this.buffer.findNextKeyframeGroup(group.groupId);

    if (group.endOfGroupReceived) {
      this.completeAndPromote(group.groupId, 'end_of_group');
    } else if (nextGroup && !this.config.waitForCompleteGop) {
      // Next group ready and we don't need to wait for complete GOP
      this.completeAndPromote(group.groupId, 'next_group_ready');
    } else if (nextGroup && nextGroup.hasKeyframe) {
      // Next group has keyframe - current GOP is done
      // (In VOD, receiving keyframe of next group implies current is complete)
      this.completeAndPromote(group.groupId, 'next_keyframe');
    }
    // Otherwise, wait for more frames or END_OF_GROUP
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
