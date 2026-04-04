// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Group Arbiter Types
 *
 * Type definitions for the group-aware deadline-based jitter buffer.
 * Handles out-of-order group delivery from parallel QUIC streams.
 */

/**
 * Status of a group in the arbiter
 */
export type GroupStatus =
  | 'receiving' // Actively receiving frames
  | 'active' // Currently being output
  | 'complete' // All frames output successfully
  | 'expired' // Deadline passed, frames dropped
  | 'skipped'; // Skipped to newer keyframe

/**
 * A single frame entry in a group
 */
export interface FrameEntry<T> {
  /** Frame data */
  data: T;

  /** Object ID within the group */
  objectId: number;

  /** Monotonic tick when frame was received */
  receivedTick: number;

  /** LOC timestamp if available (microseconds) */
  locTimestamp?: number;

  /** Whether this is a keyframe (objectId 0) */
  isKeyframe: boolean;

  /** Whether this frame is discardable (from LOC Video Frame Marking) */
  isDiscardable: boolean;
}

/**
 * State for a single group
 */
export interface GroupState<T> {
  /** Group ID from MOQT */
  groupId: number;

  /** Frames indexed by objectId (sparse) */
  frames: Map<number, FrameEntry<T>>;

  /** Monotonic tick when first frame arrived */
  firstFrameReceivedTick: number;

  /** LOC timestamp of first frame (microseconds, -1 if not available) */
  locTimestampBase: number;

  /** LOC timescale (units per second, default 1,000,000) */
  locTimescale: number;

  /** Deadline tick by which group must complete */
  deadlineTick: number;

  /** Whether we've received objectId 0 (keyframe) */
  hasKeyframe: boolean;

  /** Highest objectId received */
  highestObjectId: number;

  /** Next objectId to output (-1 if not started) */
  outputObjectId: number;

  /** Total frames received for this group */
  frameCount: number;

  /** Current status */
  status: GroupStatus;
}

/**
 * Statistics tracked by the arbiter
 */
export interface ArbiterStats {
  // Group-level stats
  /** Total groups seen */
  groupsReceived: number;

  /** Groups that completed successfully */
  groupsCompleted: number;

  /** Groups that expired (deadline passed) */
  groupsExpired: number;

  /** Groups skipped to reach a newer keyframe */
  groupsSkipped: number;

  /** Number of times deadlines were extended */
  deadlinesExtended: number;

  // Frame-level stats
  /** Total frames received */
  framesReceived: number;

  /** Total frames output to decoder */
  framesOutput: number;

  /** Frames dropped because their group already passed */
  droppedLateFrames: number;

  /** Frames skipped due to gaps under deadline pressure */
  skippedMissingFrames: number;

  // Timing stats
  /** Current estimated GOP duration (ms) */
  estimatedGopDuration: number;

  /** Average output latency (ms) */
  avgOutputLatency: number;

  /** Maximum observed output latency (ms) */
  maxOutputLatency: number;
}

/**
 * Configuration for timing behavior
 */
export interface TimingConfig {
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
}

/**
 * Default timing configuration
 */
export const DEFAULT_TIMING_CONFIG: TimingConfig = {
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
};

/**
 * Create a new empty group state
 */
export function createGroupState<T>(
  groupId: number,
  firstFrameReceivedTick: number,
  deadlineTick: number
): GroupState<T> {
  return {
    groupId,
    frames: new Map(),
    firstFrameReceivedTick,
    locTimestampBase: -1,
    locTimescale: 1_000_000,
    deadlineTick,
    hasKeyframe: false,
    highestObjectId: -1,
    outputObjectId: -1,
    frameCount: 0,
    status: 'receiving',
  };
}

/**
 * Create initial arbiter stats
 */
export function createArbiterStats(): ArbiterStats {
  return {
    groupsReceived: 0,
    groupsCompleted: 0,
    groupsExpired: 0,
    groupsSkipped: 0,
    deadlinesExtended: 0,
    framesReceived: 0,
    framesOutput: 0,
    droppedLateFrames: 0,
    skippedMissingFrames: 0,
    estimatedGopDuration: 0,
    avgOutputLatency: 0,
    maxOutputLatency: 0,
  };
}

/**
 * Input frame for the arbiter
 */
export interface ArbiterFrameInput<T> {
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
