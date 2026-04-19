// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview MOQT Message Serialization and Deserialization (Draft 14/16)
 *
 * Provides encoding and decoding of MOQT control messages to/from
 * wire format. All messages follow the QUIC variable-length integer
 * encoding and the MOQT Draft 14/16 specification format.
 *
 * Build-time version selection:
 * - IS_DRAFT_16=false: Draft-14 wire format (default)
 * - IS_DRAFT_16=true: Draft-16 wire format (includes draft-15 changes)
 *
 * @see https://datatracker.ietf.org/doc/draft-ietf-moq-transport/14/
 * @see https://datatracker.ietf.org/doc/draft-ietf-moq-transport/16/
 *
 * @example
 * ```typescript
 * import { MessageCodec, ClientSetupMessage, MessageType, Version, SetupParameter } from 'moqt-core';
 *
 * // Encode a message
 * const setup: ClientSetupMessage = {
 *   type: MessageType.CLIENT_SETUP,
 *   supportedVersions: [Version.DRAFT_14],
 *   parameters: new Map([[SetupParameter.PATH, '/moq']]),
 * };
 * const bytes = MessageCodec.encode(setup);
 *
 * // Decode a message
 * const decoded = MessageCodec.decode(bytes);
 * ```
 */

import { Logger } from '../utils/logger.js';
import { BufferReader, BufferWriter, VarInt } from './varint.js';
import { IS_DRAFT_16 } from '../version/constants.js';
import {
  MessageType,
  DataStreamType,
  Version,
  SetupParameter,
  GroupOrder,
  FilterType,
  RequestParameter,
  TrackNamespace,
  FullTrackName,
  ControlMessage,
  ClientSetupMessage,
  ServerSetupMessage,
  GoAwayMessage,
  MaxRequestIdMessage,
  RequestsBlockedMessage,
  SubscribeMessage,
  SubscribeUpdateMessage,
  SubscribeOkMessage,
  SubscribeErrorMessage,
  UnsubscribeMessage,
  PublishDoneMessage,
  PublishMessage,
  PublishOkMessage,
  PublishErrorMessage,
  PublishNamespaceMessage,
  PublishNamespaceOkMessage,
  PublishNamespaceErrorMessage,
  PublishNamespaceDoneMessage,
  PublishNamespaceCancelMessage,
  SubscribeNamespaceMessage,
  SubscribeNamespaceOkMessage,
  SubscribeNamespaceErrorMessage,
  UnsubscribeNamespaceMessage,
  FetchMessage,
  FetchOkMessage,
  FetchErrorMessage,
  FetchCancelMessage,
  TrackStatusMessage,
  TrackStatusOkMessage,
  TrackStatusErrorMessage,
  ObjectHeader,
  MOQTObject,
  ObjectStatus,
  SubgroupHeader,
  FetchHeader,
  RequestErrorCode,
  NamespaceErrorCode,
  TrackStatusCode,
  ObjectExistence,
} from '../messages/types.js';

// Draft-16 message types (for future use when full draft-16 encoding is implemented)
// These aliases share wire values with draft-14 types:
// - RequestUpdateMessage (0x02) = SubscribeUpdateMessage
// - RequestOkMessage (0x07) = PublishNamespaceOkMessage
// - RequestErrorMessage (0x05) = SubscribeErrorMessage
// - NamespaceMessage (0x08) = PublishNamespaceErrorMessage
// - NamespaceDoneMessage (0x0e) = TrackStatusOkMessage

const log = Logger.create('moqt:core:codec');

/**
 * Error thrown during message encoding or decoding
 */
export class MessageCodecError extends Error {
  /** The message type that caused the error, if known */
  messageType?: MessageType;

  constructor(message: string, messageType?: MessageType) {
    super(message);
    this.name = 'MessageCodecError';
    this.messageType = messageType;
  }
}

/**
 * MOQT Message Codec
 *
 * @remarks
 * Handles serialization and deserialization of all MOQT control messages.
 * Uses QUIC variable-length integer encoding for all numeric fields.
 *
 * Message format:
 * - Message Type (varint)
 * - Message-specific fields
 */
export class MessageCodec {
  /**
   * Encode a control message to bytes
   *
   * @param message - The message to encode
   * @returns Encoded bytes
   * @throws {MessageCodecError} If encoding fails
   *
   * @example
   * ```typescript
   * const subscribe: SubscribeMessage = {
   *   type: MessageType.SUBSCRIBE,
   *   subscribeId: 1,
   *   trackAlias: 0,
   *   fullTrackName: {
   *     namespace: ['conference', 'room-1', 'media'],
   *     trackName: 'video',
   *   },
   *   subscriberPriority: 128,
   *   groupOrder: GroupOrder.ASCENDING,
   *   filterType: FilterType.LATEST_GROUP,
   * };
   * const bytes = MessageCodec.encode(subscribe);
   * ```
   */
  static encode(message: ControlMessage): Uint8Array {
    log.debug('Encoding message', { type: MessageType[message.type] });

    // First, encode the payload (message-specific fields)
    const payloadWriter = new BufferWriter();

    switch (message.type) {
      // Session messages
      case MessageType.CLIENT_SETUP:
        MessageCodec.encodeClientSetupPayload(payloadWriter, message);
        break;
      case MessageType.SERVER_SETUP:
        MessageCodec.encodeServerSetupPayload(payloadWriter, message);
        break;
      case MessageType.GOAWAY:
        MessageCodec.encodeGoAwayPayload(payloadWriter, message);
        break;
      case MessageType.MAX_REQUEST_ID:
        MessageCodec.encodeMaxRequestIdPayload(payloadWriter, message);
        break;
      case MessageType.REQUESTS_BLOCKED:
        MessageCodec.encodeRequestsBlockedPayload(payloadWriter, message);
        break;
      // Subscribe messages
      case MessageType.SUBSCRIBE:
        MessageCodec.encodeSubscribePayload(payloadWriter, message);
        break;
      case MessageType.SUBSCRIBE_UPDATE:
        MessageCodec.encodeSubscribeUpdatePayload(payloadWriter, message);
        break;
      case MessageType.SUBSCRIBE_OK:
        MessageCodec.encodeSubscribeOkPayload(payloadWriter, message);
        break;
      case MessageType.SUBSCRIBE_ERROR:
        MessageCodec.encodeSubscribeErrorPayload(payloadWriter, message);
        break;
      case MessageType.UNSUBSCRIBE:
        MessageCodec.encodeUnsubscribePayload(payloadWriter, message);
        break;
      // Publish messages
      case MessageType.PUBLISH_DONE:
        MessageCodec.encodePublishDonePayload(payloadWriter, message);
        break;
      case MessageType.PUBLISH:
        MessageCodec.encodePublishPayload(payloadWriter, message);
        break;
      case MessageType.PUBLISH_OK:
        MessageCodec.encodePublishOkPayload(payloadWriter, message);
        break;
      case MessageType.PUBLISH_ERROR:
        MessageCodec.encodePublishErrorPayload(payloadWriter, message);
        break;
      // Namespace publish messages
      case MessageType.PUBLISH_NAMESPACE:
        MessageCodec.encodePublishNamespacePayload(payloadWriter, message);
        break;
      case MessageType.PUBLISH_NAMESPACE_OK:
        MessageCodec.encodePublishNamespaceOkPayload(payloadWriter, message);
        break;
      case MessageType.PUBLISH_NAMESPACE_ERROR:
        MessageCodec.encodePublishNamespaceErrorPayload(payloadWriter, message);
        break;
      case MessageType.PUBLISH_NAMESPACE_DONE:
        MessageCodec.encodePublishNamespaceDonePayload(payloadWriter, message);
        break;
      case MessageType.PUBLISH_NAMESPACE_CANCEL:
        MessageCodec.encodePublishNamespaceCancelPayload(payloadWriter, message);
        break;
      // Namespace subscribe messages
      case MessageType.SUBSCRIBE_NAMESPACE:
        MessageCodec.encodeSubscribeNamespacePayload(payloadWriter, message);
        break;
      case MessageType.SUBSCRIBE_NAMESPACE_OK:
        MessageCodec.encodeSubscribeNamespaceOkPayload(payloadWriter, message);
        break;
      case MessageType.SUBSCRIBE_NAMESPACE_ERROR:
        MessageCodec.encodeSubscribeNamespaceErrorPayload(payloadWriter, message);
        break;
      case MessageType.UNSUBSCRIBE_NAMESPACE:
        MessageCodec.encodeUnsubscribeNamespacePayload(payloadWriter, message);
        break;
      // Fetch messages
      case MessageType.FETCH:
        MessageCodec.encodeFetchPayload(payloadWriter, message);
        break;
      case MessageType.FETCH_CANCEL:
        MessageCodec.encodeFetchCancelPayload(payloadWriter, message);
        break;
      case MessageType.FETCH_OK:
        MessageCodec.encodeFetchOkPayload(payloadWriter, message);
        break;
      case MessageType.FETCH_ERROR:
        MessageCodec.encodeFetchErrorPayload(payloadWriter, message);
        break;
      // Track status messages
      case MessageType.TRACK_STATUS:
        MessageCodec.encodeTrackStatusPayload(payloadWriter, message);
        break;
      case MessageType.TRACK_STATUS_OK:
        // In draft-16, this wire value is also NAMESPACE_DONE
        MessageCodec.encodeTrackStatusOkPayload(payloadWriter, message);
        break;
      case MessageType.TRACK_STATUS_ERROR:
        MessageCodec.encodeTrackStatusErrorPayload(payloadWriter, message);
        break;
      // Note: Draft-16 message aliases share wire values with draft-14 messages:
      // - REQUEST_UPDATE (0x02) = SUBSCRIBE_UPDATE
      // - REQUEST_ERROR (0x05) = SUBSCRIBE_ERROR
      // - REQUEST_OK (0x07) = PUBLISH_NAMESPACE_OK
      // - NAMESPACE (0x08) = PUBLISH_NAMESPACE_ERROR
      // - NAMESPACE_DONE (0x0e) = TRACK_STATUS_OK
      // They are handled by their respective encoders above.
      default:
        throw new MessageCodecError(
          `Unknown message type: ${(message as ControlMessage).type}`,
          (message as ControlMessage).type
        );
    }

    const payload = payloadWriter.toUint8Array();

    // MOQT spec: Message Type (varint) + Message Length (16-bit) + Message Payload
    const writer = new BufferWriter();
    writer.writeVarInt(message.type);
    writer.writeByte((payload.length >> 8) & 0xff);
    writer.writeByte(payload.length & 0xff);
    writer.writeBytes(payload);

    const result = writer.toUint8Array();
    log.trace('Encoded message', { type: MessageType[message.type], bytes: result.length });
    return result;
  }

  /**
   * Decode a control message from bytes
   *
   * @param buffer - Buffer containing the encoded message
   * @param offset - Offset to start reading from
   * @returns Tuple of [decoded message, bytes consumed]
   * @throws {MessageCodecError} If decoding fails
   *
   * @example
   * ```typescript
   * const [message, bytesRead] = MessageCodec.decode(bytes);
   * if (message.type === MessageType.SUBSCRIBE) {
   *   console.log('Received subscribe:', message.fullTrackName);
   * }
   * ```
   */
  static decode(buffer: Uint8Array, offset = 0): [ControlMessage, number] {
    const reader = new BufferReader(buffer, offset);
    const startOffset = reader.offset;

    // Read message type
    const messageType = reader.readVarIntNumber();

    // MOQT spec: Message Length is 16-bit
    const lengthHigh = reader.readByte();
    const lengthLow = reader.readByte();
    const payloadLength = (lengthHigh << 8) | lengthLow;
    const payloadStartOffset = reader.offset;

    log.trace('Decoding message', {
      type: MessageType[messageType] ?? messageType,
      payloadLength,
    });

    let message: ControlMessage;

    switch (messageType) {
      // Session messages
      case MessageType.CLIENT_SETUP:
        message = MessageCodec.decodeClientSetupPayload(reader);
        break;
      case MessageType.SERVER_SETUP:
        message = MessageCodec.decodeServerSetupPayload(reader);
        break;
      case MessageType.GOAWAY:
        message = MessageCodec.decodeGoAwayPayload(reader);
        break;
      case MessageType.MAX_REQUEST_ID:
        message = MessageCodec.decodeMaxRequestIdPayload(reader);
        break;
      case MessageType.REQUESTS_BLOCKED:
        message = MessageCodec.decodeRequestsBlockedPayload(reader);
        break;
      // Subscribe messages
      case MessageType.SUBSCRIBE:
        message = MessageCodec.decodeSubscribePayload(reader);
        break;
      case MessageType.SUBSCRIBE_UPDATE:
        message = MessageCodec.decodeSubscribeUpdatePayload(reader);
        break;
      case MessageType.SUBSCRIBE_OK:
        message = MessageCodec.decodeSubscribeOkPayload(reader, payloadStartOffset + payloadLength);
        break;
      case MessageType.SUBSCRIBE_ERROR:
        message = MessageCodec.decodeSubscribeErrorPayload(reader);
        break;
      case MessageType.UNSUBSCRIBE:
        message = MessageCodec.decodeUnsubscribePayload(reader);
        break;
      // Publish messages
      case MessageType.PUBLISH_DONE:
        message = MessageCodec.decodePublishDonePayload(reader);
        break;
      case MessageType.PUBLISH:
        message = MessageCodec.decodePublishPayload(reader, payloadStartOffset + payloadLength);
        break;
      case MessageType.PUBLISH_OK:
        message = MessageCodec.decodePublishOkPayload(reader);
        break;
      case MessageType.PUBLISH_ERROR:
        message = MessageCodec.decodePublishErrorPayload(reader);
        break;
      // Namespace publish messages
      case MessageType.PUBLISH_NAMESPACE:
        message = MessageCodec.decodePublishNamespacePayload(reader);
        break;
      case MessageType.PUBLISH_NAMESPACE_OK:
        message = MessageCodec.decodePublishNamespaceOkPayload(reader);
        break;
      case MessageType.PUBLISH_NAMESPACE_ERROR:
        message = MessageCodec.decodePublishNamespaceErrorPayload(reader);
        break;
      case MessageType.PUBLISH_NAMESPACE_DONE:
        message = MessageCodec.decodePublishNamespaceDonePayload(reader);
        break;
      case MessageType.PUBLISH_NAMESPACE_CANCEL:
        message = MessageCodec.decodePublishNamespaceCancelPayload(reader);
        break;
      // Namespace subscribe messages
      case MessageType.SUBSCRIBE_NAMESPACE:
        message = MessageCodec.decodeSubscribeNamespacePayload(reader);
        break;
      case MessageType.SUBSCRIBE_NAMESPACE_OK:
        message = MessageCodec.decodeSubscribeNamespaceOkPayload(reader);
        break;
      case MessageType.SUBSCRIBE_NAMESPACE_ERROR:
        message = MessageCodec.decodeSubscribeNamespaceErrorPayload(reader);
        break;
      case MessageType.UNSUBSCRIBE_NAMESPACE:
        message = MessageCodec.decodeUnsubscribeNamespacePayload(reader);
        break;
      // Fetch messages
      case MessageType.FETCH:
        message = MessageCodec.decodeFetchPayload(reader);
        break;
      case MessageType.FETCH_CANCEL:
        message = MessageCodec.decodeFetchCancelPayload(reader);
        break;
      case MessageType.FETCH_OK:
        message = MessageCodec.decodeFetchOkPayload(reader);
        break;
      case MessageType.FETCH_ERROR:
        message = MessageCodec.decodeFetchErrorPayload(reader);
        break;
      // Track status messages
      case MessageType.TRACK_STATUS:
        message = MessageCodec.decodeTrackStatusPayload(reader);
        break;
      case MessageType.TRACK_STATUS_OK:
        message = MessageCodec.decodeTrackStatusOkPayload(reader);
        break;
      case MessageType.TRACK_STATUS_ERROR:
        message = MessageCodec.decodeTrackStatusErrorPayload(reader);
        break;
      default:
        throw new MessageCodecError(`Unknown message type: ${messageType}`, messageType);
    }

    // Calculate actual bytes consumed by payload decoder
    const actualPayloadConsumed = reader.offset - payloadStartOffset;

    // CRITICAL FIX: If we didn't consume all declared payload bytes, skip the rest
    // This prevents trailing bytes from corrupting the next message
    if (actualPayloadConsumed < payloadLength) {
      const skipped = payloadLength - actualPayloadConsumed;
      log.trace('Skipping unconsumed payload bytes', {
        messageType: MessageType[messageType] ?? messageType,
        skippedBytes: skipped,
      });
      reader.skip(skipped);
    } else if (actualPayloadConsumed > payloadLength) {
      // This shouldn't happen - decoder read more than declared
      log.warn('Payload overread - decoder consumed more bytes than declared', {
        messageType: MessageType[messageType] ?? messageType,
        declaredPayloadLength: payloadLength,
        actualPayloadConsumed,
      });
    }

    const bytesConsumed = reader.offset - startOffset;
    log.trace('Decoded message', { type: MessageType[message.type], bytes: bytesConsumed });
    return [message, bytesConsumed];
  }

