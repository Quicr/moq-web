// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Event timeline codec per MSF spec
 *
 * Encodes and decodes event timeline entries for event-driven data.
 * Events reference time via wallclock (t), location (l), or media time (m).
 *
 * Format per spec:
 * - t: wallclock time (milliseconds since Unix epoch)
 * - l: location [groupId, objectId]
 * - m: media time (milliseconds)
 * - data: application-defined data (structure defined by track's eventType)
 */

import type { EventTimelineEntry, LocationRef } from '../schemas/index.js';

/**
 * Error thrown when event timeline operations fail
 */
export class EventTimelineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventTimelineError';
  }
}

/**
 * Event timeline entry with named fields
 */
export interface EventTimelinePoint {
  /** Wallclock time (milliseconds since Unix epoch) */
  wallclockTime?: number;
  /** Location reference [groupId, objectId] */
  location?: LocationRef;
  /** Media time (milliseconds) */
  mediaTime?: number;
  /** Event-specific data */
  data?: Record<string, unknown>;
}

/**
 * Encode an event timeline point to wire format
 */
export function encodeEventTimelineEntry(point: EventTimelinePoint): EventTimelineEntry {
  const entry: EventTimelineEntry = {};

  if (point.wallclockTime !== undefined) {
    entry.t = point.wallclockTime;
  }

  if (point.location !== undefined) {
    entry.l = point.location;
  }

  if (point.mediaTime !== undefined) {
    entry.m = point.mediaTime;
  }

  if (point.data !== undefined) {
    entry.data = point.data;
  }

  return entry;
}

/**
 * Decode an event timeline entry to named fields
 */
export function decodeEventTimelineEntry(entry: EventTimelineEntry): EventTimelinePoint {
  if (typeof entry !== 'object' || entry === null) {
    throw new EventTimelineError('Invalid event timeline entry format');
  }

  const point: EventTimelinePoint = {};

  if (entry.t !== undefined) {
    point.wallclockTime = entry.t;
  }

  if (entry.l !== undefined) {
    if (!Array.isArray(entry.l) || entry.l.length !== 2) {
      throw new EventTimelineError('Invalid location reference in event entry');
    }
    point.location = entry.l;
  }

  if (entry.m !== undefined) {
    point.mediaTime = entry.m;
  }

  if (entry.data !== undefined) {
    point.data = entry.data as Record<string, unknown>;
  }

  return point;
}

/**
 * Encode multiple event timeline points
 */
export function encodeEventTimeline(points: EventTimelinePoint[]): EventTimelineEntry[] {
  return points.map(encodeEventTimelineEntry);
}

/**
 * Decode multiple event timeline entries
 */
export function decodeEventTimeline(entries: EventTimelineEntry[]): EventTimelinePoint[] {
  return entries.map(decodeEventTimelineEntry);
}

/**
 * Serialize event timeline to JSON
 */
export function serializeEventTimeline(points: EventTimelinePoint[]): string {
  return JSON.stringify(encodeEventTimeline(points));
}

/**
 * Parse event timeline from JSON
 */
export function parseEventTimeline(json: string): EventTimelinePoint[] {
  const data = JSON.parse(json);
  if (!Array.isArray(data)) {
    throw new EventTimelineError('Event timeline must be an array');
  }
  return decodeEventTimeline(data);
}

/**
 * Create an event referencing a wallclock time
 */
export function createWallclockEvent(
  wallclockTime: number,
  data?: Record<string, unknown>
): EventTimelinePoint {
  return { wallclockTime, data };
}

/**
 * Create an event referencing a location
 */
export function createLocationEvent(
  groupId: number,
  objectId: number,
  data?: Record<string, unknown>
): EventTimelinePoint {
  return { location: [groupId, objectId], data };
}

/**
 * Create an event referencing a media time
 */
export function createMediaTimeEvent(
  mediaTime: number,
  data?: Record<string, unknown>
): EventTimelinePoint {
  return { mediaTime, data };
}

/**
 * Create an event with multiple reference types
 * Note: Per spec, only one temporal index should typically be present
 */
export function createCompositeEvent(
  refs: { wallclockTime?: number; location?: LocationRef; mediaTime?: number },
  data?: Record<string, unknown>
): EventTimelinePoint {
  return {
    wallclockTime: refs.wallclockTime,
    location: refs.location,
    mediaTime: refs.mediaTime,
    data,
  };
}

