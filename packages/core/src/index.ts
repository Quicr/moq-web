// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview MOQT Core Library (Draft 14/16)
 *
 * Core MOQT protocol types, encoding, state management, and transport layer.
 * This package provides the fundamental building blocks for implementing
 * MOQT (Media over QUIC Transport) in TypeScript.
 *
 * Supports:
 * - Draft-14 (default)
 * - Draft-16 (build with MOQT_VERSION=draft-16)
 *
 * @packageDocumentation
 *
 * @example
 * ```typescript
 * import {
 *   MessageCodec,
 *   MessageType,
 *   Version,
 *   SetupParameter,
 *   TrackManager,
 *   Logger,
 *   LogLevel,
 *   MOQTransport,
 *   StreamManager,
 *   DatagramManager,
 *   IS_DRAFT_16,
 * } from '@web-moq/core';
 *
 * // Configure logging
 * Logger.setLevel(LogLevel.DEBUG);
 *
 * // Check version at runtime
 * console.log('Building for draft-16:', IS_DRAFT_16);
 *
 * // Create track manager
 * const tracks = new TrackManager();
 *
 * // Connect transport
 * const transport = new MOQTransport();
 * await transport.connect('https://relay.example.com/moq');
 *
 * // Create stream/datagram managers
 * const streams = new StreamManager(transport);
 * const datagrams = new DatagramManager(transport);
 *
 * // Encode a message
 * const bytes = MessageCodec.encode({
 *   type: MessageType.CLIENT_SETUP,
 *   supportedVersions: [Version.DRAFT_14],
 *   parameters: new Map([[SetupParameter.PATH, '/moq']]),
 * });
 * ```
 */

// Version constants (build-time selection)
export {
  MOQT_VERSION,
  IS_DRAFT_16,
  IS_DRAFT_14,
  VERSION_NUMBER,
  ALPN_PROTOCOL,
  getCurrentVersionNumber,
  getCurrentALPNProtocol,
} from './version/constants.js';

// Message types and enums (Draft 14/16)
export {
  Version,
  MessageType,
  MessageTypeDraft16,
  DataStreamType,
  SetupParameter,
  RequestParameter,
  ObjectExtension,
  GroupOrder,
  FilterType,
  SessionErrorCode,
  RequestErrorCode,
  NamespaceErrorCode,
  TrackStatusCode,
  ObjectStatus,
  ObjectExistence,
  Priority,
  DeliveryMode,
} from './messages/types.js';

// Message interfaces (Draft 14/16)
export type {
  MOQTMessage,
  TrackNamespace,
  FullTrackName,
  // Session messages
  ClientSetupMessage,
  ServerSetupMessage,
  GoAwayMessage,
  MaxRequestIdMessage,
  RequestsBlockedMessage,
  // Subscribe messages
  SubscribeMessage,
  SubscribeUpdateMessage,
  SubscribeOkMessage,
  SubscribeErrorMessage,
  UnsubscribeMessage,
  // Publish messages
  PublishDoneMessage,
  PublishMessage,
  PublishOkMessage,
  PublishErrorMessage,
  // Namespace publish messages
  PublishNamespaceMessage,
  PublishNamespaceOkMessage,
  PublishNamespaceErrorMessage,
  PublishNamespaceDoneMessage,
  PublishNamespaceCancelMessage,
  // Namespace subscribe messages
  SubscribeNamespaceOptions,
  SubscribeNamespaceMessage,
  SubscribeNamespaceOkMessage,
  SubscribeNamespaceErrorMessage,
  UnsubscribeNamespaceMessage,
  // Fetch messages
  FetchMessage,
  FetchOkMessage,
  FetchErrorMessage,
  FetchCancelMessage,
  // Track status messages
  TrackStatusMessage,
  TrackStatusOkMessage,
  TrackStatusErrorMessage,
  // Draft-16 types (interfaces exist, but use draft-14 wire format handlers)
  AuthorizationToken,
  // Union types
  ControlMessage,
  // Object types
  ObjectHeader,
  SubgroupHeader,
  FetchHeader,
  MOQTObject,
} from './messages/types.js';