  // ============================================================================
  // Namespace and Track Name Encoding/Decoding
  // ============================================================================

  /**
   * Encode a track namespace tuple
   */
  private static encodeNamespace(writer: BufferWriter, namespace: TrackNamespace): void {
    writer.writeVarInt(namespace.length);
    for (const element of namespace) {
      writer.writeString(element);
    }
  }

  /**
   * Decode a track namespace tuple
   */
  private static decodeNamespace(reader: BufferReader): TrackNamespace {
    const count = reader.readVarIntNumber();
    const namespace: TrackNamespace = [];
    for (let i = 0; i < count; i++) {
      namespace.push(reader.readString());
    }
    return namespace;
  }

  /**
   * Encode a full track name
   * Draft-14 format: Track Namespace (tuple) + Track Name (string) separately
   */
  private static encodeFullTrackName(writer: BufferWriter, fullTrackName: FullTrackName): void {
    log.info('Encoding full track name - START', {
      namespace: fullTrackName.namespace,
      namespaceLength: fullTrackName.namespace.length,
      trackName: fullTrackName.trackName,
    });

    // Write namespace as tuple (count + elements)
    writer.writeVarInt(fullTrackName.namespace.length);
    for (const element of fullTrackName.namespace) {
      writer.writeString(element);
    }

    // Write track name separately (length + bytes)
    writer.writeString(fullTrackName.trackName);

    log.info('Encoding full track name - END', {
      namespaceCount: fullTrackName.namespace.length,
      trackName: fullTrackName.trackName,
    });
  }

  /**
   * Decode a full track name
   * Draft-14 format: Track Namespace (tuple) + Track Name (string) separately
   */
  private static decodeFullTrackName(reader: BufferReader): FullTrackName {
    // Read namespace as tuple (count + elements)
    const namespaceCount = reader.readVarIntNumber();
    const namespace: string[] = [];
    for (let i = 0; i < namespaceCount; i++) {
      namespace.push(reader.readString());
    }

    // Read track name separately (length + bytes)
    const trackName = reader.readString();

    return {
      namespace,
      trackName,
    };
  }

  /**
   * Encode setup parameters
   *
   * Draft-16: Even parameter keys encode value as varint directly,
   * odd keys use length + bytes format.
   */
  private static encodeSetupParameters(
    writer: BufferWriter,
    parameters: Map<SetupParameter, number | string>
  ): void {
    writer.writeVarInt(parameters.size);

    if (IS_DRAFT_16) {
      // Draft-16: Delta-encoded keys, even keys = varint value, odd keys = length + bytes
      // Sort entries by key for delta encoding
      const sortedEntries = Array.from(parameters.entries()).sort((a, b) => a[0] - b[0]);
      let previousKey = 0;

      for (const [key, value] of sortedEntries) {
        // Delta encode key
        const deltaKey = key - previousKey;
        writer.writeVarInt(deltaKey);
        previousKey = key;

        if (key % 2 === 0) {
          // Even key: write value as varint directly
          if (typeof value === 'number') {
            writer.writeVarInt(value);
          } else {
            throw new Error(`Even parameter key ${key} must have numeric value`);
          }
        } else {
          // Odd key: write length + bytes
          if (typeof value === 'string') {
            const bytes = new TextEncoder().encode(value);
            writer.writeVarInt(bytes.length);
            writer.writeBytes(bytes);
          } else {
            const encoded = VarInt.encode(value);
            writer.writeVarInt(encoded.length);
            writer.writeBytes(encoded);
          }
        }
      }
    } else {
      // Draft-14: No delta encoding, all parameters use length + bytes format
      for (const [key, value] of parameters) {
        writer.writeVarInt(key);
        if (typeof value === 'string') {
          writer.writeString(value);
        } else {
          const encoded = VarInt.encode(value);
          writer.writeVarInt(encoded.length);
          writer.writeBytes(encoded);
        }
      }
    }
  }

  // Security limits for input validation
  private static readonly MAX_PARAMETER_COUNT = 100;
  private static readonly MAX_STRING_LENGTH = 65536;

  /**
   * Decode setup parameters
   *
   * Draft-16: Delta-encoded keys, even keys have varint value directly,
   * odd keys use length + bytes format.
   */
  private static decodeSetupParameters(
    reader: BufferReader
  ): Map<SetupParameter, number | string> {
    const count = reader.readVarIntNumber();

    // Security: limit parameter count to prevent DoS
    if (count > MessageCodec.MAX_PARAMETER_COUNT) {
      throw new MessageCodecError(`Too many parameters: ${count}`);
    }

    const parameters = new Map<SetupParameter, number | string>();

    if (IS_DRAFT_16) {
      // Draft-16: Delta-encoded keys, even keys = varint value, odd keys = length + bytes
      let previousKey = 0;

      for (let i = 0; i < count; i++) {
        const deltaKey = reader.readVarIntNumber();
        const key = (previousKey + deltaKey) as SetupParameter;
        previousKey = key;

        if (key % 2 === 0) {
          // Even key: read value as varint directly
          const value = reader.readVarIntNumber();
          parameters.set(key, value);
        } else {
          // Odd key: read length + bytes
          const valueLength = reader.readVarIntNumber();
          if (valueLength > MessageCodec.MAX_STRING_LENGTH) {
            throw new MessageCodecError(`Parameter value too long: ${valueLength}`);
          }
          const bytes = reader.readBytes(valueLength);
          // Odd keys are typically strings (PATH, ENDPOINT_ID, etc.)
          parameters.set(key, new TextDecoder().decode(bytes));
        }
      }
    } else {
      // Draft-14: No delta encoding, all parameters use length + bytes format
      for (let i = 0; i < count; i++) {
        const key = reader.readVarIntNumber() as SetupParameter;
        const valueLength = reader.readVarIntNumber();
        if (valueLength > MessageCodec.MAX_STRING_LENGTH) {
          throw new MessageCodecError(`Parameter value too long: ${valueLength}`);
        }

        if (key === SetupParameter.PATH) {
          // PATH is a string
          const bytes = reader.readBytes(valueLength);
          parameters.set(key, new TextDecoder().decode(bytes));
        } else {
          // Other parameters are varints
          const bytes = reader.readBytes(valueLength);
          const [value] = VarInt.decodeNumber(bytes);
          parameters.set(key, value);
        }
      }
    }

    return parameters;
  }

  /**
   * Encode request parameters
   *
   * Draft-16: Even parameter keys encode value directly (varint bytes),
   * odd keys use length + bytes format. Keys are delta encoded.
   */
  private static encodeRequestParameters(
    writer: BufferWriter,
    parameters?: Map<RequestParameter, Uint8Array>
  ): void {
    const count = parameters?.size ?? 0;
    writer.writeVarInt(count);
    if (parameters) {
      if (IS_DRAFT_16) {
        // Draft-16: Sort by key ascending, delta encode keys
        // Even keys = value directly, Odd keys = length + bytes
        const sortedEntries = Array.from(parameters.entries()).sort((a, b) => a[0] - b[0]);
        let previousKey = 0;

        for (const [key, value] of sortedEntries) {
          // Delta encode: write (current_key - previous_key)
          const deltaKey = key - previousKey;
          writer.writeVarInt(deltaKey);
          previousKey = key;

          if (key % 2 === 0) {
            // Even key: write value bytes directly (no length prefix)
            writer.writeBytes(value);
          } else {
            // Odd key: write length + bytes
            writer.writeVarInt(value.length);
            writer.writeBytes(value);
          }
        }
      } else {
        // Draft-14: All parameters use length + bytes format, no delta encoding
        for (const [key, value] of parameters) {
          writer.writeVarInt(key);
          writer.writeVarInt(value.length);
          writer.writeBytes(value);
        }
      }
    }
  }

  /**
   * Encode track extensions (Draft-16)
   * Unlike parameters, extensions don't have a count - just delta-encoded key-value pairs
   */
  // @ts-expect-error - temporarily unused during debugging
  private static encodeTrackExtensions(
    writer: BufferWriter,
    extensions?: Map<number, Uint8Array>
  ): void {
    if (!extensions || extensions.size === 0) return;

    // Sort by key ascending, delta encode keys
    // Even keys = value directly, Odd keys = length + bytes
    const sortedEntries = Array.from(extensions.entries()).sort((a, b) => a[0] - b[0]);
    let previousKey = 0;

    for (const [key, value] of sortedEntries) {
      // Delta encode: write (current_key - previous_key)
      const deltaKey = key - previousKey;
      writer.writeVarInt(deltaKey);
      previousKey = key;

      if (key % 2 === 0) {
        // Even key: write value bytes directly (no length prefix)
        writer.writeBytes(value);
      } else {
        // Odd key: write length + bytes
        writer.writeVarInt(value.length);
        writer.writeBytes(value);
      }
    }
  }

  /**
   * Decode track extensions (Draft-16)
   * Unlike parameters, extensions don't have a count - read until end of message
   * NOTE: Use decodeTrackExtensionsBounded for bounded reading within payload limits
   */
  // @ts-expect-error - unused, kept for reference; use decodeTrackExtensionsBounded instead
  private static decodeTrackExtensions(
    reader: BufferReader
  ): Map<number, Uint8Array> | undefined {
    if (!reader.hasMore) return undefined;

    const extensions = new Map<number, Uint8Array>();
    let previousKey = 0;

    while (reader.hasMore) {
      const deltaKey = reader.readVarIntNumber();
      const key = previousKey + deltaKey;
      previousKey = key;

      if (key % 2 === 0) {
        // Even key: read value as varint directly, convert to bytes for storage
        const value = reader.readVarIntNumber();
        extensions.set(key, VarInt.encode(value));
      } else {
        // Odd key: read length + bytes
        const length = reader.readVarIntNumber();
        extensions.set(key, reader.readBytes(length));
      }
    }

    return extensions.size > 0 ? extensions : undefined;
  }

  /**
   * Decode track extensions with a bounded end offset (Draft-16)
   * Reads key-value pairs until reaching the payload boundary
   */
  private static decodeTrackExtensionsBounded(
    reader: BufferReader,
    endOffset?: number
  ): Map<number, Uint8Array> | undefined {
    // Need at least 2 bytes for a minimal extension (1-byte key + 1-byte value)
    const remaining = endOffset !== undefined
      ? endOffset - reader.offset
      : reader.remaining;
    if (remaining < 2) return undefined;

    const extensions = new Map<number, Uint8Array>();
    let previousKey = 0;

    // Keep reading while we have at least 2 bytes remaining for a minimal extension
    while (true) {
      const bytesLeft = endOffset !== undefined
        ? endOffset - reader.offset
        : reader.remaining;
      if (bytesLeft < 2) break;

      const deltaKey = reader.readVarIntNumber();
      const key = previousKey + deltaKey;
      previousKey = key;

      if (key % 2 === 0) {
        // Even key: read value as varint directly, convert to bytes for storage
        const value = reader.readVarIntNumber();
        extensions.set(key, VarInt.encode(value));
      } else {
        // Odd key: read length + bytes
        const length = reader.readVarIntNumber();
        extensions.set(key, reader.readBytes(length));
      }
    }

    return extensions.size > 0 ? extensions : undefined;
  }

  /**
   * Decode request parameters
   *
   * Draft-16: Keys are delta encoded, even keys have value directly (as varint),
   * odd keys use length + bytes format.
   */
  private static decodeRequestParameters(
    reader: BufferReader
  ): Map<RequestParameter, Uint8Array> | undefined {
    const count = reader.readVarIntNumber();
    if (count === 0) return undefined;

    // Security: limit parameter count to prevent DoS
    if (count > MessageCodec.MAX_PARAMETER_COUNT) {
      throw new MessageCodecError(`Too many request parameters: ${count}`);
    }

    const parameters = new Map<RequestParameter, Uint8Array>();

    if (IS_DRAFT_16) {
      // Draft-16: Delta encoded keys
      // Even keys = value directly (varint), Odd keys = length + bytes
      let previousKey = 0;
      for (let i = 0; i < count; i++) {
        const deltaKey = reader.readVarIntNumber();
        const key = (previousKey + deltaKey) as RequestParameter;
        previousKey = key;

        if (key % 2 === 0) {
          // Even key: read value as varint directly, store as encoded bytes
          // Use BigInt to handle max varint values (relay sends 0x3FFFFFFFFFFFFFFF as "unknown")
          const valueBig = reader.readVarInt();
          const MAX_VARINT = 0x3FFFFFFFFFFFFFFFn;
          if (valueBig >= MAX_VARINT) {
            // Max varint is sentinel for "unknown" - store as 0
            log.info('Parameter has max varint (unknown) value', {
              key: '0x' + key.toString(16),
              keyName: RequestParameter[key] || 'UNKNOWN',
              value: valueBig.toString(),
            });
            parameters.set(key, VarInt.encode(0));
          } else {
            parameters.set(key, VarInt.encode(Number(valueBig)));
          }
        } else {
          // Odd key: read length + bytes
          const length = reader.readVarIntNumber();
          if (length > MessageCodec.MAX_STRING_LENGTH) {
            throw new MessageCodecError(`Parameter value too long: ${length}`);
          }
          parameters.set(key, reader.readBytes(length));
        }
      }
    } else {
      // Draft-14: No delta encoding, all parameters use length + bytes format
      for (let i = 0; i < count; i++) {
        const key = reader.readVarIntNumber() as RequestParameter;
        const length = reader.readVarIntNumber();
        if (length > MessageCodec.MAX_STRING_LENGTH) {
          throw new MessageCodecError(`Parameter value too long: ${length}`);
        }
        parameters.set(key, reader.readBytes(length));
      }
    }
    return parameters;
  }

