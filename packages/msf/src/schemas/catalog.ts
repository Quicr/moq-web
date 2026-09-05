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
 * Reserved field names on the catalog root (MSF §5).
 *
 * §4 forbids custom fields from colliding with reserved names. We keep the
 * list flat here (not derived from `.shape`) because the superRefine runs on
 * the already-parsed object and derivation would require dropping
 * `.passthrough()` on the track schemas.
 */
export const RESERVED_CATALOG_ROOT_FIELDS = new Set<string>([
  'version',
  'generatedAt',
  'isComplete',
  'deltaUpdate',
  'tracks',
  'publishTracks',
  'initDataList',
  'addTracks',
  'removeTracks',
  'cloneTracks',
  'updateTracks',
  'MSF_COMPRESSION',
]);

/**
 * Reserved track-object field names (MSF §6).
 *
 * Same rationale as {@link RESERVED_CATALOG_ROOT_FIELDS}: kept as a flat set so
 * name-collision checks stay decoupled from Zod's shape internals. Update this
 * list when adding a new spec-defined field to a track schema.
 */
export const RESERVED_TRACK_FIELDS = new Set<string>([
  'name',
  'packaging',
  'isLive',
  'namespace',
  'codec',
  'role',
  'renderGroup',
  'altGroup',
  'targetLatency',
  'buffers',
  'label',
  'depends',
  'initData',
  'initRef',
  'mimeType',
  'lang',
  'temporalId',
  'spatialId',
  'timescale',
  'trackDuration',
  'totalGroups',
  'gopDuration',
  'avgBitrate',
  'maxGopDuration',
  'maxGroupDuration',
  'timelineTemplate',
  'eventType',
  'authInfo',
  'connectionUri',
  'token',
  'MSF_COMPRESSION',
  // Video
  'width',
  'height',
  'displayWidth',
  'displayHeight',
  'framerate',
  'bitrate',
  // Audio
  'samplerate',
  'channelConfig',
  'audioSpecificConfig',
  // Encryption
  'encryptionScheme',
  'cipherSuite',
  'keyId',
  'trackBaseKey',
  // Accessibility
  'accessibility',
  'scte35',
  // Delta targeting
  'parentName',
  'parentNamespace',
  'sourceName',
  'overrides',
]);

/**
 * Custom field names MUST use reverse-DNS notation to avoid collision with
 * future reserved names (MSF §4). Recognised: `com.example.custom` etc.
 */
const REVERSE_DNS_RE = /^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z][A-Za-z0-9-]*){2,}$/;

function isReverseDns(key: string): boolean {
  return REVERSE_DNS_RE.test(key);
}

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
 *
 * `.passthrough()` keeps unknown top-level fields so the §4 name-collision
 * refine can inspect them. Delta catalogs override this with `.strict()`.
 */
