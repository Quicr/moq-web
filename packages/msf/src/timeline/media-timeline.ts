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
 * Media timeline entry with named fields.
 *
 * `groupId` / `objectId` are MOQT u62 varints. Wave 2 Track F migrated
 * arithmetic and transport paths to `bigint` end-to-end; for ergonomic
 * construction the fields are typed `number | bigint` so callers can still
 * pass small integer literals. Values whose magnitude exceeds
 * `Number.MAX_SAFE_INTEGER` (2^53-1) MUST be supplied as `bigint`. The
 * codec preserves the caller-provided form and {@link serializeMediaTimeline}
 * handles the JSON wire encoding — see {@link ../schemas/timeline.ts} for
 * the number-or-decimal-string contract.
 */
export interface MediaTimelinePoint {
  /** Media presentation timestamp */
  mediaPTS: number;
  /** Group ID (MOQT u62 varint). */
  groupId: number | bigint;
  /** Object ID within the group (MOQT u62 varint). */
  objectId: number | bigint;
  /** Optional wallclock time (epoch ms) */
  wallclockTime?: number;
}

/**
 * Encode a media timeline point to array format.
 *
 * `groupId` / `objectId` are emitted as `bigint`. Producers that JSON-encode
 * this value MUST first stringify the bigints (values > 2^53 lose precision
 * as JSON numbers); see {@link serializeMediaTimeline}, which handles this.
 */
export function encodeMediaTimelineEntry(point: MediaTimelinePoint): MediaTimelineEntry {
  const entry: MediaTimelineEntry = [point.mediaPTS, [point.groupId, point.objectId]];
  if (point.wallclockTime !== undefined) {
    entry.push(point.wallclockTime);
  }
  return entry;
}

/**
 * Decode a media timeline entry to named fields.
 *
 * Accepts either a native `bigint` or a JSON-safe representation (number or
 * decimal string) for the group/object ids, matching the schema contract.
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

  return {
    mediaPTS,
    groupId: normalizeVarint(groupId, 'groupId'),
    objectId: normalizeVarint(objectId, 'objectId'),
    wallclockTime: typeof wallclockTime === 'number' ? wallclockTime : undefined,
  };
}

/**
 * Normalize a wire-form varint to `number | bigint` per the MSF §11/§12
 * JSON contract:
 *   - `number` (safe-integer)  → passthrough as `number` (wire compat).
 *   - `bigint`                 → passthrough as `bigint`.
 *   - decimal `string` (JSON overflow encoding) → `bigint`.
 *
 * See {@link ../schemas/timeline.ts} file-level docstring for the full
 * contract that keeps values ≤ 2^53-1 as `number` for backwards compat and
 * promotes overflow values to `bigint` for precision.
 */
function normalizeVarint(v: unknown, field: string): number | bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return v;
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
  throw new MediaTimelineError(`Invalid ${field}: expected u62 varint`);
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
 * Serialize media timeline to JSON.
 *
 * JSON has no bigint type, so `groupId` / `objectId` are stringified when
 * their value would exceed `Number.MAX_SAFE_INTEGER` (2^53-1). Smaller
 * values are emitted as JSON numbers to preserve wire compatibility with
 * pre-Wave-3 consumers. See {@link ../schemas/timeline.ts} for the contract.
 */
export function serializeMediaTimeline(points: MediaTimelinePoint[]): string {
  const encoded = encodeMediaTimeline(points).map((entry) => {
    const [mediaPTS, [g, o], wallclock] = [entry[0], entry[1], entry[2]] as [
      number,
      [number | bigint, number | bigint],
      number | undefined,
    ];
    const loc = [varintToJson(g), varintToJson(o)];
    return wallclock === undefined ? [mediaPTS, loc] : [mediaPTS, loc, wallclock];
  });
  return JSON.stringify(encoded);
}

/**
 * Parse media timeline from JSON.
 *
 * Group/object ids may arrive as JSON numbers (small values) or JSON
 * strings (values > 2^53); either form is coerced to `bigint` on output.
 */
export function parseMediaTimeline(json: string): MediaTimelinePoint[] {
  const data = JSON.parse(json);
  if (!Array.isArray(data)) {
    throw new MediaTimelineError('Media timeline must be an array');
  }
  return decodeMediaTimeline(data as MediaTimelineEntry[]);
}

/**
 * Encode a varint for a JSON wire position that must round-trip losslessly.
 *
 * Values within the safe-integer range emit as JSON `number` (backwards
 * compat); larger values emit as a JSON `string` (Wave 3J contract).
 * Accepts either `number` or `bigint` inputs.
 */
function varintToJson(v: number | bigint): number | string {
  if (typeof v === 'number') return v; // safe-integer number stays as number
  return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString();
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
  groupId: number | bigint,
  objectId: number | bigint
): number | null {
  // Compare via bigint to bridge (1 === 1n === false) mixed inputs while
  // still supporting the pre-Wave-3 `number`-only surface.
  const g = typeof groupId === 'bigint' ? groupId : BigInt(groupId);
  const o = typeof objectId === 'bigint' ? objectId : BigInt(objectId);
  const entry = timeline.find(
    (e) =>
      (typeof e.groupId === 'bigint' ? e.groupId : BigInt(e.groupId)) === g &&
      (typeof e.objectId === 'bigint' ? e.objectId : BigInt(e.objectId)) === o
  );
  return entry?.mediaPTS ?? null;
}
