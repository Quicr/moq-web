// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Ring Buffer for Efficient Data Management
 *
 * Provides a circular buffer implementation for managing streaming data
 * with fixed memory allocation. Useful for jitter buffers, receive queues,
 * and other scenarios requiring bounded memory usage.
 *
 * @example
 * ```typescript
 * import { RingBuffer } from '@web-moq/core';
 *
 * // Create a buffer for 100 items
 * const buffer = new RingBuffer<VideoFrame>(100);
 *
 * // Push items
 * buffer.push(frame1);
 * buffer.push(frame2);
 *
 * // Pop items (FIFO)
 * const frame = buffer.pop();
 *
 * // Check status
 * console.log(`Buffer: ${buffer.size}/${buffer.capacity}`);
 * ```
 */

import { Logger } from '../utils/logger.js';

const log = Logger.create('moqt:transport:buffer');

/**
 * Generic Ring Buffer (Circular Buffer)
 *
 * @remarks
 * A fixed-size circular buffer that supports FIFO (queue) operations.
 * When the buffer is full, new items can either overwrite old items
 * or be rejected, depending on configuration.
 *
 * Features:
 * - O(1) push and pop operations
 * - Fixed memory allocation
 * - Optional overflow handling (overwrite or reject)
 * - Statistics tracking
 *
 * @typeParam T - Type of items stored in the buffer
 *
 * @example
 * ```typescript
 * // Create buffer with overflow handling
 * const buffer = new RingBuffer<Packet>(1000, {
 *   overflowMode: 'overwrite',  // Old items discarded when full
 *   onOverflow: (dropped) => console.warn('Dropped:', dropped),
 * });
 *
 * // Use as a queue
 * for (const packet of packets) {
 *   buffer.push(packet);
 * }
 *
 * while (!buffer.isEmpty) {
 *   const packet = buffer.pop();
 *   process(packet);
 * }
 * ```
 */
export class RingBuffer<T> {
  /** Internal storage */
  private items: (T | undefined)[];
  /** Read position */
  private head = 0;
  /** Write position */
  private tail = 0;
  /** Current item count */
  private _size = 0;
  /** Buffer capacity */
  private readonly _capacity: number;
  /** Overflow mode */
  private readonly overflowMode: 'reject' | 'overwrite';
  /** Overflow callback */
  private readonly onOverflow?: (droppedItem: T) => void;
  /** Statistics */
  private _totalPushed = 0;
  private _totalPopped = 0;
  private _totalDropped = 0;

  /**
   * Create a new RingBuffer
   *
   * @param capacity - Maximum number of items
   * @param options - Configuration options
   */
  constructor(
    capacity: number,
    options: {
      overflowMode?: 'reject' | 'overwrite';
      onOverflow?: (droppedItem: T) => void;
    } = {}
  ) {
    if (capacity < 1) {
      throw new Error('Buffer capacity must be at least 1');
    }

    this._capacity = capacity;
    this.items = new Array(capacity);
    this.overflowMode = options.overflowMode ?? 'reject';
    this.onOverflow = options.onOverflow;

    log.debug('RingBuffer created', { capacity, mode: this.overflowMode });
  }

  /**
   * Get buffer capacity
   */
  get capacity(): number {
    return this._capacity;
  }

  /**
   * Get current item count
   */
  get size(): number {
    return this._size;
  }

  /**
   * Check if buffer is empty
   */
  get isEmpty(): boolean {
    return this._size === 0;
  }

  /**
   * Check if buffer is full
   */
  get isFull(): boolean {
    return this._size === this._capacity;
  }

  /**
   * Get remaining space
   */
  get available(): number {
    return this._capacity - this._size;
  }

  /**
   * Get fill percentage (0-1)
   */
  get fillLevel(): number {
    return this._size / this._capacity;
  }

