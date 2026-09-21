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
 * ## JSON bigint contract (Wave 3 Track J)
 *
 * Wave 2 Track F migrated MOQT 62-bit varints (`groupId`, `objectId`,
 * subscribe aliases, expiries, capture-nanosecond timestamps, …) from
 * `number` to `bigint` end-to-end across session/media/core. MSF documents
 * (§5 catalogs, §11 media timelines, §12 event timelines, §13 moqlog,
 * §14 moqmetrics) transit as JSON, and JSON has **no bigint type** —
 * values > `Number.MAX_SAFE_INTEGER` (2^53-1) silently lose precision if
 * serialized as plain numbers.
 *
 * Every u62 wire field in this package therefore accepts a JSON `number`
 * (values ≤ 2^53-1), a JSON decimal `string` (any u62), or a native
 * `bigint`, and the schema transforms all forms to `bigint` on parse.
 * Codec paths (encode/decode/serialize helpers) additionally preserve the
 * caller-provided form for pre-Wave-3 wire compatibility: small numeric
 * values stay as JSON `number`, and only values that would overflow are
 * emitted as JSON strings. See {@link ./schemas/timeline.ts} for the full
 * contract and {@link ./schemas/bigint-json.test.ts} for the round-trip
 * verification suite.
 *
 * @packageDocumentation
 *
 * @example
 * ```typescript
 * import {
 *   createCatalog,
 *   parseCatalog,
 *   createMSFSession,
 * } from '@moq-web/msf';
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
  InitDataEntrySchema,
  UpdateTrackSchema,
  CompressionAlgorithmEnum,
  isDeltaCatalog,
  isFullCatalog,
  // Track schemas
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
  RECOMMENDED_ENCRYPTION_SCHEME,
  // Accessibility schemas (MSF §16)
  AccessibilityScheme,
  AccessibilitySchemeSchema,
  AccessibilityValueSchema,
  AccessibilitySchema,
  Scte35Schema,
  AccessibilityFieldsSchema,
  AccessibilityTypeEnum,
  // Immutability guards (§5.6, §6)
  CatalogImmutabilityError,
  assertCatalogImmutability,
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
  InitDataEntry,
  UpdateTrack,
  CompressionAlgorithm,
  // Track types
  Packaging,
  TrackRole,
  Track,
  CloneTrack,
  Buffers,
  AuthInfo,
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
  parseCompressedCatalog,
  // Serializer
  serializeCatalog,
  serializeCatalogToBytes,
  serializeCompressedCatalog,
  type SerializeOptions,
  type CompressedSerializeOptions,
  // Delta
  DeltaError,
  generateDelta,
  applyDelta,
  DeltaBuilder,
  createDelta,
  type DeltaOptions,
  // Compression (§9)
  compressBytes,
  decompressBytes,
  CompressionError,
  COMPRESSION_ALGORITHMS,
  isCompressionAlgorithm,
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
  assertTemplateUnchanged,
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
  // Variable substitution (§8)
  VariableSubstitutionError,
  parseFragmentVariables,
  serializeFragmentVariables,
  substituteVariables,
  substituteVariablesDeep,
  extractVariableNames,
  isValidVariableName,
  isValidVariableValue,
} from './url/index.js';

// ============================================================================
// Security bridge (§3 moq-secure-objects integration)
// ============================================================================

export {
  CipherSuiteMappingError,
  MSF_TO_SO_CIPHER_SUITE,
  SO_TO_MSF_CIPHER_SUITE,
  toSoCipherSuite,
  toMsfCipherSuite,
  TrackSecurityError,
  isSecureObjectsTrack,
  createTrackContext,
  parseKeyIdToBigInt,
  MsfSecurityGateway,
  ENCRYPTED_PROPERTIES_EXTENSION_ID,
  trackRequiresGateway,
  type CreateTrackContextOptions,
  type SealedObject,
  type OpenedObject,
  type EncryptedPropertiesExtension,
} from './security/index.js';

// ============================================================================
// Publish tracks (§13 moqlog, §14 moqmetrics)
// ============================================================================

export {
  // Log track (§13)
  LOG_NAMESPACE_BASE,
  LogSeverity,
  logNamespace,
  encodeLogTrackName,
  decodeLogTrackName,
  logGroupIdFromMillis,
  logGroupIdFromMicros,
  LogEntrySchema,
  LogTrackError,
  type LogEntry,
  type LogLocation,
  // Metrics track (§14)
  METRICS_NAMESPACE_BASE,
  METRICS_HEADER_OBJECT_ID,
  MetricsGranularity,
  metricsNamespace,
  encodeMetricsTrackName,
  decodeMetricsTrackName,
  metricsGroupIdFromMillis,
  GaugeSchema,
  CounterSchema,
  MetricValueSchema,
  MetricsHeaderSchema,
  MetricRecordSchema,
  MetricsTrackError,
  type Gauge,
  type Counter,
  type MetricValue,
  type MetricsHeader,
  type MetricRecord,
} from './publish-tracks/index.js';

// ============================================================================
// Session integration
// ============================================================================

export {
  // Group numbering
  EpochGroupNumbering,
  SequentialGroupNumbering,
  createGroupNumbering,
  type GroupNumberingStrategy,
  // §10 Prior Group ID Gap
  PRIOR_GROUP_ID_GAP_EXTENSION_ID,
  GroupIdGapTracker,
  encodePriorGroupIdGap,
  decodePriorGroupIdGap,
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
  type ReversePublishOptions,
} from './session/index.js';

// ============================================================================
// Pluggable auth providers (§17)
// ============================================================================

export {
  AuthProviderRegistry,
  MissingAuthProviderError,
  type AuthProvider,
  type AuthContext,
  type AuthAction,
  type AuthToken,
  type AuthValidationResult,
} from './auth/index.js';
