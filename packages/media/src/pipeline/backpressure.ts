// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Backpressure Controller
 *
 * Manages flow control to handle slow consumers without dropping
 * frames unnecessarily. Implements priority-based queuing and
 * adaptive bitrate signaling.
 */

import { Logger, Priority } from '@web-moq/core';

const log = Logger.create('moqt:media:backpressure');

/**
 * Queued item with priority
 */
export interface QueuedItem<T> {
  /** Data payload */
  data: T;
  /** Priority (lower = higher priority) */
  priority: Priority;
  /** Whether this is a keyframe */
  isKeyframe: boolean;
  /** Timestamp when queued */
  queuedAt: number;
  /** Group ID */
  groupId: number;
  /** Object ID */
  objectId: number;
}

/**
 * Backpressure controller configuration
 */
export interface BackpressureConfig {
  /** Maximum queue size in items */
  maxQueueSize?: number;
  /** Maximum queue size in bytes */
  maxQueueBytes?: number;
  /** Maximum age of items in ms before dropping */
  maxAge?: number;
  /** Callback when backpressure is detected */
  onBackpressure?: (level: 'low' | 'medium' | 'high') => void;
  /** Callback when bitrate reduction is recommended */
  onBitrateReduction?: (percent: number) => void;
}

/**
 * Backpressure statistics
 */
export interface BackpressureStats {
  /** Current queue size in items */
  queueSize: number;
  /** Current queue size in bytes */
  queueBytes: number;
  /** Items dropped due to queue overflow */
  droppedOverflow: number;
  /** Items dropped due to age */
  droppedAge: number;
  /** Keyframes dropped */
  keyframesDropped: number;
  /** Current backpressure level */
  level: 'none' | 'low' | 'medium' | 'high';
}

/**
 * Backpressure Controller
 *
 * Implements a priority queue with intelligent dropping strategy:
 * 1. Never drop keyframes unless absolutely necessary
 * 2. Drop older delta frames first
 * 3. Drop lower priority items before higher priority
 * 4. Signal bitrate reduction when queue grows
 */
export class BackpressureController<T extends { byteLength?: number }> {
  private queue: QueuedItem<T>[] = [];
  private config: Required<BackpressureConfig>;
  private stats: BackpressureStats = {
    queueSize: 0,
    queueBytes: 0,
    droppedOverflow: 0,
    droppedAge: 0,
    keyframesDropped: 0,
    level: 'none',
  };
  private currentBytes = 0;

  constructor(config: BackpressureConfig = {}) {
    this.config = {
      maxQueueSize: config.maxQueueSize ?? 100,
      maxQueueBytes: config.maxQueueBytes ?? 10 * 1024 * 1024, // 10 MB
      maxAge: config.maxAge ?? 2000, // 2 seconds
      onBackpressure: config.onBackpressure ?? (() => {}),
      onBitrateReduction: config.onBitrateReduction ?? (() => {}),
    };
  }

  /**
   * Add an item to the queue
   *
   * @returns true if added, false if dropped
   */
  push(item: QueuedItem<T>): boolean {
    const itemBytes = this.getItemBytes(item.data);

    // Check if we need to make room
    while (this.shouldDrop()) {
      const dropped = this.dropLowestPriority();
      if (!dropped) break;
    }

    // Check if we still have room
    if (this.queue.length >= this.config.maxQueueSize ||
        this.currentBytes + itemBytes > this.config.maxQueueBytes) {
      // If this is a keyframe, try harder to make room
      if (item.isKeyframe) {
        while (this.queue.length > 0 && !this.canAccept(itemBytes)) {
          const dropped = this.dropLowestPriority(true);
          if (!dropped) break;
        }
      }

      // Final check
      if (!this.canAccept(itemBytes)) {
        if (item.isKeyframe) {
          this.stats.keyframesDropped++;
        }
        this.stats.droppedOverflow++;
        log.warn('Dropped item due to queue overflow', {
          isKeyframe: item.isKeyframe,
          queueSize: this.queue.length,
          queueBytes: this.currentBytes,
        });
        return false;
      }
    }

    // Add to queue maintaining priority order
    this.insertByPriority(item);
    this.currentBytes += itemBytes;
    this.stats.queueSize = this.queue.length;
    this.stats.queueBytes = this.currentBytes;

    // Update backpressure level
    this.updateBackpressureLevel();

    return true;
  }

  /**
   * Get the next item from the queue
   */
  pop(): QueuedItem<T> | undefined {
    // First, drop expired items
    this.dropExpired();

    const item = this.queue.shift();
    if (item) {
      const itemBytes = this.getItemBytes(item.data);
      this.currentBytes -= itemBytes;
      this.stats.queueSize = this.queue.length;
      this.stats.queueBytes = this.currentBytes;
      this.updateBackpressureLevel();
    }
    return item;
  }

  /**
   * Peek at the next item without removing it
   */
  peek(): QueuedItem<T> | undefined {
    this.dropExpired();
    return this.queue[0];
  }

  /**
   * Get all ready items (up to limit)
   */
  popMany(limit: number): QueuedItem<T>[] {
    this.dropExpired();

    const items: QueuedItem<T>[] = [];
    for (let i = 0; i < limit && this.queue.length > 0; i++) {
      const item = this.queue.shift();
      if (item) {
        const itemBytes = this.getItemBytes(item.data);
        this.currentBytes -= itemBytes;
        items.push(item);
      }
    }

    this.stats.queueSize = this.queue.length;
    this.stats.queueBytes = this.currentBytes;
    this.updateBackpressureLevel();

    return items;
  }

