// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview LiveReleasePolicy - Deadline-based release for live content
 *
 * This policy implements all functionality from GroupArbiter:
 * - Jitter buffer for network variance absorption
 * - Per-group deadlines with configurable calculation modes
 * - Catch-up mode for deep buffer recovery
 * - Skip-to-latest for aggressive latency control
 * - Partial group decode support
 * - TimingEstimator for GOP duration estimation
 *
 * Used when catalog.track.isLive === true or explicitly configured.
 */

import { BaseReleasePolicy, type ReleasePolicyStats } from './release-policy.js';
import type { FrameEntry, GroupState, PlayoutBuffer } from './playout-buffer.js';
import type { TickProvider } from './tick-provider.js';
import { MonotonicTickProvider } from './tick-provider.js';
import { TimingEstimator } from './timing-estimator.js';

/**
 * Live policy configuration
 * Matches the original TimingConfig from GroupArbiter
 */
export interface LiveReleasePolicyConfig {
  // Catalog-derived hints (optional)
  /** Video framerate from catalog */
  catalogFramerate?: number;
  /** Timescale from catalog (units per second) */
  catalogTimescale?: number;

  // Core timing parameters
  /** Initial estimated GOP duration in ms (default: 1000) */
  estimatedGopDuration: number;
  /** Maximum acceptable end-to-end latency in ms (default: 500) */
  maxLatency: number;
  /** Per-frame jitter buffer delay in ms (default: 50) */
  jitterDelay: number;
  /** Deadline extension when no keyframe available in ms (default: 200) */
  deadlineExtension: number;

  // Buffer limits
  /** Maximum groups to track simultaneously (default: 4) */
  maxActiveGroups: number;
  /** Maximum frames per group (default: 120) */
  maxFramesPerGroup: number;

  // Behavior flags
  /** Allow outputting partial groups (keyframe + some P-frames) (default: true) */
  allowPartialGroupDecode: boolean;
  /** Only skip to groups that have a keyframe (default: true) */
  skipOnlyToKeyframe: boolean;
  /** Skip to latest group when a newer group arrives (aggressive catch-up, default: false) */
  skipToLatestGroup: boolean;
  /** Number of frames to wait before skipping to latest group (grace period, default: 3) */
  skipGraceFrames: number;

  // Catch-up / buffer flush settings
  /** Enable catch-up mode when buffer gets too deep (default: true) */
  enableCatchUp: boolean;
  /** Number of ready frames that triggers catch-up mode (default: 5) */
  catchUpThreshold: number;
  /** Maximum frames to flush in a single catch-up batch (default: 30) */
  maxCatchUpFrames: number;

  // Deadline mode
  /**
   * Use latency-only deadline calculation (default: true for interactive use).
   * - true: deadline = maxLatency (skip quickly when behind, good for conferencing)
   * - false: deadline = gopDuration + maxLatency (wait for full GOP, good for streaming)
   */
  useLatencyDeadline: boolean;

  /** Enable debug logging (default: false) */
  debug: boolean;
}

/**
 * Default live policy configuration
 */
export const DEFAULT_LIVE_POLICY_CONFIG: LiveReleasePolicyConfig = {
  estimatedGopDuration: 1000,
  maxLatency: 500,
  jitterDelay: 50,
  deadlineExtension: 200,
  maxActiveGroups: 4,
  maxFramesPerGroup: 120,
  allowPartialGroupDecode: true,
  skipOnlyToKeyframe: true,
  skipToLatestGroup: false,
  skipGraceFrames: 3,
  enableCatchUp: true,
  catchUpThreshold: 5,
  maxCatchUpFrames: 30,
  useLatencyDeadline: true,
  debug: false,
};

/**
 * Per-group deadline metadata (not stored in PlayoutBuffer's GroupState)
 */
interface GroupDeadlineInfo {
  deadlineTick: number;
  deadlineTime: number;  // Wall-clock deadline (performance.now())
  locTimestampBase: number;
  locTimescale: number;
}

/**
 * Live policy statistics
 */
