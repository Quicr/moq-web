// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Track definition schema
 *
 * Defines the complete track schema combining base fields with
 * video, audio, encryption, and accessibility extensions.
 */

import { z } from 'zod';
import { VideoFieldsSchema } from './video-track.js';
import { AudioFieldsSchema } from './audio-track.js';
import { EncryptionFieldsSchema } from './encryption.js';
import { AccessibilityFieldsSchema } from './accessibility.js';
import { MediaTimelineTemplateSchema } from './timeline.js';

/**
 * Track packaging types (MSF §6, Table 2)
 */
export const PackagingEnum = z.enum([
  'loc',
  'mediatimeline',
  'eventtimeline',
  'moqlog',
  'moqmetrics',
  'catalog',
]);

/**
 * Track role identifiers (MSF §6, Table 4)
 */
export const TrackRoleEnum = z.enum([
  // Spec-reserved roles (§6, Table 4)
  'audiodescription',
  'video',
  'audio',
  'mediatimeline',
  'eventtimeline',
  'caption',
  'subtitle',
  'signlanguage',
  'log',
  'metrics',
  'data',
  // Widely-used extensions (not in Table 4 but commonly seen)
  'main',
  'alternate',
  'supplementary',
  'commentary',
  'dub',
  'emergency',
  // Legacy aliases kept for backwards compatibility
  'sign-language',
  'metadata',
  'logs',
]);

/**
 * Base track fields required for all track types
 */
export const BaseTrackFieldsSchema = z.object({
  /** Track name (unique within namespace) */
  name: z.string().min(1),
  /** Track packaging type */
  packaging: PackagingEnum,
  /** Whether the track is live (unbounded) or VOD (bounded) */
  isLive: z.boolean(),
});

/**
 * Buffer target/min/max durations in milliseconds (§6, `buffers`).
 * Mutually exclusive with `targetLatency`.
 */
export const BuffersSchema = z.object({
  /** Target playback buffer in milliseconds. */
  target: z.number().nonnegative(),
  /** Minimum playback buffer in milliseconds. */
  min: z.number().nonnegative().optional(),
  /** Maximum playback buffer in milliseconds. */
  max: z.number().nonnegative().optional(),
});

/**
 * Authorization info blob attached to a track (§6, `authInfo`; §17 Table 7).
 * `scheme` uses reserved values (`privacy-pass`, `cat`) or reverse-DNS custom
 * identifiers; extra scheme-specific fields ride along via passthrough.
 */
export const AuthInfoSchema = z
  .object({
    scheme: z.string().min(1),
  })
  .passthrough();

/**
 * Common optional track fields
 */
export const CommonTrackFieldsSchema = z.object({
  /** Track namespace (array of strings) */
  namespace: z.array(z.string()).optional(),
  /** Codec string (e.g., 'avc1.4D401E', 'opus') */
  codec: z.string().optional(),
  /** Track role */
  role: TrackRoleEnum.optional(),
  /** Render group identifier for sync */
  renderGroup: z.number().int().nonnegative().optional(),
  /** Alt group identifier for switching */
  altGroup: z.number().int().nonnegative().optional(),
  /** Target latency in milliseconds (§6). MUST NOT be combined with `buffers`. */
  targetLatency: z.number().int().nonnegative().optional(),
  /** Buffer target/min/max in milliseconds (§6). MUST NOT be combined with `targetLatency`. */
  buffers: BuffersSchema.optional(),
  /** Human-readable label */
  label: z.string().optional(),
  /** Track dependencies (names of tracks this depends on) */
  depends: z.array(z.string()).optional(),
  /** Base64-encoded initialization data */
  initData: z.string().optional(),
  /** Reference to an entry in the catalog `initDataList` (§6 `initRef`). */
  initRef: z.string().min(1).optional(),
  /** MIME type */
  mimeType: z.string().optional(),
  /** BCP 47 language code */
  lang: z.string().optional(),
  /** Temporal layer ID for SVC */
  temporalId: z.number().int().nonnegative().optional(),
  /** Spatial layer ID for SVC */
  spatialId: z.number().int().nonnegative().optional(),
  /** Timescale (units per second) */
  timescale: z.number().int().positive().optional(),
  /** Track duration in timescale units (for VOD) */
  trackDuration: z.number().int().nonnegative().optional(),
  /** Total number of groups/GOPs (for VOD) */
  totalGroups: z.number().int().nonnegative().optional(),
  /** GOP duration in milliseconds (for VOD pacing) */
  gopDuration: z.number().positive().optional(),
  /** Average bitrate over the lifetime of the track (§6 `avgBitrate`). */
  avgBitrate: z.number().int().positive().optional(),
  /** Maximum milliseconds between random-access points (§6 `maxGopDuration`). */
  maxGopDuration: z.number().int().positive().optional(),
  /** Maximum milliseconds of any MOQT Group in the track (§6 `maxGroupDuration`). */
  maxGroupDuration: z.number().int().positive().optional(),
  /** Media timeline template for fixed-duration content */
  timelineTemplate: MediaTimelineTemplateSchema.optional(),
  /** Event type for eventtimeline tracks (defines data structure) */
  eventType: z.string().optional(),
  /** Authorization info for the track (§6 `authInfo`, §17 Table 7). */
  authInfo: AuthInfoSchema.optional(),
  /** MOQT connection endpoint URI for a publishTracks entry (§6 `connectionUri`). */
  connectionUri: z.string().min(1).optional(),
  /** Authorization token/credential for a publishTracks entry (§6 `token`). */
  token: z.string().min(1).optional(),
});

/**
 * Track object shape as a plain ZodObject.
 *
 * Prefer {@link TrackSchema} for parse/validate; use this base when you need
 * `.partial()`, `.omit()`, or `.extend()` (e.g. for the clone-overrides shape).
 */
export const TrackObjectSchema = BaseTrackFieldsSchema.merge(CommonTrackFieldsSchema)
  .merge(VideoFieldsSchema)
  .merge(AudioFieldsSchema)
  .merge(EncryptionFieldsSchema)
  .merge(AccessibilityFieldsSchema);

/**
 * Complete track definition schema, including cross-field spec invariants.
 */
export const TrackSchema = TrackObjectSchema.superRefine((track, ctx) => {
  // §6: buffers and targetLatency are mutually exclusive.
  if (track.buffers !== undefined && track.targetLatency !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        '`buffers` and `targetLatency` are mutually exclusive per MSF §6',
      path: ['buffers'],
    });
  }
});

/**
 * Track for clone operation (only name required)
 */
export const CloneTrackSchema = z.object({
  /** Source track name to clone from */
  sourceName: z.string().min(1),
  /** New track name */
  name: z.string().min(1),
  /** Fields to override in the cloned track */
  overrides: TrackObjectSchema.partial().omit({ name: true }).optional(),
});

export type Packaging = z.infer<typeof PackagingEnum>;
export type TrackRole = z.infer<typeof TrackRoleEnum>;
export type Track = z.infer<typeof TrackSchema>;
export type CloneTrack = z.infer<typeof CloneTrackSchema>;
export type Buffers = z.infer<typeof BuffersSchema>;
export type AuthInfo = z.infer<typeof AuthInfoSchema>;