  // ============================================================================
  // Debug Helpers
  // ============================================================================

  /** Get hex string of bytes written since startPos */
  private static hexBytes(writer: BufferWriter, startPos: number): string {
    const bytes = writer.toUint8Array().subarray(startPos);
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
  }

  // ============================================================================
  // Setup Message Encoding/Decoding
  // ============================================================================

  private static encodeClientSetupPayload(writer: BufferWriter, message: ClientSetupMessage): void {
    if (IS_DRAFT_16) {
      // Draft-16: No version list (negotiated via ALPN)
      // Format: Num Params + Params[]
      MessageCodec.encodeSetupParameters(writer, message.parameters);
    } else {
      // Draft-14: Include version list
      // Format: Num Versions + Versions[] + Num Params + Params[]
      writer.writeVarInt(message.supportedVersions.length);
      for (const version of message.supportedVersions) {
        writer.writeVarInt(version);
      }
      MessageCodec.encodeSetupParameters(writer, message.parameters);
    }
  }

  private static decodeClientSetupPayload(reader: BufferReader): ClientSetupMessage {
    if (IS_DRAFT_16) {
      // Draft-16: No version list (negotiated via ALPN)
      const parameters = MessageCodec.decodeSetupParameters(reader);
      return {
        type: MessageType.CLIENT_SETUP,
        supportedVersions: [Version.DRAFT_16], // Implicit
        parameters,
      };
    } else {
      // Draft-14: Has version list
      const versionCount = reader.readVarIntNumber();
      const supportedVersions: Version[] = [];
      for (let i = 0; i < versionCount; i++) {
        supportedVersions.push(reader.readVarIntNumber() as Version);
      }
      const parameters = MessageCodec.decodeSetupParameters(reader);

      return {
        type: MessageType.CLIENT_SETUP,
        supportedVersions,
        parameters,
      };
    }
  }

  private static encodeServerSetupPayload(writer: BufferWriter, message: ServerSetupMessage): void {
    if (IS_DRAFT_16) {
      // Draft-16: No selected version (determined by ALPN)
      // Format: Num Params + Params[]
      MessageCodec.encodeSetupParameters(writer, message.parameters);
    } else {
      // Draft-14: Include selected version
      // Format: Selected Version + Num Params + Params[]
      writer.writeVarInt(message.selectedVersion);
      MessageCodec.encodeSetupParameters(writer, message.parameters);
    }
  }

  private static decodeServerSetupPayload(reader: BufferReader): ServerSetupMessage {
    if (IS_DRAFT_16) {
      // Draft-16: No selected version (determined by ALPN)
      const parameters = MessageCodec.decodeSetupParameters(reader);
      return {
        type: MessageType.SERVER_SETUP,
        selectedVersion: Version.DRAFT_16, // Implicit
        parameters,
      };
    } else {
      // Draft-14: Has selected version
      const selectedVersion = reader.readVarIntNumber() as Version;
      const parameters = MessageCodec.decodeSetupParameters(reader);

      return {
        type: MessageType.SERVER_SETUP,
        selectedVersion,
        parameters,
      };
    }
  }

  // ============================================================================
  // Subscribe Message Encoding/Decoding
  // ============================================================================

  private static encodeSubscribePayload(writer: BufferWriter, message: SubscribeMessage): void {
    if (IS_DRAFT_16) {
      // Draft-16 SUBSCRIBE format:
      // Subscribe ID, Full Track Name, Parameters
      // Filter Type, subscriberPriority, groupOrder are all in Parameters
      writer.writeVarInt(message.requestId);
      MessageCodec.encodeFullTrackName(writer, message.fullTrackName);

      // DEBUG: Send empty parameters to test server parsing
      // TODO: Re-enable parameters once server compatibility is confirmed
      writer.writeVarInt(0); // Empty parameters count

      // // Build parameters: subscriberPriority, subscriptionFilter, groupOrder
      // // Keys: 0x20 (even), 0x21 (odd), 0x22 (even)
      // const params = new Map<number, Uint8Array>(message.parameters ?? []);

      // // Add subscriber priority (0x20, even) - encode as varint bytes
      // if (message.subscriberPriority !== undefined) {
      //   params.set(0x20, VarInt.encode(message.subscriberPriority));
      // }

      // // Add subscription filter (0x21, odd) - encode as length + bytes
      // // Filter format: filterType [startGroup startObject] [endGroup]
      // const filterWriter = new BufferWriter();
      // filterWriter.writeVarInt(message.filterType);
      // if (message.filterType === FilterType.ABSOLUTE_START ||
      //     message.filterType === FilterType.ABSOLUTE_RANGE) {
      //   filterWriter.writeVarInt(message.startGroup ?? 0);
      //   filterWriter.writeVarInt(message.startObject ?? 0);
      // }
      // if (message.filterType === FilterType.ABSOLUTE_RANGE) {
      //   filterWriter.writeVarInt(message.endGroup ?? 0);
      // }
      // params.set(0x21, filterWriter.toUint8Array());

      // // Add group order (0x22, even) - encode as varint bytes
      // if (message.groupOrder !== undefined) {
      //   params.set(0x22, VarInt.encode(message.groupOrder));
      // }

      // MessageCodec.encodeRequestParameters(writer, params);
    } else {
      // Draft-14 SUBSCRIBE format:
      // Request ID, Track Namespace, Track Name, Subscriber Priority, Group Order,
      // Forward, Filter Type, [Start Location], [End Group], Parameters
      // NOTE: NO Track Alias in SUBSCRIBE! (Track Alias is assigned by publisher in SUBSCRIBE_OK)
      writer.writeVarInt(message.requestId);
      MessageCodec.encodeFullTrackName(writer, message.fullTrackName);
      // Draft-14: subscriberPriority, groupOrder, forward are 8-bit fixed fields
      writer.writeByte(message.subscriberPriority);
      writer.writeByte(message.groupOrder);
      writer.writeByte(message.forward ?? 1); // Forward: 1 = immediately forward objects
      writer.writeVarInt(message.filterType);

      // Filter-specific fields
      if (message.filterType === FilterType.ABSOLUTE_START ||
          message.filterType === FilterType.ABSOLUTE_RANGE) {
        writer.writeVarInt(message.startGroup ?? 0);
        writer.writeVarInt(message.startObject ?? 0);
      }
      if (message.filterType === FilterType.ABSOLUTE_RANGE) {
        writer.writeVarInt(message.endGroup ?? 0);
      }

      // Subscribe parameters (count + key/value pairs)
      MessageCodec.encodeRequestParameters(writer, message.parameters);
    }
  }

  private static decodeSubscribePayload(reader: BufferReader): SubscribeMessage {
    if (IS_DRAFT_16) {
      // Draft-16 SUBSCRIBE format:
      // Subscribe ID, Full Track Name, Parameters
      // All other fields (filterType, subscriberPriority, groupOrder) are in parameters
      const requestId = reader.readVarIntNumber();
      const fullTrackName = MessageCodec.decodeFullTrackName(reader);

      const message: SubscribeMessage = {
        type: MessageType.SUBSCRIBE,
        requestId,
        fullTrackName,
        subscriberPriority: 128, // Default, may be overridden from parameters
        groupOrder: GroupOrder.ASCENDING,
        filterType: FilterType.LATEST_GROUP, // Default, may be overridden from parameters
      };

      message.parameters = MessageCodec.decodeRequestParameters(reader);

      // Extract fields from parameters
      if (message.parameters) {
        // Subscriber priority (0x20, even)
        const priorityParam = message.parameters.get(0x20);
        if (priorityParam && priorityParam.length > 0) {
          const [priority] = VarInt.decodeNumber(priorityParam);
          message.subscriberPriority = priority;
        }

        // Subscription filter (0x21, odd) - contains filterType and optional start/end
        const filterParam = message.parameters.get(0x21);
        if (filterParam && filterParam.length > 0) {
          const filterReader = new BufferReader(filterParam);
          message.filterType = filterReader.readVarIntNumber() as FilterType;

          if (message.filterType === FilterType.ABSOLUTE_START ||
              message.filterType === FilterType.ABSOLUTE_RANGE) {
            message.startGroup = filterReader.readVarIntNumber();
            message.startObject = filterReader.readVarIntNumber();
          }
          if (message.filterType === FilterType.ABSOLUTE_RANGE) {
            message.endGroup = filterReader.readVarIntNumber();
          }
        }

        // Group order (0x22, even)
        const groupOrderParam = message.parameters.get(0x22);
        if (groupOrderParam && groupOrderParam.length > 0) {
          const [order] = VarInt.decodeNumber(groupOrderParam);
          message.groupOrder = order as GroupOrder;
        }
      }

      return message;
    } else {
      // Draft-14 SUBSCRIBE format:
      // Request ID, Track Namespace, Track Name, Subscriber Priority, Group Order,
      // Forward, Filter Type, [Start Location], [End Group], Parameters
      // NOTE: NO Track Alias in SUBSCRIBE! (Track Alias is assigned by publisher in SUBSCRIBE_OK)
      const requestId = reader.readVarIntNumber();
      const fullTrackName = MessageCodec.decodeFullTrackName(reader);
      // Draft-14: subscriberPriority, groupOrder, forward are 8-bit fixed fields
      const subscriberPriority = reader.readByte();
      const groupOrder = reader.readByte() as GroupOrder;
      const forward = reader.readByte();
      const filterType = reader.readVarIntNumber() as FilterType;

      const message: SubscribeMessage = {
        type: MessageType.SUBSCRIBE,
        requestId,
        fullTrackName,
        subscriberPriority,
        groupOrder,
        forward,
        filterType,
      };

      if (filterType === FilterType.ABSOLUTE_START || filterType === FilterType.ABSOLUTE_RANGE) {
        message.startGroup = reader.readVarIntNumber();
        message.startObject = reader.readVarIntNumber();
      }
      if (filterType === FilterType.ABSOLUTE_RANGE) {
        message.endGroup = reader.readVarIntNumber();
      }

      message.parameters = MessageCodec.decodeRequestParameters(reader);
      return message;
    }
  }

  private static encodeSubscribeUpdatePayload(writer: BufferWriter, message: SubscribeUpdateMessage): void {
    writer.writeVarInt(message.requestId);
    writer.writeVarInt(message.subscriptionRequestId);

    if (IS_DRAFT_16) {
      // Draft-16: All fields are encoded as parameters
      const params = new Map<RequestParameter, Uint8Array>();

      // FORWARD (0x10)
      if (message.forward !== undefined) {
        params.set(RequestParameter.FORWARD, VarInt.encode(message.forward));
      }

      // SUBSCRIBER_PRIORITY (0x20)
      if (message.subscriberPriority !== undefined && message.subscriberPriority !== 128) {
        params.set(RequestParameter.SUBSCRIBER_PRIORITY, VarInt.encode(message.subscriberPriority));
      }

      // SUBSCRIPTION_FILTER (0x21) - encode start/end location
      if (message.startLocation || message.endGroup) {
        const filterWriter = new BufferWriter();
        // LocationType: 0x01 = AbsoluteStart, 0x02 = AbsoluteRange
        const locationType = message.endGroup ? 0x02 : 0x01;
        filterWriter.writeVarInt(locationType);
        filterWriter.writeVarInt(message.startLocation?.groupId ?? 0);
        filterWriter.writeVarInt(message.startLocation?.objectId ?? 0);
        if (message.endGroup) {
          filterWriter.writeVarInt(message.endGroup);
        }
        params.set(RequestParameter.SUBSCRIPTION_FILTER, filterWriter.toUint8Array());
      }

      MessageCodec.encodeRequestParameters(writer, params);
    } else {
      // Draft-14: Fixed fields
      writer.writeVarInt(message.startLocation.groupId);
      writer.writeVarInt(message.startLocation.objectId);
      writer.writeVarInt(message.endGroup);
      writer.writeByte(message.subscriberPriority);
      writer.writeByte(message.forward);
      MessageCodec.encodeRequestParameters(writer, message.parameters);
    }
  }

  private static decodeSubscribeUpdatePayload(reader: BufferReader): SubscribeUpdateMessage {
    const requestId = reader.readVarIntNumber();
    log.info('SUBSCRIBE_UPDATE field', { field: 'requestId', value: requestId });
    const subscriptionRequestId = reader.readVarIntNumber();
    log.info('SUBSCRIBE_UPDATE field', { field: 'subscriptionRequestId', value: subscriptionRequestId });

    if (IS_DRAFT_16) {
      // Draft-16: All fields are in parameters
      const parameters = MessageCodec.decodeRequestParameters(reader);

      // Extract fields from parameters with defaults
      let forward = 1; // Default: forward enabled
      let subscriberPriority = 128; // Default priority
      let startLocation = { groupId: 0, objectId: 0 };
      let endGroup = 0;

      if (parameters) {
        // FORWARD (0x10)
        const forwardParam = parameters.get(RequestParameter.FORWARD);
        if (forwardParam && forwardParam.length > 0) {
          const [fwd] = VarInt.decodeNumber(forwardParam);
          forward = fwd;
        }
        log.info('SUBSCRIBE_UPDATE field', { field: 'forward', value: forward });

        // SUBSCRIBER_PRIORITY (0x20)
        const priorityParam = parameters.get(RequestParameter.SUBSCRIBER_PRIORITY);
        if (priorityParam && priorityParam.length > 0) {
          const [priority] = VarInt.decodeNumber(priorityParam);
          subscriberPriority = priority;
        }
        log.info('SUBSCRIBE_UPDATE field', { field: 'subscriberPriority', value: subscriberPriority });

        // SUBSCRIPTION_FILTER (0x21)
        const filterParam = parameters.get(RequestParameter.SUBSCRIPTION_FILTER);
        if (filterParam && filterParam.length > 0) {
          const filterReader = new BufferReader(filterParam);
          const locationType = filterReader.readVarIntNumber();
          startLocation = {
            groupId: filterReader.readVarIntNumber(),
            objectId: filterReader.readVarIntNumber(),
          };
          if (locationType === 0x02 && filterReader.remaining > 0) {
            endGroup = filterReader.readVarIntNumber();
          }
        }
        log.info('SUBSCRIBE_UPDATE field', { field: 'startLocation', ...startLocation, endGroup });
      }

      return {
        type: MessageType.SUBSCRIBE_UPDATE,
        requestId,
        subscriptionRequestId,
        startLocation,
        endGroup,
        subscriberPriority,
        forward,
      };
    }

    // Draft-14: Fixed fields
    const startGroupId = reader.readVarIntNumber();
    const startObjectId = reader.readVarIntNumber();
    log.info('SUBSCRIBE_UPDATE field', { field: 'startLocation', groupId: startGroupId, objectId: startObjectId });
    const endGroup = reader.readVarIntNumber();
    log.info('SUBSCRIBE_UPDATE field', { field: 'endGroup', value: endGroup });
    // subscriber_priority is 1 byte (uint8)
    const subscriberPriority = reader.readByte();
    log.info('SUBSCRIBE_UPDATE field', { field: 'subscriberPriority', value: subscriberPriority });
    // forward is 1 byte (uint8)
    const forward = reader.readByte();
    log.info('SUBSCRIBE_UPDATE field', { field: 'forward', value: forward });

    // Skip parameters
    MessageCodec.skipParameters(reader);

    return {
      type: MessageType.SUBSCRIBE_UPDATE,
      requestId,
      subscriptionRequestId,
      startLocation: { groupId: startGroupId, objectId: startObjectId },
      endGroup,
      subscriberPriority,
      forward,
    };
  }

