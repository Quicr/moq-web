// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Jitter Buffer for Media Decoding
 *
 * Provides a jitter buffer to handle out-of-order and delayed packets
 * for smooth media decoding. Reorders frames by sequence number (decode order)
 * and manages buffer timing based on arrival time.
 *
 * @example
 * ```typescript
 * import { JitterBuffer } from '@web-moq/media';
 *
 * const buffer = new JitterBuffer({
 *   targetDelay: 100,  // 100ms buffer
 *   maxDelay: 500,     // Max 500ms delay
 * });
 *
 * // Add received frames
 * buffer.push(frame);
 *
 * // Get frames ready for playback
 * const readyFrames = buffer.getReadyFrames();
 * for (const frame of readyFrames) {
 *   playFrame(frame);
 * }
 * ```
 */

import { Logger } from '@web-moq/core';

const log = Logger.create('moqt:media:jitter-buffer');

/**
 * Buffered frame
 */
export interface BufferedFrame<T> {
  /** The frame data */
  data: T;
  /** Presentation timestamp in milliseconds */
  timestamp: number;
  /** Sequence number */
  sequence: number;
  /** Group ID */
  groupId: number;
  /** Object ID */
  objectId: number;
  /** Whether this is a keyframe */
  isKeyframe: boolean;
  /** Time when frame was received */
  receivedAt: number;
}

/**
 * Jitter buffer configuration
 */
export interface JitterBufferConfig {
  /** Target buffer delay in ms (default: 100) */
  targetDelay?: number;
  /** Maximum buffer delay in ms (default: 500) */
  maxDelay?: number;
  /** Maximum number of frames to buffer (default: 100) */
  maxFrames?: number;
  /** Maximum frames to return per getReadyFrames call (default: 2) - for pacing */
  maxFramesPerCall?: number;
  /** Callback when frame is too late */
  onLateFrame?: (frame: BufferedFrame<unknown>) => void;
}

/**
 * Jitter Buffer Statistics
 */
export interface JitterBufferStats {
  /** Current buffer size */
  bufferSize: number;
  /** Current buffer delay in ms */
  bufferDelay: number;
  /** Total frames received */
  framesReceived: number;
  /** Total frames played */
  framesPlayed: number;
  /** Frames dropped (late) */
  framesDropped: number;
  /** Frames reordered */
  framesReordered: number;
}

/**
 * Jitter Buffer for Media Playback
 *
 * @remarks
 * Buffers incoming media frames to handle network jitter and
 * out-of-order delivery. Frames are reordered by sequence number
 * (decode order) and released for decoding after a configurable delay.
 *
 * @typeParam T - Type of frame data
 *
 * @example
 * ```typescript
 * const buffer = new JitterBuffer<VideoFrame>({
 *   targetDelay: 150,
 *   maxDelay: 500,
 *   onLateFrame: (frame) => console.warn('Late frame dropped'),
 * });
 *
 * // Receive loop
 * transport.on('frame', (data) => {
 *   buffer.push({
 *     data: data.payload,
 *     timestamp: data.timestamp,
 *     sequence: data.objectId,
 *     groupId: data.groupId,
 *     objectId: data.objectId,
 *     isKeyframe: data.objectId === 0,
 *     receivedAt: performance.now(),
 *   });
 * });
 *
 * // Playback loop
 * setInterval(() => {
 *   const frames = buffer.getReadyFrames();
 *   for (const frame of frames) {
 *     renderFrame(frame.data);
 *   }
 * }, 1000 / 60);
 * ```
 */
export class JitterBuffer<T> {
  /** Configuration */
  private config: Required<JitterBufferConfig>;
  /** Buffered frames sorted by sequence (decode order) */
  private frames: BufferedFrame<T>[] = [];
  /** Playback start time */
  private playbackStartTime?: number;
  /** First frame timestamp */
  private firstTimestamp?: number;
  /** Statistics */
  private stats: JitterBufferStats = {
    bufferSize: 0,
    bufferDelay: 0,
    framesReceived: 0,
    framesPlayed: 0,
    framesDropped: 0,
    framesReordered: 0,
  };
  /** Last played sequence (for decode order tracking) */
  private lastPlayedSequence = -1;

  /**
   * Create a new JitterBuffer
   *
   * @param config - Buffer configuration
   */
  constructor(config: JitterBufferConfig = {}) {
    this.config = {
      targetDelay: config.targetDelay ?? 100,
      maxDelay: config.maxDelay ?? 500,
      maxFrames: config.maxFrames ?? 100,
      maxFramesPerCall: config.maxFramesPerCall ?? 2,
      onLateFrame: config.onLateFrame ?? (() => {}),
    };

    log.debug('JitterBuffer created', {
      targetDelay: this.config.targetDelay,
      maxDelay: this.config.maxDelay,
    });
  }

