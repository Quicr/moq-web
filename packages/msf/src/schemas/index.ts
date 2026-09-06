// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview MSF Schema exports
 *
 * Re-exports all Zod schemas and their inferred types.
 */

// Catalog schemas
export {
  CatalogMetadataSchema,
  FullCatalogSchema,
  DeltaCatalogSchema,
  CatalogSchema,
  InitDataEntrySchema,
  UpdateTrackSchema,
  CompressionAlgorithmEnum,
  RESERVED_CATALOG_ROOT_FIELDS,
  RESERVED_TRACK_FIELDS,
  isDeltaCatalog,
  isFullCatalog,
} from './catalog.js';

export type {
  CatalogMetadata,
  FullCatalog,
  DeltaCatalog,
  Catalog,
  InitDataEntry,
  UpdateTrack,
  CompressionAlgorithm,
} from './catalog.js';

// Track schemas
export {
  PackagingEnum,
  TrackRoleEnum,
  BaseTrackFieldsSchema,
  CommonTrackFieldsSchema,
  TrackObjectSchema,
  TrackSchema,
  CloneTrackSchema,
  BuffersSchema,
  AuthInfoSchema,
  AuthSchemeSchema,
  RESERVED_AUTH_SCHEMES,
} from './track.js';

export type {
  Packaging,
  TrackRole,
  Track,
  CloneTrack,
  Buffers,
  AuthInfo,
} from './track.js';

// Video track fields
export { VideoFieldsSchema } from './video-track.js';
export type { VideoFields } from './video-track.js';

// Audio track fields
export { AudioFieldsSchema, ChannelConfigEnum } from './audio-track.js';
export type { ChannelConfig, AudioFields } from './audio-track.js';

// Timeline schemas
export {
  LocationRefSchema,
  MediaTimelineEntrySchema,
  EventTimelineEntrySchema,
  MediaTimelineTemplateSchema,
  MediaTimelineTemplateArraySchema,
} from './timeline.js';

export type {
  LocationRef,
  MediaTimelineEntry,
  EventTimelineEntry,
  MediaTimelineTemplate,
  MediaTimelineTemplateArray,
} from './timeline.js';

// Encryption schemas
export {
  EncryptionSchemeEnum,
  CipherSuiteEnum,
  KeyIdSchema,
  TrackBaseKeySchema,
  EncryptionFieldsSchema,
  RECOMMENDED_ENCRYPTION_SCHEME,
} from './encryption.js';

export type { EncryptionScheme, CipherSuite, EncryptionFields } from './encryption.js';

// Accessibility schemas (MSF §16)
export {
  AccessibilityScheme,
  AccessibilitySchemeSchema,
  AccessibilityValueSchema,
  AccessibilitySchema,
  Scte35Schema,
  AccessibilityFieldsSchema,
  AccessibilityTypeEnum,
} from './accessibility.js';

export type {
  AccessibilityType,
  Accessibility,
  Scte35,
  AccessibilityFields,
} from './accessibility.js';

// Immutability guards (MSF §5.6, §6)
export {
  CatalogImmutabilityError,
  assertCatalogImmutability,
} from './immutability.js';
