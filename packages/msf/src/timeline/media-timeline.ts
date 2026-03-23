// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Media timeline codec
 *
 * Encodes and decodes media timeline entries for mapping media timestamps
 * to object locations in the MOQT namespace.
 *
 * Format: [mediaPTS, [groupId, objectId], wallclockTime?]
 */

import type { MediaTimelineEntry, LocationRef } from '../schemas/index.js';

/**
 * Error thrown when media timeline operations fail
 */
export class MediaTimelineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaTimelineError';
  }
}

/**
 * Media timeline entry with named fields
 */
export interface MediaTimelinePoint {
  /** Media presentation timestamp */
  mediaPTS: number;
  /** Group ID */
  groupId: number;
  /** Object ID within the group */
  objectId: number;
  /** Optional wallclock time (epoch ms) */
  wallclockTime?: number;
}

/**
 * Encode a media timeline point to array format
 */
export function encodeMediaTimelineEntry(point: MediaTimelinePoint): MediaTimelineEntry {
  const entry: MediaTimelineEntry = [point.mediaPTS, [point.groupId, point.objectId]];
  if (point.wallclockTime !== undefined) {
    entry.push(point.wallclockTime);
  }
  return entry;
}

/**
 * Decode a media timeline entry to named fields
 */
export function decodeMediaTimelineEntry(entry: MediaTimelineEntry): MediaTimelinePoint {
  if (!Array.isArray(entry) || entry.length < 2) {
    throw new MediaTimelineError('Invalid media timeline entry format');
  }

  const [mediaPTS, location, wallclockTime] = entry;

  if (typeof mediaPTS !== 'number') {
    throw new MediaTimelineError('Invalid mediaPTS');
  }

  if (!Array.isArray(location) || location.length < 2) {
    throw new MediaTimelineError('Invalid location reference');
  }

  const [groupId, objectId] = location;

  if (typeof groupId !== 'number' || typeof objectId !== 'number') {
    throw new MediaTimelineError('Invalid group/object ID');
  }

  return {
    mediaPTS,
    groupId,
    objectId,
    wallclockTime: typeof wallclockTime === 'number' ? wallclockTime : undefined,
  };
}

/**
 * Encode multiple media timeline points
 */
export function encodeMediaTimeline(points: MediaTimelinePoint[]): MediaTimelineEntry[] {
  return points.map(encodeMediaTimelineEntry);
}

/**
 * Decode multiple media timeline entries
 */
export function decodeMediaTimeline(entries: MediaTimelineEntry[]): MediaTimelinePoint[] {
  return entries.map(decodeMediaTimelineEntry);
}

/**
 * Serialize media timeline to JSON
 */
export function serializeMediaTimeline(points: MediaTimelinePoint[]): string {
  return JSON.stringify(encodeMediaTimeline(points));
}

/**
 * Parse media timeline from JSON
 */
export function parseMediaTimeline(json: string): MediaTimelinePoint[] {
  const data = JSON.parse(json);
  if (!Array.isArray(data)) {
    throw new MediaTimelineError('Media timeline must be an array');
  }
  return decodeMediaTimeline(data);
}

/**
 * Find the location for a given media time using binary search
 *
 * @param timeline - Sorted timeline entries (by mediaPTS)
 * @param targetPTS - Target media timestamp
 * @returns Location reference or null if not found
 */
export function findLocationForTime(
  timeline: MediaTimelinePoint[],
  targetPTS: number
): LocationRef | null {
  if (timeline.length === 0) {
    return null;
  }

  // Binary search for the entry with the largest PTS <= targetPTS
  let left = 0;
  let right = timeline.length - 1;
  let result: MediaTimelinePoint | null = null;

  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    if (timeline[mid].mediaPTS <= targetPTS) {
      result = timeline[mid];
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }

  if (result === null) {
    return null;
  }

  return [result.groupId, result.objectId];
}

/**
 * Find the media time for a given location
 *
 * @param timeline - Timeline entries
 * @param groupId - Target group ID
 * @param objectId - Target object ID
 * @returns Media timestamp or null if not found
 */
export function findTimeForLocation(
  timeline: MediaTimelinePoint[],
  groupId: number,
  objectId: number
): number | null {
  const entry = timeline.find(
    (e) => e.groupId === groupId && e.objectId === objectId
  );
  return entry?.mediaPTS ?? null;
}
