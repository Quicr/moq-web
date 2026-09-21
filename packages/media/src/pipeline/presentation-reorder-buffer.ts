// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Presentation Reorder Buffer
 *
 * Reorders decoded VideoFrames from decode order (DTS) to presentation order (PTS).
 *
 * WebCodecs VideoDecoder outputs frames in decode order, but B-frames have
 * different decode and presentation times. This buffer collects frames and
 * releases them sorted by presentation timestamp (frame.timestamp).
 *
 * For VOD content with B-frames, this is essential for smooth playback.
 * For live/interactive content without B-frames, this is a passthrough.
 */

/**
 * Configuration for the reorder buffer
 */
export interface PresentationReorderBufferConfig {
  /**
   * Number of frames to buffer before releasing.
   * Should be at least the B-frame depth (typically 2-4 for most encoders).
   * Default: 4
   */
  bufferDepth: number;

  /**
   * Maximum time to hold a frame before force-releasing (ms).
   * Prevents indefinite buffering if frames stop arriving.
   * Default: 200ms
   */
  maxHoldTimeMs: number;

  /**
   * Enable debug logging
   */
  debug: boolean;
}

const DEFAULT_CONFIG: PresentationReorderBufferConfig = {
  bufferDepth: 4,
  maxHoldTimeMs: 200,
  debug: false,
};

interface BufferedFrame {
  frame: VideoFrame;
  timestamp: number;
  receivedAt: number;
}

/**
 * Reorder buffer that sorts decoded frames by presentation timestamp
 */
export class PresentationReorderBuffer {
  private config: PresentationReorderBufferConfig;
  private buffer: BufferedFrame[] = [];
  private lastReleasedTimestamp = -1;
  private onFrame: (frame: VideoFrame) => void;

  constructor(
    onFrame: (frame: VideoFrame) => void,
    config: Partial<PresentationReorderBufferConfig> = {}
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.onFrame = onFrame;
  }

  /**
   * Update the buffer depth dynamically (e.g., from parsed SPS max_num_reorder_frames)
   */
  setBufferDepth(depth: number): void {
    this.config.bufferDepth = depth;
  }

  /**
   * Add a decoded frame to the buffer.
   *
   * The buffer is kept sorted by presentation timestamp using a binary-search
   * insert (O(log n) compare + O(n) memmove), replacing a previous full sort
   * (O(n log n)) on every push. For the typical 4-8 frame reorder window this
   * is a hot path — VideoDecoder invokes the output callback at frame rate.
   */
  push(frame: VideoFrame): void {
    const timestamp = frame.timestamp;
    const now = performance.now();

    const entry: BufferedFrame = { frame, timestamp, receivedAt: now };
    const insertAt = this.findInsertionIndex(timestamp);
    if (insertAt === this.buffer.length) {
      this.buffer.push(entry);
    } else {
      this.buffer.splice(insertAt, 0, entry);
    }

    if (this.config.debug) {
      console.log('[ReorderBuffer] push', {
        ts: timestamp,
        bufferSize: this.buffer.length,
        bufferTs: this.buffer.map(f => f.timestamp),
      });
    }

    // Release frames that are ready
    this.releaseReadyFrames(now);
  }

  /**
   * Binary search for the first index whose timestamp is greater than the
   * given value. Ties keep insertion FIFO (equal timestamps preserve arrival
   * order), matching the previous stable-sort behaviour for
   * equal-PTS frames.
   */
  private findInsertionIndex(timestamp: number): number {
    let lo = 0;
    let hi = this.buffer.length;
    while (lo < hi) {
      // Unsigned shift avoids overflow for large arrays.
      const mid = (lo + hi) >>> 1;
      if (this.buffer[mid].timestamp <= timestamp) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  /**
   * Release frames that are ready for presentation
   */
  private releaseReadyFrames(now: number): void {
    while (this.buffer.length > 0) {
      const oldest = this.buffer[0];

      // Release conditions:
      // 1. Buffer is full (enough frames to ensure ordering)
      // 2. Frame has been held too long (timeout)
      const bufferFull = this.buffer.length > this.config.bufferDepth;
      const heldTooLong = now - oldest.receivedAt > this.config.maxHoldTimeMs;

      if (!bufferFull && !heldTooLong) {
        break;
      }

      // Release the oldest frame (lowest timestamp)
      this.buffer.shift();

      // Skip if timestamp is behind what we've already released (shouldn't happen with proper sorting)
      if (oldest.timestamp < this.lastReleasedTimestamp) {
        if (this.config.debug) {
          console.warn('[ReorderBuffer] Dropping late frame', {
            ts: oldest.timestamp,
            lastReleased: this.lastReleasedTimestamp,
          });
        }
        try {
          oldest.frame.close();
        } catch {
          // Frame may already be closed
        }
        continue;
      }

      this.lastReleasedTimestamp = oldest.timestamp;

      if (this.config.debug) {
        console.log('[ReorderBuffer] release', {
          ts: oldest.timestamp,
          reason: bufferFull ? 'buffer_full' : 'timeout',
          remainingBuffer: this.buffer.length,
        });
      }

      this.onFrame(oldest.frame);
    }
  }

  /**
   * Flush all remaining frames in order
   */
  flush(): void {
    if (this.config.debug) {
      console.log('[ReorderBuffer] flush', { count: this.buffer.length });
    }

    // Buffer is maintained in sorted order on push(), so we can release in place.
    for (const { frame } of this.buffer) {
      this.onFrame(frame);
    }

    this.buffer = [];
  }

  /**
   * Reset the buffer state (e.g., on seek)
   */
  reset(): void {
    if (this.config.debug) {
      console.log('[ReorderBuffer] reset', { droppedFrames: this.buffer.length });
    }

    // Close all buffered frames
    for (const { frame } of this.buffer) {
      try {
        frame.close();
      } catch {
        // Frame may already be closed
      }
    }

    this.buffer = [];
    this.lastReleasedTimestamp = -1;
  }

  /**
   * Get current buffer size
   */
  get size(): number {
    return this.buffer.length;
  }
}
