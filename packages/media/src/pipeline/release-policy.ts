// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview ReleasePolicy - Strategy interface for frame release decisions
 *
 * ReleasePolicy defines when frames should be released from the PlayoutBuffer.
 * Different implementations support different playback scenarios:
 *
 * - VodReleasePolicy: Sequential playback, no skipping, wait for complete GOPs
 * - LiveReleasePolicy: Deadline-based, jitter buffer, skip stale groups
 * - InteractiveReleasePolicy: Aggressive skipping, minimal latency
 *
 * The policy is given full access to the buffer state to make decisions,
 * but all storage operations go through the buffer.
 */

import type { PlayoutBuffer, FrameEntry, GroupState } from './playout-buffer.js';

/**
 * Policy-specific statistics
 */
export interface ReleasePolicyStats {
  /** Policy name */
  policyName: string;

  /** Policy-specific metrics (varies by implementation) */
  [key: string]: string | number | boolean;
}

/**
 * ReleasePolicy interface
 *
 * Implementations decide when frames are ready for output and
 * how to handle group transitions, deadlines, and catch-up scenarios.
 *
 * @typeParam T - Frame data type
 */
export interface ReleasePolicy<T> {
  /**
   * Policy identifier for logging and debugging
   */
  readonly name: string;

  /**
   * Initialize the policy with a reference to the buffer
   *
   * Called once when the policy is attached to a buffer.
   * Store the reference for later use in other methods.
   *
   * @param buffer - The PlayoutBuffer this policy controls
   */
  initialize(buffer: PlayoutBuffer<T>): void;

  /**
   * Called when a new frame is added to the buffer
   *
   * Policy can update internal state based on frame arrival.
   * Examples: update deadline calculations, detect skip conditions.
   *
   * @param frame - The newly added frame
   * @param group - The group the frame belongs to
   */
  onFrameAdded(frame: FrameEntry<T>, group: GroupState<T>): void;

  /**
   * Called when END_OF_GROUP signal is received
   *
   * Policy should handle group completion logic.
   *
   * @param groupId - The group that received END_OF_GROUP
   * @param group - The group state
   */
  onEndOfGroup(groupId: number, group: GroupState<T>): void;

  /**
   * Get frames ready for output
   *
   * This is the core decision method. The policy examines buffer state
   * and returns frames that should be decoded now.
   *
   * Frames returned are removed from the buffer by the caller.
   *
   * @param maxFrames - Maximum frames to return
   * @returns Array of frames ready for decoding
   */
  getReadyFrames(maxFrames: number): FrameEntry<T>[];

  /**
   * Periodic tick for time-based logic
   *
   * Called regularly to allow policies to check deadlines,
   * trigger catch-up mode, or perform other time-based operations.
   *
   * For VOD, this is typically a no-op.
   *
   * @param nowMs - Current time (performance.now())
   */
  tick(nowMs: number): void;

  /**
   * Get policy-specific statistics
   */
  getStats(): ReleasePolicyStats;

  /**
   * Reset policy state
   *
   * Called when the buffer is reset.
   */
  reset(): void;

  /**
   * Pause frame release (optional - for VOD)
   *
   * When paused, getReadyFrames() should return empty array.
   */
  pause?(): void;

  /**
   * Resume frame release (optional - for VOD)
   */
  resume?(): void;

  /**
   * Check if frame release is paused (optional)
   */
  isPaused?(): boolean;
}

/**
 * Base class for release policies with common utilities
 *
 * Provides shared functionality that most policies need.
 * Concrete policies extend this class.
 */
export abstract class BaseReleasePolicy<T> implements ReleasePolicy<T> {
  abstract readonly name: string;

  protected buffer!: PlayoutBuffer<T>;
  protected debug = false;
  protected debugLogCallback?: (message: string, data?: Record<string, unknown>) => void;
  protected paused = false;

  /**
   * Configure debug logging
   */
  setDebug(enabled: boolean, callback?: (msg: string, data?: Record<string, unknown>) => void): void {
    this.debug = enabled;
    this.debugLogCallback = callback;
  }

  /**
   * Debug log helper
   */
  protected log(msg: string, data?: Record<string, unknown>): void {
    if (!this.debug) return;

    const prefix = `[${this.name}]`;
    if (this.debugLogCallback) {
      this.debugLogCallback(`${prefix} ${msg}`, data);
    } else if (data) {
      console.log(prefix, msg, data);
    } else {
      console.log(prefix, msg);
    }
  }

  initialize(buffer: PlayoutBuffer<T>): void {
    this.buffer = buffer;
  }

  /**
   * Pause frame release
   */
  pause(): void {
    this.paused = true;
    this.log('PAUSED');
  }

  /**
   * Resume frame release
   */
  resume(): void {
    this.paused = false;
    this.log('RESUMED');
  }

  /**
   * Check if paused
   */
  isPaused(): boolean {
    return this.paused;
  }

  abstract onFrameAdded(frame: FrameEntry<T>, group: GroupState<T>): void;
  abstract onEndOfGroup(groupId: number, group: GroupState<T>): void;
  abstract getReadyFrames(maxFrames: number): FrameEntry<T>[];
  abstract tick(nowMs: number): void;
  abstract getStats(): ReleasePolicyStats;
  abstract reset(): void;

  /**
   * Utility: Promote to next group with keyframe
   *
   * Common operation used by multiple policies.
   */
  protected promoteToNextGroup(): boolean {
    const currentGroupId = this.buffer.getActiveGroupId();
    const nextGroup = this.buffer.findNextKeyframeGroup(currentGroupId);

    if (nextGroup) {
      this.buffer.setActiveGroupId(nextGroup.groupId);
      nextGroup.status = 'active';
      this.log('PROMOTED TO NEXT GROUP', {
        from: currentGroupId,
        to: nextGroup.groupId,
      });
      return true;
    }

    return false;
  }

  /**
   * Utility: Output sequential frames from a group
   *
   * Common pattern: output frames in order starting from outputObjectId.
   * Stops at first gap or when maxFrames reached.
   *
   * @returns Array of frames that were ready
   */
  protected outputSequentialFrames(
    group: GroupState<T>,
    maxFrames: number,
    checkReady?: (frame: FrameEntry<T>) => boolean
  ): FrameEntry<T>[] {
    const result: FrameEntry<T>[] = [];
    const startObjectId = group.outputObjectId < 0 ? 0 : group.outputObjectId;

    for (
      let objId = startObjectId;
      objId <= group.highestObjectId && result.length < maxFrames;
      objId++
    ) {
      const frame = group.frames.get(objId);

      if (!frame) {
        // Gap - stop here
        break;
      }

      // Optional ready check (e.g., jitter delay)
      if (checkReady && !checkReady(frame)) {
        break;
      }

      result.push(frame);
      group.frames.delete(objId);
      group.outputObjectId = objId + 1;
    }

    return result;
  }
}