export interface LivePolicyStats extends ReleasePolicyStats {
  framesReceived: number;
  framesOutput: number;
  droppedLateFrames: number;
  skippedMissingFrames: number;
  groupsReceived: number;
  groupsCompleted: number;
  groupsExpired: number;
  groupsSkipped: number;
  deadlinesExtended: number;
  catchUpEvents: number;
  framesFlushed: number;
  estimatedGopDuration: number;
  avgOutputLatency: number;
  maxOutputLatency: number;
}

/**
 * LiveReleasePolicy - Full-featured deadline-based frame release
 *
 * Implements all GroupArbiter functionality within the PlayoutBuffer architecture.
 */
export class LiveReleasePolicy<T> extends BaseReleasePolicy<T> {
  readonly name = 'live';

  private config: LiveReleasePolicyConfig;
  private tickProvider: TickProvider;
  private timingEstimator: TimingEstimator;
  private stats: LivePolicyStats;

  // Per-group deadline tracking (parallel to PlayoutBuffer's groups)
  private groupDeadlines: Map<number, GroupDeadlineInfo> = new Map();

  // Skip-to-latest tracking
  private pendingSkipGroupId = -1;
  private pendingSkipFrameCount = 0;

  // Timing sync
  private syncCounter = 0;

  // Debug counters
  private pollCount = 0;
  private emptyPollCount = 0;

  constructor(
    config: Partial<LiveReleasePolicyConfig> = {},
    tickProvider?: TickProvider
  ) {
    super();
    this.config = { ...DEFAULT_LIVE_POLICY_CONFIG, ...config };
    this.tickProvider = tickProvider ?? new MonotonicTickProvider();
    this.timingEstimator = new TimingEstimator({
      initialGopDuration: this.config.estimatedGopDuration,
      catalogFramerate: this.config.catalogFramerate,
      catalogTimescale: this.config.catalogTimescale,
    });
    this.stats = this.createInitialStats();
    this.debug = this.config.debug;
  }

  initialize(buffer: PlayoutBuffer<T>): void {
    super.initialize(buffer);
  }

  onFrameAdded(frame: FrameEntry<T>, group: GroupState<T>): void {
    // Tick once per frame (amortized timing)
    this.tickProvider.tick();
    this.stats.framesReceived++;

    // Periodic wall-clock sync (every ~100 frames)
    this.syncCounter++;
    if (this.syncCounter >= 100) {
      this.tickProvider.sync();
      this.syncCounter = 0;
    }

    // Create deadline info for new groups
    if (!this.groupDeadlines.has(frame.groupId)) {
      this.createGroupDeadline(frame.groupId);
    }

    // Update timing estimator on keyframe
    if (frame.isKeyframe) {
      this.timingEstimator.onKeyframe(frame.groupId, frame.locTimestamp, frame.locTimescale);
    }

    // Update LOC timing info
    const deadlineInfo = this.groupDeadlines.get(frame.groupId)!;
    if (frame.locTimestamp !== undefined && deadlineInfo.locTimestampBase < 0) {
      deadlineInfo.locTimestampBase = frame.locTimestamp;
      deadlineInfo.locTimescale = frame.locTimescale ?? 1_000_000;
    }

    // Handle active group selection
    const activeGroupId = this.buffer.getActiveGroupId();
    if (activeGroupId < 0) {
      this.buffer.setActiveGroupId(frame.groupId);
      group.status = 'active';
    } else if (frame.groupId < activeGroupId) {
      // Found lower groupId - switch to it
      const oldActive = this.buffer.getGroup(activeGroupId);
      if (oldActive && oldActive.status === 'active') {
        oldActive.status = 'receiving';
      }
      this.buffer.setActiveGroupId(frame.groupId);
      group.status = 'active';
    }

    // Skip-to-latest tracking
    if (this.config.skipToLatestGroup && frame.groupId > this.buffer.getActiveGroupId()) {
      if (group.hasKeyframe) {
        if (frame.groupId > this.pendingSkipGroupId) {
          this.pendingSkipGroupId = frame.groupId;
          this.pendingSkipFrameCount = 1;
        } else if (frame.groupId === this.pendingSkipGroupId) {
          this.pendingSkipFrameCount++;
        }

        if (this.pendingSkipFrameCount >= this.config.skipGraceFrames) {
          this.executeSkipToLatest();
        }
      }
    }
  }