  /**
   * Push a frame into the buffer
   *
   * @param frame - Frame to buffer
   * @returns True if frame was accepted
   */
  push(frame: BufferedFrame<T>): boolean {
    this.stats.framesReceived++;

    // Initialize on first frame
    if (this.firstTimestamp === undefined) {
      this.firstTimestamp = frame.timestamp;
      this.playbackStartTime = performance.now() + this.config.targetDelay;
      log.debug(`Buffer init: firstTs=${Math.round(frame.timestamp)} targetDelay=${this.config.targetDelay}`);
    }

    // Check if frame is already played (by sequence - decode order)
    if (frame.sequence <= this.lastPlayedSequence) {
      log.debug('Dropping LATE frame (already past this sequence)', {
        groupId: frame.groupId,
        objectId: frame.objectId,
        sequence: frame.sequence,
        lastPlayedSequence: this.lastPlayedSequence,
        isKeyframe: frame.isKeyframe,
      });
      this.stats.framesDropped++;
      this.config.onLateFrame(frame);
      return false;
    }

    // Check buffer limit
    if (this.frames.length >= this.config.maxFrames) {
      // Drop oldest non-keyframe
      const dropIndex = this.frames.findIndex(f => !f.isKeyframe);
      if (dropIndex >= 0) {
        const dropped = this.frames[dropIndex];
        log.warn('Buffer OVERFLOW - dropping non-keyframe', {
          droppedGroupId: dropped.groupId,
          droppedObjectId: dropped.objectId,
          bufferSize: this.frames.length,
          maxFrames: this.config.maxFrames,
        });
        this.frames.splice(dropIndex, 1);
        this.stats.framesDropped++;
      } else {
        // All keyframes - drop oldest
        const dropped = this.frames[0];
        log.warn('Buffer OVERFLOW - dropping oldest keyframe', {
          droppedGroupId: dropped?.groupId,
          droppedObjectId: dropped?.objectId,
          bufferSize: this.frames.length,
        });
        this.frames.shift();
        this.stats.framesDropped++;
      }
    }

    // Insert in sorted order by sequence (decode order)
    const insertIndex = this.findInsertIndex(frame.timestamp, frame.sequence);
    this.frames.splice(insertIndex, 0, frame);

    // Check if frame was reordered
    if (insertIndex < this.frames.length - 1) {
      this.stats.framesReordered++;
    }

    this.stats.bufferSize = this.frames.length;
    this.updateBufferDelay();

    // Debug: Log every frame push to track buffering
    log.debug(`Frame pushed: g${frame.groupId}/o${frame.objectId} seq=${frame.sequence} ts=${Math.round(frame.timestamp)} buf=${this.frames.length} kf=${frame.isKeyframe}`);

    return true;
  }

  /**
   * Get frames that are ready for decoding
   *
   * @returns Array of frames ready to decode (limited by maxFramesPerCall for pacing)
   * @remarks Releases frames in sequence order (decode order), based on arrival time + targetDelay
   */
  getReadyFrames(): BufferedFrame<T>[] {
    const now = performance.now();
    const ready: BufferedFrame<T>[] = [];
    const maxFrames = this.config.maxFramesPerCall;

    // Debug: Log buffer state periodically
    if (this.frames.length > 0 && this.stats.framesPlayed % 30 === 0) {
      const firstFrame = this.frames[0];
      const releaseTime = firstFrame.receivedAt + this.config.targetDelay;
      const waitingMs = Math.round(releaseTime - now);
      log.debug(`Buffer state: size=${this.frames.length} g${firstFrame.groupId}/o${firstFrame.objectId} seq=${firstFrame.sequence} waitMs=${waitingMs} played=${this.stats.framesPlayed}`);
    }

    while (this.frames.length > 0 && ready.length < maxFrames) {
      const frame = this.frames[0];
      // Release based on arrival time + targetDelay (not presentation timestamp)
      // This ensures frames are decoded in sequence order with proper buffering
      const releaseTime = frame.receivedAt + this.config.targetDelay;

      if (releaseTime <= now) {
        this.frames.shift();
        ready.push(frame);
        this.lastPlayedSequence = frame.sequence;
        this.stats.framesPlayed++;
      } else {
        // Log when frames are waiting (first time per batch only)
        if (ready.length === 0 && this.stats.framesReceived % 10 === 0) {
          const waitMs = Math.round(releaseTime - now);
          log.debug(`Frame waiting: g${frame.groupId}/o${frame.objectId} seq=${frame.sequence} waitMs=${waitMs}`);
        }
        break;
      }
    }

    this.stats.bufferSize = this.frames.length;
    this.updateBufferDelay();

    return ready;
  }