  /**
   * Push an item to the buffer
   *
   * @param item - Item to push
   * @returns True if item was added, false if rejected due to overflow
   *
   * @example
   * ```typescript
   * if (buffer.push(frame)) {
   *   console.log('Frame added');
   * } else {
   *   console.log('Buffer full, frame dropped');
   * }
   * ```
   */
  push(item: T): boolean {
    if (this.isFull) {
      if (this.overflowMode === 'reject') {
        this._totalDropped++;
        log.trace('Buffer full, rejecting item');
        return false;
      }

      // Overwrite mode: drop oldest item
      const dropped = this.items[this.head];
      this.head = (this.head + 1) % this._capacity;
      this._totalDropped++;

      if (dropped !== undefined && this.onOverflow) {
        this.onOverflow(dropped);
      }

      log.trace('Buffer full, overwriting oldest item');
    } else {
      this._size++;
    }

    this.items[this.tail] = item;
    this.tail = (this.tail + 1) % this._capacity;
    this._totalPushed++;

    return true;
  }

  /**
   * Pop an item from the buffer (FIFO)
   *
   * @returns The oldest item, or undefined if buffer is empty
   *
   * @example
   * ```typescript
   * const item = buffer.pop();
   * if (item !== undefined) {
   *   process(item);
   * }
   * ```
   */
  pop(): T | undefined {
    if (this.isEmpty) {
      return undefined;
    }

    const item = this.items[this.head];
    this.items[this.head] = undefined; // Allow GC
    this.head = (this.head + 1) % this._capacity;
    this._size--;
    this._totalPopped++;

    return item;
  }

  /**
   * Peek at the oldest item without removing it
   *
   * @returns The oldest item, or undefined if buffer is empty
   */
  peek(): T | undefined {
    if (this.isEmpty) {
      return undefined;
    }
    return this.items[this.head];
  }

  /**
   * Peek at the newest item without removing it
   *
   * @returns The newest item, or undefined if buffer is empty
   */
  peekLast(): T | undefined {
    if (this.isEmpty) {
      return undefined;
    }
    const index = (this.tail - 1 + this._capacity) % this._capacity;
    return this.items[index];
  }

  /**
   * Pop multiple items at once
   *
   * @param count - Maximum number of items to pop
   * @returns Array of popped items
   */
  popMany(count: number): T[] {
    const result: T[] = [];
    const toRead = Math.min(count, this._size);

    for (let i = 0; i < toRead; i++) {
      const item = this.pop();
      if (item !== undefined) {
        result.push(item);
      }
    }

    return result;
  }

  /**
   * Clear all items from the buffer
   *
   * @returns Number of items cleared
   */
  clear(): number {
    const count = this._size;
    this.items = new Array(this._capacity);
    this.head = 0;
    this.tail = 0;
    this._size = 0;
    return count;
  }

  /**
   * Iterate over items without removing them
   *
   * @param callback - Function to call for each item
   */
  forEach(callback: (item: T, index: number) => void): void {
    let readIndex = this.head;
    for (let i = 0; i < this._size; i++) {
      const item = this.items[readIndex];
      if (item !== undefined) {
        callback(item, i);
      }
      readIndex = (readIndex + 1) % this._capacity;
    }
  }

  /**
   * Convert buffer contents to array (oldest first)
   *
   * @returns Array copy of buffer contents
   */
  toArray(): T[] {
    const result: T[] = [];
    this.forEach(item => result.push(item));
    return result;
  }

  /**
   * Find an item in the buffer
   *
   * @param predicate - Function to test each item
   * @returns The found item or undefined
   */
  find(predicate: (item: T) => boolean): T | undefined {
    let readIndex = this.head;
    for (let i = 0; i < this._size; i++) {
      const item = this.items[readIndex];
      if (item !== undefined && predicate(item)) {
        return item;
      }
      readIndex = (readIndex + 1) % this._capacity;
    }
    return undefined;
  }

  /**
   * Remove items matching a predicate
   *
   * @param predicate - Function to test each item
   * @returns Number of items removed
   */
  removeWhere(predicate: (item: T) => boolean): number {
    const toKeep: T[] = [];
    this.forEach(item => {
      if (!predicate(item)) {
        toKeep.push(item);
      }
    });

    const removed = this._size - toKeep.length;
    this.clear();

    for (const item of toKeep) {
      this.push(item);
    }

    return removed;
  }