  onEndOfGroup(groupId: number, group: GroupState<T>): void {
    this.log('END_OF_GROUP', {
      groupId,
      framesRemaining: group.frames.size,
      outputObjectId: group.outputObjectId,
    });

    // If active group with no frames remaining, complete it
    if (groupId === this.buffer.getActiveGroupId() && group.frames.size === 0 && group.outputObjectId >= 0) {
      this.buffer.completeGroup(groupId, 'finished');
      this.stats.groupsCompleted++;
      this.promoteToNextGroup();
    }
  }

  getReadyFrames(maxFrames: number): FrameEntry<T>[] {
    const result: FrameEntry<T>[] = [];
    this.pollCount++;

    // Update group states (check deadlines)
    this.updateGroupStates();

    // Get active group
    const activeGroupId = this.buffer.getActiveGroupId();
    let activeGroup = this.buffer.getGroup(activeGroupId);

    if (!activeGroup || activeGroup.status !== 'active') {
      if (!this.promoteToNextGroup()) {
        this.emptyPollCount++;
        if (this.debug && this.emptyPollCount % 60 === 1) {
          this.logNoActiveGroup();
        }
        return result;
      }
      activeGroup = this.buffer.getGroup(this.buffer.getActiveGroupId())!;
    }

    const now = performance.now();

    // Check catch-up mode
    const readyFrameCount = this.countReadyFrames(activeGroup, now);
    const inCatchUpMode = this.config.enableCatchUp && readyFrameCount >= this.config.catchUpThreshold;

    if (inCatchUpMode) {
      this.stats.catchUpEvents++;
      this.log('CATCH-UP MODE', { groupId: activeGroupId, readyFrames: readyFrameCount });
    }

    const effectiveMaxFrames = inCatchUpMode
      ? Math.min(readyFrameCount, this.config.maxCatchUpFrames)
      : maxFrames;

    // Output frames in objectId order
    const startObjectId = activeGroup.outputObjectId < 0 ? 0 : activeGroup.outputObjectId;
    const deadlineInfo = this.groupDeadlines.get(activeGroupId);
    let breakReason = '';

    for (let objId = startObjectId; objId <= activeGroup.highestObjectId && result.length < effectiveMaxFrames; objId++) {
      const frame = activeGroup.frames.get(objId);

      if (!frame) {
        // Gap in sequence
        if (this.shouldWaitForMissingFrame(activeGroup, objId, deadlineInfo)) {
          breakReason = `gap at objId=${objId}`;
          break;
        }
        this.stats.skippedMissingFrames++;
        continue;
      }

      // Check jitter delay (bypass in catch-up mode)
      if (!inCatchUpMode) {
        const jitterRemaining = (frame.receivedAt + this.config.jitterDelay) - now;
        if (jitterRemaining > 0) {
          breakReason = `jitter delay (${jitterRemaining.toFixed(0)}ms remaining for objId=${objId})`;
          break;
        }
      }

      result.push(frame);
      activeGroup.frames.delete(objId);
      activeGroup.outputObjectId = objId + 1;
      this.stats.framesOutput++;

      // Update latency stats
      const latencyMs = now - frame.receivedAt;
      this.updateLatencyStats(latencyMs);
    }

    // Log output status
    this.logOutputStatus(result, activeGroup, breakReason, now);

    // Handle catch-up mode rendering
    if (inCatchUpMode && result.length > 1) {
      for (let i = 0; i < result.length - 1; i++) {
        result[i].shouldRender = false;
        this.stats.framesFlushed++;
      }
      result[result.length - 1].shouldRender = true;
    }

    // Check group completion
    this.checkGroupCompletion(activeGroup);

    return result;
  }