  private static encodeSubscribeOkPayload(writer: BufferWriter, message: SubscribeOkMessage): void {
    writer.writeVarInt(message.requestId);
    writer.writeVarInt(message.trackAlias);

    if (IS_DRAFT_16) {
      // Draft-16: SUBSCRIBE_OK format - Request ID, Track Alias, Parameters
      // Send empty parameters for minimal interop
      writer.writeVarInt(0);
    } else {
      // Draft-14: Direct fields
      writer.writeVarInt(message.expires);
      // GroupOrder is 1 byte (uint8)
      writer.writeByte(message.groupOrder);

      // Content Exists is a single byte (0 or 1)
      const exists = typeof message.contentExists === 'boolean'
        ? message.contentExists
        : message.contentExists === ObjectExistence.EXISTS;
      writer.writeByte(exists ? 1 : 0);
      if (exists) {
        writer.writeVarInt(message.largestGroupId ?? 0);
        writer.writeVarInt(message.largestObjectId ?? 0);
      }
    }
  }

  private static decodeSubscribeOkPayload(reader: BufferReader, payloadEndOffset?: number): SubscribeOkMessage {
    const requestId = reader.readVarIntNumber();
    log.info('SUBSCRIBE_OK field', { field: 'requestId', value: requestId });
    // trackAlias can be large (62-bit CityHash64), keep as BigInt
    const trackAlias = reader.readVarInt();
    log.info('SUBSCRIBE_OK field', { field: 'trackAlias', value: trackAlias.toString() });

    let expires = 0;
    let groupOrder: GroupOrder = GroupOrder.ASCENDING;
    let contentExists: boolean | ObjectExistence = ObjectExistence.UNKNOWN;
    let largestGroupId: number | undefined;
    let largestObjectId: number | undefined;

    if (IS_DRAFT_16) {
      // Draft-16: SUBSCRIBE_OK format after trackAlias:
      // 1. Parameters (count + delta-encoded) - includes EXPIRES (key 0x06)
      // 2. Track Extensions (delta-encoded) - includes GROUP_ORDER (key 0x02)

      // Read Parameters first
      const params = MessageCodec.decodeRequestParameters(reader);
      log.info('SUBSCRIBE_OK params', { paramCount: params?.size ?? 0 });

      if (params) {
        // EXPIRES (0x06)
        const expiresParam = params.get(RequestParameter.EXPIRES);
        if (expiresParam) {
          const expiresReader = new BufferReader(expiresParam);
          expires = expiresReader.readVarIntNumber();
        }

        // LARGEST_OBJECT (0x09) - contains largestGroupId and largestObjectId
        const largestObjParam = params.get(RequestParameter.LARGEST_OBJECT);
        if (largestObjParam) {
          const largestObjReader = new BufferReader(largestObjParam);
          largestGroupId = largestObjReader.readVarIntNumber();
          largestObjectId = largestObjReader.readVarIntNumber();
          contentExists = ObjectExistence.EXISTS;
        }
      }

      // Read Track Extensions (no count, just key-value pairs until payload end)
      const extensions = MessageCodec.decodeTrackExtensionsBounded(reader, payloadEndOffset);
      log.info('SUBSCRIBE_OK extensions', { extCount: extensions?.size ?? 0 });

      if (extensions) {
        // GROUP_ORDER extension (key 0x02)
        const groupOrderExt = extensions.get(0x02);
        if (groupOrderExt) {
          const groupOrderReader = new BufferReader(groupOrderExt);
          groupOrder = groupOrderReader.readVarIntNumber() as GroupOrder;
        }
      }
    } else {
      // Draft-14: Direct fields
      expires = reader.readVarIntNumber();
      log.info('SUBSCRIBE_OK field', { field: 'expires', value: expires });

      // GroupOrder is 1 byte (uint8)
      groupOrder = reader.readByte() as GroupOrder;
      log.info('SUBSCRIBE_OK field', { field: 'groupOrder', value: groupOrder });

      // Content Exists is 1 byte (uint8)
      const contentExistsByte = reader.readByte();
      log.info('SUBSCRIBE_OK field', { field: 'contentExists', value: contentExistsByte });
      contentExists = contentExistsByte === 1;
      if (contentExistsByte === 1) {
        largestGroupId = reader.readVarIntNumber();
        largestObjectId = reader.readVarIntNumber();
      }
      // Read and skip any additional parameters (LAPS sends parameters with SUBSCRIBE_OK)
      MessageCodec.skipParameters(reader);
    }

    return {
      type: MessageType.SUBSCRIBE_OK,
      requestId,
      trackAlias,
      expires,
      groupOrder,
      contentExists,
      largestGroupId,
      largestObjectId,
    };
  }

  /**
   * Skip over parameters in the stream (used for messages that include parameters we don't process)
   */
  private static skipParameters(reader: BufferReader): void {
    try {
      const paramCount = reader.readVarIntNumber();
      log.trace('Reading parameters', { count: paramCount });
      for (let i = 0; i < paramCount; i++) {
        const paramType = reader.readVarIntNumber();
        if (paramType % 2 === 0) {
          // Even type: value is a single varint
          const value = reader.readVarIntNumber();
          log.trace('Parameter (even/varint)', { type: paramType, value });
        } else {
          // Odd type: length-prefixed bytes
          const length = reader.readVarIntNumber();
          reader.readBytes(length); // Skip bytes without allocating hex string
          log.trace('Parameter (odd/bytes)', { type: paramType, length });
        }
      }
    } catch {
      // No parameters or incomplete - that's fine
    }
  }

  private static encodeSubscribeErrorPayload(writer: BufferWriter, message: SubscribeErrorMessage): void {
    writer.writeVarInt(message.requestId);
    writer.writeVarInt(message.errorCode);

    if (IS_DRAFT_16) {
      // Draft-16 (REQUEST_ERROR): trackAlias comes BEFORE reasonPhrase
      writer.writeVarInt(message.trackAlias);
      writer.writeString(message.reasonPhrase);
    } else {
      // Draft-14 (SUBSCRIBE_ERROR): trackAlias comes AFTER reasonPhrase
      writer.writeString(message.reasonPhrase);
      writer.writeVarInt(message.trackAlias);
    }
  }

  private static decodeSubscribeErrorPayload(reader: BufferReader): SubscribeErrorMessage {
    const requestId = reader.readVarIntNumber();
    const errorCode = reader.readVarIntNumber() as RequestErrorCode;

    // Draft-16 (REQUEST_ERROR): trackAlias comes BEFORE reasonPhrase
    // Draft-14 (SUBSCRIBE_ERROR): trackAlias comes AFTER reasonPhrase
    let trackAlias: number;
    let reasonPhrase: string;

    if (IS_DRAFT_16) {
      trackAlias = reader.readVarIntNumber();
      reasonPhrase = reader.readString();
    } else {
      reasonPhrase = reader.readString();
      trackAlias = reader.hasMore ? reader.readVarIntNumber() : 0;
    }

    return {
      type: MessageType.SUBSCRIBE_ERROR,
      requestId,
      errorCode,
      reasonPhrase,
      trackAlias,
    };
  }

  private static encodeUnsubscribePayload(writer: BufferWriter, message: UnsubscribeMessage): void {
    writer.writeVarInt(message.requestId);
  }

  private static decodeUnsubscribePayload(reader: BufferReader): UnsubscribeMessage {
    return {
      type: MessageType.UNSUBSCRIBE,
      requestId: reader.readVarIntNumber(),
    };
  }

  // ============================================================================
  // Publish Message Encoding/Decoding (Draft 14)
  // ============================================================================

  private static encodePublishDonePayload(writer: BufferWriter, message: PublishDoneMessage): void {
    writer.writeVarInt(message.requestId);
    writer.writeVarInt(message.statusCode);
    writer.writeString(message.reasonPhrase);
    writer.writeByte(message.contentExists ? 1 : 0);
    if (message.contentExists) {
      writer.writeVarInt(message.finalGroupId ?? 0);
      writer.writeVarInt(message.finalObjectId ?? 0);
    }
  }

  private static decodePublishDonePayload(reader: BufferReader): PublishDoneMessage {
    const requestId = reader.readVarIntNumber();

    // Draft-16: PUBLISH_DONE has trackAlias after requestId
    const trackAlias = IS_DRAFT_16 ? reader.readVarIntNumber() : 0;

    const statusCode = reader.readVarIntNumber() as RequestErrorCode;
    const reasonPhrase = reader.readString();

    // Draft-16: contentExists might not be present or is in a different format
    const contentExists = IS_DRAFT_16 ? false : reader.readByte() === 1;

    const message: PublishDoneMessage = {
      type: MessageType.PUBLISH_DONE,
      requestId,
      statusCode,
      reasonPhrase,
      contentExists,
    };

    if (!IS_DRAFT_16 && contentExists) {
      message.finalGroupId = reader.readVarIntNumber();
      message.finalObjectId = reader.readVarIntNumber();
    }

    log.info('Decoded PUBLISH_DONE', { requestId, trackAlias, statusCode, reasonPhrase });

    return message;
  }

  private static encodePublishPayload(writer: BufferWriter, message: PublishMessage): void {
    if (IS_DRAFT_16) {
      // Draft-16 PUBLISH format:
      // Request ID, Full Track Name, Track Alias, Parameters
      // groupOrder, forward, largestLocation are all in Parameters

      // DEBUG: Track byte offsets for each field
      const debugParts: { field: string; start: number; bytes: string }[] = [];
      let startPos = writer.length;

      writer.writeVarInt(message.requestId);
      debugParts.push({ field: 'requestId=' + message.requestId, start: startPos, bytes: MessageCodec.hexBytes(writer, startPos) });
      startPos = writer.length;

      MessageCodec.encodeFullTrackName(writer, message.fullTrackName);
      debugParts.push({ field: 'fullTrackName', start: startPos, bytes: MessageCodec.hexBytes(writer, startPos) });
      startPos = writer.length;

      writer.writeVarInt(message.trackAlias);
      debugParts.push({ field: 'trackAlias=' + message.trackAlias, start: startPos, bytes: MessageCodec.hexBytes(writer, startPos) });
      startPos = writer.length;

      // Build parameters from message fields
      // Note: Don't include user-provided parameters - only spec-defined ones
      const params = new Map<number, Uint8Array>();

      // LARGEST_OBJECT (0x09, odd) - only if content exists with location
      if (message.contentExists && message.largestLocation) {
        const locWriter = new BufferWriter();
        locWriter.writeVarInt(message.largestLocation.groupId);
        locWriter.writeVarInt(message.largestLocation.objectId);
        params.set(RequestParameter.LARGEST_OBJECT, locWriter.toUint8Array());
      }

      // FORWARD (0x10, even)
      if (message.forward !== undefined) {
        params.set(RequestParameter.FORWARD, VarInt.encode(message.forward));
      }

      // GROUP_ORDER (0x22, even)
      if (message.groupOrder !== undefined) {
        params.set(RequestParameter.GROUP_ORDER, VarInt.encode(message.groupOrder));
      }

      // Encode parameters with debug
      MessageCodec.encodeRequestParameters(writer, params);
      debugParts.push({ field: 'params(count=' + params.size + ')', start: startPos, bytes: MessageCodec.hexBytes(writer, startPos) });

      // Log the full breakdown
      log.info('PUBLISH (draft-16) encoding breakdown:', debugParts);
      log.info('PUBLISH params detail:', {
        forward: message.forward,
        groupOrder: message.groupOrder,
        contentExists: message.contentExists,
        paramKeys: Array.from(params.keys()).map(k => '0x' + k.toString(16))
      });
    } else {
      // Draft-14 PUBLISH format (Section 9.13):
      // Request ID (varint), Track Namespace (tuple), Track Name (string),
      // Track Alias (varint), Group Order (8), Content Exists (8),
      // [Largest Location], Forward (8), Parameters
      writer.writeVarInt(message.requestId);
      MessageCodec.encodeFullTrackName(writer, message.fullTrackName);
      writer.writeVarInt(message.trackAlias);
      writer.writeByte(message.groupOrder);
      writer.writeByte(message.contentExists ? 1 : 0);
      if (message.contentExists && message.largestLocation) {
        writer.writeVarInt(message.largestLocation.groupId);
        writer.writeVarInt(message.largestLocation.objectId);
      }
      writer.writeByte(message.forward);
      MessageCodec.encodeRequestParameters(writer, message.parameters);
    }
  }

