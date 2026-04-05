// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Group Arbiter
 *
 * Handles out-of-order group delivery from parallel QUIC streams.
 * Ensures correct decode order while respecting latency deadlines.
 *
 * Key features:
 * - Orders frames by (groupId, objectId)
 * - Deadline-based skip logic for stale groups
 * - Partial group decode support
 * - Gap handling in groupId sequence
 */

import type {
  TimingConfig,
  GroupState,
  FrameEntry,
  ArbiterStats,
  ArbiterFrameInput,
} from './group-arbiter-types';
import {
  createGroupState,
  createArbiterStats,
  DEFAULT_TIMING_CONFIG,
} from './group-arbiter-types';
import type { TickProvider } from './tick-provider';
import { MonotonicTickProvider } from './tick-provider';
import { TimingEstimator, createTimingEstimator } from './timing-estimator';

/**
 * Group Arbiter for deadline-based frame ordering
 *
 * @remarks
 * Manages multiple concurrent groups, ensuring frames are output
 * in the correct order (by groupId, then objectId) while respecting
 * latency deadlines.
 *
 * @example
 * ```typescript
 * const arbiter = new GroupArbiter<VideoFrame>({
 *   maxLatency: 500,
 *   jitterDelay: 50,
 * });
 *
 * // Add frames as they arrive
 * arbiter.addFrame({
 *   groupId: 10,
 *   objectId: 0,
 *   data: frameData,
 *   isKeyframe: true,
 *   locTimestamp: 1234567890,
 * });
 *
 * // Get ready frames in output loop
 * const frames = arbiter.getReadyFrames();
 * for (const frame of frames) {
 *   decoder.decode(frame.data);
 * }
 * ```
 */
export class GroupArbiter<T> {
  private groups: Map<number, GroupState<T>> = new Map();
  private activeGroupId = -1;
  private tickProvider: TickProvider;
  private timingEstimator: TimingEstimator;
  private config: TimingConfig;
  private stats: ArbiterStats;
  private syncCounter = 0;

  // Skip-to-latest tracking
  private pendingSkipGroupId = -1;
  private pendingSkipFrameCount = 0;

  // Debug logging
  private pollCount = 0;
  private emptyPollCount = 0;

  constructor(config: Partial<TimingConfig> = {}, tickProvider?: TickProvider) {
    this.config = { ...DEFAULT_TIMING_CONFIG, ...config };
    this.tickProvider = tickProvider ?? new MonotonicTickProvider();
    this.timingEstimator = createTimingEstimator(this.config);
    this.stats = createArbiterStats();
  }

  /** Debug log helper - only logs if debug is enabled */
  private log(msg: string, data?: Record<string, unknown>): void {
    if (!this.config.debug) return;
    const now = performance.now();
    const prefix = `[Arbiter T+${now.toFixed(0)}ms]`;

    // Use callback if provided (for worker-to-main-thread relay)
    if (this.config.debugLogCallback) {
      this.config.debugLogCallback(`${prefix} ${msg}`, data);
    } else {
      if (data) {
        console.log(prefix, msg, data);
      } else {
        console.log(prefix, msg);
      }
    }
  }

