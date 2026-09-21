// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Media timeline template per MSF spec
 *
 * For fixed-duration content (constant framerate video, fixed audio frames),
 * the template allows calculating time/location mappings without storing
 * individual entries.
 *
 * Spec format (6-element array):
 * [startMediaTime, deltaMediaTime, [startGroupID, startObjectID],
 *  [deltaGroupID, deltaObjectID], startWallclock, deltaWallclock]
 */

import type {
  MediaTimelineTemplate,
  MediaTimelineTemplateArray,
} from '../schemas/index.js';
import type { MediaTimelinePoint } from './media-timeline.js';

/**
 * Location tuple returned by calculator/codec paths.
 *
 * Distinct from the schema-parsed `LocationRef` (`[bigint, bigint]`): here
 * we preserve the caller's input form so pre-Wave-3 consumers that used
 * `number` still see plain numbers on output. Bigint is only used when the
 * value exceeds `Number.MAX_SAFE_INTEGER` (per the JSON wire contract in
 * {@link ../schemas/timeline.ts}).
 */
type LocationTuple = [number | bigint, number | bigint];

/**
 * Error thrown when template operations fail
 */
export class TimelineTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimelineTemplateError';
  }
}

/**
 * Convert spec array format to object format.
 *
 * Group/object id fields are passed through untouched — the schema has
 * already coerced string inputs to `bigint`, and small numeric values stay
 * as `number` per the JSON wire contract in {@link ../schemas/timeline.ts}.
 */
export function templateFromArray(arr: MediaTimelineTemplateArray): MediaTimelineTemplate {
  return {
    startMediaTime: arr[0],
    deltaMediaTime: arr[1],
    startGroupId: arr[2][0],
    startObjectId: arr[2][1],
    deltaGroupId: arr[3][0],
    deltaObjectId: arr[3][1],
    startWallclock: arr[4],
    deltaWallclock: arr[5],
  };
}

/**
 * MSF §11: media timeline template values are immutable once published.
 *
 * When a publisher (re)emits the same template, every field MUST match
 * bit-for-bit. This helper compares two normalized templates and throws
 * on any drift, so callers can gate republish/update paths.
 *
 * Group/object id fields are compared as `bigint` (equal via `===` when
 * the two values represent the same MOQT u62 varint), so a template that
 * was rebuilt from a JSON string still matches its bigint form.
 */
export function assertTemplateUnchanged(
  previous: MediaTimelineTemplate,
  next: MediaTimelineTemplate
): void {
  const normalize = (t: MediaTimelineTemplate) => ({
    startMediaTime: t.startMediaTime ?? 0,
    deltaMediaTime: t.deltaMediaTime,
    startGroupId: toVarint(t.startGroupId),
    startObjectId: toVarint(t.startObjectId ?? 0),
    deltaGroupId: toVarint(t.deltaGroupId ?? 0),
    deltaObjectId: toVarint(t.deltaObjectId ?? 1),
    startWallclock: t.startWallclock ?? 0,
    deltaWallclock: t.deltaWallclock ?? 0,
  });
  const a = normalize(previous);
  const b = normalize(next);
  for (const key of Object.keys(a) as (keyof typeof a)[]) {
    if (a[key] !== b[key]) {
      throw new TimelineTemplateError(
        `MSF §11: template values are immutable once published; ` +
          `field '${key}' changed from ${a[key]} to ${b[key]}`
      );
    }
  }
}

/**
 * Convert object format to spec array format.
 *
 * Group/object id fields preserve the caller's form: `number` inputs stay
 * as `number` on the wire (backwards compat with pre-Wave-3 consumers),
 * decimal strings are promoted to `bigint` (Wave 3J), and native bigints
 * pass through untouched. See {@link ../schemas/timeline.ts} for the full
 * JSON contract.
 */
export function templateToArray(template: MediaTimelineTemplate): MediaTimelineTemplateArray {
  return [
    template.startMediaTime ?? 0,
    template.deltaMediaTime,
    [preserveVarint(template.startGroupId), preserveVarint(template.startObjectId ?? 0)],
    [preserveVarint(template.deltaGroupId ?? 0), preserveVarint(template.deltaObjectId ?? 1)],
    template.startWallclock ?? 0,
    template.deltaWallclock ?? 0,
  ];
}

/**
 * Preserve caller's varint form while emitting wire-safe types:
 *   - `number` stays as `number` (pre-Wave-3 wire compat).
 *   - `bigint` downcasts to `number` when ≤ 2^53-1, else stays `bigint`.
 *   - decimal `string` promotes to `bigint`, then downcasts if safe.
 * See {@link ../schemas/timeline.ts} for the JSON wire contract.
 */
function preserveVarint(v: bigint | number | string): number | bigint {
  if (typeof v === 'number') return v;
  const b = typeof v === 'bigint' ? v : BigInt(v);
  return b >= 0n && b <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(b) : b;
}

/** Coerce `number | bigint` (or numeric string) → `bigint` for varint fields. */
function toVarint(v: bigint | number | string): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(v);
  return BigInt(v);
}

