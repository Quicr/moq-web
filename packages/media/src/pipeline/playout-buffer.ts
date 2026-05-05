// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview PlayoutBuffer - Core buffering for media playback
 *
 * PlayoutBuffer handles the storage and organization of frames by group/object.
 * It delegates all release timing decisions to a ReleasePolicy, enabling
 * different playback behaviors (interactive, live streaming, VOD) without
 * changing the core buffering logic.
 *
 * Design: Strategy + Composition pattern
 * - PlayoutBuffer: storage, memory management, group lifecycle
 * - ReleasePolicy: when to release frames, skip groups, handle deadlines
 */

import type { ReleasePolicy, ReleasePolicyStats } from './release-policy.js';

/**
 * A single frame entry in the buffer
 */
export interface FrameEntry<T> {
  /** Frame data (codec-specific payload) */
  data: T;

  /** Group ID (GOP identifier) */
  groupId: number;

  /** Object ID within the group (frame index) */
  objectId: number;

  /** Whether this is a keyframe (IDR for video) */
  isKeyframe: boolean;

  /** Wall-clock time when frame was received (performance.now()) */
  receivedAt: number;

  /** LOC timestamp if available (microseconds) */
  locTimestamp?: number;

  /** LOC timescale (units per second) */
  locTimescale?: number;

  /** Whether frame is discardable (from LOC Video Frame Marking) */
  isDiscardable: boolean;

  /**
   * Whether this frame should be rendered after decoding.
   * When false, frame should be decoded (to update decoder state) but not displayed.
   * Used during catch-up to flush buffered frames quickly.
   */
  shouldRender: boolean;
}

/**
 * State for a single group (GOP)
 */
export interface GroupState<T> {
  /** Group ID from MOQT */
  groupId: number;

  /** Frames indexed by objectId (sparse map for out-of-order arrival) */
  frames: Map<number, FrameEntry<T>>;

  /** Wall-clock time when first frame arrived */
  firstFrameReceivedAt: number;

  /** Whether we've received objectId 0 (keyframe) */
  hasKeyframe: boolean;

  /** Highest objectId received so far */
  highestObjectId: number;

  /** Next objectId to output (-1 if not started) */
  outputObjectId: number;

  /** Total frames received for this group */
  frameCount: number;

  /** Whether END_OF_GROUP signal has been received */
  endOfGroupReceived: boolean;

  /** Group status for lifecycle management */
  status: GroupStatus;
}

/**
 * Group lifecycle status
 */
export type GroupStatus =
  | 'receiving' // Actively receiving frames
  | 'active'    // Currently being output
  | 'complete'  // All frames output successfully
  | 'skipped';  // Skipped (policy decision)

/**
 * Input for adding a frame to the buffer
 */
export interface FrameInput<T> {
  /** Group ID from MOQT */
  groupId: number;

  /** Object ID within the group */
  objectId: number;

  /** Frame data */
  data: T;

  /** Whether this is a keyframe */
  isKeyframe: boolean;

  /** LOC timestamp (microseconds, optional) */
  locTimestamp?: number;

  /** LOC timescale (optional, default 1,000,000) */
  locTimescale?: number;

  /** Whether frame is discardable (optional) */
  isDiscardable?: boolean;
}

/**
 * Buffer statistics
 */
export interface PlayoutBufferStats {
  /** Total frames received */
  framesReceived: number;

  /** Total frames output */
  framesOutput: number;

  /** Frames dropped (late arrival, buffer full, etc.) */
  framesDropped: number;

  /** Total groups seen */
  groupsReceived: number;

  /** Groups completed successfully */
  groupsCompleted: number;

  /** Groups skipped by policy */
  groupsSkipped: number;

  /** Current number of tracked groups */
  activeGroupCount: number;

  /** Current active group ID */
  activeGroupId: number;
}

/**
 * Buffer configuration
 */
export interface PlayoutBufferConfig {
  /** Maximum groups to track simultaneously (default: 8) */
  maxGroups: number;

  /** Maximum frames per group (default: 300) */
  maxFramesPerGroup: number;

  /** Enable debug logging */
  debug: boolean;

  /** Optional callback for debug logs */
  debugLogCallback?: (message: string, data?: Record<string, unknown>) => void;
}

/**
 * Default buffer configuration
 */
export const DEFAULT_BUFFER_CONFIG: PlayoutBufferConfig = {
  maxGroups: 8,
  maxFramesPerGroup: 300,
  debug: false,
};