  /**
   * Add a frame to the arbiter
   *
   * @param input - Frame input with groupId, objectId, data, and optional timing
   * @returns true if frame was accepted, false if dropped
   */
  addFrame(input: ArbiterFrameInput<T>): boolean {
    const {
      groupId,
      objectId,
      data,
      isKeyframe,
      locTimestamp,
      locTimescale,
      isDiscardable,
    } = input;

    // Tick once per frame (amortized timing)
    this.tickProvider.tick();
    this.stats.framesReceived++;

    // Periodic wall-clock sync (every ~100 frames)
    this.syncCounter++;
    if (this.syncCounter >= 100) {
      this.tickProvider.sync();
      this.syncCounter = 0;
    }

    // Get or create group
    let group = this.groups.get(groupId);

    if (!group) {
      group = this.createGroup(groupId);
      this.groups.set(groupId, group);
      this.stats.groupsReceived++;
      this.log('NEW GROUP', {
        groupId,
        deadlineMs: (group.deadlineTime - performance.now()).toFixed(0),
        activeGroupId: this.activeGroupId,
        isKeyframe,
      });
      this.pruneOldGroups();
    }

    // Don't accept frames for terminal groups
    if (
      group.status === 'expired' ||
      group.status === 'skipped' ||
      group.status === 'complete'
    ) {
      this.stats.droppedLateFrames++;
      return false;
    }

    // Check frame limit
    if (group.frameCount >= this.config.maxFramesPerGroup) {
      this.stats.droppedLateFrames++;
      return false;
    }

    // Store frame
    const frameEntry: FrameEntry<T> = {
      data,
      objectId,
      receivedTick: this.tickProvider.currentTick,
      receivedAt: performance.now(),
      locTimestamp,
      isKeyframe,
      isDiscardable: isDiscardable ?? false,
      shouldRender: true, // Default to render; catch-up logic may change this
    };

    group.frames.set(objectId, frameEntry);
    group.frameCount++;
    group.highestObjectId = Math.max(group.highestObjectId, objectId);

    if (isKeyframe) {
      group.hasKeyframe = true;
      this.timingEstimator.onKeyframe(groupId, locTimestamp, locTimescale);
    }

    // Update LOC timing if available
    if (locTimestamp !== undefined && group.locTimestampBase < 0) {
      group.locTimestampBase = locTimestamp;
      group.locTimescale = locTimescale ?? 1_000_000;
    }

    // Activate first group or switch to lower groupId if found
    if (this.activeGroupId < 0) {
      this.activeGroupId = groupId;
      group.status = 'active';
    } else if (groupId < this.activeGroupId) {
      // Found a lower groupId - switch active to this one
      const oldActive = this.groups.get(this.activeGroupId);
      if (oldActive && oldActive.status === 'active') {
        oldActive.status = 'receiving';
      }
      this.activeGroupId = groupId;
      group.status = 'active';
    }

    // Skip-to-latest logic: track newer groups with keyframes
    if (this.config.skipToLatestGroup && groupId > this.activeGroupId) {
      if (group.hasKeyframe) {
        // Track this as a potential skip target
        if (groupId > this.pendingSkipGroupId) {
          // New higher group with keyframe - reset counter
          this.pendingSkipGroupId = groupId;
          this.pendingSkipFrameCount = 1;
        } else if (groupId === this.pendingSkipGroupId) {
          // Same group - increment counter
          this.pendingSkipFrameCount++;
        }

        // Check if grace period reached
        if (this.pendingSkipFrameCount >= this.config.skipGraceFrames) {
          this.executeSkipToLatest();
        }
      }
    }

    return true;
  }

  /**
   * Execute skip to the latest group (pendingSkipGroupId)
   */
  private executeSkipToLatest(): void {
    const targetGroup = this.groups.get(this.pendingSkipGroupId);
    if (!targetGroup || !targetGroup.hasKeyframe) {
      return;
    }

    // Check if target group has at least one frame ready (past jitter delay)
    // This prevents freezes caused by skipping to a group whose frames
    // are all still in the jitter buffer
    // Use tick-based comparison to avoid performance.now() in hot path
    const keyframe = targetGroup.frames.get(0); // objectId 0 is the keyframe
    const jitterDelayTicks = this.tickProvider.msToTicks(this.config.jitterDelay);
    if (!keyframe || keyframe.receivedTick + jitterDelayTicks > this.tickProvider.currentTick) {
      // Keyframe not ready yet - don't skip, wait for jitter delay
      this.log('SKIP DEFERRED (jitter)', {
        pendingSkipGroupId: this.pendingSkipGroupId,
        hasKeyframe: !!keyframe,
        jitterDelayMs: this.config.jitterDelay,
      });
      return;
    }

    this.log('SKIP TO LATEST', {
      fromGroup: this.activeGroupId,
      toGroup: this.pendingSkipGroupId,
      frameCount: this.pendingSkipFrameCount,
    });

    // Mark all groups between active and target as skipped
    for (const [groupId, group] of this.groups) {
      if (groupId >= this.activeGroupId && groupId < this.pendingSkipGroupId) {
        if (group.status === 'active' || group.status === 'receiving') {
          group.status = 'skipped';
          this.stats.groupsSkipped++;
        }
      }
    }

    // Switch to target group
    this.activeGroupId = this.pendingSkipGroupId;
    targetGroup.status = 'active';

    // Reset pending skip tracking
    this.pendingSkipGroupId = -1;
    this.pendingSkipFrameCount = 0;
  }