  tick(nowMs: number): void {
    // Check pending skip-to-latest
    if (this.pendingSkipGroupId > 0 && this.config.skipToLatestGroup) {
      this.executeSkipToLatest();
    }

    // Deadline checking happens in updateGroupStates() called from getReadyFrames()
    // But we can also check here for proactive deadline handling
    const activeGroupId = this.buffer.getActiveGroupId();
    const deadlineInfo = this.groupDeadlines.get(activeGroupId);
    const group = this.buffer.getGroup(activeGroupId);

    if (deadlineInfo && group && nowMs > deadlineInfo.deadlineTime) {
      this.handleExpiredDeadline(group, deadlineInfo, nowMs);
    }
  }

  getStats(): LivePolicyStats {
    return {
      ...this.stats,
      estimatedGopDuration: this.timingEstimator.getEstimatedGopDuration(),
    };
  }

  reset(): void {
    this.stats = this.createInitialStats();
    this.groupDeadlines.clear();
    this.tickProvider.reset();
    this.timingEstimator.reset();
    this.pendingSkipGroupId = -1;
    this.pendingSkipFrameCount = 0;
    this.syncCounter = 0;
    this.pollCount = 0;
    this.emptyPollCount = 0;
  }

  // ============================================================
  // Private implementation
  // ============================================================

  private createGroupDeadline(groupId: number): void {
    const tick = this.tickProvider.currentTick;
    const now = performance.now();

    const gopDurationMs = this.timingEstimator.getEstimatedGopDuration();
    const deadlineMs = this.config.useLatencyDeadline
      ? this.config.maxLatency
      : gopDurationMs + this.config.maxLatency;
    const deadlineTicks = this.tickProvider.msToTicks(deadlineMs);

    this.groupDeadlines.set(groupId, {
      deadlineTick: tick + deadlineTicks,
      deadlineTime: now + deadlineMs,
      locTimestampBase: -1,
      locTimescale: 1_000_000,
    });

    this.stats.groupsReceived++;
    this.log('NEW GROUP', { groupId, deadlineMs: deadlineMs.toFixed(0), activeGroupId: this.buffer.getActiveGroupId() });
  }

  private executeSkipToLatest(): void {
    const targetGroup = this.buffer.getGroup(this.pendingSkipGroupId);
    if (!targetGroup || !targetGroup.hasKeyframe) {
      return;
    }

    // Check if keyframe is past jitter delay
    const keyframe = targetGroup.frames.get(0);
    if (!keyframe || keyframe.receivedAt + this.config.jitterDelay > performance.now()) {
      this.log('SKIP DEFERRED (jitter)', { pendingSkipGroupId: this.pendingSkipGroupId });
      return;
    }

    this.log('SKIP TO LATEST', {
      fromGroup: this.buffer.getActiveGroupId(),
      toGroup: this.pendingSkipGroupId,
      frameCount: this.pendingSkipFrameCount,
    });

    // Mark intermediate groups as skipped
    const activeGroupId = this.buffer.getActiveGroupId();
    for (const [groupId, group] of this.buffer.getAllGroups()) {
      if (groupId >= activeGroupId && groupId < this.pendingSkipGroupId) {
        if (group.status === 'active' || group.status === 'receiving') {
          this.buffer.completeGroup(groupId, 'skipped');
          this.stats.groupsSkipped++;
        }
      }
    }

    // Switch to target
    this.buffer.setActiveGroupId(this.pendingSkipGroupId);
    targetGroup.status = 'active';

    // Reset tracking
    this.pendingSkipGroupId = -1;
    this.pendingSkipFrameCount = 0;
  }