/**
 * PlayoutBuffer - Core media frame buffering
 *
 * Handles storage and organization of frames. All release timing
 * decisions are delegated to the configured ReleasePolicy.
 *
 * @typeParam T - Frame data type (e.g., VideoBufferData, AudioBufferData)
 *
 * @example
 * ```typescript
 * // Create buffer with VOD policy
 * const buffer = new PlayoutBuffer(new VodReleasePolicy());
 *
 * // Add frames as they arrive
 * buffer.addFrame({
 *   groupId: 10,
 *   objectId: 0,
 *   data: frameData,
 *   isKeyframe: true,
 * });
 *
 * // Get ready frames (policy decides what's ready)
 * const frames = buffer.getReadyFrames();
 * for (const frame of frames) {
 *   decoder.decode(frame.data);
 * }
 * ```
 */
export class PlayoutBuffer<T> {
  private groups: Map<number, GroupState<T>> = new Map();
  private activeGroupId = -1;
  private policy: ReleasePolicy<T>;
  private config: PlayoutBufferConfig;
  private stats: PlayoutBufferStats;

  constructor(
    policy: ReleasePolicy<T>,
    config: Partial<PlayoutBufferConfig> = {}
  ) {
    this.policy = policy;
    this.config = { ...DEFAULT_BUFFER_CONFIG, ...config };
    this.stats = this.createInitialStats();

    // Initialize policy with buffer reference
    this.policy.initialize(this);
  }

  /**
   * Debug log helper
   */
  private log(msg: string, data?: Record<string, unknown>): void {
    if (!this.config.debug) return;

    const prefix = `[PlayoutBuffer:${this.policy.name}]`;
    if (this.config.debugLogCallback) {
      this.config.debugLogCallback(`${prefix} ${msg}`, data);
    } else if (data) {
      console.log(prefix, msg, data);
    } else {
      console.log(prefix, msg);
    }
  }

  /**
   * Add a frame to the buffer
   *
   * @param input - Frame input with groupId, objectId, data, etc.
   * @returns true if frame was accepted, false if dropped
   */
  addFrame(input: FrameInput<T>): boolean {
    const { groupId, objectId, data, isKeyframe, locTimestamp, locTimescale, isDiscardable } = input;

    this.stats.framesReceived++;

    // Get or create group
    let group = this.groups.get(groupId);
    if (!group) {
      group = this.createGroup(groupId);
      this.groups.set(groupId, group);
      this.stats.groupsReceived++;
      this.log('NEW GROUP', { groupId, activeGroupId: this.activeGroupId, isKeyframe });
      this.pruneOldGroups();
    }

    // Don't accept frames for terminal groups
    if (group.status === 'complete' || group.status === 'skipped') {
      this.stats.framesDropped++;
      return false;
    }

    // Check frame limit
    if (group.frameCount >= this.config.maxFramesPerGroup) {
      this.stats.framesDropped++;
      return false;
    }

    // Create frame entry
    const frameEntry: FrameEntry<T> = {
      data,
      groupId,
      objectId,
      isKeyframe,
      receivedAt: performance.now(),
      locTimestamp,
      locTimescale,
      isDiscardable: isDiscardable ?? false,
      shouldRender: true,
    };

    // Store frame
    group.frames.set(objectId, frameEntry);
    group.frameCount++;
    group.highestObjectId = Math.max(group.highestObjectId, objectId);

    if (isKeyframe && objectId === 0) {
      group.hasKeyframe = true;
    }

    // Activate first group
    if (this.activeGroupId < 0) {
      this.activeGroupId = groupId;
      group.status = 'active';
    }

    // Notify policy of new frame
    this.policy.onFrameAdded(frameEntry, group);

    return true;
  }

  /**
   * Mark a group as complete (END_OF_GROUP received)
   */
  markGroupComplete(groupId: number): void {
    const group = this.groups.get(groupId);
    if (!group) return;

    group.endOfGroupReceived = true;
    this.log('GROUP MARKED COMPLETE', {
      groupId,
      framesRemaining: group.frames.size,
      outputObjectId: group.outputObjectId,
    });

    // Notify policy
    this.policy.onEndOfGroup(groupId, group);
  }

  /**
   * Skip a group that is unavailable (e.g., relay doesn't have it).
   * Creates a dummy group entry and immediately marks it complete so the
   * sequential release policy advances past it.
   */
  skipGroup(groupId: number): void {
    if (!this.groups.has(groupId)) {
      // Create a minimal group entry
      this.groups.set(groupId, {
        groupId,
        frames: new Map(),
        firstFrameReceivedAt: performance.now(),
        hasKeyframe: true, // pretend it has a keyframe so policy can activate it
        highestObjectId: -1,
        outputObjectId: 0,
        frameCount: 0,
        endOfGroupReceived: true,
        status: 'receiving',
      });
    }
    // Mark it complete immediately
    this.markGroupComplete(groupId);
  }