  /**
   * Get frames ready for output
   *
   * @param maxFrames - Maximum frames to return (default: 5)
   * @returns Array of frames ready for decoding. Check frame.shouldRender
   *          to determine if frame should be displayed or just decoded.
   */
  getReadyFrames(maxFrames = 5): FrameEntry<T>[] {
    const result: FrameEntry<T>[] = [];
    this.pollCount++;

    // Update group states (check deadlines)
    this.updateGroupStates();

    // Get active group
    let activeGroup = this.groups.get(this.activeGroupId);
    if (!activeGroup || activeGroup.status !== 'active') {
      // Try to find next active group
      this.promoteNextGroup();
      activeGroup = this.groups.get(this.activeGroupId);
      if (!activeGroup || activeGroup.status !== 'active') {
        this.emptyPollCount++;
        // Log periodically why we have no frames
        if (this.config.debug && this.emptyPollCount % 60 === 1) {
          this.log('NO ACTIVE GROUP', {
            activeGroupId: this.activeGroupId,
            groupCount: this.groups.size,
            groups: [...this.groups.entries()].map(([id, g]) => ({
              id, status: g.status, frames: g.frameCount, hasKeyframe: g.hasKeyframe
            })),
          });
        }
        return result;
      }
    }

    // Check if we should enter catch-up mode
    const readyFrameCount = this.countReadyFrames(activeGroup);
    const inCatchUpMode =
      this.config.enableCatchUp &&
      readyFrameCount >= this.config.catchUpThreshold;

    if (inCatchUpMode) {
      this.stats.catchUpEvents++;
      this.log('CATCH-UP MODE', {
        groupId: this.activeGroupId,
        readyFrames: readyFrameCount,
        threshold: this.config.catchUpThreshold,
      });
    }

    // Determine how many frames to output
    const effectiveMaxFrames = inCatchUpMode
      ? Math.min(readyFrameCount, this.config.maxCatchUpFrames)
      : maxFrames;

    // Output frames in objectId order
    const startObjectId =
      activeGroup.outputObjectId < 0 ? 0 : activeGroup.outputObjectId;

    const now = performance.now();
    let breakReason = '';

    for (
      let objId = startObjectId;
      objId <= activeGroup.highestObjectId && result.length < effectiveMaxFrames;
      objId++
    ) {
      const frame = activeGroup.frames.get(objId);

      if (!frame) {
        // Gap in sequence
        if (this.shouldWaitForMissingFrame(activeGroup, objId)) {
          breakReason = `gap at objId=${objId}`;
          break; // Wait for missing frame
        }
        // Skip missing frame (deadline pressure)
        this.stats.skippedMissingFrames++;
        continue;
      }

      // In catch-up mode, bypass jitter delay to flush frames quickly
      if (!inCatchUpMode) {
        // Check jitter delay using wall-clock time (not ticks)
        // This ensures frames are released even when no new frames are arriving
        const jitterRemaining = (frame.receivedAt + this.config.jitterDelay) - now;
        if (jitterRemaining > 0) {
          breakReason = `jitter delay (${jitterRemaining.toFixed(0)}ms remaining for objId=${objId})`;
          break; // Not ready yet - still within jitter buffer window
        }
      }

      result.push(frame);
      activeGroup.frames.delete(objId);
      activeGroup.outputObjectId = objId + 1;
      this.stats.framesOutput++;

      // Update latency stats using wall-clock time for accuracy
      const latencyMs = now - frame.receivedAt;
      this.updateLatencyStats(latencyMs);
    }

    // Log when we return no frames despite having an active group
    if (result.length === 0 && activeGroup.frameCount > 0) {
      this.emptyPollCount++;
      if (this.config.debug && this.emptyPollCount % 30 === 1) {
        this.log('NO FRAMES READY', {
          groupId: this.activeGroupId,
          reason: breakReason || 'unknown',
          startObjectId,
          highestObjectId: activeGroup.highestObjectId,
          framesInGroup: activeGroup.frameCount,
          hasKeyframe: activeGroup.hasKeyframe,
          deadlineIn: (activeGroup.deadlineTime - now).toFixed(0) + 'ms',
        });
      }
    } else if (result.length > 0) {
      this.emptyPollCount = 0; // Reset empty poll counter
      // Log frame output periodically
      if (this.config.debug && this.stats.framesOutput % 30 === 0) {
        this.log('FRAMES OUTPUT', {
          count: result.length,
          groupId: this.activeGroupId,
          objIds: result.map(f => f.objectId).join(','),
          avgLatencyMs: this.stats.avgOutputLatency.toFixed(1),
          totalOutput: this.stats.framesOutput,
          skipped: this.stats.groupsSkipped,
        });
      }
    }

    // In catch-up mode, mark all but the last frame as decode-only (don't render)
    if (inCatchUpMode && result.length > 1) {
      for (let i = 0; i < result.length - 1; i++) {
        result[i].shouldRender = false;
        this.stats.framesFlushed++;
      }
      // Last frame should be rendered
      result[result.length - 1].shouldRender = true;
    }

    // Check if group is complete (END_OF_GROUP received and all frames output)
    if (activeGroup.endOfGroupReceived && activeGroup.frames.size === 0 && activeGroup.outputObjectId >= 0) {
      activeGroup.status = 'complete';
      this.stats.groupsCompleted++;
      this.log('GROUP COMPLETED (END_OF_GROUP + all frames output)', { groupId: this.activeGroupId });
      this.promoteNextGroup();
    }

    return result;
  }

