// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Timeline schema definitions
 *
 * Defines schemas for media and event timeline track packaging.
 *
 * ## JSON bigint contract (Wave 3 Track J)
 *
 * MOQT `groupId` / `objectId` values are 62-bit unsigned varints (§MOQT-8.2).
 * Wave 2 Track F migrated them to `bigint` end-to-end across session/media.
 * MSF timeline documents (MSF §11, §12) transit as JSON, and JSON has **no
 * bigint type** — values greater than `Number.MAX_SAFE_INTEGER` (2^53-1)
 * silently lose precision if serialized as plain numbers.
 *
 * The location/template schemas below therefore accept **either** a JSON
 * number (values ≤ 2^53-1) **or** a JSON decimal string (any u62 value) and
 * always emit a `bigint`. Emitters that need to preserve u62 precision on
 * the wire MUST stringify the bigint themselves via `.toString()` before
 * calling `JSON.stringify`; callers that receive JSON MUST parse via
 * `BigInt(...)` rather than coerce with `Number(...)`.
 *
 * @example
 *   // Emit: bigint → decimal string on the wire.
 *   const json = JSON.stringify([90000, [start.toString(), obj.toString()]]);
 *   // Parse: schema yields bigint on both sides.
 *   const [pts, [g, o]] = MediaTimelineEntrySchema.parse(JSON.parse(json));
 *   // g === (1n << 60n) → true (no precision loss).
 */

import { z } from 'zod';

/**
 * MOQT u62 varint value on a JSON-serialized surface.
 *
 * Accepts a native `bigint`, a non-negative safe-integer `number`, or a
 * non-negative decimal string. Always emits a `bigint`. The string form is
 * the JSON wire encoding for values > 2^53 (see file-level docstring).
 */
const MoqtVarintSchema = z
  .union([
    z.bigint().nonnegative(),
    z
      .number()
      .int()
      .nonnegative()
      .refine((n) => Number.isSafeInteger(n), {
        message:
          'MOQT varint number must be a safe integer; use a decimal string for values > 2^53 - 1',
      }),
    z
      .string()
      .regex(/^\d+$/, 'MOQT varint string must be a non-negative decimal integer'),
  ])
  .transform((v) => (typeof v === 'bigint' ? v : BigInt(v)));

/**
 * Signed MOQT delta (e.g. `deltaGroupId`, `deltaObjectId`).
 *
 * Same wire contract as {@link MoqtVarintSchema} but permits negative values
 * since deltas in MSF §11 templates may be `0`, `+1`, or negative.
 */
const MoqtVarintSignedSchema = z
  .union([
    z.bigint(),
    z
      .number()
      .int()
      .refine((n) => Number.isSafeInteger(n), {
        message:
          'MOQT delta number must be a safe integer; use a decimal string for magnitudes > 2^53 - 1',
      }),
    z.string().regex(/^-?\d+$/, 'MOQT delta string must be a signed decimal integer'),
  ])
  .transform((v) => (typeof v === 'bigint' ? v : BigInt(v)));

/**
 * Location reference: `[groupId, objectId]` — both MOQT u62 varints.
 *
 * See file-level docstring for the JSON bigint contract. Consumers get
 * `[bigint, bigint]`; emitters should stringify bigints before
 * `JSON.stringify` when values exceed 2^53-1.
 */
export const LocationRefSchema = z.tuple([MoqtVarintSchema, MoqtVarintSchema]);

/**
 * Media timeline entry with wallclock time
 */
const MediaTimelineEntryWithWallclockSchema = z.tuple([
  z.number(), // mediaPTS
  LocationRefSchema,
  z.number(), // wallclockTime (epoch ms)
]);

/**
 * Media timeline entry without wallclock time
 */
const MediaTimelineEntryWithoutWallclockSchema = z.tuple([
  z.number(), // mediaPTS
  LocationRefSchema,
]);

/**
 * Media timeline entry: [mediaPTS, location, wallclockTime?]
 */
export const MediaTimelineEntrySchema = z.union([
  MediaTimelineEntryWithWallclockSchema,
  MediaTimelineEntryWithoutWallclockSchema,
]);

/**
 * Event timeline entry per MSF §12.
 *
 * Exactly ONE temporal index (`t`, `l`, or `m`) MUST be present per record.
 * A record with all three or none is a spec violation.
 */