  private static decodePublishPayload(reader: BufferReader, payloadEndOffset?: number): PublishMessage {
    if (IS_DRAFT_16) {
      // Draft-16 PUBLISH format:
      // Request ID, Full Track Name, Track Alias, Parameters, [Track Extensions]
      const requestId = reader.readVarIntNumber();
      const fullTrackName = MessageCodec.decodeFullTrackName(reader);
      const trackAlias = reader.readVarIntNumber();
      const parameters = MessageCodec.decodeRequestParameters(reader);

      // Read track extensions only if there are at least 2 bytes remaining (minimum for valid extension)
      const remainingBytes = payloadEndOffset !== undefined
        ? payloadEndOffset - reader.offset
        : reader.remaining;
      if (remainingBytes >= 2) {
        MessageCodec.decodeTrackExtensionsBounded(reader, payloadEndOffset);
      }

      // Extract fields from parameters
      let groupOrder = GroupOrder.ASCENDING;
      let forward = 1;
      let contentExists = false;
      let largestLocation: { groupId: number; objectId: number } | undefined;

      if (parameters) {
        // GROUP_ORDER (0x22, even)
        const groupOrderParam = parameters.get(RequestParameter.GROUP_ORDER);
        if (groupOrderParam && groupOrderParam.length > 0) {
          const [order] = VarInt.decodeNumber(groupOrderParam);
          groupOrder = order as GroupOrder;
        }

        // FORWARD (0x10, even)
        const forwardParam = parameters.get(RequestParameter.FORWARD);
        if (forwardParam && forwardParam.length > 0) {
          const [fwd] = VarInt.decodeNumber(forwardParam);
          forward = fwd;
        }

        // LARGEST_OBJECT (0x09, odd)
        const largestParam = parameters.get(RequestParameter.LARGEST_OBJECT);
        if (largestParam && largestParam.length > 0) {
          contentExists = true;
          const locReader = new BufferReader(largestParam);
          largestLocation = {
            groupId: locReader.readVarIntNumber(),
            objectId: locReader.readVarIntNumber(),
          };
        }
      }

      return {
        type: MessageType.PUBLISH,
        requestId,
        fullTrackName,
        trackAlias,
        groupOrder,
        contentExists,
        largestLocation,
        forward,
        parameters,
      };
    } else {
      // Draft-14 PUBLISH format (Section 9.13):
      // Request ID (varint), Track Namespace (tuple), Track Name (string),
      // Track Alias (varint), Group Order (8), Content Exists (8),
      // [Largest Location], Forward (8), Parameters
      const requestId = reader.readVarIntNumber();
      const fullTrackName = MessageCodec.decodeFullTrackName(reader);
      const trackAlias = reader.readVarIntNumber();
      const groupOrder = reader.readByte() as GroupOrder;
      const contentExists = reader.readByte() === 1;

      let largestLocation: { groupId: number; objectId: number } | undefined;
      if (contentExists) {
        largestLocation = {
          groupId: reader.readVarIntNumber(),
          objectId: reader.readVarIntNumber(),
        };
      }

      const forward = reader.readByte();
      const parameters = MessageCodec.decodeRequestParameters(reader);

      return {
        type: MessageType.PUBLISH,
        requestId,
        fullTrackName,
        trackAlias,
        groupOrder,
        contentExists,
        largestLocation,
        forward,
        parameters,
      };
    }
  }

  private static encodePublishOkPayload(writer: BufferWriter, message: PublishOkMessage): void {
    writer.writeVarInt(message.requestId);

    if (IS_DRAFT_16) {
      // Draft-16: Request ID, Parameters
      const params = new Map<number, Uint8Array>();

      // FORWARD (0x10, even)
      if (message.forward !== undefined) {
        params.set(RequestParameter.FORWARD, VarInt.encode(message.forward));
      }

      // SUBSCRIBER_PRIORITY (0x20, even)
      if (message.subscriberPriority !== undefined) {
        params.set(RequestParameter.SUBSCRIBER_PRIORITY, VarInt.encode(message.subscriberPriority));
      }

      // SUBSCRIPTION_FILTER (0x21, odd) - contains filterType and optional locations
      const filterWriter = new BufferWriter();
      filterWriter.writeVarInt(message.filterType);
      if (message.filterType === FilterType.ABSOLUTE_START || message.filterType === FilterType.ABSOLUTE_RANGE) {
        filterWriter.writeVarInt(message.startLocation?.groupId ?? 0);
        filterWriter.writeVarInt(message.startLocation?.objectId ?? 0);
      }
      if (message.filterType === FilterType.ABSOLUTE_RANGE) {
        filterWriter.writeVarInt(message.endGroup ?? 0);
      }
      params.set(RequestParameter.SUBSCRIPTION_FILTER, filterWriter.toUint8Array());

      // GROUP_ORDER (0x22, even)
      if (message.groupOrder !== undefined) {
        params.set(RequestParameter.GROUP_ORDER, VarInt.encode(message.groupOrder));
      }

      MessageCodec.encodeRequestParameters(writer, params);
    } else {
      // Draft-14: direct fields
      writer.writeByte(message.forward);
      writer.writeByte(message.subscriberPriority);
      writer.writeByte(message.groupOrder);
      writer.writeVarInt(message.filterType);
      // Optional groups based on filter type - not implemented for now
      // Write empty parameters
      writer.writeVarInt(0);
    }
  }

  private static decodePublishOkPayload(reader: BufferReader): PublishOkMessage {
    const requestId = reader.readVarIntNumber();
    log.info('PUBLISH_OK field', { field: 'requestId', value: requestId });

    if (IS_DRAFT_16) {
      // Draft-16: Request ID, Parameters
      // All fields (forward, subscriberPriority, groupOrder, filterType, etc.) are in parameters
      const parameters = MessageCodec.decodeRequestParameters(reader);

      let forward = 1;
      let subscriberPriority = 128;
      let groupOrder = GroupOrder.ASCENDING;
      let filterType = FilterType.LATEST_GROUP;
      let startLocation: { groupId: number; objectId: number } | undefined;
      let endGroup: number | undefined;

      if (parameters) {
        // FORWARD (0x10, even)
        const forwardParam = parameters.get(RequestParameter.FORWARD);
        if (forwardParam && forwardParam.length > 0) {
          const [fwd] = VarInt.decodeNumber(forwardParam);
          forward = fwd;
        }

        // SUBSCRIBER_PRIORITY (0x20, even)
        const priorityParam = parameters.get(RequestParameter.SUBSCRIBER_PRIORITY);
        if (priorityParam && priorityParam.length > 0) {
          const [pri] = VarInt.decodeNumber(priorityParam);
          subscriberPriority = pri;
        }

        // GROUP_ORDER (0x22, even)
        const groupOrderParam = parameters.get(RequestParameter.GROUP_ORDER);
        if (groupOrderParam && groupOrderParam.length > 0) {
          const [order] = VarInt.decodeNumber(groupOrderParam);
          groupOrder = order as GroupOrder;
        }

        // SUBSCRIPTION_FILTER (0x21, odd) - contains filterType and optional locations
        const filterParam = parameters.get(RequestParameter.SUBSCRIPTION_FILTER);
        if (filterParam && filterParam.length > 0) {
          const filterReader = new BufferReader(filterParam);
          filterType = filterReader.readVarIntNumber() as FilterType;

          if (filterType === FilterType.ABSOLUTE_START || filterType === FilterType.ABSOLUTE_RANGE) {
            // Use BigInt for location values - relay may send max varint (0x3FFFFFFFFFFFFFFF) as "unknown"
            const groupIdBig = filterReader.readVarInt();
            const objectIdBig = filterReader.readVarInt();
            // Max 62-bit varint is sentinel for "unknown" - treat as 0
            const MAX_VARINT = 0x3FFFFFFFFFFFFFFFn;
            if (groupIdBig >= MAX_VARINT) {
              log.info('PUBLISH_OK filter has max varint groupId (unknown)', { value: groupIdBig.toString() });
            }
            if (objectIdBig >= MAX_VARINT) {
              log.info('PUBLISH_OK filter has max varint objectId (unknown)', { value: objectIdBig.toString() });
            }
            startLocation = {
              groupId: groupIdBig >= MAX_VARINT ? 0 : Number(groupIdBig),
              objectId: objectIdBig >= MAX_VARINT ? 0 : Number(objectIdBig),
            };
          }
          if (filterType === FilterType.ABSOLUTE_RANGE) {
            const endGroupBig = filterReader.readVarInt();
            const MAX_VARINT = 0x3FFFFFFFFFFFFFFFn;
            if (endGroupBig >= MAX_VARINT) {
              log.info('PUBLISH_OK filter has max varint endGroup (unknown)', { value: endGroupBig.toString() });
            }
            endGroup = endGroupBig >= MAX_VARINT ? undefined : Number(endGroupBig);
          }
        }
      }

      log.info('PUBLISH_OK (draft-16)', { forward, subscriberPriority, groupOrder, filterType });

      return {
        type: MessageType.PUBLISH_OK,
        requestId,
        forward,
        subscriberPriority,
        groupOrder,
        filterType,
        startLocation,
        endGroup,
        parameters,
      };
    } else {
      // Draft-14: requestId, forward, subscriberPriority, groupOrder, filterType as direct fields
      const forward = reader.readByte();
      log.info('PUBLISH_OK field', { field: 'forward', value: forward });
      const subscriberPriority = reader.readByte();
      log.info('PUBLISH_OK field', { field: 'subscriberPriority', value: subscriberPriority });
      const groupOrder = reader.readByte() as GroupOrder;
      log.info('PUBLISH_OK field', { field: 'groupOrder', value: groupOrder });
      const filterType = reader.readVarIntNumber();
      log.info('PUBLISH_OK field', { field: 'filterType', value: filterType });

      const message: PublishOkMessage = {
        type: MessageType.PUBLISH_OK,
        requestId,
        forward,
        subscriberPriority,
        groupOrder,
        filterType,
      };

      // Read optional groups based on filter type
      if (filterType === 0x2 || filterType === 0x3 || filterType === 0x4) {
        message.startLocation = {
          groupId: reader.readVarIntNumber(),
          objectId: reader.readVarIntNumber(),
        };
        log.info('PUBLISH_OK field', { field: 'startLocation', value: message.startLocation });
      }
      if (filterType === 0x4) {
        message.endGroup = reader.readVarIntNumber();
        log.info('PUBLISH_OK field', { field: 'endGroup', value: message.endGroup });
      }

      // Skip parameters
      MessageCodec.skipParameters(reader);

      return message;
    }
  }

  private static encodePublishErrorPayload(writer: BufferWriter, message: PublishErrorMessage): void {
    writer.writeVarInt(message.requestId);
    writer.writeVarInt(message.errorCode);

    if (IS_DRAFT_16) {
      // Draft-16: trackAlias before reasonPhrase (like REQUEST_ERROR)
      writer.writeVarInt(message.trackAlias);
      writer.writeString(message.reasonPhrase);
    } else {
      // Draft-14: reasonPhrase before trackAlias
      writer.writeString(message.reasonPhrase);
      writer.writeVarInt(message.trackAlias);
    }
  }

  private static decodePublishErrorPayload(reader: BufferReader): PublishErrorMessage {
    const requestId = reader.readVarIntNumber();
    const errorCode = reader.readVarIntNumber() as RequestErrorCode;

    let trackAlias: number;
    let reasonPhrase: string;

    if (IS_DRAFT_16) {
      // Draft-16: trackAlias before reasonPhrase
      trackAlias = reader.readVarIntNumber();
      reasonPhrase = reader.readString();
    } else {
      // Draft-14: reasonPhrase before trackAlias
      reasonPhrase = reader.readString();
      trackAlias = reader.readVarIntNumber();
    }

    return {
      type: MessageType.PUBLISH_ERROR,
      requestId,
      errorCode,
      reasonPhrase,
      trackAlias,
    };
  }

  // ============================================================================
  // Namespace Publishing Encoding/Decoding (Draft 14/16)
  // ============================================================================

  private static encodePublishNamespacePayload(writer: BufferWriter, message: PublishNamespaceMessage): void {
    // Draft-16 adds Request ID at the beginning
    if (IS_DRAFT_16) {
      writer.writeVarInt(message.requestId ?? 0);
    }
    MessageCodec.encodeNamespace(writer, message.namespace);
    const paramCount = message.parameters?.size ?? 0;
    writer.writeVarInt(paramCount);
    if (message.parameters) {
      for (const [key, value] of message.parameters) {
        writer.writeVarInt(key);
        writer.writeVarInt(value.length);
        writer.writeBytes(value);
      }
    }
  }

  private static decodePublishNamespacePayload(reader: BufferReader): PublishNamespaceMessage {
    // Draft-16 has Request ID at the beginning
    let requestId: number | undefined;
    if (IS_DRAFT_16) {
      requestId = reader.readVarIntNumber();
    }
    const namespace = MessageCodec.decodeNamespace(reader);
    const paramCount = reader.readVarIntNumber();

    let parameters: Map<number, Uint8Array> | undefined;
    if (paramCount > 0) {
      parameters = new Map();
      for (let i = 0; i < paramCount; i++) {
        const key = reader.readVarIntNumber();
        const length = reader.readVarIntNumber();
        parameters.set(key, reader.readBytes(length));
      }
    }

    return {
      type: MessageType.PUBLISH_NAMESPACE,
      requestId,
      namespace,
      parameters,
    };
  }

  private static encodePublishNamespaceOkPayload(writer: BufferWriter, message: PublishNamespaceOkMessage): void {
    if (IS_DRAFT_16) {
      // Draft-16: REQUEST_OK format (Request ID + Expires)
      writer.writeVarInt(message.requestId ?? 0);
      writer.writeVarInt(message.expires ?? 0);
    } else {
      // Draft-14: Namespace
      MessageCodec.encodeNamespace(writer, message.namespace ?? []);
    }
  }

  private static decodePublishNamespaceOkPayload(reader: BufferReader): PublishNamespaceOkMessage {
    if (IS_DRAFT_16) {
      // Draft-16: REQUEST_OK format (Request ID + Expires)
      return {
        type: MessageType.PUBLISH_NAMESPACE_OK,
        requestId: reader.readVarIntNumber(),
        expires: reader.readVarIntNumber(),
      };
    } else {
      // Draft-14: Namespace
      return {
        type: MessageType.PUBLISH_NAMESPACE_OK,
        namespace: MessageCodec.decodeNamespace(reader),
      };
    }
  }

  private static encodePublishNamespaceErrorPayload(writer: BufferWriter, message: PublishNamespaceErrorMessage): void {
    MessageCodec.encodeNamespace(writer, message.namespace);
    writer.writeVarInt(message.errorCode);
    writer.writeString(message.reasonPhrase);
  }

  private static decodePublishNamespaceErrorPayload(reader: BufferReader): PublishNamespaceErrorMessage {
    return {
      type: MessageType.PUBLISH_NAMESPACE_ERROR,
      namespace: MessageCodec.decodeNamespace(reader),
      errorCode: reader.readVarIntNumber() as NamespaceErrorCode,
      reasonPhrase: reader.readString(),
    };
  }

  private static encodePublishNamespaceDonePayload(writer: BufferWriter, message: PublishNamespaceDoneMessage): void {
    MessageCodec.encodeNamespace(writer, message.namespace);
  }

  private static decodePublishNamespaceDonePayload(reader: BufferReader): PublishNamespaceDoneMessage {
    return {
      type: MessageType.PUBLISH_NAMESPACE_DONE,
      namespace: MessageCodec.decodeNamespace(reader),
    };
  }

  private static encodePublishNamespaceCancelPayload(writer: BufferWriter, message: PublishNamespaceCancelMessage): void {
    MessageCodec.encodeNamespace(writer, message.namespace);
  }