  /**
   * Count how many frames are ready for output (past jitter delay)
   */
  private countReadyFrames(group: GroupState<T>): number {
    const now = performance.now();
    let count = 0;
    const startObjectId = group.outputObjectId < 0 ? 0 : group.outputObjectId;

    for (let objId = startObjectId; objId <= group.highestObjectId; objId++) {
      const frame = group.frames.get(objId);
      if (!frame) {
        // Gap - stop counting consecutive ready frames
        break;
      }
      if (frame.receivedAt + this.config.jitterDelay <= now) {
        count++;
      } else {
        break; // Not ready yet
      }
    }

    return count;
  }

  /**
   * Update group states based on deadlines
   */
  private updateGroupStates(): void {
    const now = performance.now();

    // Check if there's a pending skip-to-latest that's now ready
    // This handles the case where the keyframe wasn't ready when skip was triggered
    if (this.pendingSkipGroupId > 0 && this.config.skipToLatestGroup) {
      this.executeSkipToLatest();
    }

    for (const [groupId, group] of this.groups) {
      if (group.status !== 'receiving' && group.status !== 'active') {
        continue;
      }

      // Check deadline using wall-clock time
      if (now > group.deadlineTime) {
        if (groupId === this.activeGroupId) {
          // Active group expired - decide what to do
          this.handleExpiredActiveGroup(group);
        } else if (groupId < this.activeGroupId) {
          // Old group we already passed
          group.status = 'expired';
          this.stats.groupsExpired++;
        }
        // Future groups: let them continue receiving
      }
    }
  }

