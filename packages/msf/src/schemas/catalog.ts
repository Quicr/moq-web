// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview MSF Catalog schema
 *
 * Defines the root catalog schema for MSF track discovery.
 */

import { z } from 'zod';
import { MSF_VERSION } from '../version.js';
import { TrackSchema, TrackObjectSchema, CloneTrackSchema } from './track.js';

/**
 * Initialization data list entry (MSF §5, `initDataList`).
 *
 * A single reference to init data that tracks can point at via `initRef`.
 * The catalog spec models this as a JSON object; concrete shape is opaque
 * (base64 blob, URI, or codec-specific fields) so we validate loosely and
 * only require an `id` that `initRef` can match on.
 */
export const InitDataEntrySchema = z
  .object({
    /** Identifier that tracks reference via `initRef`. */
    id: z.string().min(1),
    /** Optional base64-encoded init blob. */
    data: z.string().optional(),
    /** Optional URI pointing at init data. */
    uri: z.string().optional(),
    /** Optional MIME type describing the init payload. */
    mimeType: z.string().optional(),
  })
  .passthrough();

/**
 * MSF §9 `MSF_COMPRESSION` values.
 */
export const CompressionAlgorithmEnum = z.enum([
  'identity',
  'gzip',
  'deflate',
]);

/**
 * Catalog metadata fields
 */
export const CatalogMetadataSchema = z.object({
  /** MSF version number */
  version: z.literal(MSF_VERSION),
  /** Whether this is a delta update */
  deltaUpdate: z.boolean().optional(),
  /** Generation timestamp (epoch milliseconds) */
  generatedAt: z.number().optional(),
  /** Whether the catalog is complete (all tracks known) */
  isComplete: z.boolean().optional(),
  /**
   * Compression applied to catalog OBJECTS in this track (§9).
   * The catalog root document itself is always JSON, but subsequent objects
   * MAY be compressed with this algorithm.
   */
  MSF_COMPRESSION: CompressionAlgorithmEnum.optional(),
});

/**
 * Full catalog (independent object in group)
 *
 * §13.5 / §14.5: `moqlog` / `moqmetrics` tracks MUST live in `publishTracks`
 * (not the main `tracks` array), with the expected role, and MUST NOT appear
 * in the main tracks list.
 */
export const FullCatalogSchema = CatalogMetadataSchema.extend({
  /** All tracks in this catalog */
  tracks: z.array(TrackSchema),
  /** Delta fields should not be present in full catalog */
  deltaUpdate: z.literal(false).optional(),
  /** Tracks the subscriber may publish back on this session (§5). */
  publishTracks: z.array(TrackSchema).optional(),
  /** Init data references pointed at by track `initRef` fields (§5). */
  initDataList: z.array(InitDataEntrySchema).optional(),
}).superRefine((cat, ctx) => {
  // §13.5 / §14.5: moqlog + moqmetrics tracks belong in publishTracks only.
  cat.tracks.forEach((t, i) => {
    if (t.packaging === 'moqlog' || t.packaging === 'moqmetrics') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `packaging=\`${t.packaging}\` tracks MUST be declared in \`publishTracks\`, not \`tracks\` (MSF §13.5/§14.5)`,
        path: ['tracks', i, 'packaging'],
      });
    }
  });

  // §13.5 / §14.5: role must match packaging for moqlog / moqmetrics.
  cat.publishTracks?.forEach((t, i) => {
    if (t.packaging === 'moqlog' && t.role !== undefined && t.role !== 'log') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'packaging=`moqlog` tracks MUST have role=`log` (MSF §13.5)',
        path: ['publishTracks', i, 'role'],
      });
    }
    if (
      t.packaging === 'moqmetrics' &&
      t.role !== undefined &&
      t.role !== 'metrics'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'packaging=`moqmetrics` tracks MUST have role=`metrics` (MSF §14.5)',
        path: ['publishTracks', i, 'role'],
      });
    }
  });
});

/**
 * `update` delta operation (MSF §7).
 *
 * Targets an existing track by `parentName` (+ optional `parentNamespace`)
 * and applies a partial patch. Any subset of track fields may be included
 * except `name` (that's what identifies the target).
 */
export const UpdateTrackSchema = z
  .object({
    /** Name of the track to update. */
    parentName: z.string().min(1),
    /** Optional namespace scope for the target track. */
    parentNamespace: z.array(z.string()).optional(),
  })
  .merge(TrackObjectSchema.partial().omit({ name: true }));

/**
 * Delta catalog update (dependent object in group)
 *
 * §7: `generatedAt` is REQUIRED on delta updates so subscribers can order
 * concurrent patches.
 */
export const DeltaCatalogSchema = CatalogMetadataSchema.extend({
  /** Must be true for delta updates */
  deltaUpdate: z.literal(true),
  /** Generation timestamp (epoch milliseconds); REQUIRED on delta updates. */
  generatedAt: z.number(),
  /** Tracks to add */
  addTracks: z.array(TrackSchema).optional(),
  /** Track names to remove */
  removeTracks: z.array(z.string()).optional(),
  /** Tracks to clone */
  cloneTracks: z.array(CloneTrackSchema).optional(),
  /** Track patches to apply in place (MSF §7 `update`). */
  updateTracks: z.array(UpdateTrackSchema).optional(),
});

/**
 * Union schema for any catalog (full or delta)
 */
export const CatalogSchema = z.union([FullCatalogSchema, DeltaCatalogSchema]);

/**
 * Type guard for delta catalogs
 */
export function isDeltaCatalog(
  catalog: Catalog
): catalog is z.infer<typeof DeltaCatalogSchema> {
  return catalog.deltaUpdate === true;
}

/**
 * Type guard for full catalogs
 */
export function isFullCatalog(
  catalog: Catalog
): catalog is z.infer<typeof FullCatalogSchema> {
  return !catalog.deltaUpdate;
}

export type CatalogMetadata = z.infer<typeof CatalogMetadataSchema>;
export type FullCatalog = z.infer<typeof FullCatalogSchema>;
export type DeltaCatalog = z.infer<typeof DeltaCatalogSchema>;
export type Catalog = z.infer<typeof CatalogSchema>;
export type InitDataEntry = z.infer<typeof InitDataEntrySchema>;
export type UpdateTrack = z.infer<typeof UpdateTrackSchema>;
export type CompressionAlgorithm = z.infer<typeof CompressionAlgorithmEnum>;