  private static decodePublishNamespaceCancelPayload(reader: BufferReader): PublishNamespaceCancelMessage {
    return {
      type: MessageType.PUBLISH_NAMESPACE_CANCEL,
      namespace: MessageCodec.decodeNamespace(reader),
    };
  }

  // ============================================================================
  // Namespace Subscription Encoding/Decoding
  // ============================================================================

  private static encodeSubscribeNamespacePayload(
    writer: BufferWriter,
    message: SubscribeNamespaceMessage
  ): void {
    if (IS_DRAFT_16) {
      writer.writeVarInt(message.requestId ?? 0);
    }
    MessageCodec.encodeNamespace(writer, message.namespacePrefix);
    if (IS_DRAFT_16) {
      // Subscribe Options: 0x00=PUBLISH, 0x01=NAMESPACE, 0x02=BOTH
      writer.writeVarInt(message.subscribeOptions ?? 0x00);
    }
    const paramCount = message.parameters?.size ?? 0;
    writer.writeVarInt(paramCount);
    if (message.parameters) {
      for (const [key, value] of message.parameters) {
        writer.writeVarInt(key);
        writer.writeVarInt(value.length);
        writer.writeBytes(value);
      }
    }
  }

  private static decodeSubscribeNamespacePayload(reader: BufferReader): SubscribeNamespaceMessage {
    let requestId: number | undefined;
    let subscribeOptions: number | undefined;
    if (IS_DRAFT_16) {
      requestId = reader.readVarIntNumber();
    }
    const namespacePrefix = MessageCodec.decodeNamespace(reader);
    if (IS_DRAFT_16) {
      subscribeOptions = reader.readVarIntNumber();
    }
    const paramCount = reader.readVarIntNumber();

    let parameters: Map<number, Uint8Array> | undefined;
    if (paramCount > 0) {
      parameters = new Map();
      for (let i = 0; i < paramCount; i++) {
        const key = reader.readVarIntNumber();
        const length = reader.readVarIntNumber();
        parameters.set(key, reader.readBytes(length));
      }
    }

    return {
      type: MessageType.SUBSCRIBE_NAMESPACE,
      requestId,
      namespacePrefix,
      subscribeOptions,
      parameters,
    };
  }

  private static encodeSubscribeNamespaceOkPayload(
    writer: BufferWriter,
    message: SubscribeNamespaceOkMessage
  ): void {
    if (IS_DRAFT_16) {
      writer.writeVarInt(message.requestId ?? 0);
    } else {
      MessageCodec.encodeNamespace(writer, message.namespacePrefix ?? []);
    }
  }

  private static decodeSubscribeNamespaceOkPayload(reader: BufferReader): SubscribeNamespaceOkMessage {
    if (IS_DRAFT_16) {
      return {
        type: MessageType.SUBSCRIBE_NAMESPACE_OK,
        requestId: reader.readVarIntNumber(),
      };
    } else {
      return {
        type: MessageType.SUBSCRIBE_NAMESPACE_OK,
        namespacePrefix: MessageCodec.decodeNamespace(reader),
      };
    }
  }

  private static encodeSubscribeNamespaceErrorPayload(
    writer: BufferWriter,
    message: SubscribeNamespaceErrorMessage
  ): void {
    if (IS_DRAFT_16) {
      writer.writeVarInt(message.requestId ?? 0);
    } else {
      MessageCodec.encodeNamespace(writer, message.namespacePrefix ?? []);
    }
    writer.writeVarInt(message.errorCode);
    writer.writeString(message.reasonPhrase);
  }

  private static decodeSubscribeNamespaceErrorPayload(
    reader: BufferReader
  ): SubscribeNamespaceErrorMessage {
    if (IS_DRAFT_16) {
      return {
        type: MessageType.SUBSCRIBE_NAMESPACE_ERROR,
        requestId: reader.readVarIntNumber(),
        errorCode: reader.readVarIntNumber(),
        reasonPhrase: reader.readString(),
      };
    } else {
      return {
        type: MessageType.SUBSCRIBE_NAMESPACE_ERROR,
        namespacePrefix: MessageCodec.decodeNamespace(reader),
        errorCode: reader.readVarIntNumber(),
        reasonPhrase: reader.readString(),
      };
    }
  }

  private static encodeUnsubscribeNamespacePayload(
    writer: BufferWriter,
    message: UnsubscribeNamespaceMessage
  ): void {
    MessageCodec.encodeNamespace(writer, message.namespacePrefix);
  }

  private static decodeUnsubscribeNamespacePayload(reader: BufferReader): UnsubscribeNamespaceMessage {
    return {
      type: MessageType.UNSUBSCRIBE_NAMESPACE,
      namespacePrefix: MessageCodec.decodeNamespace(reader),
    };
  }

  // ============================================================================
  // Fetch Message Encoding/Decoding (Draft 14 / Draft 16)
  // ============================================================================

  // FetchType values for draft-15+
  private static readonly FETCH_TYPE_STANDALONE = 0x01;

  private static encodeFetchPayload(writer: BufferWriter, message: FetchMessage): void {
    log.info('FETCH encode', {
      requestId: message.requestId,
      namespace: message.fullTrackName.namespace.join('/'),
      trackName: message.fullTrackName.trackName,
      subscriberPriority: message.subscriberPriority,
      groupOrder: message.groupOrder,
      startGroup: message.startGroup,
      startObject: message.startObject,
      endGroup: message.endGroup,
      endObject: message.endObject,
      paramCount: message.parameters?.size ?? 0,
      isDraft16: IS_DRAFT_16,
    });

    writer.writeVarInt(message.requestId);

    if (IS_DRAFT_16) {
      // Draft-15+: FetchType, then type-specific fields, then parameters
      // Using STANDALONE (0x01) which requires: Full Track Name, Start Location, End Location
      writer.writeVarInt(MessageCodec.FETCH_TYPE_STANDALONE);
      MessageCodec.encodeFullTrackName(writer, message.fullTrackName);
      // Start location (group, object)
      writer.writeVarInt(message.startGroup);
      writer.writeVarInt(message.startObject);
      // End location (group, object)
      writer.writeVarInt(message.endGroup);
      writer.writeVarInt(message.endObject);
      // Parameters - include priority and group order as parameters
      const params = new Map<RequestParameter, Uint8Array>(message.parameters ?? []);
      // Add subscriber priority as parameter (0x20)
      const priorityWriter = new BufferWriter();
      priorityWriter.writeVarInt(message.subscriberPriority);
      params.set(RequestParameter.SUBSCRIBER_PRIORITY, priorityWriter.toUint8Array());
      // Add group order as parameter (0x22)
      const orderWriter = new BufferWriter();
      orderWriter.writeVarInt(message.groupOrder);
      params.set(RequestParameter.GROUP_ORDER, orderWriter.toUint8Array());
      MessageCodec.encodeRequestParameters(writer, params);
    } else {
      // Draft-14: Fixed format fields
      MessageCodec.encodeFullTrackName(writer, message.fullTrackName);
      writer.writeByte(message.subscriberPriority);
      writer.writeByte(message.groupOrder);
      writer.writeVarInt(message.startGroup);
      writer.writeVarInt(message.startObject);
      writer.writeVarInt(message.endGroup);
      writer.writeVarInt(message.endObject);
      MessageCodec.encodeRequestParameters(writer, message.parameters);
    }
  }

  private static decodeFetchPayload(reader: BufferReader): FetchMessage {
    const requestId = reader.readVarIntNumber();

    if (IS_DRAFT_16) {
      // Draft-15+: Read fetch type, then type-specific fields
      const fetchType = reader.readVarIntNumber();
      if (fetchType !== MessageCodec.FETCH_TYPE_STANDALONE) {
        throw new MessageCodecError(`Unsupported fetch type: ${fetchType}`);
      }
      const fullTrackName = MessageCodec.decodeFullTrackName(reader);
      const startGroup = reader.readVarIntNumber();
      const startObject = reader.readVarIntNumber();
      const endGroup = reader.readVarIntNumber();
      const endObject = reader.readVarIntNumber();
      const parameters = MessageCodec.decodeRequestParameters(reader);

      // Extract priority and group order from parameters, with defaults
      let subscriberPriority = 128;
      let groupOrder = GroupOrder.ASCENDING;
      // Parameters would need to be parsed for these values

      return {
        type: MessageType.FETCH,
        requestId,
        fullTrackName,
        subscriberPriority,
        groupOrder,
        startGroup,
        startObject,
        endGroup,
        endObject,
        parameters,
      };
    } else {
      // Draft-14 format
      return {
        type: MessageType.FETCH,
        requestId,
        fullTrackName: MessageCodec.decodeFullTrackName(reader),
        subscriberPriority: reader.readByte(),
        groupOrder: reader.readByte() as GroupOrder,
        startGroup: reader.readVarIntNumber(),
        startObject: reader.readVarIntNumber(),
        endGroup: reader.readVarIntNumber(),
        endObject: reader.readVarIntNumber(),
        parameters: MessageCodec.decodeRequestParameters(reader),
      };
    }
  }

  private static encodeFetchCancelPayload(writer: BufferWriter, message: FetchCancelMessage): void {
    writer.writeVarInt(message.requestId);
  }

  private static decodeFetchCancelPayload(reader: BufferReader): FetchCancelMessage {
    return {
      type: MessageType.FETCH_CANCEL,
      requestId: reader.readVarIntNumber(),
    };
  }

  private static encodeFetchOkPayload(writer: BufferWriter, message: FetchOkMessage): void {
    writer.writeVarInt(message.requestId);
    if (IS_DRAFT_16) {
      // Draft-16 FETCH_OK: requestId | numParams | [params...]
      // Only requestId + parameters on the wire
      writer.writeVarInt(0); // Number of parameters
    } else {
      // Pre-draft-16: full fields
      writer.writeVarInt(message.groupOrder);
      writer.writeByte(message.endOfTrack ? 1 : 0);
      writer.writeVarInt(message.largestGroupId);
      writer.writeVarInt(message.largestObjectId);
    }
  }

  private static decodeFetchOkPayload(reader: BufferReader): FetchOkMessage {
    const requestId = reader.readVarIntNumber();

    if (IS_DRAFT_16) {
      // Draft-16 FETCH_OK: requestId | numParams | [params...]
      const numParams = reader.readVarIntNumber();
      for (let i = 0; i < numParams; i++) {
        reader.readVarIntNumber(); // key
        const valueLen = reader.readVarIntNumber();
        reader.readBytes(valueLen); // value
      }
      // Return with defaults for fields not on wire
      return {
        type: MessageType.FETCH_OK,
        requestId,
        groupOrder: GroupOrder.ASCENDING,
        endOfTrack: false,
        largestGroupId: 0,
        largestObjectId: 0,
      };
    }

    // Pre-draft-16: full fields on wire
    const groupOrder = reader.readVarIntNumber() as GroupOrder;
    const endOfTrack = reader.readByte() === 1;
    const largestGroupId = reader.readVarIntNumber();
    const largestObjectId = reader.readVarIntNumber();

    return {
      type: MessageType.FETCH_OK,
      requestId,
      groupOrder,
      endOfTrack,
      largestGroupId,
      largestObjectId,
    };
  }

  private static encodeFetchErrorPayload(writer: BufferWriter, message: FetchErrorMessage): void {
    writer.writeVarInt(message.requestId);
    writer.writeVarInt(message.errorCode);
    writer.writeString(message.reasonPhrase);
  }

  private static decodeFetchErrorPayload(reader: BufferReader): FetchErrorMessage {
    return {
      type: MessageType.FETCH_ERROR,
      requestId: reader.readVarIntNumber(),
      errorCode: reader.readVarIntNumber() as RequestErrorCode,
      reasonPhrase: reader.readString(),
    };
  }

  // ============================================================================
  // Session Message Encoding/Decoding (Draft 14)
  // ============================================================================

  private static encodeGoAwayPayload(writer: BufferWriter, message: GoAwayMessage): void {
    writer.writeString(message.newSessionUri ?? '');
  }

  private static decodeGoAwayPayload(reader: BufferReader): GoAwayMessage {
    const newSessionUri = reader.readString();
    return {
      type: MessageType.GOAWAY,
      newSessionUri: newSessionUri || undefined,
    };
  }

  private static encodeMaxRequestIdPayload(writer: BufferWriter, message: MaxRequestIdMessage): void {
    writer.writeVarInt(message.maxRequestId);
  }

  private static decodeMaxRequestIdPayload(reader: BufferReader): MaxRequestIdMessage {
    return {
      type: MessageType.MAX_REQUEST_ID,
      maxRequestId: reader.readVarIntNumber(),
    };
  }

  private static encodeRequestsBlockedPayload(writer: BufferWriter, message: RequestsBlockedMessage): void {
    writer.writeVarInt(message.blockedRequestId);
  }

  private static decodeRequestsBlockedPayload(reader: BufferReader): RequestsBlockedMessage {
    return {
      type: MessageType.REQUESTS_BLOCKED,
      blockedRequestId: reader.readVarIntNumber(),
    };
  }

  // ============================================================================
  // Track Status Encoding/Decoding (Draft 14)
  // ============================================================================

  private static encodeTrackStatusPayload(writer: BufferWriter, message: TrackStatusMessage): void {
    writer.writeVarInt(message.requestId);
    MessageCodec.encodeFullTrackName(writer, message.fullTrackName);
    MessageCodec.encodeRequestParameters(writer, message.parameters);
  }

  private static decodeTrackStatusPayload(reader: BufferReader): TrackStatusMessage {
    return {
      type: MessageType.TRACK_STATUS,
      requestId: reader.readVarIntNumber(),
      fullTrackName: MessageCodec.decodeFullTrackName(reader),
      parameters: MessageCodec.decodeRequestParameters(reader),
    };
  }

  private static encodeTrackStatusOkPayload(writer: BufferWriter, message: TrackStatusOkMessage): void {
    writer.writeVarInt(message.requestId);
    writer.writeVarInt(message.statusCode);
    if (message.statusCode === TrackStatusCode.IN_PROGRESS ||
        message.statusCode === TrackStatusCode.FINISHED) {
      writer.writeVarInt(message.lastGroupId ?? 0);
      writer.writeVarInt(message.lastObjectId ?? 0);
    }
  }

  private static decodeTrackStatusOkPayload(reader: BufferReader): TrackStatusOkMessage {
    const requestId = reader.readVarIntNumber();
    const statusCode = reader.readVarIntNumber() as TrackStatusCode;

    const message: TrackStatusOkMessage = {
      type: MessageType.TRACK_STATUS_OK,
      requestId,
      statusCode,
    };

    if (statusCode === TrackStatusCode.IN_PROGRESS || statusCode === TrackStatusCode.FINISHED) {
      message.lastGroupId = reader.readVarIntNumber();
      message.lastObjectId = reader.readVarIntNumber();
    }

    return message;
  }

  private static encodeTrackStatusErrorPayload(writer: BufferWriter, message: TrackStatusErrorMessage): void {
    writer.writeVarInt(message.requestId);
    writer.writeVarInt(message.errorCode);
    writer.writeString(message.reasonPhrase);
  }