/**
 * Downcast a bigint to `number` if it fits safely; keep as `bigint` otherwise.
 *
 * MOQT u62 arithmetic runs in `bigint` for precision, but wire-facing tuples
 * downcast to `number` when the value fits within `Number.MAX_SAFE_INTEGER`
 * so pre-Wave-3 JSON consumers continue to receive plain numbers.
 */
function downcastVarint(v: bigint): number | bigint {
  return v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= 0n ? Number(v) : v;
}

/**
 * Media timeline template calculator
 *
 * Supports both spec-compliant array format and object format for ease of use.
 *
 * @example
 * ```typescript
 * // From spec array format
 * const calc = MediaTimelineCalculator.fromArray([0, 3000, [0, 0], [0, 1], Date.now(), 33]);
 *
 * // From object format
 * const calc = new MediaTimelineCalculator({
 *   startMediaTime: 0,
 *   deltaMediaTime: 3000, // 30fps at 90kHz timescale
 *   startGroupId: 0,
 *   startObjectId: 0,
 *   deltaGroupId: 0,
 *   deltaObjectId: 1,
 *   startWallclock: Date.now(),
 *   deltaWallclock: 33, // ~30fps in ms
 * });
 *
 * // Calculate location for a given time
 * const location = calc.locationForTime(90000);
 *
 * // Calculate time for a given location
 * const time = calc.timeForLocation(0, 15);
 * ```
 */
export class MediaTimelineCalculator {
  /**
   * Normalized template with all group/object ids kept as `bigint`.
   *
   * The user-facing {@link MediaTimelineTemplate} type accepts JSON-friendly
   * `number | bigint | string` inputs (see the schema JSON contract). All
   * varint fields are coerced to `bigint` on construction so index math is
   * unambiguous and precision-preserving for MOQT u62 values.
   */
  private readonly template: {
    startMediaTime: number;
    deltaMediaTime: number;
    startGroupId: bigint;
    startObjectId: bigint;
    deltaGroupId: bigint;
    deltaObjectId: bigint;
    startWallclock: number;
    deltaWallclock: number;
  };

  constructor(template: MediaTimelineTemplate) {
    this.template = {
      startMediaTime: template.startMediaTime ?? 0,
      deltaMediaTime: template.deltaMediaTime,
      startGroupId: toVarint(template.startGroupId),
      startObjectId: toVarint(template.startObjectId ?? 0),
      deltaGroupId: toVarint(template.deltaGroupId ?? 0),
      deltaObjectId: toVarint(template.deltaObjectId ?? 1),
      startWallclock: template.startWallclock ?? 0,
      deltaWallclock: template.deltaWallclock ?? 0,
    };

    if (this.template.deltaMediaTime <= 0) {
      throw new TimelineTemplateError('deltaMediaTime must be positive');
    }

    if (this.template.deltaObjectId === 0n && this.template.deltaGroupId === 0n) {
      throw new TimelineTemplateError(
        'At least one of deltaObjectId or deltaGroupId must be non-zero'
      );
    }
  }

  /**
   * Create calculator from spec array format
   */
  static fromArray(arr: MediaTimelineTemplateArray): MediaTimelineCalculator {
    return new MediaTimelineCalculator(templateFromArray(arr));
  }

  /**
   * Calculate the location for a given media time.
   *
   * Internal arithmetic runs entirely in `bigint` (precision-preserving
   * across the MOQT u62 range). The returned tuple downcasts to `number`
   * when the value fits within `Number.MAX_SAFE_INTEGER`, preserving the
   * pre-Wave-3 wire form for typical media (< 2^53 objects). Values that
   * would overflow are returned as `bigint` per the Wave 3J contract.
   *
   * @param mediaTime - Media time in timescale units
   * @returns Location reference `[groupId, objectId]` — each element is
   *   `number` when ≤ 2^53-1, else `bigint`.
   */
  locationForTime(mediaTime: number): LocationTuple {
    const relativeTime = mediaTime - this.template.startMediaTime;
    if (relativeTime < 0) {
      throw new TimelineTemplateError('Media time is before start time');
    }

    const objectIndex = BigInt(Math.floor(relativeTime / this.template.deltaMediaTime));
    const groupId = this.template.startGroupId + objectIndex * this.template.deltaGroupId;
    const objectId = this.template.startObjectId + objectIndex * this.template.deltaObjectId;

    return [downcastVarint(groupId), downcastVarint(objectId)];
  }

