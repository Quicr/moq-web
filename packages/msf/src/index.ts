// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview MOQT Streaming Format (MSF) Library
 *
 * MSF provides JSON catalogs for LOC-compliant media delivery over MOQT.
 * This package implements the MSF specification with support for:
 *
 * - Catalog creation and validation (Zod schemas)
 * - Delta updates for efficient catalog synchronization
 * - Media and event timelines
 * - URL encoding for track references
 * - Session integration for catalog publication/subscription
 *
 * @packageDocumentation
 *
 * @example
 * ```typescript
 * import {
 *   createCatalog,
 *   parseCatalog,
 *   createMSFSession,
 * } from '@web-moq/msf';
 *
 * // Build a catalog
 * const catalog = createCatalog()
 *   .generatedAt()
 *   .addVideoTrack({
 *     name: 'video-main',
 *     codec: 'avc1.4D401E',
 *     width: 1280, height: 720,
 *     framerate: 30, bitrate: 2_000_000,
 *     isLive: true,
 *   })
 *   .addAudioTrack({
 *     name: 'audio-main',
 *     codec: 'opus',
 *     samplerate: 48000,
 *     channelConfig: 'stereo',
 *     isLive: true,
 *   })
 *   .build();
 *
 * // Use with a MOQT session
 * const msfSession = createMSFSession(moqtSession, ['conference', 'room-1']);
 * await msfSession.startCatalogPublishing();
 * await msfSession.publishCatalog(catalog);
 * ```
 */

// Version constant
export { MSF_VERSION, CATALOG_TRACK_NAME } from './version.js';

// ============================================================================
// Schemas (Zod validation)
// ============================================================================

export {
  // Catalog schemas
  CatalogMetadataSchema,
  FullCatalogSchema,
  DeltaCatalogSchema,
  CatalogSchema,
  isDeltaCatalog,
  isFullCatalog,
  // Track schemas
  PackagingEnum,
  TrackRoleEnum,
  BaseTrackFieldsSchema,
  CommonTrackFieldsSchema,
  TrackSchema,
  CloneTrackSchema,
  // Video/Audio schemas
  VideoFieldsSchema,
  AudioFieldsSchema,
  ChannelConfigEnum,
  // Timeline schemas
  LocationRefSchema,
  MediaTimelineEntrySchema,
  EventTimelineEntrySchema,
  MediaTimelineTemplateSchema,
  MediaTimelineTemplateArraySchema,
  // Encryption schemas
  EncryptionSchemeEnum,
  CipherSuiteEnum,
  KeyIdSchema,
  TrackBaseKeySchema,
  EncryptionFieldsSchema,
  // Accessibility schemas (PR #133)
  AccessibilityTypeEnum,
  AccessibilitySchema,
  Scte35Schema,
  AccessibilityFieldsSchema,
} from './schemas/index.js';

// ============================================================================
// Types
// ============================================================================

export type {
  // Catalog types
  CatalogMetadata,
  FullCatalog,
  DeltaCatalog,
  Catalog,
  // Track types
  Packaging,
  TrackRole,
  Track,
  CloneTrack,
  // Video/Audio types
  VideoFields,
  ChannelConfig,
  AudioFields,
  // Timeline types
  LocationRef,
  MediaTimelineEntry,
  EventTimelineEntry,
  MediaTimelineTemplate,
  MediaTimelineTemplateArray,
  // Encryption types
  EncryptionScheme,
  CipherSuite,
  EncryptionFields,
  // Accessibility types
  AccessibilityType,
  Accessibility,
  Scte35,
  AccessibilityFields,
} from './schemas/index.js';

export type {
  VideoTrackInput,
  AudioTrackInput,
  DataTrackInput,
} from './types/index.js';

// ============================================================================
// Catalog operations
// ============================================================================

export {
  // Builder
  CatalogBuilder,
  createCatalog,
  // Parser
  CatalogParseError,
  parseCatalog,
  validateCatalog,
  parseFullCatalog,
  parseDeltaCatalog,
  tryParseCatalog,
  parseCatalogFromBytes,
  // qdroid interop
  parseQdroidCatalog,
  parseQdroidCatalogFromBytes,
  decodeQdroidNamespace,
  normalizeQdroidCatalog,
  // Serializer
  serializeCatalog,
  serializeCatalogToBytes,
  type SerializeOptions,
  // Delta
  DeltaError,
  generateDelta,
  applyDelta,
  DeltaBuilder,
  createDelta,
  type DeltaOptions,
} from './catalog/index.js';

// ============================================================================
// Timeline operations
// ============================================================================

export {
  // Media timeline
  MediaTimelineError,
  encodeMediaTimelineEntry,
  decodeMediaTimelineEntry,
  encodeMediaTimeline,
  decodeMediaTimeline,
  serializeMediaTimeline,
  parseMediaTimeline,
  findLocationForTime,
  findTimeForLocation,
  type MediaTimelinePoint,
  // Event timeline
  EventTimelineError,
  encodeEventTimelineEntry,
  decodeEventTimelineEntry,
  encodeEventTimeline,
  decodeEventTimeline,
  serializeEventTimeline,
  parseEventTimeline,
  createWallclockEvent,
  createLocationEvent,
  createMediaTimeEvent,
  createCompositeEvent,
  type EventTimelinePoint,
  // Timeline template
  TimelineTemplateError,
  MediaTimelineCalculator,
  createVideoTemplate,
  createAudioTemplate,
  templateFromArray,
  templateToArray,
} from './timeline/index.js';

// ============================================================================
// URL handling (PR #87)
// ============================================================================

export {
  // Encoder
  NamespaceEncoderError,
  encodeElement,
  decodeElement,
  encodeNamespace,
  decodeNamespace,
  encodeTrackReference,
  decodeTrackReference,
  type TrackReference,
  // Parser
  MsfUrlError,
  parseMsfUrl,
  generateMsfUrl,
  generateCatalogUrl,
  extractTrackReference,
  buildFragment,
  buildNamespaceFragment,
  type MsfUrl,
} from './url/index.js';

// ============================================================================
// Session integration
// ============================================================================

export {
  // Group numbering
  EpochGroupNumbering,
  SequentialGroupNumbering,
  createGroupNumbering,
  type GroupNumberingStrategy,
  // Catalog track
  CatalogTrackError,
  CatalogSubscriber,
  CatalogPublisher,
  createCatalogSubscriber,
  createCatalogPublisher,
  type CatalogCallback,
  type CatalogSubscribeOptions,
  type CatalogPublishOptions,
  // MSF session
  MSFSession,
  createMSFSession,
  type MSFSessionConfig,
  type TrackInfo,
  type PublishedTrackInfo,
} from './session/index.js';
