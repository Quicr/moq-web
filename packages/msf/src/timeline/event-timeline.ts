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

import type { EventTimelineEntry } from '../schemas/index.js';

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
 * Event timeline entry with named fields.
 *
 * `location` group/object ids are MOQT u62 varints and typed
 * `number | bigint` for ergonomic construction (see MSF §11/§12 JSON
 * contract in {@link ../schemas/timeline.ts}). Values > 2^53-1 MUST be
 * supplied as `bigint`; the codec preserves the caller-provided form and
 * {@link serializeEventTimeline} handles the JSON wire encoding.
 */
export interface EventTimelinePoint {
  /** Wallclock time (milliseconds since Unix epoch) */
  wallclockTime?: number;
  /** Location reference [groupId, objectId] — MOQT u62 varints. */
  location?: [number | bigint, number | bigint];
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
 * Decode an event timeline entry to named fields.
 *
 * Accepts either schema-validated input (location already `[bigint, bigint]`)
 * or a raw `JSON.parse` tuple (`[number, number]` or `[string, string]`).
 * Group/object ids are always normalized to `bigint` on output.
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
    point.location = [normalizeVarint(entry.l[0]), normalizeVarint(entry.l[1])];
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
 * Normalize a wire-form group/object id to `number | bigint`.
 *
 * Safe-integer numbers pass through as `number` (backwards compat with
 * pre-Wave-3 consumers); decimal strings — the JSON encoding for values
 * > 2^53-1 — are promoted to `bigint`; native bigints are preserved.
 */
function normalizeVarint(v: unknown): number | bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return v;
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
  throw new EventTimelineError('Invalid location id: expected MOQT u62 varint');
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
 * Serialize event timeline to JSON.
 *
 * `l` locations carry MOQT u62 varints; bigints are stringified when their
 * magnitude exceeds `Number.MAX_SAFE_INTEGER`. Smaller values remain JSON
 * numbers for compatibility with pre-Wave-3 consumers.
 */
export function serializeEventTimeline(points: EventTimelinePoint[]): string {
  const encoded = encodeEventTimeline(points).map((entry) => {
    if (entry.l === undefined) return entry;
    const [g, o] = entry.l as [number | bigint, number | bigint];
    return { ...entry, l: [varintToJson(g), varintToJson(o)] };
  });
  return JSON.stringify(encoded);
}

/**
 * Parse event timeline from JSON.
 *
 * `l` locations may arrive as JSON numbers or JSON strings; both forms are
 * normalized to `bigint` on output per the schema contract.
 */
export function parseEventTimeline(json: string): EventTimelinePoint[] {
  const data = JSON.parse(json);
  if (!Array.isArray(data)) {
    throw new EventTimelineError('Event timeline must be an array');
  }
  return decodeEventTimeline(data as EventTimelineEntry[]);
}

/**
 * Encode a varint for a JSON wire position that must round-trip losslessly.
 *
 * Safe-integer numbers pass through as JSON `number` (wire compat with
 * pre-Wave-3 consumers). Bigints ≤ 2^53-1 downcast to number for the same
 * reason. Larger bigints are stringified per the Wave 3J contract.
 */
function varintToJson(v: number | bigint): number | string {
  if (typeof v === 'number') return v;
  return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString();
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
 * Create an event referencing a location.
 *
 * `groupId` / `objectId` are MOQT u62 varints; accept `number | bigint`.
 * Caller-provided form is preserved (small numbers stay as `number` for
 * pre-Wave-3 wire compat; large values must be passed as `bigint`).
 * See {@link ../schemas/timeline.ts} for the JSON round-trip contract.
 */
export function createLocationEvent(
  groupId: number | bigint,
  objectId: number | bigint,
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
  refs: {
    wallclockTime?: number;
    /** MOQT u62 varints; accept either `number` or `bigint` per MSF §12. */
    location?: [number | bigint, number | bigint];
    mediaTime?: number;
  },
  data?: Record<string, unknown>
): EventTimelinePoint {
  return {
    wallclockTime: refs.wallclockTime,
    location: refs.location,
    mediaTime: refs.mediaTime,
    data,
  };
}