// Type guards
export { isControlMessage, isSetupMessage } from './messages/types.js';

// Encoding utilities
export {
  VarInt,
  VarIntError,
  BufferReader,
  BufferWriter,
  PreallocBufferWriter,
  VARINT_MAX,
  VARINT_MAX_1BYTE,
  VARINT_MAX_2BYTE,
  VARINT_MAX_4BYTE,
} from './encoding/varint.js';

// MOQT VarInt (draft-ietf-moq-transport Section 1.4.1)
export {
  MOQTVarInt,
  MOQTVarIntError,
  MOQT_VARINT_MAX,
  MOQT_VARINT_MAX_1BYTE,
  MOQT_VARINT_MAX_2BYTE,
  MOQT_VARINT_MAX_3BYTE,
  MOQT_VARINT_MAX_4BYTE,
  MOQT_VARINT_MAX_5BYTE,
  MOQT_VARINT_MAX_6BYTE,
  MOQT_VARINT_MAX_8BYTE,
  MOQT_VARINT_INVALID_PATTERN,
} from './encoding/moqt-varint.js';

// VarInt codec abstraction (switchable between QUIC and MOQT)
export {
  VarIntCodec,
  VarIntCodecError,
  VarIntType,
  getVarIntType,
  setVarIntType,
  createScopedVarIntCodec,
} from './encoding/varint-codec.js';

// Message codec
export { MessageCodec, MessageCodecError, ObjectCodec } from './encoding/message-codec.js';
export type { FetchEncoderState, FetchDecoderState, FetchObjectResult } from './encoding/message-codec.js';

// State machines
export {
  ConnectionStateMachine,
  SubscriptionStateMachine,
  AnnouncementStateMachine,
  NamespaceSubscriptionStateMachine,
} from './connection/state-machine.js';

export type {
  ConnectionState,
  SubscriptionState,
  AnnouncementState,
  StateChangeHandler,
} from './connection/state-machine.js';

// Track management
export {
  TrackManager,
  trackNameToKey,
  namespaceToKey,
  keyToTrackName,
  namespaceMatchesPrefix,
} from './track/track-manager.js';

export type {
  PublishedTrackConfig,
  SubscriptionConfig,
  PublishedTrack,
  SubscribedTrack,
  TrackManagerEvent,
  TrackManagerEventHandler,
} from './track/track-manager.js';

// Priority scheduling
export {
  PriorityScheduler,
  determinePriority,
  priorityFromPublisher,
  priorityToPublisher,
} from './track/priority-scheduler.js';

// Logging
export { Logger, createLogger, LogLevel } from './utils/logger.js';

export type { LogEntry, LogHandler, LoggerConfig } from './utils/logger.js';

// Track alias hashing (for LAPS compatibility)
export {
  cityHash64,
  hashCombine,
  computeTrackAlias,
  trackAliasToNumber,
} from './encoding/cityhash64.js';

// Buffer pooling
export {
  BufferPool,
  acquireBuffer,
  releaseBuffer,
  acquireBufferForChunk,
} from './buffer/buffer-pool.js';

// ============================================================================
// Transport Layer (merged from moqt-transport)
// ============================================================================

// WebTransport wrapper
export { MOQTransport } from './transport/transport.js';

export type {
  TransportState,
  TransportEventType,
  TransportEvents,
  TransportEventHandler,
  TransportConfig,
} from './transport/transport.js';

// Stream management
export { StreamManager, StreamReader } from './streams/stream-manager.js';

export type {
  ManagedStream,
  StreamOptions,
} from './streams/stream-manager.js';

// Datagram management
export { DatagramManager } from './datagrams/datagram-manager.js';

export type { DatagramStats } from './datagrams/datagram-manager.js';

// Ring buffer utilities
export { RingBuffer, PriorityRingBuffer } from './buffer/ring-buffer.js';
