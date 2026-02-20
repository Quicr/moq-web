// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Ring Buffer Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RingBuffer, PriorityRingBuffer } from './ring-buffer';

describe('RingBuffer', () => {
  let buffer: RingBuffer<number>;

  beforeEach(() => {
    buffer = new RingBuffer<number>(5);
  });

  describe('constructor', () => {
    it('creates empty buffer with specified capacity', () => {
      expect(buffer.capacity).toBe(5);
      expect(buffer.size).toBe(0);
      expect(buffer.isEmpty).toBe(true);
    });

    it('throws for capacity less than 1', () => {
      expect(() => new RingBuffer<number>(0)).toThrow('capacity must be at least 1');
      expect(() => new RingBuffer<number>(-1)).toThrow('capacity must be at least 1');
    });

    it('defaults to reject overflow mode', () => {
      const buf = new RingBuffer<number>(1);
      buf.push(1);
      expect(buf.push(2)).toBe(false);
    });
  });

  describe('push', () => {
    it('adds items to buffer', () => {
      expect(buffer.push(1)).toBe(true);
      expect(buffer.push(2)).toBe(true);
      expect(buffer.size).toBe(2);
    });

    it('fills buffer to capacity', () => {
      for (let i = 0; i < 5; i++) {
        buffer.push(i);
      }
      expect(buffer.size).toBe(5);
      expect(buffer.isFull).toBe(true);
    });

    it('rejects items when full (reject mode)', () => {
      for (let i = 0; i < 5; i++) {
        buffer.push(i);
      }
      expect(buffer.push(99)).toBe(false);
      expect(buffer.size).toBe(5);
    });

    it('overwrites oldest when full (overwrite mode)', () => {
      const overwriteBuffer = new RingBuffer<number>(3, {
        overflowMode: 'overwrite',
      });

      overwriteBuffer.push(1);
      overwriteBuffer.push(2);
      overwriteBuffer.push(3);
      overwriteBuffer.push(4); // Overwrites 1

      expect(overwriteBuffer.size).toBe(3);
      expect(overwriteBuffer.pop()).toBe(2);
    });

    it('calls onOverflow callback when overwriting', () => {
      const onOverflow = vi.fn();
      const overwriteBuffer = new RingBuffer<number>(2, {
        overflowMode: 'overwrite',
        onOverflow,
      });

      overwriteBuffer.push(1);
      overwriteBuffer.push(2);
      overwriteBuffer.push(3); // Overwrites 1

      expect(onOverflow).toHaveBeenCalledWith(1);
    });
  });

  describe('pop', () => {
    it('returns undefined for empty buffer', () => {
      expect(buffer.pop()).toBeUndefined();
    });

    it('returns items in FIFO order', () => {
      buffer.push(1);
      buffer.push(2);
      buffer.push(3);

      expect(buffer.pop()).toBe(1);
      expect(buffer.pop()).toBe(2);
      expect(buffer.pop()).toBe(3);
    });

    it('decrements size', () => {
      buffer.push(1);
      buffer.push(2);
      buffer.pop();
      expect(buffer.size).toBe(1);
    });

    it('allows push after pop', () => {
      for (let i = 0; i < 5; i++) {
        buffer.push(i);
      }
      buffer.pop();
      expect(buffer.push(99)).toBe(true);
    });
  });

  describe('peek', () => {
    it('returns undefined for empty buffer', () => {
      expect(buffer.peek()).toBeUndefined();
    });

    it('returns oldest item without removing', () => {
      buffer.push(1);
      buffer.push(2);

      expect(buffer.peek()).toBe(1);
      expect(buffer.size).toBe(2);
    });
  });

  describe('peekLast', () => {
    it('returns undefined for empty buffer', () => {
      expect(buffer.peekLast()).toBeUndefined();
    });

    it('returns newest item without removing', () => {
      buffer.push(1);
      buffer.push(2);
      buffer.push(3);

      expect(buffer.peekLast()).toBe(3);
      expect(buffer.size).toBe(3);
    });
  });

  describe('popMany', () => {
    it('pops multiple items', () => {
      buffer.push(1);
      buffer.push(2);
      buffer.push(3);

      const items = buffer.popMany(2);

      expect(items).toEqual([1, 2]);
      expect(buffer.size).toBe(1);
    });

    it('pops all items if count exceeds size', () => {
      buffer.push(1);
      buffer.push(2);

      const items = buffer.popMany(10);

      expect(items).toEqual([1, 2]);
      expect(buffer.isEmpty).toBe(true);
    });

    it('returns empty array for count 0', () => {
      buffer.push(1);
      expect(buffer.popMany(0)).toEqual([]);
    });
  });

  describe('clear', () => {
    it('removes all items', () => {
      buffer.push(1);
      buffer.push(2);

      const cleared = buffer.clear();

      expect(cleared).toBe(2);
      expect(buffer.isEmpty).toBe(true);
    });

    it('resets head and tail', () => {
      buffer.push(1);
      buffer.push(2);
      buffer.pop();
      buffer.clear();

      buffer.push(99);
      expect(buffer.peek()).toBe(99);
    });
  });

  describe('forEach', () => {
    it('iterates over all items in order', () => {
      buffer.push(1);
      buffer.push(2);
      buffer.push(3);

      const items: number[] = [];
      buffer.forEach(item => items.push(item));

      expect(items).toEqual([1, 2, 3]);
    });

    it('provides correct index', () => {
      buffer.push(10);
      buffer.push(20);

      const indices: number[] = [];
      buffer.forEach((_, index) => indices.push(index));

      expect(indices).toEqual([0, 1]);
    });

    it('handles wrapped buffer', () => {
      // Fill and partially empty to cause wrap
      buffer.push(1);
      buffer.push(2);
      buffer.push(3);
      buffer.pop();
      buffer.pop();
      buffer.push(4);
      buffer.push(5);
      buffer.push(6);

      const items: number[] = [];
      buffer.forEach(item => items.push(item));

      expect(items).toEqual([3, 4, 5, 6]);
    });
  });

  describe('toArray', () => {
    it('returns array copy of buffer', () => {
      buffer.push(1);
      buffer.push(2);
      buffer.push(3);

      const arr = buffer.toArray();

      expect(arr).toEqual([1, 2, 3]);
      expect(buffer.size).toBe(3); // Original unchanged
    });

    it('returns empty array for empty buffer', () => {
      expect(buffer.toArray()).toEqual([]);
    });
  });

  describe('find', () => {
    it('finds item matching predicate', () => {
      buffer.push(1);
      buffer.push(2);
      buffer.push(3);

      const found = buffer.find(x => x === 2);

      expect(found).toBe(2);
    });

    it('returns undefined if not found', () => {
      buffer.push(1);
      buffer.push(2);

      const found = buffer.find(x => x === 99);

      expect(found).toBeUndefined();
    });

    it('returns first match', () => {
      buffer.push(1);
      buffer.push(2);
      buffer.push(2);

      const found = buffer.find(x => x === 2);

      expect(found).toBe(2);
    });
  });

  describe('removeWhere', () => {
    it('removes items matching predicate', () => {
      buffer.push(1);
      buffer.push(2);
      buffer.push(3);
      buffer.push(4);

      const removed = buffer.removeWhere(x => x % 2 === 0);

      expect(removed).toBe(2);
      expect(buffer.toArray()).toEqual([1, 3]);
    });

    it('returns 0 when nothing matches', () => {
      buffer.push(1);
      buffer.push(3);

      const removed = buffer.removeWhere(x => x === 99);

      expect(removed).toBe(0);
    });
  });

  describe('properties', () => {
    it('available returns remaining space', () => {
      buffer.push(1);
      buffer.push(2);
      expect(buffer.available).toBe(3);
    });

    it('fillLevel returns correct ratio', () => {
      expect(buffer.fillLevel).toBe(0);

      buffer.push(1);
      buffer.push(2);
      expect(buffer.fillLevel).toBe(0.4);

      buffer.push(3);
      buffer.push(4);
      buffer.push(5);
      expect(buffer.fillLevel).toBe(1);
    });

    it('isFull is true at capacity', () => {
      expect(buffer.isFull).toBe(false);

      for (let i = 0; i < 5; i++) {
        buffer.push(i);
      }

      expect(buffer.isFull).toBe(true);
    });
  });

  describe('statistics', () => {
    it('tracks total pushed', () => {
      buffer.push(1);
      buffer.push(2);

      const stats = buffer.getStats();
      expect(stats.totalPushed).toBe(2);
    });

    it('tracks total popped', () => {
      buffer.push(1);
      buffer.push(2);
      buffer.pop();

      const stats = buffer.getStats();
      expect(stats.totalPopped).toBe(1);
    });

    it('tracks total dropped (reject mode)', () => {
      const smallBuffer = new RingBuffer<number>(1);
      smallBuffer.push(1);
      smallBuffer.push(2); // dropped

      const stats = smallBuffer.getStats();
      expect(stats.totalDropped).toBe(1);
    });

    it('tracks total dropped (overwrite mode)', () => {
      const smallBuffer = new RingBuffer<number>(1, {
        overflowMode: 'overwrite',
      });
      smallBuffer.push(1);
      smallBuffer.push(2); // overwrites

      const stats = smallBuffer.getStats();
      expect(stats.totalDropped).toBe(1);
    });

    it('resetStats clears counters', () => {
      buffer.push(1);
      buffer.pop();
      buffer.resetStats();

      const stats = buffer.getStats();
      expect(stats.totalPushed).toBe(0);
      expect(stats.totalPopped).toBe(0);
    });
  });

  describe('circular behavior', () => {
    it('handles wrap-around correctly', () => {
      // Push to full
      for (let i = 0; i < 5; i++) {
        buffer.push(i);
      }

      // Pop some
      buffer.pop(); // 0
      buffer.pop(); // 1

      // Push more (wraps)
      buffer.push(5);
      buffer.push(6);

      // Verify order
      expect(buffer.toArray()).toEqual([2, 3, 4, 5, 6]);
    });

    it('handles many push/pop cycles', () => {
      for (let cycle = 0; cycle < 100; cycle++) {
        buffer.push(cycle);
        if (cycle % 2 === 0) {
          buffer.pop();
        }
      }

      // Should still be working correctly
      expect(buffer.size).toBeLessThanOrEqual(5);
      expect(buffer.size).toBeGreaterThan(0);
    });
  });
});