  /**
   * Peek at the next frame without removing it
   *
   * @returns Next frame or undefined
   */
  peek(): BufferedFrame<T> | undefined {
    return this.frames[0];
  }

  /**
   * Get time until next frame is ready
   *
   * @returns Milliseconds until next frame, or -1 if buffer empty
   */
  getTimeUntilNextFrame(): number {
    if (this.frames.length === 0) return -1;

    const frame = this.frames[0];
    const playbackTime = this.getPlaybackTime(frame.timestamp);
    return Math.max(0, playbackTime - performance.now());
  }

  /**
   * Calculate playback time for a timestamp
   */
  private getPlaybackTime(timestamp: number): number {
    if (this.playbackStartTime === undefined || this.firstTimestamp === undefined) {
      return performance.now();
    }
    return this.playbackStartTime + (timestamp - this.firstTimestamp);
  }

  /**
   * Find insertion index for sorted order by sequence
   * Sorts by sequence for correct H.264 decode order (not presentation order)
   */
  private findInsertIndex(_timestamp: number, sequence: number): number {
    let low = 0;
    let high = this.frames.length;

    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (this.frames[mid].sequence < sequence) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }

    return low;
  }

  /**
   * Update buffer delay statistic
   */
  private updateBufferDelay(): void {
    if (this.frames.length === 0) {
      this.stats.bufferDelay = 0;
      return;
    }

    const oldestFrame = this.frames[0];
    const playbackTime = this.getPlaybackTime(oldestFrame.timestamp);
    this.stats.bufferDelay = Math.max(0, playbackTime - performance.now());
  }

  /**
   * Reset the buffer
   */
  reset(): void {
    this.frames = [];
    this.playbackStartTime = undefined;
    this.firstTimestamp = undefined;
    this.lastPlayedSequence = -1;

    log.debug('JitterBuffer reset');
  }

  /**
   * Flush all frames
   *
   * @returns All buffered frames
   */
  flush(): BufferedFrame<T>[] {
    const frames = this.frames;
    this.frames = [];
    this.stats.bufferSize = 0;
    this.stats.framesPlayed += frames.length;
    return frames;
  }

  /**
   * Skip to a specific group (for seeking)
   *
   * @param groupId - Target group ID
   * @returns True if seek was successful
   */
  seekToGroup(groupId: number): boolean {
    // Find first keyframe at or after target group
    const keyframeIndex = this.frames.findIndex(
      f => f.groupId >= groupId && f.isKeyframe
    );

    if (keyframeIndex < 0) {
      log.warn('No keyframe found for seek', { targetGroup: groupId });
      return false;
    }

    // Drop frames before keyframe
    const dropped = this.frames.splice(0, keyframeIndex);
    this.stats.framesDropped += dropped.length;

    // Update last played state (by sequence for decode order)
    if (dropped.length > 0) {
      const lastDropped = dropped[dropped.length - 1];
      this.lastPlayedSequence = lastDropped.sequence;
    }

    this.stats.bufferSize = this.frames.length;
    log.debug('Seeked to group', { groupId, dropped: dropped.length });

    return true;
  }

  /**
   * Adjust target delay
   *
   * @param delay - New target delay in ms
   */
  setTargetDelay(delay: number): void {
    this.config.targetDelay = delay;
    log.debug('Target delay updated', { delay });
  }

  /**
   * Get buffer statistics
   *
   * @returns Statistics object
   */
  getStats(): JitterBufferStats {
    return { ...this.stats };
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    this.stats = {
      bufferSize: this.frames.length,
      bufferDelay: this.stats.bufferDelay,
      framesReceived: 0,
      framesPlayed: 0,
      framesDropped: 0,
      framesReordered: 0,
    };
  }

  /**
   * Check if buffer has a keyframe
   */
  hasKeyframe(): boolean {
    return this.frames.some(f => f.isKeyframe);
  }

  /**
   * Get current buffer size
   */
  get size(): number {
    return this.frames.length;
  }

  /**
   * Check if buffer is empty
   */
  get isEmpty(): boolean {
    return this.frames.length === 0;
  }

  /**
   * Get current buffer delay
   */
  get delay(): number {
    return this.stats.bufferDelay;
  }
}
