// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Priority Scheduler Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  PriorityScheduler,
  determinePriority,
  priorityFromPublisher,
  priorityToPublisher,
} from './priority-scheduler';
import { Priority } from '../messages/types';

describe('PriorityScheduler', () => {
  let scheduler: PriorityScheduler<string>;

  beforeEach(() => {
    scheduler = new PriorityScheduler<string>();
  });

  describe('constructor', () => {
    it('creates empty scheduler', () => {
      expect(scheduler.isEmpty()).toBe(true);
      expect(scheduler.size).toBe(0);
    });

    it('accepts custom options', () => {
      const customScheduler = new PriorityScheduler<string>({
        maxQueueSize: 10,
        maxAge: 1000,
      });
      expect(customScheduler.isEmpty()).toBe(true);
    });
  });

  describe('enqueue', () => {
    it('enqueues item at default priority', () => {
      expect(scheduler.enqueue('item1')).toBe(true);
      expect(scheduler.size).toBe(1);
      expect(scheduler.sizeAt(Priority.MEDIUM_HIGH)).toBe(1);
    });

    it('enqueues item at specified priority', () => {
      scheduler.enqueue('high', Priority.HIGH);
      scheduler.enqueue('low', Priority.LOW);

      expect(scheduler.sizeAt(Priority.HIGH)).toBe(1);
      expect(scheduler.sizeAt(Priority.LOW)).toBe(1);
    });

    it('rejects items when queue is full (reject mode)', () => {
      const limitedScheduler = new PriorityScheduler<string>({
        maxQueueSize: 2,
      });

      expect(limitedScheduler.enqueue('item1', Priority.HIGH)).toBe(true);
      expect(limitedScheduler.enqueue('item2', Priority.HIGH)).toBe(true);
      expect(limitedScheduler.enqueue('item3', Priority.HIGH)).toBe(false);

      expect(limitedScheduler.sizeAt(Priority.HIGH)).toBe(2);
    });

    it('normalizes invalid priority to MEDIUM_HIGH', () => {
      scheduler.enqueue('item', 99 as Priority);
      expect(scheduler.sizeAt(Priority.MEDIUM_HIGH)).toBe(1);
    });

    it('normalizes negative priority to MEDIUM_HIGH', () => {
      scheduler.enqueue('item', -1 as Priority);
      expect(scheduler.sizeAt(Priority.MEDIUM_HIGH)).toBe(1);
    });
  });

  describe('dequeue', () => {
    it('returns undefined for empty scheduler', () => {
      expect(scheduler.dequeue()).toBeUndefined();
    });

    it('returns highest priority item first', () => {
      scheduler.enqueue('low', Priority.LOW);
      scheduler.enqueue('high', Priority.HIGH);
      scheduler.enqueue('medium', Priority.MEDIUM_HIGH);

      expect(scheduler.dequeue()).toBe('high');
      expect(scheduler.dequeue()).toBe('medium');
      expect(scheduler.dequeue()).toBe('low');
    });

    it('maintains FIFO within priority level', () => {
      scheduler.enqueue('first', Priority.HIGH);
      scheduler.enqueue('second', Priority.HIGH);
      scheduler.enqueue('third', Priority.HIGH);

      expect(scheduler.dequeue()).toBe('first');
      expect(scheduler.dequeue()).toBe('second');
      expect(scheduler.dequeue()).toBe('third');
    });

    it('decrements size on dequeue', () => {
      scheduler.enqueue('item', Priority.HIGH);
      expect(scheduler.size).toBe(1);

      scheduler.dequeue();
      expect(scheduler.size).toBe(0);
    });
  });

  describe('peek', () => {
    it('returns undefined for empty scheduler', () => {
      expect(scheduler.peek()).toBeUndefined();
    });

    it('returns highest priority item without removing', () => {
      scheduler.enqueue('low', Priority.LOW);
      scheduler.enqueue('high', Priority.HIGH);

      expect(scheduler.peek()).toBe('high');
      expect(scheduler.size).toBe(2);
      expect(scheduler.peek()).toBe('high');
    });
  });

  describe('isEmpty', () => {
    it('returns true for empty scheduler', () => {
      expect(scheduler.isEmpty()).toBe(true);
    });

    it('returns false when items are queued', () => {
      scheduler.enqueue('item', Priority.LOW);
      expect(scheduler.isEmpty()).toBe(false);
    });
  });

  describe('size', () => {
    it('returns total count across all priorities', () => {
      scheduler.enqueue('a', Priority.HIGH);
      scheduler.enqueue('b', Priority.MEDIUM_HIGH);
      scheduler.enqueue('c', Priority.MEDIUM_LOW);
      scheduler.enqueue('d', Priority.LOW);

      expect(scheduler.size).toBe(4);
    });
  });

  describe('sizeAt', () => {
    it('returns count at specific priority', () => {
      scheduler.enqueue('a', Priority.HIGH);
      scheduler.enqueue('b', Priority.HIGH);
      scheduler.enqueue('c', Priority.LOW);

      expect(scheduler.sizeAt(Priority.HIGH)).toBe(2);
      expect(scheduler.sizeAt(Priority.LOW)).toBe(1);
      expect(scheduler.sizeAt(Priority.MEDIUM_HIGH)).toBe(0);
    });
  });

  describe('clear', () => {
    it('removes all items', () => {
      scheduler.enqueue('a', Priority.HIGH);
      scheduler.enqueue('b', Priority.LOW);

      const cleared = scheduler.clear();

      expect(cleared).toBe(2);
      expect(scheduler.isEmpty()).toBe(true);
    });

    it('updates totalDropped stat', () => {
      scheduler.enqueue('item', Priority.HIGH);
      scheduler.clear();

      const stats = scheduler.getStats();
      expect(stats.totalDropped).toBe(1);
    });
  });

  describe('clearAt', () => {
    it('clears items at specific priority', () => {
      scheduler.enqueue('high1', Priority.HIGH);
      scheduler.enqueue('high2', Priority.HIGH);
      scheduler.enqueue('low', Priority.LOW);

      const cleared = scheduler.clearAt(Priority.HIGH);

      expect(cleared).toBe(2);
      expect(scheduler.sizeAt(Priority.HIGH)).toBe(0);
      expect(scheduler.sizeAt(Priority.LOW)).toBe(1);
    });

    it('returns 0 for empty priority', () => {
      expect(scheduler.clearAt(Priority.HIGH)).toBe(0);
    });
  });

  describe('expiration (maxAge)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('removes expired items on dequeue', () => {
      const expiringScheduler = new PriorityScheduler<string>({
        maxAge: 100,
      });

      expiringScheduler.enqueue('old', Priority.HIGH);

      // Advance time past maxAge
      vi.advanceTimersByTime(150);

      expiringScheduler.enqueue('new', Priority.LOW);

      // Old item should be expired
      expect(expiringScheduler.dequeue()).toBe('new');
    });

    it('keeps fresh items', () => {
      const expiringScheduler = new PriorityScheduler<string>({
        maxAge: 100,
      });

      expiringScheduler.enqueue('item', Priority.HIGH);

      // Advance time but not past maxAge
      vi.advanceTimersByTime(50);

      expect(expiringScheduler.dequeue()).toBe('item');
    });
  });

  describe('statistics', () => {
    it('tracks enqueued count', () => {
      scheduler.enqueue('a', Priority.HIGH);
      scheduler.enqueue('b', Priority.LOW);

      const stats = scheduler.getStats();
      expect(stats.totalEnqueued).toBe(2);
    });

    it('tracks dequeued count', () => {
      scheduler.enqueue('a', Priority.HIGH);
      scheduler.enqueue('b', Priority.LOW);
      scheduler.dequeue();

      const stats = scheduler.getStats();
      expect(stats.totalDequeued).toBe(1);
    });

    it('tracks dropped count from queue limit', () => {
      const limitedScheduler = new PriorityScheduler<string>({
        maxQueueSize: 1,
      });

      limitedScheduler.enqueue('first', Priority.HIGH);
      limitedScheduler.enqueue('second', Priority.HIGH); // dropped

      const stats = limitedScheduler.getStats();
      expect(stats.totalDropped).toBe(1);
    });

    it('provides size by priority', () => {
      scheduler.enqueue('a', Priority.HIGH);
      scheduler.enqueue('b', Priority.HIGH);
      scheduler.enqueue('c', Priority.LOW);

      const stats = scheduler.getStats();
      expect(stats.sizeByPriority[Priority.HIGH]).toBe(2);
      expect(stats.sizeByPriority[Priority.LOW]).toBe(1);
    });

    it('resetStats clears counters', () => {
      scheduler.enqueue('item', Priority.HIGH);
      scheduler.dequeue();
      scheduler.resetStats();

      const stats = scheduler.getStats();
      expect(stats.totalEnqueued).toBe(0);
      expect(stats.totalDequeued).toBe(0);
    });
  });

  describe('priority ordering', () => {
    it('dequeues in correct order across all priorities', () => {
      // Enqueue in reverse order
      scheduler.enqueue('low', Priority.LOW);
      scheduler.enqueue('medium_low', Priority.MEDIUM_LOW);
      scheduler.enqueue('medium_high', Priority.MEDIUM_HIGH);
      scheduler.enqueue('high', Priority.HIGH);

      expect(scheduler.dequeue()).toBe('high');
      expect(scheduler.dequeue()).toBe('medium_high');
      expect(scheduler.dequeue()).toBe('medium_low');
      expect(scheduler.dequeue()).toBe('low');
    });

    it('interleaves correctly with mixed insertions', () => {
      scheduler.enqueue('low1', Priority.LOW);
      scheduler.enqueue('high1', Priority.HIGH);
      scheduler.enqueue('low2', Priority.LOW);
      scheduler.enqueue('high2', Priority.HIGH);

      expect(scheduler.dequeue()).toBe('high1');
      expect(scheduler.dequeue()).toBe('high2');
      expect(scheduler.dequeue()).toBe('low1');
      expect(scheduler.dequeue()).toBe('low2');
    });
  });
});

