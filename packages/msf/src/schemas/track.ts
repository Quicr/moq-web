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
 * Track packaging types
 */
export const PackagingEnum = z.enum(['loc', 'mediatimeline', 'eventtimeline']);

/**
 * Track role identifiers (including PR #121 additions)
 */
export const TrackRoleEnum = z.enum([
  'main',
  'alternate',
  'supplementary',
  'commentary',
  'dub',
  'emergency',
  'caption',
  'subtitle',
  'sign-language',
  'metadata',
  // PR #121: Logs/Metrics track roles
  'logs',
  'metrics',
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
  /** Target latency in milliseconds */
  targetLatency: z.number().int().nonnegative().optional(),
  /** Human-readable label */
  label: z.string().optional(),
  /** Track dependencies (names of tracks this depends on) */
  depends: z.array(z.string()).optional(),
  /** Base64-encoded initialization data */
  initData: z.string().optional(),
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
  /** Media timeline template for fixed-duration content */
  timelineTemplate: MediaTimelineTemplateSchema.optional(),
  /** Event type for eventtimeline tracks (defines data structure) */
  eventType: z.string().optional(),
});

/**
 * Complete track definition schema
 */
export const TrackSchema = BaseTrackFieldsSchema.merge(CommonTrackFieldsSchema)
  .merge(VideoFieldsSchema)
  .merge(AudioFieldsSchema)
  .merge(EncryptionFieldsSchema)
  .merge(AccessibilityFieldsSchema);

/**
 * Track for clone operation (only name required)
 */
export const CloneTrackSchema = z.object({
  /** Source track name to clone from */
  sourceName: z.string().min(1),
  /** New track name */
  name: z.string().min(1),
  /** Fields to override in the cloned track */
  overrides: TrackSchema.partial().omit({ name: true }).optional(),
});

export type Packaging = z.infer<typeof PackagingEnum>;
export type TrackRole = z.infer<typeof TrackRoleEnum>;
export type Track = z.infer<typeof TrackSchema>;
export type CloneTrack = z.infer<typeof CloneTrackSchema>;