  /**
   * Get current queue size
   */
  get size(): number {
    return this.queue.length;
  }

  /**
   * Get current queue bytes
   */
  get bytes(): number {
    return this.currentBytes;
  }

  /**
   * Check if queue is empty
   */
  get isEmpty(): boolean {
    return this.queue.length === 0;
  }

  /**
   * Get statistics
   */
  getStats(): BackpressureStats {
    return { ...this.stats };
  }

  /**
   * Reset the controller
   */
  reset(): void {
    this.queue = [];
    this.currentBytes = 0;
    this.stats = {
      queueSize: 0,
      queueBytes: 0,
      droppedOverflow: 0,
      droppedAge: 0,
      keyframesDropped: 0,
      level: 'none',
    };
  }

  /**
   * Get byte size of an item
   */
  private getItemBytes(data: T): number {
    if ('byteLength' in data && typeof data.byteLength === 'number') {
      return data.byteLength;
    }
    return 0;
  }

  /**
   * Check if we should drop items
   */
  private shouldDrop(): boolean {
    return (
      this.queue.length >= this.config.maxQueueSize ||
      this.currentBytes >= this.config.maxQueueBytes
    );
  }

  /**
   * Check if we can accept an item of given size
   */
  private canAccept(bytes: number): boolean {
    return (
      this.queue.length < this.config.maxQueueSize &&
      this.currentBytes + bytes <= this.config.maxQueueBytes
    );
  }

  /**
   * Insert item maintaining priority order (higher priority = lower number = earlier in queue)
   */
  private insertByPriority(item: QueuedItem<T>): void {
    // Keyframes always go to front of their priority level
    let insertIndex = this.queue.length;

    for (let i = 0; i < this.queue.length; i++) {
      const existing = this.queue[i];

      // Higher priority items (lower number) come first
      if (item.priority < existing.priority) {
        insertIndex = i;
        break;
      }

      // Same priority: keyframes come before non-keyframes
      if (item.priority === existing.priority && item.isKeyframe && !existing.isKeyframe) {
        insertIndex = i;
        break;
      }
    }

    this.queue.splice(insertIndex, 0, item);
  }

  /**
   * Drop the lowest priority item
   *
   * @param allowKeyframes - Allow dropping keyframes if no other option
   * @returns true if an item was dropped
   */
  private dropLowestPriority(allowKeyframes = false): boolean {
    // Find lowest priority non-keyframe
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (!this.queue[i].isKeyframe) {
        const dropped = this.queue.splice(i, 1)[0];
        this.currentBytes -= this.getItemBytes(dropped.data);
        this.stats.droppedOverflow++;
        log.debug('Dropped non-keyframe', {
          priority: dropped.priority,
          groupId: dropped.groupId,
          objectId: dropped.objectId,
        });
        return true;
      }
    }

    // Only drop keyframes if explicitly allowed
    if (allowKeyframes && this.queue.length > 0) {
      const dropped = this.queue.pop()!;
      this.currentBytes -= this.getItemBytes(dropped.data);
      this.stats.droppedOverflow++;
      this.stats.keyframesDropped++;
      log.warn('Dropped keyframe', {
        priority: dropped.priority,
        groupId: dropped.groupId,
      });
      return true;
    }

    return false;
  }

  /**
   * Drop expired items
   */
  private dropExpired(): void {
    const now = performance.now();
    const maxAge = this.config.maxAge;

    let dropped = 0;
    while (this.queue.length > 0) {
      const age = now - this.queue[0].queuedAt;
      if (age <= maxAge) break;

      const item = this.queue.shift()!;
      this.currentBytes -= this.getItemBytes(item.data);
      dropped++;

      if (item.isKeyframe) {
        this.stats.keyframesDropped++;
      }
    }

    if (dropped > 0) {
      this.stats.droppedAge += dropped;
      log.debug('Dropped expired items', { count: dropped });
    }
  }

  /**
   * Update backpressure level and signal callbacks
   */
  private updateBackpressureLevel(): void {
    const sizeRatio = this.queue.length / this.config.maxQueueSize;
    const bytesRatio = this.currentBytes / this.config.maxQueueBytes;
    const ratio = Math.max(sizeRatio, bytesRatio);

    let newLevel: 'none' | 'low' | 'medium' | 'high';
    let bitrateReduction = 0;

    if (ratio >= 0.9) {
      newLevel = 'high';
      bitrateReduction = 50; // Suggest 50% bitrate reduction
    } else if (ratio >= 0.7) {
      newLevel = 'medium';
      bitrateReduction = 25; // Suggest 25% bitrate reduction
    } else if (ratio >= 0.5) {
      newLevel = 'low';
      bitrateReduction = 10; // Suggest 10% bitrate reduction
    } else {
      newLevel = 'none';
    }

    if (newLevel !== this.stats.level) {
      this.stats.level = newLevel;
      if (newLevel !== 'none') {
        this.config.onBackpressure(newLevel);
      }
    }

    if (bitrateReduction > 0) {
      this.config.onBitrateReduction(bitrateReduction);
    }
  }
}