describe('Helper Functions', () => {
  describe('determinePriority', () => {
    it('returns HIGH for keyframes', () => {
      expect(determinePriority(0, true, 0)).toBe(Priority.HIGH);
    });

    it('returns HIGH for objectId 0', () => {
      expect(determinePriority(0, false, 0)).toBe(Priority.HIGH);
    });

    it('returns LOW for old objects', () => {
      expect(determinePriority(10, false, 600)).toBe(Priority.LOW);
    });

    it('returns MEDIUM_HIGH for early frames in group', () => {
      expect(determinePriority(2, false, 0)).toBe(Priority.MEDIUM_HIGH);
      expect(determinePriority(4, false, 0)).toBe(Priority.MEDIUM_HIGH);
    });

    it('returns MEDIUM_LOW for later frames in group', () => {
      expect(determinePriority(10, false, 0)).toBe(Priority.MEDIUM_LOW);
    });
  });

  describe('priorityFromPublisher', () => {
    it('maps 0-63 to HIGH', () => {
      expect(priorityFromPublisher(0)).toBe(Priority.HIGH);
      expect(priorityFromPublisher(32)).toBe(Priority.HIGH);
      expect(priorityFromPublisher(63)).toBe(Priority.HIGH);
    });

    it('maps 64-127 to MEDIUM_HIGH', () => {
      expect(priorityFromPublisher(64)).toBe(Priority.MEDIUM_HIGH);
      expect(priorityFromPublisher(100)).toBe(Priority.MEDIUM_HIGH);
      expect(priorityFromPublisher(127)).toBe(Priority.MEDIUM_HIGH);
    });

    it('maps 128-191 to MEDIUM_LOW', () => {
      expect(priorityFromPublisher(128)).toBe(Priority.MEDIUM_LOW);
      expect(priorityFromPublisher(160)).toBe(Priority.MEDIUM_LOW);
      expect(priorityFromPublisher(191)).toBe(Priority.MEDIUM_LOW);
    });

    it('maps 192-255 to LOW', () => {
      expect(priorityFromPublisher(192)).toBe(Priority.LOW);
      expect(priorityFromPublisher(224)).toBe(Priority.LOW);
      expect(priorityFromPublisher(255)).toBe(Priority.LOW);
    });
  });

  describe('priorityToPublisher', () => {
    it('maps HIGH to 32', () => {
      expect(priorityToPublisher(Priority.HIGH)).toBe(32);
    });

    it('maps MEDIUM_HIGH to 96', () => {
      expect(priorityToPublisher(Priority.MEDIUM_HIGH)).toBe(96);
    });

    it('maps MEDIUM_LOW to 160', () => {
      expect(priorityToPublisher(Priority.MEDIUM_LOW)).toBe(160);
    });

    it('maps LOW to 224', () => {
      expect(priorityToPublisher(Priority.LOW)).toBe(224);
    });

    it('handles unknown priority as 128', () => {
      expect(priorityToPublisher(99 as Priority)).toBe(128);
    });
  });

  describe('round-trip conversion', () => {
    it('preserves priority through publisher conversion', () => {
      for (const priority of [Priority.HIGH, Priority.MEDIUM_HIGH, Priority.MEDIUM_LOW, Priority.LOW]) {
        const publisherValue = priorityToPublisher(priority);
        const roundTripped = priorityFromPublisher(publisherValue);
        expect(roundTripped).toBe(priority);
      }
    });
  });
});