  /**
   * Handle expired active group
   */
  private handleExpiredActiveGroup(group: GroupState<T>): void {
    const now = performance.now();

    this.log('DEADLINE EXPIRED', {
      groupId: group.groupId,
      hasKeyframe: group.hasKeyframe,
      outputObjectId: group.outputObjectId,
      framesRemaining: group.frames.size,
      endOfGroupReceived: group.endOfGroupReceived,
    });

    // If END_OF_GROUP was received and no frames remaining, complete the group
    if (group.endOfGroupReceived && group.frames.size === 0) {
      this.log('GROUP COMPLETED (END_OF_GROUP + no frames)', { groupId: group.groupId });
      group.status = 'complete';
      this.stats.groupsCompleted++;
      this.promoteNextGroup();
      return;
    }

    // Check if next group has enough frames to indicate current group is done
    // BUT only skip if we have no more frames to output in current group
    const nextGroup = this.findNextKeyframeGroup(group.groupId);
    if (nextGroup && nextGroup.frameCount >= 3 && group.frames.size === 0) {
      this.log('SKIP TO NEXT GROUP (current empty, next has 3+ frames)', {
        fromGroup: group.groupId,
        toGroup: nextGroup.groupId,
        nextGroupFrames: nextGroup.frameCount,
      });
      group.status = 'skipped';
      this.activeGroupId = nextGroup.groupId;
      nextGroup.status = 'active';
      this.stats.groupsSkipped++;
      return;
    }

    // Option 1: If we have partial content and allowPartialGroupDecode, keep outputting
    // But only extend if there are frames remaining to output
    if (
      this.config.allowPartialGroupDecode &&
      group.hasKeyframe &&
      group.outputObjectId >= 0 &&
      group.frames.size > 0
    ) {
      // Extend deadline slightly to finish partial output
      group.deadlineTime = now + this.config.deadlineExtension;
      group.deadlineTick =
        this.tickProvider.currentTick +
        this.tickProvider.msToTicks(this.config.deadlineExtension);
      this.stats.deadlinesExtended++;
      this.log('DEADLINE EXTENDED (partial output)', { extensionMs: this.config.deadlineExtension });
      return;
    }

    // Option 2: Find next group with keyframe to skip to
    if (this.config.skipOnlyToKeyframe && nextGroup) {
      this.log('SKIP ON DEADLINE', {
        fromGroup: group.groupId,
        toGroup: nextGroup.groupId,
      });
      group.status = 'skipped';
      this.activeGroupId = nextGroup.groupId;
      nextGroup.status = 'active';
      this.stats.groupsSkipped++;
      return;
    }

    // Option 3: No keyframe available - extend deadline (but only if frames remaining or no END_OF_GROUP)
    if (group.frames.size > 0 || !group.endOfGroupReceived) {
      group.deadlineTime = now + this.config.deadlineExtension;
      group.deadlineTick =
        this.tickProvider.currentTick +
        this.tickProvider.msToTicks(this.config.deadlineExtension);
      this.stats.deadlinesExtended++;
      this.log('DEADLINE EXTENDED (waiting for frames/EOG)', { extensionMs: this.config.deadlineExtension });
    } else {
      // END_OF_GROUP received and no frames - mark complete
      this.log('GROUP COMPLETED (EOG, no frames, no next)', { groupId: group.groupId });
      group.status = 'complete';
      this.stats.groupsCompleted++;
      this.promoteNextGroup();
    }
  }

  /**
   * Find next group (by groupId) that has a keyframe
   * Handles gaps in groupId sequence
   */
  private findNextKeyframeGroup(afterGroupId: number): GroupState<T> | null {
    let candidate: GroupState<T> | null = null;
    let candidateGroupId = Infinity;

    for (const [groupId, group] of this.groups) {
      if (
        groupId > afterGroupId &&
        groupId < candidateGroupId &&
        group.hasKeyframe &&
        group.status === 'receiving'
      ) {
        candidate = group;
        candidateGroupId = groupId;
      }
    }

    return candidate;
  }

  /**
   * Decide whether to wait for a missing frame
   */
  private shouldWaitForMissingFrame(
    group: GroupState<T>,
    objectId: number
  ): boolean {
    const now = this.tickProvider.currentTick;
    const timeUntilDeadline = group.deadlineTick - now;
    const jitterTicks = this.tickProvider.msToTicks(this.config.jitterDelay);

    // If plenty of time, wait
    if (timeUntilDeadline > jitterTicks * 2) {
      return true;
    }

    // If it's objectId 0 (keyframe), must wait (can't decode without it)
    if (objectId === 0) {
      return true;
    }

    // Otherwise, skip if under deadline pressure
    return false;
  }

