// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Group numbering utilities
 *
 * Provides epoch-based group ID generation for MSF catalogs.
 * The first object in each group is the full catalog (independent),
 * subsequent objects are delta updates (dependent).
 */

/**
 * Group numbering strategy
 */
export type GroupNumberingStrategy = 'epoch' | 'sequential';

/**
 * Epoch-based group ID generator
 *
 * Uses Unix epoch seconds as the group ID base, making it easier
 * to synchronize catalogs across sessions.
 */
export class EpochGroupNumbering {
  private currentGroup: number;
  private currentObject: number;

  constructor(startEpoch?: number) {
    this.currentGroup = startEpoch ?? Math.floor(Date.now() / 1000);
    this.currentObject = 0;
  }

  /**
   * Get the current group ID
   */
  getGroup(): number {
    return this.currentGroup;
  }

  /**
   * Get the current object ID
   */
  getObject(): number {
    return this.currentObject;
  }

  /**
   * Get next ID for a full catalog (starts new group)
   * @returns [groupId, objectId]
   */
  nextFull(): [number, number] {
    // Start new group with epoch timestamp
    this.currentGroup = Math.floor(Date.now() / 1000);
    this.currentObject = 0;
    return [this.currentGroup, this.currentObject];
  }

  /**
   * Get next ID for a delta update (same group, incremented object)
   * @returns [groupId, objectId]
   */
  nextDelta(): [number, number] {
    this.currentObject++;
    return [this.currentGroup, this.currentObject];
  }

  /**
   * Check if the given object ID represents a full catalog
   */
  isFullCatalog(objectId: number): boolean {
    return objectId === 0;
  }
}

/**
 * Sequential group ID generator
 *
 * Simple sequential numbering starting from a given base.
 */
export class SequentialGroupNumbering {
  private currentGroup: number;
  private currentObject: number;

  constructor(startGroup = 0) {
    this.currentGroup = startGroup;
    this.currentObject = 0;
  }

  /**
   * Get the current group ID
   */
  getGroup(): number {
    return this.currentGroup;
  }

  /**
   * Get the current object ID
   */
  getObject(): number {
    return this.currentObject;
  }

  /**
   * Get next ID for a full catalog (starts new group)
   * @returns [groupId, objectId]
   */
  nextFull(): [number, number] {
    this.currentGroup++;
    this.currentObject = 0;
    return [this.currentGroup, this.currentObject];
  }

  /**
   * Get next ID for a delta update (same group, incremented object)
   * @returns [groupId, objectId]
   */
  nextDelta(): [number, number] {
    this.currentObject++;
    return [this.currentGroup, this.currentObject];
  }

  /**
   * Check if the given object ID represents a full catalog
   */
  isFullCatalog(objectId: number): boolean {
    return objectId === 0;
  }
}

/**
 * Create a group numbering instance
 */
export function createGroupNumbering(
  strategy: GroupNumberingStrategy = 'epoch',
  startValue?: number
): EpochGroupNumbering | SequentialGroupNumbering {
  if (strategy === 'epoch') {
    return new EpochGroupNumbering(startValue);
  }
  return new SequentialGroupNumbering(startValue);
}