  private static decodeTrackStatusErrorPayload(reader: BufferReader): TrackStatusErrorMessage {
    return {
      type: MessageType.TRACK_STATUS_ERROR,
      requestId: reader.readVarIntNumber(),
      errorCode: reader.readVarIntNumber() as RequestErrorCode,
      reasonPhrase: reader.readString(),
    };
  }
}

/**
 * Object Codec for encoding/decoding MOQT objects (Draft 14)
 *
 * @remarks
 * Handles the encoding and decoding of media objects (frames)
 * for both stream and datagram delivery modes.
 * In Draft 14, subgroup-based streaming replaces track/group-based streaming.
 */
export class ObjectCodec {
  /**
   * Encode an object header for datagram delivery
   *
   * @param header - Object header to encode
   * @returns Encoded bytes
   */
  static encodeDatagramHeader(header: ObjectHeader): Uint8Array {
    const writer = new BufferWriter();
    writer.writeVarInt(DataStreamType.OBJECT_DATAGRAM);
    writer.writeVarInt(header.trackAlias);
    writer.writeVarInt(header.groupId);
    if (!IS_DRAFT_16) {
      // Draft-14 includes subgroupId; draft-16 datagrams don't belong to subgroups
      writer.writeVarInt(header.subgroupId);
    }
    writer.writeVarInt(header.objectId);
    if (IS_DRAFT_16) {
      // Draft-16: Object ID | ExtLen | [Extensions] | Payload
      writer.writeVarInt(0); // No extensions for now
    } else {
      // Draft-14 includes publisherPriority and objectStatus in datagram header
      writer.writeByte(header.publisherPriority); // 1 byte, not varint
      writer.writeVarInt(header.objectStatus);
    }
    return writer.toUint8Array();
  }

  /**
   * Decode an object header from a datagram
   *
   * @param buffer - Buffer containing the encoded header
   * @returns Tuple of [decoded header, bytes consumed]
   */
  static decodeDatagramHeader(buffer: Uint8Array): [ObjectHeader, number] {
    const reader = new BufferReader(buffer);
    const streamType = reader.readVarIntNumber();

    if (streamType !== DataStreamType.OBJECT_DATAGRAM) {
      throw new MessageCodecError(
        `Expected OBJECT_DATAGRAM (${DataStreamType.OBJECT_DATAGRAM}), got ${streamType}`,
        streamType
      );
    }

    // trackAlias can be a 62-bit hash - keep as bigint to preserve full value
    const trackAliasBigInt = reader.readVarInt();
    const groupId = reader.readVarIntNumber();
    // Draft-16 datagrams don't have subgroupId; draft-14 does
    const subgroupId = IS_DRAFT_16 ? 0 : reader.readVarIntNumber();
    const objectId = reader.readVarIntNumber();

    let publisherPriority: number;
    let objectStatus: ObjectStatus;

    if (IS_DRAFT_16) {
      // Draft-16: Object ID | ExtLen | [Extensions] | Payload
      const extensionLength = reader.readVarIntNumber();
      if (extensionLength > 0) {
        // Skip extension bytes
        reader.readBytes(extensionLength);
      }
      publisherPriority = 128; // default priority
      objectStatus = ObjectStatus.NORMAL;
    } else {
      // Draft-14 includes publisherPriority (1 byte) and objectStatus (varint)
      publisherPriority = reader.readByte();
      objectStatus = reader.readVarIntNumber() as ObjectStatus;
    }

    const header: ObjectHeader = {
      trackAlias: trackAliasBigInt,
      groupId,
      subgroupId,
      objectId,
      publisherPriority,
      objectStatus,
    };

    log.trace('Decoded datagram header', {
      trackAlias: trackAliasBigInt.toString(),
      groupId: header.groupId,
      objectId: header.objectId
    });

    return [header, reader.offset];
  }

  /**
   * Encode a complete object for datagram delivery (Draft 14)
   *
   * @param object - Object to encode
   * @returns Encoded bytes including header and payload
   */
  static encodeDatagramObject(object: MOQTObject): Uint8Array {
    const headerBytes = ObjectCodec.encodeDatagramHeader(object.header);
    const result = new Uint8Array(headerBytes.length + object.payload.length);
    result.set(headerBytes);
    result.set(object.payload, headerBytes.length);
    return result;
  }

  /**
   * Decode a complete object from a datagram (Draft 14)
   *
   * @param buffer - Buffer containing the encoded object
   * @returns Decoded object
   */
  static decodeDatagramObject(buffer: Uint8Array): MOQTObject {
    const [header, headerLength] = ObjectCodec.decodeDatagramHeader(buffer);
    const payload = buffer.slice(headerLength);

    return {
      header,
      payload,
      payloadLength: payload.length,
    };
  }

  /**
   * Encode a subgroup header for stream-based delivery
   *
   * Draft-16 SUBGROUP_HEADER format:
   *   Type (varint) | Track Alias (varint) | Group ID (varint) | [Subgroup ID] | [Publisher Priority (8)]
   *
   * Type bits:
   * - Bit 4: Always 1 (base 0x10)
   * - Bit 0: EXTENSIONS (0x01)
   * - Bits 1-2: SUBGROUP_ID_MODE (0x06 mask)
   * - Bit 3: END_OF_GROUP (0x08)
   * - Bit 5: DEFAULT_PRIORITY (0x20)
   *
   * @param header - Subgroup header to encode
   * @param endOfGroup - Whether this is the last subgroup in the group
   * @returns Tuple of [encoded bytes, hasExtensions flag]
   */
  static encodeSubgroupHeader(header: SubgroupHeader, endOfGroup = false): [Uint8Array, boolean] {
    const writer = new BufferWriter();
    let hasExtensions: boolean;

    if (IS_DRAFT_16) {
      // Draft-16 format:
      // Type | Track Alias | Group ID | [Subgroup ID] | [Publisher Priority]

      // Subgroup Header Type: 0b00X1XXXX (bit 4 always set)
      // Use EXTENSIONS=1 to match relay behavior (0x11 or 0x19)
      // SUBGROUP_ID_MODE=0b00, DEFAULT_PRIORITY=0 (include priority)
      let headerType = 0x11; // Base with bit 4 set + EXTENSIONS bit
      if (endOfGroup) {
        headerType |= 0x08; // END_OF_GROUP bit (0x19)
      }
      // SUBGROUP_ID_MODE = 0b00: no subgroup ID field (implicit 0)
      // DEFAULT_PRIORITY = 0: include publisher priority field
      hasExtensions = (headerType & 0x01) !== 0; // true for 0x11/0x19

      writer.writeVarInt(headerType);
      writer.writeVarInt(header.trackAlias);
      writer.writeVarInt(header.groupId);
      // No Subgroup ID when SUBGROUP_ID_MODE = 0b00
      writer.writeByte(header.publisherPriority);
    } else {
      // Draft-14: Use subgroup header with subgroup_id=0 implicit, with extensions
      // 0x11 = SUBGROUP_ZERO_ID_EXT (no EndOfGroup)
      // 0x19 = SUBGROUP_ZERO_ID_EXT_END_OF_GROUP (signals EndOfGroup)
      const headerType = endOfGroup
        ? DataStreamType.SUBGROUP_ZERO_ID_EXT_END_OF_GROUP
        : DataStreamType.SUBGROUP_ZERO_ID_EXT;
      writer.writeVarInt(headerType);
      writer.writeVarInt(header.trackAlias);
      writer.writeVarInt(header.groupId);
      // subgroupId not written for SUBGROUP_ZERO_ID variants (implied 0)
      writer.writeByte(header.publisherPriority);
      hasExtensions = true; // Both 0x11 and 0x19 have extensions bit set
    }
    return [writer.toUint8Array(), hasExtensions];
  }

  /**
   * Decode a subgroup header for stream-based delivery
   * Supports draft-16 format and draft-14 LAPS formats
   *
   * @param buffer - Buffer containing the encoded header
   * @returns Tuple of [decoded header, bytes consumed, endOfGroup flag, hasExtensions flag]
   */
  static decodeSubgroupHeader(buffer: Uint8Array): [SubgroupHeader, number, boolean, boolean] {
    const reader = new BufferReader(buffer);

    if (IS_DRAFT_16) {
      // Draft-16 format:
      // Type | Track Alias | Group ID | [Subgroup ID] | [Publisher Priority]
      const headerType = reader.readVarIntNumber();
      const trackAlias = reader.readVarInt();
      const groupId = reader.readVarIntNumber();

      // Subgroup Header Type bits:
      // Bit 4: Always 1 (0x10 base)
      // Bit 0: EXTENSIONS (0x01) - indicates objects have extensions
      // Bits 1-2: SUBGROUP_ID_MODE (0x06)
      // Bit 3: END_OF_GROUP (0x08)
      // Bit 5: DEFAULT_PRIORITY (0x20)
      const hasExtensions = (headerType & 0x01) !== 0;
      const subgroupIdMode = (headerType & 0x06) >> 1;
      const endOfGroup = (headerType & 0x08) !== 0;
      const defaultPriority = (headerType & 0x20) !== 0;

      // Read subgroup ID based on mode
      let subgroupId = 0;
      if (subgroupIdMode === 1 || subgroupIdMode === 2) {
        subgroupId = reader.readVarIntNumber();
      }
      // mode 0 = implicit 0, mode 3 = reserved

      // Read publisher priority if not using default
      const publisherPriority = defaultPriority ? 128 : reader.readByte();

      return [{
        trackAlias,
        groupId,
        subgroupId,
        publisherPriority,
      }, reader.offset, endOfGroup, hasExtensions];
    }

    // Draft-14 format
    const streamType = reader.readVarIntNumber();

    // Parse header type bits for 0x10-0x1D range:
    // Bit 0: hasExtensions (odd types: 0x11, 0x13, 0x15, 0x19, 0x1b, 0x1d)
    // Bit 3: endOfGroup (0x18-0x1D)
    // Bits 1-2: subgroupIdMode (0=zero, 1=firstObject, 2=explicit)
    const isSubgroupType = streamType >= 0x10 && streamType <= 0x1d;
    if (isSubgroupType) {
      const hasExtensions = (streamType & 0x01) !== 0;
      const endOfGroup = (streamType & 0x08) !== 0;
      const subgroupIdMode = (streamType & 0x06) >> 1;

      const trackAlias = reader.readVarInt();
      const groupId = reader.readVarIntNumber();

      // Read subgroupId based on mode
      let subgroupId = 0;
      if (subgroupIdMode === 2) {
        // Explicit subgroup ID (0x14, 0x15, 0x1c, 0x1d)
        subgroupId = reader.readVarIntNumber();
      }
      // Mode 0 (0x10, 0x11, 0x18, 0x19) = implicit 0
      // Mode 1 (0x12, 0x13, 0x1a, 0x1b) = from first object (treat as 0 in header)

      const publisherPriority = reader.readByte();

      return [{
        trackAlias,
        groupId,
        subgroupId,
        publisherPriority,
      }, reader.offset, endOfGroup, hasExtensions];
    }

    // Standard MOQT format (0x04)
    if (streamType !== DataStreamType.SUBGROUP_HEADER) {
      throw new MessageCodecError(
        `Expected subgroup header type (0x04 or 0x10-0x1D), got 0x${streamType.toString(16)}`,
        streamType
      );
    }

    return [{
      trackAlias: reader.readVarInt(),
      groupId: reader.readVarIntNumber(),
      subgroupId: reader.readVarIntNumber(),
      publisherPriority: reader.readByte(),
    }, reader.offset, false, false];
  }

  /**
   * Encode a fetch header for fetch stream (Draft 14)
   *
   * @param header - Fetch header to encode
   * @returns Encoded bytes
   */
  static encodeFetchHeader(header: FetchHeader): Uint8Array {
    const writer = new BufferWriter();
    writer.writeVarInt(DataStreamType.FETCH_HEADER);
    writer.writeVarInt(header.requestId);
    return writer.toUint8Array();
  }

  /**
   * Decode a fetch header for fetch stream (Draft 14)
   *
   * @param buffer - Buffer containing the encoded header
   * @returns Tuple of [decoded header, bytes consumed]
   */
  static decodeFetchHeader(buffer: Uint8Array): [FetchHeader, number] {
    const reader = new BufferReader(buffer);
    const streamType = reader.readVarIntNumber();

    if (streamType !== DataStreamType.FETCH_HEADER) {
      throw new MessageCodecError(
        `Expected FETCH_HEADER, got ${streamType}`,
        streamType
      );
    }

    return [{
      requestId: reader.readVarIntNumber(),
    }, reader.offset];
  }

  /**
   * Encode an object within a stream (after subgroup header)
   *
   * Draft-16 Object ID Delta encoding:
   * - First object: delta = objectId
   * - Subsequent objects: delta = objectId - previousObjectId - 1
   * For sequential IDs (0,1,2,3...), all deltas are 0.
   *
   * @param objectId - Object ID within subgroup
   * @param payload - Object payload
   * @param status - Object status (default: NORMAL)
   * @param previousObjectId - Previous object ID for delta encoding (draft-16), -1 for first object
   * @param hasExtensions - Whether to include extension length field (from subgroup header EXTENSIONS bit)
   * @returns Encoded bytes
   */
  static encodeStreamObject(
    objectId: number,
    payload: Uint8Array,
    status: ObjectStatus = ObjectStatus.NORMAL,
    previousObjectId = -1,
    hasExtensions = false,
    extensions?: Map<number, number | Uint8Array>
  ): Uint8Array {
    const writer = new BufferWriter();

    if (IS_DRAFT_16) {
      // Draft-16: Object ID Delta encoding
      // First object: delta = objectId
      // Subsequent: delta = objectId - previousObjectId - 1
      const isFirstObject = previousObjectId < 0;
      const objectIdDelta = isFirstObject ? objectId : (objectId - previousObjectId - 1);
      writer.writeVarInt(objectIdDelta);

      // Draft-16 format: Object ID Delta | [ExtLen] | [Extensions] | Payload Length | [Status] | Payload
      // Extension length field is ONLY present when EXTENSIONS bit is set in subgroup header type
      // Types with Ext suffix (0x11, 0x19, etc.) have extensions; others (0x10, 0x18, etc.) don't
      if (hasExtensions) {
        if (extensions && extensions.size > 0) {
          // Encode extensions into a temporary buffer to get total length
          const extWriter = new BufferWriter();
          for (const [key, value] of extensions) {
            extWriter.writeVarInt(key);
            if (typeof value === 'number') {
              // Varint value - write length then varint-encoded value
              const encodedValue = VarInt.encode(value);
              extWriter.writeVarInt(encodedValue.length);
              extWriter.writeBytes(encodedValue);
            } else {
              // Raw bytes value
              extWriter.writeVarInt(value.length);
              extWriter.writeBytes(value);
            }
          }
          const extBytes = extWriter.toUint8Array();
          writer.writeVarInt(extBytes.length);
          writer.writeBytes(extBytes);
        } else {
          writer.writeVarInt(0); // Extension length = 0 (no actual extension data)
        }
      }

      if (payload.length === 0) {
        writer.writeVarInt(0);
        writer.writeVarInt(status);
      } else {
        writer.writeVarInt(payload.length);
        writer.writeBytes(payload);
      }
    } else {
      // Draft-14: Object ID is absolute
      writer.writeVarInt(objectId);
      // Draft-14 LAPS format: Object ID | Extension Length | Payload Length | Payload
      // Write extension length (0 = no extensions) for type 0x11 compatibility
      if (extensions && extensions.size > 0) {
        // Encode extensions
        const extWriter = new BufferWriter();
        for (const [key, value] of extensions) {
          extWriter.writeVarInt(key);
          if (typeof value === 'number') {
            const encodedValue = VarInt.encode(value);
            extWriter.writeVarInt(encodedValue.length);
            extWriter.writeBytes(encodedValue);
          } else {
            extWriter.writeVarInt(value.length);
            extWriter.writeBytes(value);
          }
        }
        const extBytes = extWriter.toUint8Array();
        writer.writeVarInt(extBytes.length);
        writer.writeBytes(extBytes);
      } else {
        writer.writeVarInt(0);
      }
      if (payload.length === 0) {
        writer.writeVarInt(0);
        writer.writeVarInt(status);
      } else {
        writer.writeVarInt(payload.length);
        writer.writeBytes(payload);
      }
    }
    return writer.toUint8Array();
  }

