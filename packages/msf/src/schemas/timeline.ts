// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Timeline schema definitions
 *
 * Defines schemas for media and event timeline track packaging.
 */

import { z } from 'zod';

/**
 * Location reference: [groupId, objectId]
 */
export const LocationRefSchema = z.tuple([
  z.number().int().nonnegative(),
  z.number().int().nonnegative(),
]);

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
 * Event timeline entry per MSF spec
 * Only one temporal index (t, l, or m) should be present per record
 */
export const EventTimelineEntrySchema = z.object({
  /** Wallclock time (milliseconds since Unix epoch) */
  t: z.number().optional(),
  /** Location reference [groupId, objectId] */
  l: LocationRefSchema.optional(),
  /** Media time (milliseconds) */
  m: z.number().optional(),
  /** Event-specific data (structure defined by track's eventType) */
  data: z.record(z.unknown()).optional(),
});

/**
 * Media timeline template per MSF spec
 * 6-element array: [startMediaTime, deltaMediaTime, [startGroupID, startObjectID],
 *                   [deltaGroupID, deltaObjectID], startWallclock, deltaWallclock]
 */
export const MediaTimelineTemplateArraySchema = z.tuple([
  z.number(), // startMediaTime
  z.number(), // deltaMediaTime (duration per object)
  LocationRefSchema, // [startGroupID, startObjectID]
  z.tuple([z.number().int(), z.number().int()]), // [deltaGroupID, deltaObjectID] - increments
  z.number(), // startWallclock (epoch ms)
  z.number(), // deltaWallclock (ms per object)
]);

/**
 * Object-based template for easier programmatic use
 */
export const MediaTimelineTemplateSchema = z.object({
  /** Start media time in timescale units */
  startMediaTime: z.number().nonnegative().default(0),
  /** Duration of each object in timescale units */
  deltaMediaTime: z.number().positive(),
  /** Start group ID */
  startGroupId: z.number().int().nonnegative(),
  /** Start object ID */
  startObjectId: z.number().int().nonnegative().default(0),
  /** Group increment per object (typically 0 or 1) */
  deltaGroupId: z.number().int().default(0),
  /** Object ID increment per object (typically 1) */
  deltaObjectId: z.number().int().default(1),
  /** Start wallclock time (epoch ms) */
  startWallclock: z.number().default(0),
  /** Wallclock increment per object (ms) */
  deltaWallclock: z.number().default(0),
});

export type LocationRef = z.infer<typeof LocationRefSchema>;
export type MediaTimelineEntry = z.infer<typeof MediaTimelineEntrySchema>;
export type EventTimelineEntry = z.infer<typeof EventTimelineEntrySchema>;
export type MediaTimelineTemplateArray = z.infer<typeof MediaTimelineTemplateArraySchema>;
export type MediaTimelineTemplate = z.infer<typeof MediaTimelineTemplateSchema>;