export const CatalogMetadataSchema = z
  .object({
    /** MSF version number */
    version: z.literal(MSF_VERSION),
    /** Whether this is a delta update */
    deltaUpdate: z.boolean().optional(),
    /** Generation timestamp (epoch milliseconds) */
    generatedAt: z.number().optional(),
    /**
     * Whether the catalog is complete (all tracks known).
     * §5.6: MUST NOT be included if it is FALSE — only `true` or omission are
     * legal. This schema rejects an explicit `false`.
     */
    isComplete: z.literal(true).optional(),
    /**
     * Compression applied to catalog OBJECTS in this track (§9).
     * The catalog root document itself is always JSON, but subsequent objects
     * MAY be compressed with this algorithm.
     */
    MSF_COMPRESSION: CompressionAlgorithmEnum.optional(),
  })
  .passthrough();

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

  // §2: Tracks sharing an altGroup MUST be time-aligned. The strongest
  // structural check we can perform without media inspection is that they
  // agree on `timescale` and (for VOD) `trackDuration` — otherwise the
  // subscriber cannot switch between them at Group boundaries.
  const byAltGroup = new Map<number, { index: number; track: (typeof cat.tracks)[number] }[]>();
  cat.tracks.forEach((t, i) => {
    if (t.altGroup === undefined) return;
    const bucket = byAltGroup.get(t.altGroup) ?? [];
    bucket.push({ index: i, track: t });
    byAltGroup.set(t.altGroup, bucket);
  });
  for (const bucket of byAltGroup.values()) {
    if (bucket.length < 2) continue;
    const first = bucket[0]!.track;
    for (let k = 1; k < bucket.length; k++) {
      const { index, track } = bucket[k]!;
      if (
        first.timescale !== undefined &&
        track.timescale !== undefined &&
        first.timescale !== track.timescale
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `altGroup=${first.altGroup} tracks MUST share \`timescale\` for time-aligned switching (MSF §2)`,
          path: ['tracks', index, 'timescale'],
        });
      }
      if (
        first.isLive === false &&
        track.isLive === false &&
        first.trackDuration !== undefined &&
        track.trackDuration !== undefined &&
        first.trackDuration !== track.trackDuration
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `altGroup=${first.altGroup} VOD tracks MUST share \`trackDuration\` for time-aligned switching (MSF §2)`,
          path: ['tracks', index, 'trackDuration'],
        });
      }
    }
  }

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

  // §4: Custom (extra) fields MUST use reverse-DNS notation and MUST NOT
  // collide with reserved spec names. Check both the root catalog object and
  // every track object we can see.
  for (const key of Object.keys(cat)) {
    if (RESERVED_CATALOG_ROOT_FIELDS.has(key)) continue;
    if (!isReverseDns(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `custom catalog field '${key}' MUST use reverse-DNS notation (MSF §4)`,
        path: [key],
      });
    }
  }
  const checkTrackExtras = (
    tracks: readonly Record<string, unknown>[] | undefined,
    parentPath: 'tracks' | 'publishTracks'
  ): void => {
    tracks?.forEach((t, i) => {
      for (const key of Object.keys(t)) {
        if (RESERVED_TRACK_FIELDS.has(key)) continue;
        if (!isReverseDns(key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `custom track field '${key}' MUST use reverse-DNS notation (MSF §4)`,
            path: [parentPath, i, key],
          });
        }
      }
    });
  };
  checkTrackExtras(
    cat.tracks as unknown as Record<string, unknown>[],
    'tracks'
  );
  checkTrackExtras(
    cat.publishTracks as unknown as Record<string, unknown>[] | undefined,
    'publishTracks'
  );

  // §12: eventtimeline tracks that reference a media timeline MUST list the
  // referenced timeline in `depends`. We can't see individual record `l:`
  // targets from the catalog, but we can enforce that `depends` (when
  // present on an eventtimeline track) actually resolves to catalog tracks.
  const knownTrackNames = new Set(cat.tracks.map((t) => t.name));
  cat.tracks.forEach((t, i) => {
    if (t.packaging !== 'eventtimeline') return;
    t.depends?.forEach((depName, k) => {
      if (!knownTrackNames.has(depName)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `eventtimeline track '${t.name}' depends on '${depName}' which is not declared in \`tracks\` (MSF §12)`,
          path: ['tracks', i, 'depends', k],
        });
      }
    });
  });
  // §11 already enforces that mediatimeline tracks declare non-empty
  // `depends`; here we additionally verify the referenced tracks exist.
  cat.tracks.forEach((t, i) => {
    if (t.packaging !== 'mediatimeline') return;
    t.depends?.forEach((depName, k) => {
      if (!knownTrackNames.has(depName)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `mediatimeline track '${t.name}' depends on '${depName}' which is not declared in \`tracks\` (MSF §11)`,
          path: ['tracks', i, 'depends', k],
        });
      }
    });
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
 * concurrent patches. Delta roots MUST NOT carry any fields other than the
 * spec-listed keys (§7), so this schema is `.strict()` — unknown keys are
 * rejected up-front.
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
}).strict();

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