export const EventTimelineEntrySchema = z
  .object({
    /** Wallclock time (milliseconds since Unix epoch) */
    t: z.number().optional(),
    /** Location reference [groupId, objectId] */
    l: LocationRefSchema.optional(),
    /** Media time (milliseconds) */
    m: z.number().optional(),
    /** Event-specific data (structure defined by track's eventType) */
    data: z.record(z.unknown()).optional(),
  })
  .superRefine((entry, ctx) => {
    const count =
      (entry.t !== undefined ? 1 : 0) +
      (entry.l !== undefined ? 1 : 0) +
      (entry.m !== undefined ? 1 : 0);
    if (count !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'event timeline entry must have exactly one temporal index (t | l | m) per MSF §12',
      });
    }
  });

/**
 * Media timeline template per MSF spec
 * 6-element array: [startMediaTime, deltaMediaTime, [startGroupID, startObjectID],
 *                   [deltaGroupID, deltaObjectID], startWallclock, deltaWallclock]
 *
 * Note: positions 2 and 3 are MOQT u62 varints on the JSON wire — see the
 * file-level docstring for the number-or-decimal-string contract.
 */
export const MediaTimelineTemplateArraySchema = z.tuple([
  z.number(), // startMediaTime
  z.number(), // deltaMediaTime (duration per object)
  LocationRefSchema, // [startGroupID, startObjectID] — bigint after parse
  z.tuple([MoqtVarintSignedSchema, MoqtVarintSignedSchema]), // [deltaGroupID, deltaObjectID]
  z.number(), // startWallclock (epoch ms)
  z.number(), // deltaWallclock (ms per object)
]);

/**
 * Object-based template for easier programmatic use.
 *
 * `startGroupId` / `startObjectId` and their deltas are MOQT u62 varints;
 * see the file-level docstring for the number-or-decimal-string JSON
 * contract. The parsed output types are `bigint`.
 */
export const MediaTimelineTemplateSchema = z.object({
  /** Start media time in timescale units */
  startMediaTime: z.number().nonnegative().default(0),
  /** Duration of each object in timescale units */
  deltaMediaTime: z.number().positive(),
  /** Start group ID (MOQT u62 varint; bigint after parse). */
  startGroupId: MoqtVarintSchema,
  /** Start object ID (MOQT u62 varint; bigint after parse). */
  startObjectId: MoqtVarintSchema.optional().transform((v) => v ?? 0n),
  /** Group increment per object (typically 0 or 1; signed bigint after parse). */
  deltaGroupId: MoqtVarintSignedSchema.optional().transform((v) => v ?? 0n),
  /** Object ID increment per object (typically 1; signed bigint after parse). */
  deltaObjectId: MoqtVarintSignedSchema.optional().transform((v) => v ?? 1n),
  /** Start wallclock time (epoch ms) */
  startWallclock: z.number().default(0),
  /** Wallclock increment per object (ms) */
  deltaWallclock: z.number().default(0),
});

/**
 * Location tuple `[groupId, objectId]`.
 *
 * Uses `z.input` so callers may hand in plain `number` for small values
 * (the JSON wire form for values ≤ 2^53-1) and `bigint` / decimal string
 * for values > 2^53-1. Schema output after `.parse` is always
 * `[bigint, bigint]`; use `z.infer<typeof LocationRefSchema>` if you need
 * the strictly-typed post-parse shape.
 */
export type LocationRef = z.input<typeof LocationRefSchema>;
export type MediaTimelineEntry = z.input<typeof MediaTimelineEntrySchema>;
export type EventTimelineEntry = z.input<typeof EventTimelineEntrySchema>;
export type MediaTimelineTemplateArray = z.input<typeof MediaTimelineTemplateArraySchema>;
/**
 * Template as accepted by builders / calculators.
 *
 * Uses `z.input` so callers may still hand in plain `number` for varint
 * fields (auto-coerced to `bigint` inside the schema/codec). Schema output
 * after `.parse` is always `bigint`; if you need the strictly-typed post-
 * parse shape, use `z.infer<typeof MediaTimelineTemplateSchema>` directly.
 */
export type MediaTimelineTemplate = z.input<typeof MediaTimelineTemplateSchema>;
