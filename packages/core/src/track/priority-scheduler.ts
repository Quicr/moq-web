// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview MOQT Priority Scheduler
 *
 * Implements 4-level priority scheduling for MOQT objects as specified
 * in the MOQT draft. Higher priority objects are delivered first when
 * there is congestion or limited bandwidth.
 *
 * Priority levels (0-3):
 * - 0: Highest (e.g., keyframes, control data)
 * - 1: High (e.g., important delta frames)
 * - 2: Medium (e.g., normal delta frames)
 * - 3: Low (e.g., enhancement layers, optional data)
 *
 * @example
 * ```typescript
 * import { PriorityScheduler, Priority } from 'moqt-core';
 *
 * const scheduler = new PriorityScheduler();
 *
 * // Enqueue objects at different priorities
 * scheduler.enqueue(keyframeObject, Priority.HIGH);
 * scheduler.enqueue(deltaFrame1, Priority.MEDIUM_HIGH);
 * scheduler.enqueue(deltaFrame2, Priority.MEDIUM_LOW);
 *
 * // Dequeue returns highest priority first
 * const next = scheduler.dequeue(); // keyframeObject
 * ```
 */

import { Logger } from '../utils/logger.js';
import { Priority, MOQTObject } from '../messages/types.js';

const log = Logger.create('moqt:core:scheduler');

/**
 * Item in the priority queue
 */
interface QueueItem<T> {
  /** The data item */
  data: T;
  /** Priority level (0-3) */
  priority: Priority;
  /** Sequence number for FIFO within priority */
  sequence: number;
  /** Timestamp when enqueued */
  enqueuedAt: number;
}

/**
 * Priority Scheduler for MOQT Objects
 *
 * @remarks
 * Implements a 4-level priority queue for scheduling MOQT object
 * transmission. Objects are dequeued in priority order, with FIFO
 * ordering within each priority level.
 *
 * Features:
 * - 4 priority levels (0=highest, 3=lowest)
 * - FIFO within each priority level
 * - Optional deadline-based expiration
 * - Statistics tracking
 *
 * @typeParam T - Type of items to schedule (default: MOQTObject)
 *
 * @example
 * ```typescript
 * const scheduler = new PriorityScheduler<MOQTObject>();
 *
 * // Enqueue a keyframe at high priority
 * scheduler.enqueue(keyframe, Priority.HIGH);
 *
 * // Enqueue delta frames at lower priority
 * scheduler.enqueue(delta1, Priority.MEDIUM_LOW);
 * scheduler.enqueue(delta2, Priority.MEDIUM_LOW);
 *
 * // Dequeue processes highest priority first
 * while (!scheduler.isEmpty()) {
 *   const item = scheduler.dequeue();
 *   await sendObject(item);
 * }
 * ```
 */
export class PriorityScheduler<T = MOQTObject> {
  /** Queues for each priority level */
  private queues: Map<Priority, QueueItem<T>[]> = new Map([
    [Priority.HIGH, []],
    [Priority.MEDIUM_HIGH, []],
    [Priority.MEDIUM_LOW, []],
    [Priority.LOW, []],
  ]);

  /** Sequence counter for FIFO ordering */
  private sequence = 0;

  /** Total items ever enqueued */
  private totalEnqueued = 0;

  /** Total items ever dequeued */
  private totalDequeued = 0;

  /** Total items dropped */
  private totalDropped = 0;

  /** Maximum queue size per priority (0 = unlimited) */
  private maxQueueSize: number;

  /** Maximum age in ms before item is dropped (0 = no expiration) */
  private maxAge: number;

  /**
   * Create a new PriorityScheduler
   *
   * @param options - Configuration options
   * @param options.maxQueueSize - Max items per priority queue (default: 0 = unlimited)
   * @param options.maxAge - Max age in ms before dropping (default: 0 = no expiration)
   */
  constructor(options: { maxQueueSize?: number; maxAge?: number } = {}) {
    this.maxQueueSize = options.maxQueueSize ?? 0;
    this.maxAge = options.maxAge ?? 0;

    log.debug('PriorityScheduler created', {
      maxQueueSize: this.maxQueueSize,
      maxAge: this.maxAge,
    });
  }

