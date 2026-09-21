// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Wave 3 Track J — JSON bigint round-trip verification.
 *
 * Wave 2 Track F migrated MOQT 62-bit varints from `number` to `bigint`
 * end-to-end across session/media/core. MSF catalogs and MOQLOG/MOQMETRICS
 * payloads are JSON-serialized (MSF §5, §11, §12, §13, §14), and JSON has no
 * bigint type: values > 2^53 lose precision when they cross a
 * `JSON.stringify` / `JSON.parse` boundary as plain `number`s.
 *
 * These tests pin down the wire-format contract for each JSON-crossing
 * field family that carries a MOQT varint (groupId/objectId/aliases/epoch
 * timestamps) and prove it survives a value > 2^53 with `===` bigint
 * equality (not `Number(...)` coercion, which silently loses bits).
 *
 * Fields under test (one representative per family):
 *   • LocationRef [groupId, objectId]     — MSF §11/§12 (timelines).
 *   • MediaTimelineTemplate                — MSF §11 (template start/delta).
 *   • MetricsHeader.captureNanos           — MSF §14 (epoch nanoseconds).
 *   • LogEntry.timestamp                   — MSF §13 (epoch millis or ISO).
 */

import { describe, it, expect } from 'vitest';
import {
  LocationRefSchema,
  MediaTimelineEntrySchema,
  EventTimelineEntrySchema,
  MediaTimelineTemplateArraySchema,
  MediaTimelineTemplateSchema,
} from './index.js';
import {
  LogEntrySchema,
  MetricsHeaderSchema,
} from '../publish-tracks/index.js';

/** A value that overflows the 2^53 mantissa (Number.MAX_SAFE_INTEGER = 2^53-1). */
const BIG = (1n << 53n) + 1n; // 9007199254740993n — one past MAX_SAFE_INTEGER.
const BIG_STR = BIG.toString();
/** A value near the MOQT u62 ceiling, well past Number precision. */
const HUGE = (1n << 61n) + 12345n;
const HUGE_STR = HUGE.toString();

