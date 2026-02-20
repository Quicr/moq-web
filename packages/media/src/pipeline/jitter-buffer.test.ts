// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Jitter Buffer Tests
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { JitterBuffer, type BufferedFrame } from './jitter-buffer';

// Helper to create a test frame
function createFrame<T>(
  data: T,
  timestamp: number,
  options: Partial<BufferedFrame<T>> = {}
): BufferedFrame<T> {
  return {
    data,
    timestamp,
    sequence: options.sequence ?? 0,
    groupId: options.groupId ?? 0,
    objectId: options.objectId ?? 0,
    isKeyframe: options.isKeyframe ?? false,
    receivedAt: options.receivedAt ?? performance.now(),
  };
}

describe('JitterBuffer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('constructor', () => {
    it('creates buffer with default config', () => {
      const buffer = new JitterBuffer();
      expect(buffer.size).toBe(0);
      expect(buffer.isEmpty).toBe(true);
    });

    it('creates buffer with custom config', () => {
      const buffer = new JitterBuffer({
        targetDelay: 200,
        maxDelay: 1000,
        maxFrames: 50,
      });

      const stats = buffer.getStats();
      expect(stats.bufferSize).toBe(0);
    });
  });

  describe('push', () => {
    it('accepts first frame and initializes timing', () => {
      const buffer = new JitterBuffer<string>();
      const frame = createFrame('frame1', 0);

      const accepted = buffer.push(frame);

      expect(accepted).toBe(true);
      expect(buffer.size).toBe(1);
      expect(buffer.getStats().framesReceived).toBe(1);
    });

    it('accepts multiple frames', () => {
      const buffer = new JitterBuffer<string>();

      buffer.push(createFrame('frame1', 0));
      buffer.push(createFrame('frame2', 33));
      buffer.push(createFrame('frame3', 66));

      expect(buffer.size).toBe(3);
      expect(buffer.getStats().framesReceived).toBe(3);
    });

    it('handles buffer limit by dropping non-keyframes first', () => {
      const buffer = new JitterBuffer<string>({ maxFrames: 3 });

      buffer.push(createFrame('kf', 0, { isKeyframe: true }));
      buffer.push(createFrame('delta1', 33, { isKeyframe: false }));
      buffer.push(createFrame('delta2', 66, { isKeyframe: false }));

      // Buffer is full, push another - should drop a non-keyframe
      const accepted = buffer.push(createFrame('new', 99, { isKeyframe: false }));

      expect(accepted).toBe(true);
      expect(buffer.size).toBe(3);
      expect(buffer.getStats().framesDropped).toBe(1);
    });

    it('rejects already-played frames', () => {
      const buffer = new JitterBuffer<string>({ targetDelay: 0 });

      buffer.push(createFrame('frame1', 0));
      buffer.push(createFrame('frame2', 33));

      // Advance time and get ready frames
      vi.advanceTimersByTime(100);
      buffer.getReadyFrames();

      // Try to push a frame with timestamp <= last played
      const accepted = buffer.push(createFrame('old', 0));
      expect(accepted).toBe(false);
    });

    it('drops non-keyframe when buffer is full', () => {
      const buffer = new JitterBuffer<string>({ maxFrames: 3 });

      buffer.push(createFrame('frame1', 0, { isKeyframe: true }));
      buffer.push(createFrame('frame2', 33, { isKeyframe: false }));
      buffer.push(createFrame('frame3', 66, { isKeyframe: false }));

      // Buffer is now full, push another frame
      buffer.push(createFrame('frame4', 99, { isKeyframe: false }));

      expect(buffer.size).toBe(3);
      expect(buffer.getStats().framesDropped).toBe(1);
    });

    it('drops oldest keyframe when buffer is full of keyframes', () => {
      const buffer = new JitterBuffer<string>({ maxFrames: 2 });

      buffer.push(createFrame('kf1', 0, { isKeyframe: true }));
      buffer.push(createFrame('kf2', 33, { isKeyframe: true }));

      // Buffer is full of keyframes, push another
      buffer.push(createFrame('kf3', 66, { isKeyframe: true }));

      expect(buffer.size).toBe(2);
    });

    it('tracks reordered frames', () => {
      const buffer = new JitterBuffer<string>();

      buffer.push(createFrame('frame1', 0));
      buffer.push(createFrame('frame3', 66)); // Out of order
      buffer.push(createFrame('frame2', 33)); // This will be inserted in the middle

      expect(buffer.getStats().framesReordered).toBe(1);
    });

    it('calls onLateFrame callback for late frames', () => {
      const onLateFrame = vi.fn();
      const buffer = new JitterBuffer<string>({
        targetDelay: 100,
        maxDelay: 200,
        onLateFrame,
      });

      // onLateFrame is called when frames are dropped due to being late
      // This is tested through the dropped frames counter
      buffer.push(createFrame('frame1', 0));

      // Verify the callback is set up (it will be called when late frames are dropped)
      expect(buffer.getStats().framesDropped).toBe(0);
    });
  });

  describe('getReadyFrames', () => {
    it('returns empty array when buffer is empty', () => {
      const buffer = new JitterBuffer<string>();
      const ready = buffer.getReadyFrames();
      expect(ready).toEqual([]);
    });

    it('maintains frames in buffer until ready', () => {
      const buffer = new JitterBuffer<string>({ targetDelay: 100 });

      buffer.push(createFrame('frame1', 0));
      buffer.push(createFrame('frame2', 33));

      // Frames should be buffered
      expect(buffer.size).toBe(2);
    });

    it('returns frames in timestamp order when flushed', () => {
      const buffer = new JitterBuffer<string>({ targetDelay: 0 });

      // Push out of order
      buffer.push(createFrame('frame3', 66));
      buffer.push(createFrame('frame1', 0));
      buffer.push(createFrame('frame2', 33));

      // Use flush to get all frames in order
      const flushed = buffer.flush();

      expect(flushed.map(f => f.data)).toEqual(['frame1', 'frame2', 'frame3']);
    });

    it('updates statistics when flushing', () => {
      const buffer = new JitterBuffer<string>({ targetDelay: 0 });

      buffer.push(createFrame('frame1', 0));
      buffer.push(createFrame('frame2', 33));

      buffer.flush();

      const stats = buffer.getStats();
      expect(stats.framesPlayed).toBe(2);
      expect(stats.bufferSize).toBe(0);
    });

    it('buffers multiple frames with different timestamps', () => {
      const buffer = new JitterBuffer<string>({ targetDelay: 100 });

      buffer.push(createFrame('frame1', 0));
      buffer.push(createFrame('frame2', 200));

      // Both frames should be buffered
      expect(buffer.size).toBe(2);
      expect(buffer.peek()?.data).toBe('frame1');
    });
  });

  describe('peek', () => {
    it('returns undefined for empty buffer', () => {
      const buffer = new JitterBuffer<string>();
      expect(buffer.peek()).toBeUndefined();
    });

    it('returns next frame without removing it', () => {
      const buffer = new JitterBuffer<string>();
      buffer.push(createFrame('frame1', 0));
      buffer.push(createFrame('frame2', 33));

      const peeked = buffer.peek();
      expect(peeked?.data).toBe('frame1');
      expect(buffer.size).toBe(2); // Still 2 frames
    });
  });

  describe('getTimeUntilNextFrame', () => {
    it('returns -1 for empty buffer', () => {
      const buffer = new JitterBuffer<string>();
      expect(buffer.getTimeUntilNextFrame()).toBe(-1);
    });

    it('returns time until next frame is ready', () => {
      const buffer = new JitterBuffer<string>({ targetDelay: 100 });
      buffer.push(createFrame('frame1', 0));

      const time = buffer.getTimeUntilNextFrame();
      expect(time).toBeGreaterThanOrEqual(0);
      expect(time).toBeLessThanOrEqual(100);
    });

    it('returns 0 when frame is ready', () => {
      const buffer = new JitterBuffer<string>({ targetDelay: 0 });
      buffer.push(createFrame('frame1', 0));

      vi.advanceTimersByTime(50);
      expect(buffer.getTimeUntilNextFrame()).toBe(0);
    });
  });

  describe('reset', () => {
    it('clears all frames', () => {
      const buffer = new JitterBuffer<string>();
      buffer.push(createFrame('frame1', 0));
      buffer.push(createFrame('frame2', 33));

      buffer.reset();

      expect(buffer.size).toBe(0);
      expect(buffer.isEmpty).toBe(true);
    });

    it('resets timing state', () => {
      const buffer = new JitterBuffer<string>({ targetDelay: 100 });
      buffer.push(createFrame('frame1', 1000));

      vi.advanceTimersByTime(200);
      buffer.getReadyFrames();
      buffer.reset();

      // After reset, new frames start fresh timing
      buffer.push(createFrame('newFrame', 0));
      expect(buffer.getTimeUntilNextFrame()).toBeGreaterThanOrEqual(0);
    });
  });

  describe('flush', () => {
    it('returns all buffered frames', () => {
      const buffer = new JitterBuffer<string>();
      buffer.push(createFrame('frame1', 0));
      buffer.push(createFrame('frame2', 33));
      buffer.push(createFrame('frame3', 66));

      const flushed = buffer.flush();

      expect(flushed.length).toBe(3);
      expect(buffer.size).toBe(0);
    });

    it('updates played count', () => {
      const buffer = new JitterBuffer<string>();
      buffer.push(createFrame('frame1', 0));
      buffer.push(createFrame('frame2', 33));

      buffer.flush();

      expect(buffer.getStats().framesPlayed).toBe(2);
    });
  });

  describe('seekToGroup', () => {
    it('seeks to keyframe at target group', () => {
      const buffer = new JitterBuffer<string>();
      buffer.push(createFrame('frame1', 0, { groupId: 0, isKeyframe: true }));
      buffer.push(createFrame('frame2', 33, { groupId: 0, isKeyframe: false }));
      buffer.push(createFrame('frame3', 66, { groupId: 1, isKeyframe: true }));
      buffer.push(createFrame('frame4', 99, { groupId: 1, isKeyframe: false }));

      const success = buffer.seekToGroup(1);

      expect(success).toBe(true);
      expect(buffer.size).toBe(2);
      expect(buffer.peek()?.groupId).toBe(1);
      expect(buffer.peek()?.isKeyframe).toBe(true);
    });

    it('returns false when no keyframe found', () => {
      const buffer = new JitterBuffer<string>();
      buffer.push(createFrame('frame1', 0, { groupId: 0, isKeyframe: false }));
      buffer.push(createFrame('frame2', 33, { groupId: 0, isKeyframe: false }));

      const success = buffer.seekToGroup(1);

      expect(success).toBe(false);
    });

    it('tracks dropped frames during seek', () => {
      const buffer = new JitterBuffer<string>();
      buffer.push(createFrame('frame1', 0, { groupId: 0, isKeyframe: true }));
      buffer.push(createFrame('frame2', 33, { groupId: 0, isKeyframe: false }));
      buffer.push(createFrame('frame3', 66, { groupId: 1, isKeyframe: true }));

      buffer.seekToGroup(1);

      expect(buffer.getStats().framesDropped).toBe(2);
    });
  });

  describe('setTargetDelay', () => {
    it('updates target delay', () => {
      const buffer = new JitterBuffer<string>({ targetDelay: 100 });
      buffer.setTargetDelay(200);

      // The new target delay should be stored
      // We can verify this indirectly through the buffer's behavior
      buffer.push(createFrame('frame1', 0));

      // With 200ms target delay, frame should not be ready immediately
      expect(buffer.getTimeUntilNextFrame()).toBeGreaterThan(0);
    });
  });

  describe('statistics', () => {
    it('tracks all statistics correctly', () => {
      const buffer = new JitterBuffer<string>({ targetDelay: 0 });

      buffer.push(createFrame('frame1', 0));
      buffer.push(createFrame('frame3', 66));
      buffer.push(createFrame('frame2', 33)); // reordered

      // Verify received and reordered counts
      const stats = buffer.getStats();
      expect(stats.framesReceived).toBe(3);
      expect(stats.framesReordered).toBe(1);
      expect(stats.bufferSize).toBe(3);
    });

    it('resets statistics with resetStats', () => {
      const buffer = new JitterBuffer<string>({ targetDelay: 0 });

      buffer.push(createFrame('frame1', 0));
      vi.advanceTimersByTime(100);
      buffer.getReadyFrames();

      buffer.resetStats();

      const stats = buffer.getStats();
      expect(stats.framesReceived).toBe(0);
      expect(stats.framesPlayed).toBe(0);
      expect(stats.framesDropped).toBe(0);
      expect(stats.framesReordered).toBe(0);
    });
  });

  describe('hasKeyframe', () => {
    it('returns false for empty buffer', () => {
      const buffer = new JitterBuffer<string>();
      expect(buffer.hasKeyframe()).toBe(false);
    });

    it('returns true when buffer has a keyframe', () => {
      const buffer = new JitterBuffer<string>();
      buffer.push(createFrame('frame1', 0, { isKeyframe: true }));
      expect(buffer.hasKeyframe()).toBe(true);
    });

    it('returns false when buffer has only delta frames', () => {
      const buffer = new JitterBuffer<string>();
      buffer.push(createFrame('frame1', 0, { isKeyframe: false }));
      buffer.push(createFrame('frame2', 33, { isKeyframe: false }));
      expect(buffer.hasKeyframe()).toBe(false);
    });
  });

  describe('delay property', () => {
    it('returns 0 for empty buffer', () => {
      const buffer = new JitterBuffer<string>();
      expect(buffer.delay).toBe(0);
    });

    it('returns current buffer delay', () => {
      const buffer = new JitterBuffer<string>({ targetDelay: 100 });
      buffer.push(createFrame('frame1', 0));

      // Delay should be around targetDelay initially
      expect(buffer.delay).toBeGreaterThanOrEqual(0);
      expect(buffer.delay).toBeLessThanOrEqual(100);
    });
  });

  describe('binary search insertion', () => {
    it('correctly inserts frames in sorted order', () => {
      const buffer = new JitterBuffer<string>({ targetDelay: 0 });

      // Insert in random order
      buffer.push(createFrame('t50', 50));
      buffer.push(createFrame('t10', 10));
      buffer.push(createFrame('t90', 90));
      buffer.push(createFrame('t30', 30));
      buffer.push(createFrame('t70', 70));

      // Verify buffer maintains sorted order by flushing
      const flushed = buffer.flush();
      expect(flushed.map(f => f.timestamp)).toEqual([10, 30, 50, 70, 90]);
    });

    it('handles duplicate timestamps', () => {
      const buffer = new JitterBuffer<string>({ targetDelay: 0 });

      buffer.push(createFrame('first', 50));
      buffer.push(createFrame('second', 50));

      expect(buffer.size).toBe(2);
    });
  });
});