  /**
   * Get buffer statistics
   *
   * @returns Statistics object
   */
  getStats(): {
    capacity: number;
    size: number;
    fillLevel: number;
    totalPushed: number;
    totalPopped: number;
    totalDropped: number;
  } {
    return {
      capacity: this._capacity,
      size: this._size,
      fillLevel: this.fillLevel,
      totalPushed: this._totalPushed,
      totalPopped: this._totalPopped,
      totalDropped: this._totalDropped,
    };
  }

  /**
   * Reset statistics counters
   */
  resetStats(): void {
    this._totalPushed = 0;
    this._totalPopped = 0;
    this._totalDropped = 0;
  }
}

/**
 * Priority Ring Buffer
 *
 * @remarks
 * A ring buffer with multiple priority levels. Items are stored in
 * separate queues by priority, and dequeuing prefers higher priorities.
 *
 * @typeParam T - Type of items stored
 */
export class PriorityRingBuffer<T> {
  /** Buffers for each priority level */
  private buffers: Map<number, RingBuffer<T>> = new Map();
  /** Priority levels (sorted high to low) */
  private priorities: number[] = [];

  /**
   * Create a PriorityRingBuffer
   *
   * @param priorityLevels - Number of priority levels (default: 4)
   * @param capacityPerPriority - Capacity for each priority queue
   * @param options - Buffer options
   */
  constructor(
    priorityLevels = 4,
    capacityPerPriority: number,
    options?: {
      overflowMode?: 'reject' | 'overwrite';
    }
  ) {
    for (let i = 0; i < priorityLevels; i++) {
      this.buffers.set(i, new RingBuffer<T>(capacityPerPriority, options));
      this.priorities.push(i);
    }

    // Sort priorities (0 = highest)
    this.priorities.sort((a, b) => a - b);

    log.debug('PriorityRingBuffer created', {
      levels: priorityLevels,
      capacityPerLevel: capacityPerPriority,
    });
  }

  /**
   * Push an item at a specific priority
   *
   * @param item - Item to push
   * @param priority - Priority level (0 = highest)
   * @returns True if item was added
   */
  push(item: T, priority: number): boolean {
    const buffer = this.buffers.get(priority);
    if (!buffer) {
      log.warn('Invalid priority level', { priority });
      return false;
    }
    return buffer.push(item);
  }

  /**
   * Pop the highest priority item
   *
   * @returns Item or undefined if all queues are empty
   */
  pop(): T | undefined {
    for (const priority of this.priorities) {
      const buffer = this.buffers.get(priority)!;
      if (!buffer.isEmpty) {
        return buffer.pop();
      }
    }
    return undefined;
  }

  /**
   * Peek at the highest priority item
   *
   * @returns Item or undefined if all queues are empty
   */
  peek(): T | undefined {
    for (const priority of this.priorities) {
      const buffer = this.buffers.get(priority)!;
      if (!buffer.isEmpty) {
        return buffer.peek();
      }
    }
    return undefined;
  }

  /**
   * Get total item count across all priorities
   */
  get size(): number {
    let total = 0;
    for (const buffer of this.buffers.values()) {
      total += buffer.size;
    }
    return total;
  }

  /**
   * Check if all queues are empty
   */
  get isEmpty(): boolean {
    for (const buffer of this.buffers.values()) {
      if (!buffer.isEmpty) return false;
    }
    return true;
  }

  /**
   * Get size at a specific priority
   *
   * @param priority - Priority level
   * @returns Item count at that priority
   */
  sizeAt(priority: number): number {
    return this.buffers.get(priority)?.size ?? 0;
  }

  /**
   * Clear all items
   */
  clear(): void {
    for (const buffer of this.buffers.values()) {
      buffer.clear();
    }
  }

  /**
   * Get statistics for all priorities
   */
  getStats(): {
    totalSize: number;
    byPriority: Map<number, { size: number; fillLevel: number }>;
  } {
    const byPriority = new Map<number, { size: number; fillLevel: number }>();

    for (const [priority, buffer] of this.buffers) {
      byPriority.set(priority, {
        size: buffer.size,
        fillLevel: buffer.fillLevel,
      });
    }

    return {
      totalSize: this.size,
      byPriority,
    };
  }
}
