// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview MSF Catalog schema
 *
 * Defines the root catalog schema for MSF track discovery.
 */

import { z } from 'zod';
import { MSF_VERSION } from '../version.js';
import { TrackSchema, CloneTrackSchema } from './track.js';

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
});

/**
 * Full catalog (independent object in group)
 */
export const FullCatalogSchema = CatalogMetadataSchema.extend({
  /** All tracks in this catalog */
  tracks: z.array(TrackSchema),
  /** Delta fields should not be present in full catalog */
  deltaUpdate: z.literal(false).optional(),
});

/**
 * Delta catalog update (dependent object in group)
 */
export const DeltaCatalogSchema = CatalogMetadataSchema.extend({
  /** Must be true for delta updates */
  deltaUpdate: z.literal(true),
  /** Tracks to add */
  addTracks: z.array(TrackSchema).optional(),
  /** Track names to remove */
  removeTracks: z.array(z.string()).optional(),
  /** Tracks to clone */
  cloneTracks: z.array(CloneTrackSchema).optional(),
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