  private updateGroupStates(): void {
    const now = performance.now();

    // Check pending skip-to-latest
    if (this.pendingSkipGroupId > 0 && this.config.skipToLatestGroup) {
      this.executeSkipToLatest();
    }

    const activeGroupId = this.buffer.getActiveGroupId();

    for (const [groupId, group] of this.buffer.getAllGroups()) {
      if (group.status !== 'receiving' && group.status !== 'active') {
        continue;
      }

      const deadlineInfo = this.groupDeadlines.get(groupId);
      if (!deadlineInfo) continue;

      if (now > deadlineInfo.deadlineTime) {
        if (groupId === activeGroupId) {
          this.handleExpiredDeadline(group, deadlineInfo, now);
        } else if (groupId < activeGroupId) {
          group.status = 'complete'; // Mark as expired equivalent
          this.stats.groupsExpired++;
        }
      }
    }
  }

  private handleExpiredDeadline(group: GroupState<T>, deadlineInfo: GroupDeadlineInfo, now: number): void {
    this.log('DEADLINE EXPIRED', {
      groupId: group.groupId,
      hasKeyframe: group.hasKeyframe,
      outputObjectId: group.outputObjectId,
      framesRemaining: group.frames.size,
      endOfGroupReceived: group.endOfGroupReceived,
    });

    // END_OF_GROUP received and no frames - complete
    if (group.endOfGroupReceived && group.frames.size === 0) {
      this.buffer.completeGroup(group.groupId, 'finished');
      this.stats.groupsCompleted++;
      this.promoteToNextGroup();
      return;
    }

    // Check if next group has enough frames
    const nextGroup = this.buffer.findNextKeyframeGroup(group.groupId);
    if (nextGroup && nextGroup.frameCount >= 3 && group.frames.size === 0) {
      this.log('SKIP TO NEXT (current empty, next has 3+ frames)', {
        fromGroup: group.groupId,
        toGroup: nextGroup.groupId,
      });
      this.buffer.completeGroup(group.groupId, 'skipped');
      this.buffer.setActiveGroupId(nextGroup.groupId);
      nextGroup.status = 'active';
      this.stats.groupsSkipped++;
      return;
    }

    // Partial group decode - extend deadline
    if (this.config.allowPartialGroupDecode && group.hasKeyframe && group.outputObjectId >= 0 && group.frames.size > 0) {
      this.extendDeadline(deadlineInfo, now, 'partial output');
      return;
    }

    // Skip to next keyframe group
    if (this.config.skipOnlyToKeyframe && nextGroup) {
      this.log('SKIP ON DEADLINE', { fromGroup: group.groupId, toGroup: nextGroup.groupId });
      this.buffer.completeGroup(group.groupId, 'skipped');
      this.buffer.setActiveGroupId(nextGroup.groupId);
      nextGroup.status = 'active';
      this.stats.groupsSkipped++;
      return;
    }

    // Extend deadline if frames remaining or no END_OF_GROUP
    if (group.frames.size > 0 || !group.endOfGroupReceived) {
      this.extendDeadline(deadlineInfo, now, 'waiting for frames/EOG');
    } else {
      this.buffer.completeGroup(group.groupId, 'finished');
      this.stats.groupsCompleted++;
      this.promoteToNextGroup();
    }
  }

  private extendDeadline(deadlineInfo: GroupDeadlineInfo, now: number, reason: string): void {
    deadlineInfo.deadlineTime = now + this.config.deadlineExtension;
    deadlineInfo.deadlineTick = this.tickProvider.currentTick + this.tickProvider.msToTicks(this.config.deadlineExtension);
    this.stats.deadlinesExtended++;
    this.log('DEADLINE EXTENDED', { reason, extensionMs: this.config.deadlineExtension });
  }

  private countReadyFrames(group: GroupState<T>, now: number): number {
    let count = 0;
    const startObjectId = group.outputObjectId < 0 ? 0 : group.outputObjectId;

    for (let objId = startObjectId; objId <= group.highestObjectId; objId++) {
      const frame = group.frames.get(objId);
      if (!frame) break;
      if (frame.receivedAt + this.config.jitterDelay <= now) {
        count++;
      } else {
        break;
      }
    }

    return count;
  }