  /**
   * Calculate the media time for a given location.
   *
   * Accepts `number | bigint` for group/object ids — matching the
   * post-Wave-2 wire types.
   */
  timeForLocation(groupId: number | bigint, objectId: number | bigint): number {
    // Calculate object index from location — all arithmetic stays in bigint
    // so u62 values do not overflow Number.
    const g = typeof groupId === 'bigint' ? groupId : BigInt(groupId);
    const o = typeof objectId === 'bigint' ? objectId : BigInt(objectId);
    let objectIndex: bigint;

    if (this.template.deltaGroupId !== 0n) {
      const groupOffset = g - this.template.startGroupId;
      if (groupOffset < 0n) {
        throw new TimelineTemplateError('Group ID is before start group');
      }
      if (groupOffset % this.template.deltaGroupId !== 0n) {
        throw new TimelineTemplateError('Location does not align with template');
      }
      objectIndex = groupOffset / this.template.deltaGroupId;
    } else {
      const objectOffset = o - this.template.startObjectId;
      if (objectOffset < 0n) {
        throw new TimelineTemplateError('Object ID is before start object');
      }
      if (objectOffset % this.template.deltaObjectId !== 0n) {
        throw new TimelineTemplateError('Location does not align with template');
      }
      objectIndex = objectOffset / this.template.deltaObjectId;
    }

    // Object index is safely in Number range for realistic media (< 2^53
    // objects); fall back to Number for the final scalar multiplication.
    return this.template.startMediaTime + Number(objectIndex) * this.template.deltaMediaTime;
  }

  /**
   * Calculate wallclock time for a given media time
   *
   * @param mediaTime - Media time in timescale units
   * @returns Wallclock time in epoch milliseconds
   */
  wallclockForMediaTime(mediaTime: number): number {
    const relativeTime = mediaTime - this.template.startMediaTime;
    const objectIndex = Math.floor(relativeTime / this.template.deltaMediaTime);
    return this.template.startWallclock + objectIndex * this.template.deltaWallclock;
  }

  /**
   * Calculate media time for a given wallclock time
   *
   * @param wallclock - Wallclock time in epoch milliseconds
   * @returns Media time in timescale units
   */
  mediaTimeForWallclock(wallclock: number): number {
    if (this.template.deltaWallclock === 0) {
      throw new TimelineTemplateError('Cannot calculate media time: deltaWallclock is 0');
    }
    const relativeWallclock = wallclock - this.template.startWallclock;
    const objectIndex = Math.floor(relativeWallclock / this.template.deltaWallclock);
    return this.template.startMediaTime + objectIndex * this.template.deltaMediaTime;
  }

  /**
   * Generate timeline points for a range of objects
   *
   * @param startIndex - Start object index (inclusive)
   * @param endIndex - End object index (exclusive)
   * @returns Array of media timeline points
   */
  generatePoints(startIndex: number, endIndex: number): MediaTimelinePoint[] {
    const points: MediaTimelinePoint[] = [];

    for (let i = startIndex; i < endIndex; i++) {
      const idx = BigInt(i);
      const mediaPTS = this.template.startMediaTime + i * this.template.deltaMediaTime;
      const groupId = this.template.startGroupId + idx * this.template.deltaGroupId;
      const objectId = this.template.startObjectId + idx * this.template.deltaObjectId;
      const wallclockTime = this.template.startWallclock + i * this.template.deltaWallclock;

      points.push({
        mediaPTS,
        // Downcast to `number` when safe so pre-Wave-3 consumers continue
        // to receive plain numbers on the JSON wire (see `locationForTime`).
        groupId: downcastVarint(groupId),
        objectId: downcastVarint(objectId),
        wallclockTime: this.template.deltaWallclock !== 0 ? wallclockTime : undefined,
      });
    }

    return points;
  }

  /**
   * Get the template configuration in object format
   */
  getTemplate(): MediaTimelineTemplate {
    return { ...this.template };
  }

  /**
   * Get the template configuration in spec array format
   */
  toArray(): MediaTimelineTemplateArray {
    return templateToArray(this.template);
  }
}

/**
 * Create a template for constant framerate video
 *
 * @param startGroupId - Starting group ID
 * @param framerate - Frames per second
 * @param timescale - Timescale units per second (default 90000 for video)
 * @param startWallclock - Optional start wallclock time
 */
export function createVideoTemplate(
  startGroupId: number | bigint,
  framerate: number,
  timescale = 90000,
  startWallclock?: number
): MediaTimelineCalculator {
  const deltaMediaTime = timescale / framerate;
  const deltaWallclock = 1000 / framerate;

  return new MediaTimelineCalculator({
    startMediaTime: 0,
    deltaMediaTime,
    startGroupId,
    startObjectId: 0,
    deltaGroupId: 0,
    deltaObjectId: 1,
    startWallclock: startWallclock ?? 0,
    deltaWallclock,
  });
}

/**
 * Create a template for audio frames
 *
 * @param startGroupId - Starting group ID
 * @param samplerate - Audio sample rate (used to calculate wallclock delta)
 * @param samplesPerFrame - Samples per audio frame (deltaMediaTime)
 * @param startWallclock - Optional start wallclock time
 */
export function createAudioTemplate(
  startGroupId: number | bigint,
  samplerate: number,
  samplesPerFrame: number,
  startWallclock?: number
): MediaTimelineCalculator {
  const deltaWallclock = (samplesPerFrame / samplerate) * 1000;

  return new MediaTimelineCalculator({
    startMediaTime: 0,
    deltaMediaTime: samplesPerFrame,
    startGroupId,
    startObjectId: 0,
    deltaGroupId: 0,
    deltaObjectId: 1,
    startWallclock: startWallclock ?? 0,
    deltaWallclock,
  });
}