  /**
   * Decode an object within a stream
   *
   * Draft-16 Object ID Delta decoding:
   * - First object: objectId = delta
   * - Subsequent objects: objectId = previousObjectId + delta + 1
   *
   * Draft-16 Object format:
   *   Object ID Delta | [Extensions] | Object Payload Length | [Object Status] | [Object Payload]
   *
   * @param buffer - Buffer containing the encoded object
   * @param offset - Offset to start reading from
   * @param hasExtensions - Whether objects have extensions (from header type EXTENSIONS bit)
   * @param useRemainingAsPayload - Use remaining buffer as payload (draft-14 LAPS)
   * @param previousObjectId - Previous object ID for delta decoding (draft-16), -1 for first object
   * @returns Tuple of [objectId, payload, status, bytesConsumed]
   */
  static decodeStreamObject(
    buffer: Uint8Array,
    offset = 0,
    hasExtensions = true,
    useRemainingAsPayload = false,
    previousObjectId = -1
  ): [number, Uint8Array, ObjectStatus, number] {
    const reader = new BufferReader(buffer, offset);

    const objectIdDelta = reader.readVarIntNumber();
    let objectId: number;

    if (IS_DRAFT_16) {
      // Draft-16: Object ID Delta decoding
      // First object: objectId = delta
      // Subsequent: objectId = previousObjectId + delta + 1
      const isFirstObject = previousObjectId < 0;
      objectId = isFirstObject ? objectIdDelta : (previousObjectId + objectIdDelta + 1);
    } else {
      // Draft-14: Object ID is absolute
      objectId = objectIdDelta;
    }

    if (IS_DRAFT_16) {
      // Draft-16 format: Object ID Delta | [ExtLen] | [Extensions] | Payload Length | [Status] | [Payload]
      // Extension length field is ONLY present when EXTENSIONS bit is set in subgroup header type
      // Types with Ext suffix (0x11, 0x19, etc.) have extensions; others (0x10, 0x18, etc.) don't
      if (hasExtensions) {
        const extensionLength = reader.readVarIntNumber();
        if (extensionLength > 0) {
          // Skip extension bytes (TODO: parse KVPs if needed)
          reader.readBytes(extensionLength);
        }
      }

      const payloadLength = reader.readVarIntNumber();
      let status = ObjectStatus.NORMAL;
      if (payloadLength === 0 && reader.hasMore) {
        status = reader.readVarIntNumber() as ObjectStatus;
      }
      const payload = reader.readBytes(payloadLength);
      return [objectId, payload, status, reader.offset - offset];
    }

    // Draft-14 LAPS format handling
    // LAPS formats with extensions (0x11, 0x13, 0x15, etc.) have an extension length field
    if (hasExtensions) {
      const extensionLength = reader.readVarIntNumber();
      if (extensionLength > 0) {
        // Skip extension bytes
        reader.readBytes(extensionLength);
      }
    }

    // For LAPS streams that don't include payload_length, use remaining bytes
    if (useRemainingAsPayload) {
      const payload = reader.readBytes(reader.remaining);
      return [objectId, payload, ObjectStatus.NORMAL, reader.offset - offset];
    }

    const payloadLength = reader.readVarIntNumber();

    // Check if there's a status byte
    let status = ObjectStatus.NORMAL;
    if (payloadLength === 0 && reader.hasMore) {
      status = reader.readVarIntNumber() as ObjectStatus;
    }

    const payload = reader.readBytes(payloadLength);
    return [objectId, payload, status, reader.offset - offset];
  }

  /**
   * FETCH Serialization Flags bits (draft-16) - matches moqx/moxygen relay
   * Bit layout (LSB-first as per moqx implementation):
   *   Bits 0-1: Subgroup ID Mode (0=zero, 1=same, 2=inc, 3=present)
   *   Bit 2: Object ID Present
   *   Bit 3: Group ID Present
   *   Bit 4: Publisher Priority Present
   *   Bit 5: Extensions Present
   *   Bit 6: Datagram forwarding preference (draft-16+)
   *   Bit 7: Reserved (must be 0)
   */
  private static readonly FETCH_FLAG_SUBGROUP_MODE_MASK = 0x03;
  private static readonly FETCH_FLAG_SUBGROUP_MODE_SHIFT = 0;
  private static readonly FETCH_FLAG_OBJECT_ID_PRESENT = 0x04;
  private static readonly FETCH_FLAG_GROUP_ID_PRESENT = 0x08;
  private static readonly FETCH_FLAG_PRIORITY_PRESENT = 0x10;
  private static readonly FETCH_FLAG_EXTENSIONS_PRESENT = 0x20;

  /**
   * State for FETCH object delta encoding
   */
  static createFetchEncoderState(): FetchEncoderState {
    return {
      previousGroupId: -1,
      previousSubgroupId: -1,
      previousObjectId: -1,
      previousPriority: 128,
    };
  }

  /**
   * Encode an object for FETCH response stream (draft-15/16 serialization flags format)
   *
   * Draft-15/16 FETCH objects use serialization flags to indicate which fields are present:
   * Flags | [Group ID] | [Subgroup ID] | [Object ID] | [Priority] | [ExtLen] | PayloadLen | Payload
   *
   * @param groupId - Group ID
   * @param subgroupId - Subgroup ID (usually 0)
   * @param objectId - Object ID
   * @param payload - Object payload
   * @param state - Encoder state for delta encoding
   * @param priority - Publisher priority (default 128)
   * @returns Encoded bytes
   */
  static encodeFetchObject(
    groupId: number,
    subgroupId: number,
    objectId: number,
    payload: Uint8Array,
    state: FetchEncoderState,
    priority = 128
  ): Uint8Array {
    const writer = new BufferWriter();

    // Build flags byte
    let flags = 0;

    // Determine which fields need to be present
    const isFirstObject = state.previousGroupId < 0;
    const sameGroup = !isFirstObject && groupId === state.previousGroupId;
    const samePriority = !isFirstObject && priority === state.previousPriority;

    // Group ID present if first object or group changed
    if (!sameGroup) {
      flags |= ObjectCodec.FETCH_FLAG_GROUP_ID_PRESENT;
    }

    // Subgroup mode (stored in bits 7-6):
    // 0 = zero (subgroupId == 0 and doesn't need to be sent)
    // 1 = same as previous
    // 2 = previous + 1
    // 3 = present on wire
    let subgroupMode = 0;
    if (isFirstObject || !sameGroup) {
      // First object in stream or new group - need to send subgroup
      if (subgroupId === 0) {
        // Mode 0: implicit zero
        subgroupMode = 0;
      } else {
        // Mode 3: present on wire
        subgroupMode = 3;
      }
    } else if (subgroupId === state.previousSubgroupId) {
      // Mode 1: same as previous
      subgroupMode = 1;
    } else if (subgroupId === state.previousSubgroupId + 1) {
      // Mode 2: previous + 1
      subgroupMode = 2;
    } else {
      // Mode 3: present on wire
      subgroupMode = 3;
    }
    flags |= (subgroupMode << ObjectCodec.FETCH_FLAG_SUBGROUP_MODE_SHIFT);

    // Object ID: always present for clarity (could optimize with delta encoding)
    flags |= ObjectCodec.FETCH_FLAG_OBJECT_ID_PRESENT;

    // Priority present if first object or priority changed
    if (!samePriority) {
      flags |= ObjectCodec.FETCH_FLAG_PRIORITY_PRESENT;
    }

    // No extensions for now
    // flags |= ObjectCodec.FETCH_FLAG_EXTENSIONS_PRESENT;

    // Write flags (varint in draft-16)
    writer.writeVarInt(flags);

    // Write fields based on flags
    if (flags & ObjectCodec.FETCH_FLAG_GROUP_ID_PRESENT) {
      writer.writeVarInt(groupId);
    }

    // Subgroup ID if mode 3
    if (subgroupMode === 3) {
      writer.writeVarInt(subgroupId);
    }

    // Object ID
    if (flags & ObjectCodec.FETCH_FLAG_OBJECT_ID_PRESENT) {
      writer.writeVarInt(objectId);
    }

    // Priority
    if (flags & ObjectCodec.FETCH_FLAG_PRIORITY_PRESENT) {
      writer.writeByte(priority);
    }

    // Extensions (not used, but write length 0 if flag set)
    if (flags & ObjectCodec.FETCH_FLAG_EXTENSIONS_PRESENT) {
      writer.writeVarInt(0);
    }

    // Payload length and payload
    writer.writeVarInt(payload.length);
    if (payload.length > 0) {
      writer.writeBytes(payload);
    }

    // Update state for next object
    state.previousGroupId = groupId;
    state.previousSubgroupId = subgroupId;
    state.previousObjectId = objectId;
    state.previousPriority = priority;

    return writer.toUint8Array();
  }

  /**
   * Create initial state for FETCH object decoding
   */
  static createFetchDecoderState(): FetchDecoderState {
    return {
      previousGroupId: -1,
      previousSubgroupId: 0,
      previousObjectId: -1,
      previousPriority: 128,
    };
  }

  /**
   * Decode a FETCH object from stream (draft-15/16 serialization flags format)
   *
   * @param buffer - Buffer containing encoded FETCH object
   * @param state - Decoder state for delta decoding
   * @returns Decoded object result with groupId, subgroupId, objectId, priority, payload, and bytesConsumed
   */
  static decodeFetchObject(
    buffer: Uint8Array,
    state: FetchDecoderState
  ): FetchObjectResult {
    const reader = new BufferReader(buffer);

    // Debug: log first few bytes for diagnosis
    const previewLen = Math.min(20, buffer.length);
    const preview = Array.from(buffer.subarray(0, previewLen)).map(b => b.toString(16).padStart(2, '0')).join(' ');
    log.debug('FETCH object decode start', {
      bufferLen: buffer.length,
      preview,
      prevGroup: state.previousGroupId,
      prevObject: state.previousObjectId,
    });

    // Read flags (varint)
    const flags = reader.readVarIntNumber();

    log.debug('FETCH flags decoded', {
      flags: flags.toString(16),
      groupIdPresent: !!(flags & ObjectCodec.FETCH_FLAG_GROUP_ID_PRESENT),
      objectIdPresent: !!(flags & ObjectCodec.FETCH_FLAG_OBJECT_ID_PRESENT),
      priorityPresent: !!(flags & ObjectCodec.FETCH_FLAG_PRIORITY_PRESENT),
      extPresent: !!(flags & ObjectCodec.FETCH_FLAG_EXTENSIONS_PRESENT),
      subgroupMode: (flags & ObjectCodec.FETCH_FLAG_SUBGROUP_MODE_MASK) >> ObjectCodec.FETCH_FLAG_SUBGROUP_MODE_SHIFT,
    });

    // Decode group ID
    let groupId: number;
    if (flags & ObjectCodec.FETCH_FLAG_GROUP_ID_PRESENT) {
      groupId = reader.readVarIntNumber();
    } else {
      groupId = state.previousGroupId;
    }

    // Decode subgroup ID based on mode (bits 7-6)
    let subgroupId: number;
    const subgroupMode = (flags & ObjectCodec.FETCH_FLAG_SUBGROUP_MODE_MASK) >> ObjectCodec.FETCH_FLAG_SUBGROUP_MODE_SHIFT;
    switch (subgroupMode) {
      case 0: // Zero
        subgroupId = 0;
        break;
      case 1: // Same as previous
        subgroupId = state.previousSubgroupId;
        break;
      case 2: // Previous + 1
        subgroupId = state.previousSubgroupId + 1;
        break;
      case 3: // Present on wire
        subgroupId = reader.readVarIntNumber();
        break;
      default:
        subgroupId = 0;
    }

    // Decode object ID
    let objectId: number;
    if (flags & ObjectCodec.FETCH_FLAG_OBJECT_ID_PRESENT) {
      objectId = reader.readVarIntNumber();
    } else {
      objectId = state.previousObjectId + 1;
    }

    // Decode priority
    let priority: number;
    if (flags & ObjectCodec.FETCH_FLAG_PRIORITY_PRESENT) {
      priority = reader.readByte();
    } else {
      priority = state.previousPriority;
    }

    // Skip extensions if present
    if (flags & ObjectCodec.FETCH_FLAG_EXTENSIONS_PRESENT) {
      const extLen = reader.readVarIntNumber();
      reader.skip(extLen);
    }

    // Read payload length and payload
    const payloadLength = reader.readVarIntNumber();
    const payload = reader.readBytes(payloadLength);

    // Update state for next object
    state.previousGroupId = groupId;
    state.previousSubgroupId = subgroupId;
    state.previousObjectId = objectId;
    state.previousPriority = priority;

    return {
      groupId,
      subgroupId,
      objectId,
      priority,
      payload,
      bytesConsumed: reader.offset,
    };
  }
}

/**
 * State for FETCH object delta encoding
 */
export interface FetchEncoderState {
  previousGroupId: number;
  previousSubgroupId: number;
  previousObjectId: number;
  previousPriority: number;
}

/**
 * State for FETCH object delta decoding
 */
export interface FetchDecoderState {
  previousGroupId: number;
  previousSubgroupId: number;
  previousObjectId: number;
  previousPriority: number;
}

/**
 * Result of decoding a FETCH object
 */
export interface FetchObjectResult {
  groupId: number;
  subgroupId: number;
  objectId: number;
  priority: number;
  payload: Uint8Array;
  bytesConsumed: number;
}