  private shouldWaitForMissingFrame(_group: GroupState<T>, objectId: number, deadlineInfo?: GroupDeadlineInfo): boolean {
    if (!deadlineInfo) return true;

    const now = this.tickProvider.currentTick;
    const timeUntilDeadline = deadlineInfo.deadlineTick - now;
    const jitterTicks = this.tickProvider.msToTicks(this.config.jitterDelay);

    // Plenty of time - wait
    if (timeUntilDeadline > jitterTicks * 2) {
      return true;
    }

    // Keyframe (objectId 0) - must wait
    if (objectId === 0) {
      return true;
    }

    // Under deadline pressure - skip
    return false;
  }

  private checkGroupCompletion(group: GroupState<T>): void {
    if (group.frames.size > 0 || group.outputObjectId < 0) {
      return;
    }

    const nextGroup = this.buffer.findNextKeyframeGroup(group.groupId);

    if (group.endOfGroupReceived || nextGroup) {
      this.buffer.completeGroup(group.groupId, 'finished');
      this.stats.groupsCompleted++;
      this.log('GROUP COMPLETED', {
        groupId: group.groupId,
        reason: group.endOfGroupReceived ? 'END_OF_GROUP' : 'next_group_ready',
        nextGroupId: nextGroup?.groupId,
      });

      if (nextGroup) {
        this.buffer.setActiveGroupId(nextGroup.groupId);
        nextGroup.status = 'active';
      } else {
        this.promoteToNextGroup();
      }
    }
  }

  private updateLatencyStats(latencyMs: number): void {
    if (latencyMs > this.stats.maxOutputLatency) {
      this.stats.maxOutputLatency = latencyMs;
    }

    const alpha = 0.1;
    this.stats.avgOutputLatency = (1 - alpha) * this.stats.avgOutputLatency + alpha * latencyMs;
  }

  private logNoActiveGroup(): void {
    this.log('NO ACTIVE GROUP', {
      activeGroupId: this.buffer.getActiveGroupId(),
      groupCount: this.buffer.getGroupCount(),
      groups: [...this.buffer.getAllGroups().entries()].map(([id, g]) => ({
        id,
        status: g.status,
        frames: g.frameCount,
        hasKeyframe: g.hasKeyframe,
      })),
    });
  }

  private logOutputStatus(result: FrameEntry<T>[], group: GroupState<T>, breakReason: string, now: number): void {
    if (result.length === 0 && group.frameCount > 0) {
      this.emptyPollCount++;
      const deadlineInfo = this.groupDeadlines.get(group.groupId);
      if (this.debug && this.emptyPollCount % 30 === 1) {
        this.log('NO FRAMES READY', {
          groupId: group.groupId,
          reason: breakReason || 'unknown',
          startObjectId: group.outputObjectId < 0 ? 0 : group.outputObjectId,
          highestObjectId: group.highestObjectId,
          framesInGroup: group.frameCount,
          hasKeyframe: group.hasKeyframe,
          deadlineIn: deadlineInfo ? (deadlineInfo.deadlineTime - now).toFixed(0) + 'ms' : 'unknown',
        });
      }
    } else if (result.length > 0) {
      this.emptyPollCount = 0;
      if (this.debug && this.stats.framesOutput % 30 === 0) {
        this.log('FRAMES OUTPUT', {
          count: result.length,
          groupId: group.groupId,
          objIds: result.map(f => f.objectId).join(','),
          avgLatencyMs: this.stats.avgOutputLatency.toFixed(1),
          totalOutput: this.stats.framesOutput,
          skipped: this.stats.groupsSkipped,
        });
      }
    }
  }

  private createInitialStats(): LivePolicyStats {
    return {
      policyName: this.name,
      framesReceived: 0,
      framesOutput: 0,
      droppedLateFrames: 0,
      skippedMissingFrames: 0,
      groupsReceived: 0,
      groupsCompleted: 0,
      groupsExpired: 0,
      groupsSkipped: 0,
      deadlinesExtended: 0,
      catchUpEvents: 0,
      framesFlushed: 0,
      estimatedGopDuration: this.config.estimatedGopDuration,
      avgOutputLatency: 0,
      maxOutputLatency: 0,
    };
  }
}
