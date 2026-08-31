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
   * Add a decoded frame to the buffer
   */
  push(frame: VideoFrame): void {
    const timestamp = frame.timestamp;
    const now = performance.now();

    // Add to buffer
    this.buffer.push({
      frame,
      timestamp,
      receivedAt: now,
    });

    // Sort by presentation timestamp
    this.buffer.sort((a, b) => a.timestamp - b.timestamp);

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

    // Sort and release all
    this.buffer.sort((a, b) => a.timestamp - b.timestamp);

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