describe('Wave 3J — JSON-crossing bigint fields', () => {
  describe('LocationRefSchema (MSF §11/§12)', () => {
    it('accepts numeric-string encoded [groupId, objectId] and yields bigint', () => {
      const parsed = LocationRefSchema.parse([BIG_STR, HUGE_STR]);
      expect(typeof parsed[0]).toBe('bigint');
      expect(typeof parsed[1]).toBe('bigint');
      expect(parsed[0]).toBe(BIG);
      expect(parsed[1]).toBe(HUGE);
    });

    it('round-trips a > 2^53 pair through JSON without precision loss', () => {
      const parsed = LocationRefSchema.parse([BIG_STR, HUGE_STR]);
      // Emit: bigint → string on the JSON wire (JSON has no bigint).
      const wire = JSON.stringify([parsed[0].toString(), parsed[1].toString()]);
      const reparsed = LocationRefSchema.parse(JSON.parse(wire));
      expect(reparsed[0]).toBe(BIG);
      expect(reparsed[1]).toBe(HUGE);
    });

    it('still accepts small numeric input for backwards compatibility', () => {
      const parsed = LocationRefSchema.parse([0, 5]);
      expect(parsed[0]).toBe(0n);
      expect(parsed[1]).toBe(5n);
    });

    it('rejects fractional numeric strings', () => {
      expect(LocationRefSchema.safeParse(['1.5', '0']).success).toBe(false);
    });

    it('rejects negative numeric strings', () => {
      expect(LocationRefSchema.safeParse(['-1', '0']).success).toBe(false);
    });
  });

  describe('MediaTimelineEntrySchema (MSF §11)', () => {
    it('accepts a large-groupId location embedded in a timeline entry', () => {
      const parsed = MediaTimelineEntrySchema.parse([90000, [BIG_STR, '0']]);
      expect(Array.isArray(parsed)).toBe(true);
      const [, loc] = parsed;
      expect(loc[0]).toBe(BIG);
      expect(loc[1]).toBe(0n);
    });
  });

  describe('EventTimelineEntrySchema (MSF §12)', () => {
    it('accepts a large-groupId location on the `l` field', () => {
      const parsed = EventTimelineEntrySchema.parse({
        l: [BIG_STR, HUGE_STR],
        data: { kind: 'seek' },
      });
      expect(parsed.l).toBeDefined();
      expect(parsed.l![0]).toBe(BIG);
      expect(parsed.l![1]).toBe(HUGE);
    });
  });

  describe('MediaTimelineTemplateArraySchema / MediaTimelineTemplateSchema (MSF §11)', () => {
    it('accepts large group/object ids in template array form', () => {
      const parsed = MediaTimelineTemplateArraySchema.parse([
        0,          // startMediaTime
        3000,       // deltaMediaTime
        [BIG_STR, HUGE_STR], // [startGroupId, startObjectId]
        [0, 1],     // [deltaGroupId, deltaObjectId]
        1700000000000,
        33,
      ]);
      expect(parsed[2][0]).toBe(BIG);
      expect(parsed[2][1]).toBe(HUGE);
    });

    it('accepts large ids in template object form and round-trips via JSON', () => {
      const parsed = MediaTimelineTemplateSchema.parse({
        deltaMediaTime: 3000,
        startGroupId: BIG_STR,
        startObjectId: HUGE_STR,
      });
      expect(parsed.startGroupId).toBe(BIG);
      expect(parsed.startObjectId).toBe(HUGE);

      // Wire: bigints stringified for JSON. All varint fields must be
      // stringified (schema promotes every u62 field to bigint on parse).
      const wire = JSON.stringify({
        ...parsed,
        startGroupId: parsed.startGroupId.toString(),
        startObjectId: parsed.startObjectId.toString(),
        deltaGroupId: parsed.deltaGroupId.toString(),
        deltaObjectId: parsed.deltaObjectId.toString(),
      });
      const reparsed = MediaTimelineTemplateSchema.parse(JSON.parse(wire));
      expect(reparsed.startGroupId).toBe(BIG);
      expect(reparsed.startObjectId).toBe(HUGE);
    });
  });

  describe('MetricsHeaderSchema.captureNanos (MSF §14)', () => {
    it('accepts a > 2^53 nanosecond timestamp as a numeric string', () => {
      const parsed = MetricsHeaderSchema.parse({ captureNanos: HUGE_STR });
      // captureNanos may be either bigint or number depending on wire encoding.
      // For > 2^53 inputs it MUST be bigint to preserve precision.
      expect(typeof parsed.captureNanos).toBe('bigint');
      expect(parsed.captureNanos).toBe(HUGE);
    });

    it('preserves precision through a JSON round-trip', () => {
      const parsed = MetricsHeaderSchema.parse({ captureNanos: HUGE_STR });
      const wire = JSON.stringify({
        ...parsed,
        captureNanos:
          typeof parsed.captureNanos === 'bigint'
            ? parsed.captureNanos.toString()
            : parsed.captureNanos,
      });
      const reparsed = MetricsHeaderSchema.parse(JSON.parse(wire));
      expect(reparsed.captureNanos).toBe(HUGE);
    });

    it('still accepts safe-integer number inputs', () => {
      const parsed = MetricsHeaderSchema.parse({ captureNanos: 1700000000000 });
      // For safe-integer inputs, we tolerate either number or bigint; the
      // invariant is only that the value is not truncated.
      const v = parsed.captureNanos;
      expect(typeof v === 'number' || typeof v === 'bigint').toBe(true);
      expect(BigInt(v as number | bigint)).toBe(1700000000000n);
    });
  });

  describe('LogEntrySchema.timestamp (MSF §13)', () => {
    it('accepts a > 2^53 epoch nanosecond timestamp as a numeric string', () => {
      const parsed = LogEntrySchema.parse({ timestamp: HUGE_STR, message: 'x' });
      expect(parsed.timestamp).toBe(HUGE_STR);
      // String input passes through unchanged; consumer parses with BigInt.
      expect(BigInt(parsed.timestamp as string)).toBe(HUGE);
    });

    it('still accepts ISO-8601 string timestamps', () => {
      const parsed = LogEntrySchema.parse({
        timestamp: '2026-01-01T00:00:00Z',
        message: 'x',
      });
      expect(parsed.timestamp).toBe('2026-01-01T00:00:00Z');
    });

    it('still accepts safe-integer number timestamps', () => {
      const parsed = LogEntrySchema.parse({ timestamp: 1700000000000, message: 'x' });
      expect(parsed.timestamp).toBe(1700000000000);
    });
  });
});