  /**
   * Create a new group
   */
  private createGroup(groupId: number): GroupState<T> {
    const tick = this.tickProvider.currentTick;
    const now = performance.now();

    // Calculate deadline in both ticks and wall-clock time
    // useLatencyDeadline: deadline = maxLatency (interactive, skip quickly)
    // !useLatencyDeadline: deadline = gopDuration + maxLatency (streaming, wait for GOP)
    const gopDurationMs = this.timingEstimator.getEstimatedGopDuration();
    const deadlineMs = this.config.useLatencyDeadline
      ? this.config.maxLatency
      : gopDurationMs + this.config.maxLatency;
    const deadlineTicks = this.tickProvider.msToTicks(deadlineMs);

    const group = createGroupState<T>(
      groupId,
      tick,
      now,
      tick + deadlineTicks,
      now + deadlineMs
    );

    return group;
  }

  /**
   * Promote next group to active
   */
  private promoteNextGroup(): void {
    // Find lowest groupId > activeGroupId with status 'receiving'
    let nextGroup: GroupState<T> | null = null;
    let nextGroupId = Infinity;

    for (const [groupId, group] of this.groups) {
      if (
        groupId > this.activeGroupId &&
        groupId < nextGroupId &&
        (group.status === 'receiving' || group.status === 'active')
      ) {
        nextGroup = group;
        nextGroupId = groupId;
      }
    }

    if (nextGroup) {
      this.activeGroupId = nextGroupId;
      nextGroup.status = 'active';
    }
  }

  /**
   * Mark a group as complete (received END_OF_GROUP signal from publisher)
   * This prevents infinite deadline extensions when all frames have been output.
   */
  markGroupComplete(groupId: number): void {
    const group = this.groups.get(groupId);
    if (!group) {
      this.log('MARK COMPLETE - group not found', { groupId });
      return;
    }

    group.endOfGroupReceived = true;
    this.log('GROUP MARKED COMPLETE', {
      groupId,
      framesRemaining: group.frames.size,
      outputObjectId: group.outputObjectId,
    });

    // If this is the active group with no frames remaining, complete it now
    if (groupId === this.activeGroupId && group.frames.size === 0 && group.outputObjectId >= 0) {
      group.status = 'complete';
      this.stats.groupsCompleted++;
      this.log('GROUP COMPLETED (all frames output)', { groupId });
      this.promoteNextGroup();
    }
  }

  /**
   * Prune old groups to limit memory
   */
  private pruneOldGroups(): void {
    if (this.groups.size <= this.config.maxActiveGroups) {
      return;
    }

    // Remove oldest groups that are complete/expired/skipped
    const sortedGroups = [...this.groups.entries()].sort(([a], [b]) => a - b);

    for (const [groupId, group] of sortedGroups) {
      if (this.groups.size <= this.config.maxActiveGroups) break;

      if (
        group.status === 'complete' ||
        group.status === 'expired' ||
        group.status === 'skipped'
      ) {
        this.groups.delete(groupId);
      }
    }
  }

  /**
   * Update latency statistics
   */
  private updateLatencyStats(latencyMs: number): void {
    // Track max
    if (latencyMs > this.stats.maxOutputLatency) {
      this.stats.maxOutputLatency = latencyMs;
    }

    // Update average (exponential moving average)
    const alpha = 0.1;
    this.stats.avgOutputLatency =
      (1 - alpha) * this.stats.avgOutputLatency + alpha * latencyMs;

    // Update GOP duration in stats
    this.stats.estimatedGopDuration =
      this.timingEstimator.getEstimatedGopDuration();
  }

  /**
   * Get current statistics
   */
  getStats(): ArbiterStats {
    return { ...this.stats };
  }

  /**
   * Get current active group ID
   */
  getActiveGroupId(): number {
    return this.activeGroupId;
  }

  /**
   * Get number of tracked groups
   */
  getGroupCount(): number {
    return this.groups.size;
  }

  /**
   * Check if a group exists
   */
  hasGroup(groupId: number): boolean {
    return this.groups.has(groupId);
  }

  /**
   * Get group state (for debugging/testing)
   */
  getGroupState(groupId: number): GroupState<T> | undefined {
    return this.groups.get(groupId);
  }

  /**
   * Reset the arbiter
   */
  reset(): void {
    this.groups.clear();
    this.activeGroupId = -1;
    this.tickProvider.reset();
    this.timingEstimator.reset();
    this.stats = createArbiterStats();
    this.syncCounter = 0;
    this.pendingSkipGroupId = -1;
    this.pendingSkipFrameCount = 0;
  }
}