  /**
   * Enqueue an item at a specific priority
   *
   * @param data - The item to enqueue
   * @param priority - Priority level (0-3)
   * @returns True if item was enqueued, false if dropped
   *
   * @example
   * ```typescript
   * // Enqueue at high priority
   * scheduler.enqueue(keyframe, Priority.HIGH);
   *
   * // Enqueue at medium priority (default behavior)
   * scheduler.enqueue(deltaFrame, Priority.MEDIUM_HIGH);
   * ```
   */
  enqueue(data: T, priority: Priority = Priority.MEDIUM_HIGH): boolean {
    // Validate priority
    if (priority < Priority.HIGH || priority > Priority.LOW) {
      log.warn('Invalid priority, using MEDIUM_HIGH', { priority });
      priority = Priority.MEDIUM_HIGH;
    }

    const queue = this.queues.get(priority)!;

    // Check max queue size
    if (this.maxQueueSize > 0 && queue.length >= this.maxQueueSize) {
      log.debug('Queue full, dropping item', { priority, size: queue.length });
      this.totalDropped++;
      return false;
    }

    const item: QueueItem<T> = {
      data,
      priority,
      sequence: this.sequence++,
      enqueuedAt: Date.now(),
    };

    queue.push(item);
    this.totalEnqueued++;

    log.trace('Item enqueued', {
      priority,
      sequence: item.sequence,
      queueSize: queue.length,
    });

    return true;
  }

  /**
   * Dequeue the highest priority item
   *
   * @returns The item or undefined if queue is empty
   *
   * @example
   * ```typescript
   * const item = scheduler.dequeue();
   * if (item) {
   *   await processItem(item);
   * }
   * ```
   */
  dequeue(): T | undefined {
    // Remove expired items first
    if (this.maxAge > 0) {
      this.removeExpired();
    }

    // Check each priority level from highest to lowest
    for (const priority of [Priority.HIGH, Priority.MEDIUM_HIGH, Priority.MEDIUM_LOW, Priority.LOW]) {
      const queue = this.queues.get(priority)!;
      if (queue.length > 0) {
        const item = queue.shift()!;
        this.totalDequeued++;

        log.trace('Item dequeued', {
          priority,
          sequence: item.sequence,
          waitTime: Date.now() - item.enqueuedAt,
        });

        return item.data;
      }
    }

    return undefined;
  }

  /**
   * Peek at the highest priority item without removing it
   *
   * @returns The item or undefined if queue is empty
   */
  peek(): T | undefined {
    for (const priority of [Priority.HIGH, Priority.MEDIUM_HIGH, Priority.MEDIUM_LOW, Priority.LOW]) {
      const queue = this.queues.get(priority)!;
      if (queue.length > 0) {
        return queue[0].data;
      }
    }
    return undefined;
  }

  /**
   * Check if the scheduler is empty
   *
   * @returns True if no items are queued
   */
  isEmpty(): boolean {
    for (const queue of this.queues.values()) {
      if (queue.length > 0) {
        return false;
      }
    }
    return true;
  }

  /**
   * Get the total number of queued items
   *
   * @returns Total item count across all priorities
   */
  get size(): number {
    let total = 0;
    for (const queue of this.queues.values()) {
      total += queue.length;
    }
    return total;
  }

  /**
   * Get the number of items at a specific priority
   *
   * @param priority - Priority level to check
   * @returns Item count at that priority
   */
  sizeAt(priority: Priority): number {
    return this.queues.get(priority)?.length ?? 0;
  }

  /**
   * Clear all queued items
   *
   * @returns Number of items cleared
   */
  clear(): number {
    let count = 0;
    for (const queue of this.queues.values()) {
      count += queue.length;
      queue.length = 0;
    }
    this.totalDropped += count;
    log.debug('Scheduler cleared', { cleared: count });
    return count;
  }

  /**
   * Clear items at a specific priority
   *
   * @param priority - Priority level to clear
   * @returns Number of items cleared
   */
  clearAt(priority: Priority): number {
    const queue = this.queues.get(priority);
    if (!queue) return 0;

    const count = queue.length;
    queue.length = 0;
    this.totalDropped += count;

    log.debug('Priority queue cleared', { priority, cleared: count });
    return count;
  }

