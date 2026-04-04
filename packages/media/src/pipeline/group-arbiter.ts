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

  constructor(config: Partial<TimingConfig> = {}, tickProvider?: TickProvider) {
    this.config = { ...DEFAULT_TIMING_CONFIG, ...config };
    this.tickProvider = tickProvider ?? new MonotonicTickProvider();
    this.timingEstimator = createTimingEstimator(this.config);
    this.stats = createArbiterStats();
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
      locTimestamp,
      isKeyframe,
      isDiscardable: isDiscardable ?? false,
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

    return true;
  }

  /**
   * Get frames ready for output
   *
   * @param maxFrames - Maximum frames to return (default: 5)
   * @returns Array of frames ready for decoding
   */
  getReadyFrames(maxFrames = 5): FrameEntry<T>[] {
    const result: FrameEntry<T>[] = [];

    // Update group states (check deadlines)
    this.updateGroupStates();

    // Get active group
    let activeGroup = this.groups.get(this.activeGroupId);
    if (!activeGroup || activeGroup.status !== 'active') {
      // Try to find next active group
      this.promoteNextGroup();
      activeGroup = this.groups.get(this.activeGroupId);
      if (!activeGroup || activeGroup.status !== 'active') {
        return result;
      }
    }

    // Output frames in objectId order
    const startObjectId =
      activeGroup.outputObjectId < 0 ? 0 : activeGroup.outputObjectId;

    for (
      let objId = startObjectId;
      objId <= activeGroup.highestObjectId && result.length < maxFrames;
      objId++
    ) {
      const frame = activeGroup.frames.get(objId);

      if (!frame) {
        // Gap in sequence
        if (this.shouldWaitForMissingFrame(activeGroup, objId)) {
          break; // Wait for missing frame
        }
        // Skip missing frame (deadline pressure)
        this.stats.skippedMissingFrames++;
        continue;
      }

      // Check jitter delay
      const jitterTicks = this.tickProvider.msToTicks(this.config.jitterDelay);
      if (frame.receivedTick + jitterTicks > this.tickProvider.currentTick) {
        break; // Not ready yet
      }

      result.push(frame);
      activeGroup.frames.delete(objId);
      activeGroup.outputObjectId = objId + 1;
      this.stats.framesOutput++;

      // Update latency stats
      const latencyTicks = this.tickProvider.currentTick - frame.receivedTick;
      const latencyMs = this.tickProvider.ticksToMs(latencyTicks);
      this.updateLatencyStats(latencyMs);
    }

    // Check if group is complete (all frames output)
    if (activeGroup.frames.size === 0 && activeGroup.outputObjectId > 0) {
      activeGroup.status = 'complete';
      this.stats.groupsCompleted++;
      this.promoteNextGroup();
    }

    return result;
  }

  /**
   * Update group states based on deadlines
   */
  private updateGroupStates(): void {
    const now = this.tickProvider.currentTick;

    for (const [groupId, group] of this.groups) {
      if (group.status !== 'receiving' && group.status !== 'active') {
        continue;
      }

      // Check deadline
      if (now > group.deadlineTick) {
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
    // Option 1: If we have partial content and allowPartialGroupDecode, keep outputting
    if (
      this.config.allowPartialGroupDecode &&
      group.hasKeyframe &&
      group.outputObjectId >= 0
    ) {
      // Extend deadline slightly to finish partial output
      group.deadlineTick =
        this.tickProvider.currentTick +
        this.tickProvider.msToTicks(this.config.deadlineExtension);
      this.stats.deadlinesExtended++;
      return;
    }

    // Option 2: Find next group with keyframe to skip to
    if (this.config.skipOnlyToKeyframe) {
      const nextKeyframeGroup = this.findNextKeyframeGroup(group.groupId);
      if (nextKeyframeGroup) {
        group.status = 'skipped';
        this.activeGroupId = nextKeyframeGroup.groupId;
        nextKeyframeGroup.status = 'active';
        this.stats.groupsSkipped++;
        return;
      }
    }

    // Option 3: No keyframe available - extend deadline
    group.deadlineTick =
      this.tickProvider.currentTick +
      this.tickProvider.msToTicks(this.config.deadlineExtension);
    this.stats.deadlinesExtended++;
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

    const group = createGroupState<T>(groupId, tick, 0);

    // Calculate deadline
    group.deadlineTick = this.timingEstimator.calculateDeadline(
      group,
      this.tickProvider,
      this.config.maxLatency
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
  }
}