  /**
   * Get frames ready for output
   *
   * Delegates to the release policy to determine which frames are ready.
   *
   * @param maxFrames - Maximum frames to return (default: 5)
   * @returns Array of frames ready for decoding
   */
  getReadyFrames(maxFrames = 5): FrameEntry<T>[] {
    const frames = this.policy.getReadyFrames(maxFrames);
    this.stats.framesOutput += frames.length;
    return frames;
  }

  /**
   * Periodic tick for policy to check deadlines/timeouts
   *
   * Call this regularly (e.g., every frame or on a timer) to allow
   * policies with time-based logic to update state.
   */
  tick(): void {
    this.policy.tick(performance.now());
  }

  // ============================================================
  // Accessors for ReleasePolicy to query and modify buffer state
  // ============================================================

  /** Get current active group ID */
  getActiveGroupId(): number {
    return this.activeGroupId;
  }

  /** Set active group ID (used by policy during group transitions) */
  setActiveGroupId(groupId: number): void {
    this.activeGroupId = groupId;
    this.stats.activeGroupId = groupId;
  }

  /** Get a specific group's state */
  getGroup(groupId: number): GroupState<T> | undefined {
    return this.groups.get(groupId);
  }

  /** Get all groups (for policy iteration) */
  getAllGroups(): Map<number, GroupState<T>> {
    return this.groups;
  }

  /** Get number of tracked groups */
  getGroupCount(): number {
    return this.groups.size;
  }

  /** Get all group IDs currently in buffer */
  getGroupIds(): number[] {
    return Array.from(this.groups.keys()).sort((a, b) => a - b);
  }

  /**
   * Find next group after the given groupId that has a keyframe
   * Handles gaps in groupId sequence (parallel QUIC streams)
   */
  findNextKeyframeGroup(afterGroupId: number): GroupState<T> | null {
    let candidate: GroupState<T> | null = null;
    let candidateId = Infinity;

    for (const [groupId, group] of this.groups) {
      if (
        groupId > afterGroupId &&
        groupId < candidateId &&
        group.hasKeyframe &&
        (group.status === 'receiving' || group.status === 'active')
      ) {
        candidate = group;
        candidateId = groupId;
      }
    }

    return candidate;
  }

  /**
   * Complete a group and update stats
   */
  completeGroup(groupId: number, reason: 'finished' | 'skipped'): void {
    const group = this.groups.get(groupId);
    if (!group) return;

    if (reason === 'skipped') {
      group.status = 'skipped';
      this.stats.groupsSkipped++;
    } else {
      group.status = 'complete';
      this.stats.groupsCompleted++;
    }

    this.log('GROUP COMPLETED', { groupId, reason });
  }

  /** Get buffer statistics */
  getStats(): PlayoutBufferStats {
    return {
      ...this.stats,
      activeGroupCount: this.groups.size,
      activeGroupId: this.activeGroupId,
    };
  }

  /** Get combined stats (buffer + policy) */
  getCombinedStats(): PlayoutBufferStats & ReleasePolicyStats {
    return {
      ...this.getStats(),
      ...this.policy.getStats(),
    };
  }

  /** Get the current release policy */
  getPolicy(): ReleasePolicy<T> {
    return this.policy;
  }

  /** Get policy name */
  getPolicyName(): string {
    return this.policy.name;
  }

  /** Reset the buffer */
  reset(): void {
    this.groups.clear();
    this.activeGroupId = -1;
    this.stats = this.createInitialStats();
    this.policy.reset();
  }

  // ============================================================
  // Private helpers
  // ============================================================

  private createGroup(groupId: number): GroupState<T> {
    return {
      groupId,
      frames: new Map(),
      firstFrameReceivedAt: performance.now(),
      hasKeyframe: false,
      highestObjectId: -1,
      outputObjectId: -1,
      frameCount: 0,
      endOfGroupReceived: false,
      status: 'receiving',
    };
  }

  private pruneOldGroups(): void {
    if (this.groups.size <= this.config.maxGroups) return;

    // Remove oldest completed/skipped groups
    const sortedGroups = [...this.groups.entries()].sort(([a], [b]) => a - b);

    for (const [groupId, group] of sortedGroups) {
      if (this.groups.size <= this.config.maxGroups) break;

      if (group.status === 'complete' || group.status === 'skipped') {
        this.groups.delete(groupId);
      }
    }
  }

  private createInitialStats(): PlayoutBufferStats {
    return {
      framesReceived: 0,
      framesOutput: 0,
      framesDropped: 0,
      groupsReceived: 0,
      groupsCompleted: 0,
      groupsSkipped: 0,
      activeGroupCount: 0,
      activeGroupId: -1,
    };
  }
}