  /**
   * Remove expired items from all queues
   *
   * @returns Number of items removed
   */
  private removeExpired(): number {
    if (this.maxAge <= 0) return 0;

    const now = Date.now();
    let removed = 0;

    for (const [_priority, queue] of this.queues) {
      let i = 0;
      while (i < queue.length) {
        if (now - queue[i].enqueuedAt > this.maxAge) {
          queue.splice(i, 1);
          removed++;
          this.totalDropped++;
        } else {
          i++;
        }
      }
    }

    if (removed > 0) {
      log.debug('Removed expired items', { count: removed });
    }

    return removed;
  }

  /**
   * Get scheduler statistics
   *
   * @returns Statistics object
   */
  getStats(): {
    totalEnqueued: number;
    totalDequeued: number;
    totalDropped: number;
    currentSize: number;
    sizeByPriority: Record<Priority, number>;
  } {
    return {
      totalEnqueued: this.totalEnqueued,
      totalDequeued: this.totalDequeued,
      totalDropped: this.totalDropped,
      currentSize: this.size,
      sizeByPriority: {
        [Priority.HIGH]: this.sizeAt(Priority.HIGH),
        [Priority.MEDIUM_HIGH]: this.sizeAt(Priority.MEDIUM_HIGH),
        [Priority.MEDIUM_LOW]: this.sizeAt(Priority.MEDIUM_LOW),
        [Priority.LOW]: this.sizeAt(Priority.LOW),
      },
    };
  }

  /**
   * Reset statistics counters
   */
  resetStats(): void {
    this.totalEnqueued = 0;
    this.totalDequeued = 0;
    this.totalDropped = 0;
  }
}

/**
 * Determine priority based on object characteristics
 *
 * @remarks
 * Helper function to assign priority based on common patterns:
 * - Keyframes get HIGH priority
 * - First few objects in a group get MEDIUM_HIGH
 * - Other objects get MEDIUM_LOW
 * - Old objects or retransmissions get LOW
 *
 * @param objectId - Object ID within the group
 * @param isKeyframe - Whether this is a keyframe (first in group)
 * @param age - Age of the object in milliseconds
 * @returns Recommended priority level
 *
 * @example
 * ```typescript
 * const priority = determinePriority(0, true, 0);  // HIGH (keyframe)
 * const priority = determinePriority(1, false, 0); // MEDIUM_HIGH
 * const priority = determinePriority(10, false, 500); // MEDIUM_LOW
 * ```
 */
export function determinePriority(
  objectId: number,
  isKeyframe: boolean,
  age: number = 0
): Priority {
  // Keyframes always get high priority
  if (isKeyframe || objectId === 0) {
    return Priority.HIGH;
  }

  // Old objects get low priority
  if (age > 500) {
    return Priority.LOW;
  }

  // First few frames in group get medium-high
  if (objectId < 5) {
    return Priority.MEDIUM_HIGH;
  }

  // Default to medium-low
  return Priority.MEDIUM_LOW;
}

/**
 * Determine priority from publisher priority field
 *
 * @remarks
 * Maps the 8-bit publisher priority (0-255) to 4-level priority.
 *
 * @param publisherPriority - Publisher priority (0-255)
 * @returns Priority level (0-3)
 *
 * @example
 * ```typescript
 * const priority = priorityFromPublisher(32);  // HIGH (0-63)
 * const priority = priorityFromPublisher(100); // MEDIUM_HIGH (64-127)
 * ```
 */
export function priorityFromPublisher(publisherPriority: number): Priority {
  if (publisherPriority < 64) {
    return Priority.HIGH;
  } else if (publisherPriority < 128) {
    return Priority.MEDIUM_HIGH;
  } else if (publisherPriority < 192) {
    return Priority.MEDIUM_LOW;
  } else {
    return Priority.LOW;
  }
}

/**
 * Convert priority level to publisher priority value
 *
 * @param priority - Priority level (0-3)
 * @returns Publisher priority (0-255)
 *
 * @example
 * ```typescript
 * const pubPri = priorityToPublisher(Priority.HIGH);        // 32
 * const pubPri = priorityToPublisher(Priority.MEDIUM_HIGH); // 96
 * ```
 */
export function priorityToPublisher(priority: Priority): number {
  switch (priority) {
    case Priority.HIGH:
      return 32;
    case Priority.MEDIUM_HIGH:
      return 96;
    case Priority.MEDIUM_LOW:
      return 160;
    case Priority.LOW:
      return 224;
    default:
      return 128;
  }
}