describe('PriorityRingBuffer', () => {
  let buffer: PriorityRingBuffer<string>;

  beforeEach(() => {
    buffer = new PriorityRingBuffer<string>(4, 10);
  });

  describe('constructor', () => {
    it('creates buffer with priority levels', () => {
      expect(buffer.isEmpty).toBe(true);
      expect(buffer.size).toBe(0);
    });

    it('defaults to 4 priority levels', () => {
      // Should be able to push to priorities 0-3
      for (let i = 0; i < 4; i++) {
        expect(buffer.push(`item${i}`, i)).toBe(true);
      }
    });
  });

  describe('push', () => {
    it('pushes to specific priority', () => {
      buffer.push('high', 0);
      buffer.push('low', 3);

      expect(buffer.sizeAt(0)).toBe(1);
      expect(buffer.sizeAt(3)).toBe(1);
    });

    it('returns false for invalid priority', () => {
      expect(buffer.push('item', 99)).toBe(false);
    });

    it('respects per-priority capacity', () => {
      // Push to fill one priority
      for (let i = 0; i < 10; i++) {
        buffer.push(`item${i}`, 0);
      }
      expect(buffer.push('overflow', 0)).toBe(false);
    });
  });

  describe('pop', () => {
    it('returns highest priority first', () => {
      buffer.push('low', 3);
      buffer.push('high', 0);
      buffer.push('medium', 1);

      expect(buffer.pop()).toBe('high');
      expect(buffer.pop()).toBe('medium');
      expect(buffer.pop()).toBe('low');
    });

    it('returns undefined for empty buffer', () => {
      expect(buffer.pop()).toBeUndefined();
    });

    it('maintains FIFO within priority', () => {
      buffer.push('first', 0);
      buffer.push('second', 0);

      expect(buffer.pop()).toBe('first');
      expect(buffer.pop()).toBe('second');
    });
  });

  describe('peek', () => {
    it('returns highest priority without removing', () => {
      buffer.push('low', 3);
      buffer.push('high', 0);

      expect(buffer.peek()).toBe('high');
      expect(buffer.size).toBe(2);
    });

    it('returns undefined for empty buffer', () => {
      expect(buffer.peek()).toBeUndefined();
    });
  });

  describe('size', () => {
    it('returns total across all priorities', () => {
      buffer.push('a', 0);
      buffer.push('b', 1);
      buffer.push('c', 2);

      expect(buffer.size).toBe(3);
    });
  });

  describe('sizeAt', () => {
    it('returns size at specific priority', () => {
      buffer.push('a', 0);
      buffer.push('b', 0);
      buffer.push('c', 1);

      expect(buffer.sizeAt(0)).toBe(2);
      expect(buffer.sizeAt(1)).toBe(1);
      expect(buffer.sizeAt(2)).toBe(0);
    });

    it('returns 0 for invalid priority', () => {
      expect(buffer.sizeAt(99)).toBe(0);
    });
  });

  describe('isEmpty', () => {
    it('returns true for empty buffer', () => {
      expect(buffer.isEmpty).toBe(true);
    });

    it('returns false when any priority has items', () => {
      buffer.push('item', 3); // lowest priority
      expect(buffer.isEmpty).toBe(false);
    });
  });

  describe('clear', () => {
    it('clears all priorities', () => {
      buffer.push('a', 0);
      buffer.push('b', 1);
      buffer.push('c', 2);

      buffer.clear();

      expect(buffer.isEmpty).toBe(true);
      expect(buffer.size).toBe(0);
    });
  });

  describe('getStats', () => {
    it('returns size by priority', () => {
      buffer.push('a', 0);
      buffer.push('b', 0);
      buffer.push('c', 1);

      const stats = buffer.getStats();

      expect(stats.totalSize).toBe(3);
      expect(stats.byPriority.get(0)?.size).toBe(2);
      expect(stats.byPriority.get(1)?.size).toBe(1);
    });
  });

  describe('mixed operations', () => {
    it('handles interleaved push and pop', () => {
      buffer.push('low1', 3);
      buffer.push('high1', 0);

      expect(buffer.pop()).toBe('high1');

      buffer.push('med1', 1);
      buffer.push('high2', 0);

      expect(buffer.pop()).toBe('high2');
      expect(buffer.pop()).toBe('med1');
      expect(buffer.pop()).toBe('low1');
    });
  });
});
