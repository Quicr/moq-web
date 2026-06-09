// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Draft-18 Message Encoding and Decoding
 *
 * Implements wire format encoding/decoding for MOQT draft-18 control messages.
 * Uses MOQT varints (leading 1-bits) instead of QUIC varints.
 */

import { Logger } from '../utils/logger.js';
import { MOQTVarInt } from './moqt-varint.js';
import { Draft18BufferWriter, Draft18BufferReader } from './protocol-codec.js';
import {
  MessageTypeDraft18,
  Version,
  GroupOrder,
  SubscriptionFilterDraft18,
  SetupOptionDraft18,
  type ControlMessageDraft18,
  type ClientSetupMessageDraft18,
  type ServerSetupMessageDraft18,
  type SubscribeMessageDraft18,
  type SubscribeOkMessageDraft18,
  type PublishMessageDraft18,
  type PublishDoneMessageDraft18,
  type RequestErrorMessageDraft18,
  type RequestOkMessageDraft18,
  type RequestUpdateMessageDraft18,
  type FetchMessageDraft18,
  type FetchOkMessageDraft18,
  type GoAwayMessageDraft18,
  type TrackStatusMessageDraft18,
  type PublishNamespaceMessageDraft18,
  type SubscribeNamespaceMessageDraft18,
  type NamespaceMessageDraft18,
  type NamespaceDoneMessageDraft18,
  type SubscribeTracksMessageDraft18,
  type PublishBlockedMessageDraft18,
  type TrackNamespace,
  type Location,
} from '../messages/types.js';

const log = Logger.create('moqt:core:draft18-codec');

export class Draft18CodecError extends Error {
  messageType?: MessageTypeDraft18;

  constructor(message: string, messageType?: MessageTypeDraft18) {
    super(message);
    this.name = 'Draft18CodecError';
    this.messageType = messageType;
  }
}

/**
 * Draft-18 Message Codec
 */
export class Draft18MessageCodec {
  /**
   * Encode a draft-18 control message to bytes
   */
  static encode(message: ControlMessageDraft18): Uint8Array {
    log.debug('Encoding draft-18 message', { type: MessageTypeDraft18[message.type] });

    const payloadWriter = new Draft18BufferWriter();

    switch (message.type) {
      case MessageTypeDraft18.SETUP:
        Draft18MessageCodec.encodeSetup(payloadWriter, message as ClientSetupMessageDraft18);
        break;
      case MessageTypeDraft18.SUBSCRIBE:
        Draft18MessageCodec.encodeSubscribe(payloadWriter, message);
        break;
      case MessageTypeDraft18.SUBSCRIBE_OK:
        Draft18MessageCodec.encodeSubscribeOk(payloadWriter, message);
        break;
      case MessageTypeDraft18.PUBLISH:
        Draft18MessageCodec.encodePublish(payloadWriter, message);
        break;
      case MessageTypeDraft18.REQUEST_ERROR:
        Draft18MessageCodec.encodeRequestError(payloadWriter, message);
        break;
      case MessageTypeDraft18.REQUEST_OK:
        Draft18MessageCodec.encodeRequestOk(payloadWriter, message);
        break;
      case MessageTypeDraft18.FETCH:
        Draft18MessageCodec.encodeFetch(payloadWriter, message);
        break;
      case MessageTypeDraft18.FETCH_OK:
        Draft18MessageCodec.encodeFetchOk(payloadWriter, message);
        break;
      case MessageTypeDraft18.GOAWAY:
        Draft18MessageCodec.encodeGoAway(payloadWriter, message);
        break;
      case MessageTypeDraft18.TRACK_STATUS:
        Draft18MessageCodec.encodeTrackStatus(payloadWriter, message);
        break;
      case MessageTypeDraft18.PUBLISH_DONE:
        Draft18MessageCodec.encodePublishDone(payloadWriter, message);
        break;
      case MessageTypeDraft18.REQUEST_UPDATE:
        Draft18MessageCodec.encodeRequestUpdate(payloadWriter, message);
        break;
      case MessageTypeDraft18.PUBLISH_NAMESPACE:
        Draft18MessageCodec.encodePublishNamespace(payloadWriter, message);
        break;
      case MessageTypeDraft18.SUBSCRIBE_NAMESPACE:
        Draft18MessageCodec.encodeSubscribeNamespace(payloadWriter, message);
        break;
      case MessageTypeDraft18.NAMESPACE:
        Draft18MessageCodec.encodeNamespaceMessage(payloadWriter, message);
        break;
      case MessageTypeDraft18.NAMESPACE_DONE:
        Draft18MessageCodec.encodeNamespaceDone(payloadWriter, message);
        break;
      case MessageTypeDraft18.SUBSCRIBE_TRACKS:
        Draft18MessageCodec.encodeSubscribeTracks(payloadWriter, message);
        break;
      case MessageTypeDraft18.PUBLISH_BLOCKED:
        Draft18MessageCodec.encodePublishBlocked(payloadWriter, message);
        break;
      default:
        throw new Draft18CodecError(`Unknown message type: ${(message as ControlMessageDraft18).type}`);
    }

    const payload = payloadWriter.toUint8Array();

    // Draft-18 framing: Message Type (MOQT varint) | Message Length (16-bit BE) | Message Payload
    const typeBytes = MOQTVarInt.encode(BigInt(message.type));
    const result = new Uint8Array(typeBytes.length + 2 + payload.length);
    result.set(typeBytes, 0);
    result[typeBytes.length] = (payload.length >> 8) & 0xFF;
    result[typeBytes.length + 1] = payload.length & 0xFF;
    result.set(payload, typeBytes.length + 2);

    return result;
  }

  /**
   * Decode a draft-18 control message from bytes
   */
  static decode(buffer: Uint8Array, offset = 0): [ControlMessageDraft18, number] {
    // Draft-18 framing: Message Type (MOQT varint) | Message Length (16-bit BE) | Message Payload
    const [typeValue, typeBytesRead] = MOQTVarInt.decodeNumber(buffer, offset);
    const messageType = typeValue as MessageTypeDraft18;

    if (buffer.length < offset + typeBytesRead + 2) {
      throw new Draft18CodecError('Incomplete message: missing length field');
    }
    const payloadLength = (buffer[offset + typeBytesRead] << 8) | buffer[offset + typeBytesRead + 1];
    const headerSize = typeBytesRead + 2;

    if (buffer.length < offset + headerSize + payloadLength) {
      throw new Draft18CodecError('Incomplete message: not enough payload bytes');
    }

    const reader = new Draft18BufferReader(buffer, offset + headerSize);

    log.trace('Decoding draft-18 message', { type: MessageTypeDraft18[messageType] ?? messageType, payloadLength });

    let message: ControlMessageDraft18;

    switch (messageType) {
      case MessageTypeDraft18.SETUP:
        message = Draft18MessageCodec.decodeSetup(reader, payloadLength);
        break;
      case MessageTypeDraft18.SUBSCRIBE:
        message = Draft18MessageCodec.decodeSubscribe(reader);
        break;
      case MessageTypeDraft18.SUBSCRIBE_OK:
        message = Draft18MessageCodec.decodeSubscribeOk(reader);
        break;
      case MessageTypeDraft18.PUBLISH:
        message = Draft18MessageCodec.decodePublish(reader);
        break;
      case MessageTypeDraft18.REQUEST_ERROR:
        message = Draft18MessageCodec.decodeRequestError(reader);
        break;
      case MessageTypeDraft18.REQUEST_OK:
      case MessageTypeDraft18.PUBLISH_OK:
        message = Draft18MessageCodec.decodeRequestOk(reader);
        (message as RequestOkMessageDraft18).type = messageType as MessageTypeDraft18.REQUEST_OK;
        break;
      case MessageTypeDraft18.FETCH:
        message = Draft18MessageCodec.decodeFetch(reader);
        break;
      case MessageTypeDraft18.FETCH_OK:
        message = Draft18MessageCodec.decodeFetchOk(reader);
        break;
      case MessageTypeDraft18.GOAWAY:
        message = Draft18MessageCodec.decodeGoAway(reader);
        break;
      case MessageTypeDraft18.TRACK_STATUS:
        message = Draft18MessageCodec.decodeTrackStatus(reader);
        break;
      case MessageTypeDraft18.PUBLISH_DONE:
        message = Draft18MessageCodec.decodePublishDone(reader);
        break;
      case MessageTypeDraft18.REQUEST_UPDATE:
        message = Draft18MessageCodec.decodeRequestUpdate(reader);
        break;
      case MessageTypeDraft18.PUBLISH_NAMESPACE:
        message = Draft18MessageCodec.decodePublishNamespace(reader);
        break;
      case MessageTypeDraft18.SUBSCRIBE_NAMESPACE:
        message = Draft18MessageCodec.decodeSubscribeNamespace(reader);
        break;
      case MessageTypeDraft18.NAMESPACE:
        message = Draft18MessageCodec.decodeNamespaceMessage(reader);
        break;
      case MessageTypeDraft18.NAMESPACE_DONE:
        message = Draft18MessageCodec.decodeNamespaceDone(reader);
        break;
      case MessageTypeDraft18.SUBSCRIBE_TRACKS:
        message = Draft18MessageCodec.decodeSubscribeTracks(reader);
        break;
      case MessageTypeDraft18.PUBLISH_BLOCKED:
        message = Draft18MessageCodec.decodePublishBlocked(reader);
        break;
      default:
        throw new Draft18CodecError(`Unknown message type: ${messageType}`, messageType);
    }

    return [message, headerSize + payloadLength];
  }

  /**
   * Decode a SETUP message from the setup stream.
   * On the setup stream, the message type is implicit (stream type = 0x2F00),
   * so the wire format is just: Length (16-bit BE) | Setup Options
   */
  static decodeSetupStream(buffer: Uint8Array, offset = 0): [ServerSetupMessageDraft18, number] {
    if (buffer.length < offset + 2) {
      throw new Draft18CodecError('Incomplete setup message: missing length field');
    }
    const payloadLength = (buffer[offset] << 8) | buffer[offset + 1];
    if (buffer.length < offset + 2 + payloadLength) {
      throw new Draft18CodecError('Incomplete setup message: not enough payload bytes');
    }
    const reader = new Draft18BufferReader(buffer, offset + 2);
    const message = Draft18MessageCodec.decodeSetup(reader, payloadLength);
    return [message, 2 + payloadLength];
  }

  /**
   * Encode a SETUP message for the setup stream.
   * No message type prefix — just Length (16-bit BE) | Setup Options
   */
  static encodeSetupStream(message: ClientSetupMessageDraft18): Uint8Array {
    const payloadWriter = new Draft18BufferWriter();
    Draft18MessageCodec.encodeSetup(payloadWriter, message);
    const payload = payloadWriter.toUint8Array();
    const result = new Uint8Array(2 + payload.length);
    result[0] = (payload.length >> 8) & 0xFF;
    result[1] = payload.length & 0xFF;
    result.set(payload, 2);
    return result;
  }

  // ============================================================================
  // Setup Message (draft-18: single SETUP, no separate CLIENT/SERVER)
  // ============================================================================

  /**
   * Encode SETUP message payload.
   * Draft-18 SETUP body is just Setup Options as Key-Value-Pairs.
   * No version list, no role — version is negotiated via ALPN.
   */
  private static encodeSetup(writer: Draft18BufferWriter, message: ClientSetupMessageDraft18): void {
    // Setup Options are KVPs directly in the payload (delta-encoded keys)
    // Collect options to encode, sorted by key value for delta encoding
    const options: Array<{ key: number; encode: (w: Draft18BufferWriter) => void }> = [];

    if (message.path !== undefined) {
      options.push({
        key: SetupOptionDraft18.PATH,
        encode: (w) => {
          const bytes = new TextEncoder().encode(message.path!);
          w.writeVarInt(BigInt(bytes.length));
          w.writeBytes(bytes);
        },
      });
    }
    if (message.authToken !== undefined) {
      options.push({
        key: SetupOptionDraft18.AUTHORIZATION_TOKEN,
        encode: (w) => {
          w.writeVarInt(BigInt(message.authToken!.length));
          w.writeBytes(message.authToken!);
        },
      });
    }
    if (message.maxAuthTokenCacheSize !== undefined) {
      options.push({
        key: SetupOptionDraft18.MAX_AUTH_TOKEN_CACHE_SIZE,
        encode: (w) => {
          w.writeVarInt(BigInt(message.maxAuthTokenCacheSize!));
        },
      });
    }
    if (message.authority !== undefined) {
      options.push({
        key: SetupOptionDraft18.AUTHORITY,
        encode: (w) => {
          const bytes = new TextEncoder().encode(message.authority!);
          w.writeVarInt(BigInt(bytes.length));
          w.writeBytes(bytes);
        },
      });
    }
    if (message.moqtImplementation !== undefined) {
      options.push({
        key: SetupOptionDraft18.MOQT_IMPLEMENTATION,
        encode: (w) => {
          const bytes = new TextEncoder().encode(message.moqtImplementation!);
          w.writeVarInt(BigInt(bytes.length));
          w.writeBytes(bytes);
        },
      });
    }

    // Sort by key and write delta-encoded
    options.sort((a, b) => a.key - b.key);
    let previousKey = 0;
    for (const opt of options) {
      writer.writeVarInt(BigInt(opt.key - previousKey));
      previousKey = opt.key;
      opt.encode(writer);
    }
  }

  /**
   * Decode SETUP message. Body is Setup Options as KVPs bounded by message length.
   */
  private static decodeSetup(reader: Draft18BufferReader, payloadLength: number): ServerSetupMessageDraft18 {
    const endOffset = reader.offset + payloadLength;

    // Parse Setup Options (KVPs with delta-encoded keys)
    let path: string | undefined;
    let authority: string | undefined;
    let maxAuthTokenCacheSize: number | undefined;
    let previousKey = 0;

    while (reader.offset < endOffset) {
      const deltaKey = reader.readVarIntNumber();
      const key = previousKey + deltaKey;
      previousKey = key;

      switch (key) {
        case SetupOptionDraft18.PATH: {
          const length = reader.readVarIntNumber();
          path = new TextDecoder().decode(reader.readBytes(length));
          break;
        }
        case SetupOptionDraft18.MAX_AUTH_TOKEN_CACHE_SIZE:
          maxAuthTokenCacheSize = reader.readVarIntNumber();
          break;
        case SetupOptionDraft18.AUTHORIZATION_TOKEN: {
          const length = reader.readVarIntNumber();
          reader.skip(length);
          break;
        }
        case SetupOptionDraft18.AUTHORITY: {
          const length = reader.readVarIntNumber();
          authority = new TextDecoder().decode(reader.readBytes(length));
          break;
        }
        case SetupOptionDraft18.MOQT_IMPLEMENTATION: {
          const length = reader.readVarIntNumber();
          reader.skip(length);
          break;
        }
        default:
          // Skip unknown options per KVP rules
          if (key % 2 === 0) {
            // Even key: value is a varint
            reader.readVarInt();
          } else {
            // Odd key: length-prefixed bytes
            const length = reader.readVarIntNumber();
            reader.skip(length);
          }
      }
    }

    return {
      type: MessageTypeDraft18.SERVER_SETUP,
      selectedVersion: Version.DRAFT_18,
      path,
      authority,
      maxAuthTokenCacheSize,
    };
  }

  // ============================================================================
  // Subscribe Messages
  // ============================================================================

  private static encodeSubscribe(writer: Draft18BufferWriter, message: SubscribeMessageDraft18): void {
    writer.writeVarInt(message.requestId);
    Draft18MessageCodec.encodeTrackNamespace(writer, message.trackNamespace);
    Draft18MessageCodec.encodeString(writer, message.trackName);

    // Forward State (1 bit) + Reserved (7 bits)
    writer.writeByte(message.forwardState ? 0x80 : 0x00);

    // Subscription Filter
    Draft18MessageCodec.encodeSubscriptionFilter(writer, message);

    // Parameters
    const params = message.parameters ?? new Map();
    const paramsWriter = new Draft18BufferWriter();
    Draft18MessageCodec.encodeKeyValuePairs(paramsWriter, params);
    const paramsBytes = paramsWriter.toUint8Array();
    writer.writeVarInt(paramsBytes.length);
    writer.writeBytes(paramsBytes);
  }

  private static decodeSubscribe(reader: Draft18BufferReader): SubscribeMessageDraft18 {
    const requestId = reader.readVarInt();
    const trackNamespace = Draft18MessageCodec.decodeTrackNamespace(reader);
    const trackName = Draft18MessageCodec.decodeString(reader);

    const flags = reader.readByte();
    const forwardState = (flags & 0x80) !== 0;

    const { filter, startLocation, endGroupDelta } = Draft18MessageCodec.decodeSubscriptionFilter(reader);

    const paramsLength = reader.readVarIntNumber();
    const paramsEnd = reader.offset + paramsLength;
    const parameters = Draft18MessageCodec.decodeKeyValuePairs(reader, paramsEnd);

    return {
      type: MessageTypeDraft18.SUBSCRIBE,
      requestId,
      trackNamespace,
      trackName,
      forwardState,
      filter,
      startLocation,
      endGroupDelta,
      parameters: parameters.size > 0 ? parameters : undefined,
    };
  }

  private static encodeSubscribeOk(writer: Draft18BufferWriter, message: SubscribeOkMessageDraft18): void {
    writer.writeVarInt(message.requestId);
    Draft18MessageCodec.encodeLocation(writer, message.largestLocation);
    if (message.trackProperties) {
      Draft18MessageCodec.encodeKeyValuePairs(writer, message.trackProperties);
    }
  }

  private static decodeSubscribeOk(reader: Draft18BufferReader): SubscribeOkMessageDraft18 {
    const requestId = reader.readVarInt();
    const largestLocation = Draft18MessageCodec.decodeLocation(reader);
    const trackProperties = reader.hasMore
      ? Draft18MessageCodec.decodeKeyValuePairsToEnd(reader)
      : undefined;

    return {
      type: MessageTypeDraft18.SUBSCRIBE_OK,
      requestId,
      largestLocation,
      trackProperties: trackProperties?.size ? trackProperties : undefined,
    };
  }

  // ============================================================================
  // Publish Messages
  // ============================================================================

  private static encodePublish(writer: Draft18BufferWriter, message: PublishMessageDraft18): void {
    writer.writeVarInt(message.requestId);
    writer.writeVarInt(message.trackAlias);
    Draft18MessageCodec.encodeTrackNamespace(writer, message.trackNamespace);
    Draft18MessageCodec.encodeString(writer, message.trackName);

    // Forward State (1 bit) + Reserved (7 bits)
    writer.writeByte(message.forwardState ? 0x80 : 0x00);

    Draft18MessageCodec.encodeLocation(writer, message.largestLocation);

    if (message.trackProperties) {
      Draft18MessageCodec.encodeKeyValuePairs(writer, message.trackProperties);
    }
  }

  private static decodePublish(reader: Draft18BufferReader): PublishMessageDraft18 {
    const requestId = reader.readVarInt();
    const trackAlias = reader.readVarInt();
    const trackNamespace = Draft18MessageCodec.decodeTrackNamespace(reader);
    const trackName = Draft18MessageCodec.decodeString(reader);

    const flags = reader.readByte();
    const forwardState = (flags & 0x80) !== 0;

    const largestLocation = Draft18MessageCodec.decodeLocation(reader);
    const trackProperties = reader.hasMore
      ? Draft18MessageCodec.decodeKeyValuePairsToEnd(reader)
      : undefined;

    return {
      type: MessageTypeDraft18.PUBLISH,
      requestId,
      trackAlias,
      trackNamespace,
      trackName,
      forwardState,
      largestLocation,
      trackProperties: trackProperties?.size ? trackProperties : undefined,
    };
  }

  // ============================================================================
  // Request Messages
  // ============================================================================

  private static encodeRequestError(writer: Draft18BufferWriter, message: RequestErrorMessageDraft18): void {
    writer.writeVarInt(message.requestId);
    writer.writeVarInt(message.errorCode);
    Draft18MessageCodec.encodeString(writer, message.reasonPhrase);
  }

  private static decodeRequestError(reader: Draft18BufferReader): RequestErrorMessageDraft18 {
    const requestId = reader.readVarInt();
    const errorCode = reader.readVarIntNumber();
    const reasonPhrase = Draft18MessageCodec.decodeString(reader);

    return {
      type: MessageTypeDraft18.REQUEST_ERROR,
      requestId,
      errorCode,
      reasonPhrase,
    };
  }

  private static encodeRequestOk(writer: Draft18BufferWriter, message: RequestOkMessageDraft18): void {
    writer.writeVarInt(message.requestId);
    if (message.expires !== undefined) {
      writer.writeVarInt(message.expires);
    }
  }

  private static decodeRequestOk(reader: Draft18BufferReader): RequestOkMessageDraft18 {
    const requestId = reader.readVarInt();
    const expires = reader.hasMore ? reader.readVarInt() : undefined;

    return {
      type: MessageTypeDraft18.REQUEST_OK,
      requestId,
      expires,
    };
  }

  // ============================================================================
  // Fetch Messages
  // ============================================================================

  private static encodeFetch(writer: Draft18BufferWriter, message: FetchMessageDraft18): void {
    writer.writeVarInt(message.requestId);

    // Flags: Bit 0 = Joining Flag
    const flags = message.joiningFlag ? 0x01 : 0x00;
    writer.writeVarInt(flags);

    if (message.joiningFlag && message.subscribeRequestId !== undefined) {
      writer.writeVarInt(message.subscribeRequestId);
    } else if (message.trackNamespace && message.trackName) {
      Draft18MessageCodec.encodeTrackNamespace(writer, message.trackNamespace);
      Draft18MessageCodec.encodeString(writer, message.trackName);
    }

    writer.writeByte(message.subscriberPriority);
    writer.writeByte(message.groupOrder);

    Draft18MessageCodec.encodeLocation(writer, message.startLocation);
    Draft18MessageCodec.encodeLocation(writer, message.endLocation);

    const params = message.parameters ?? new Map();
    const paramsWriter = new Draft18BufferWriter();
    Draft18MessageCodec.encodeKeyValuePairs(paramsWriter, params);
    const paramsBytes = paramsWriter.toUint8Array();
    writer.writeVarInt(paramsBytes.length);
    writer.writeBytes(paramsBytes);
  }

  private static decodeFetch(reader: Draft18BufferReader): FetchMessageDraft18 {
    const requestId = reader.readVarInt();
    const flags = reader.readVarIntNumber();
    const joiningFlag = (flags & 0x01) !== 0;

    let trackNamespace: TrackNamespace | undefined;
    let trackName: string | undefined;
    let subscribeRequestId: bigint | undefined;

    if (joiningFlag) {
      subscribeRequestId = reader.readVarInt();
    } else {
      trackNamespace = Draft18MessageCodec.decodeTrackNamespace(reader);
      trackName = Draft18MessageCodec.decodeString(reader);
    }

    const subscriberPriority = reader.readByte();
    const groupOrder = reader.readByte() as GroupOrder;

    const startLocation = Draft18MessageCodec.decodeLocation(reader);
    const endLocation = Draft18MessageCodec.decodeLocation(reader);

    const paramsLength = reader.readVarIntNumber();
    const paramsEnd = reader.offset + paramsLength;
    const parameters = Draft18MessageCodec.decodeKeyValuePairs(reader, paramsEnd);

    return {
      type: MessageTypeDraft18.FETCH,
      requestId,
      joiningFlag,
      trackNamespace,
      trackName,
      subscribeRequestId,
      subscriberPriority,
      groupOrder,
      startLocation,
      endLocation,
      parameters: parameters.size > 0 ? parameters : undefined,
    };
  }

  private static encodeFetchOk(writer: Draft18BufferWriter, message: FetchOkMessageDraft18): void {
    writer.writeVarInt(message.requestId);

    // Flags: Bit 0 = End of Track
    const flags = message.endOfTrack ? 0x01 : 0x00;
    writer.writeVarInt(flags);

    Draft18MessageCodec.encodeLocation(writer, message.endLocation);

    if (message.trackProperties) {
      Draft18MessageCodec.encodeKeyValuePairs(writer, message.trackProperties);
    }
  }

  private static decodeFetchOk(reader: Draft18BufferReader): FetchOkMessageDraft18 {
    const requestId = reader.readVarInt();
    const flags = reader.readVarIntNumber();
    const endOfTrack = (flags & 0x01) !== 0;

    const endLocation = Draft18MessageCodec.decodeLocation(reader);
    const trackProperties = reader.hasMore
      ? Draft18MessageCodec.decodeKeyValuePairsToEnd(reader)
      : undefined;

    return {
      type: MessageTypeDraft18.FETCH_OK,
      requestId,
      endOfTrack,
      endLocation,
      trackProperties: trackProperties?.size ? trackProperties : undefined,
    };
  }

  // ============================================================================
  // Other Messages
  // ============================================================================

  private static encodeGoAway(writer: Draft18BufferWriter, message: GoAwayMessageDraft18): void {
    if (message.newSessionUri !== undefined) {
      Draft18MessageCodec.encodeString(writer, message.newSessionUri);
    }
  }

  private static decodeGoAway(reader: Draft18BufferReader): GoAwayMessageDraft18 {
    const newSessionUri = reader.hasMore ? Draft18MessageCodec.decodeString(reader) : undefined;

    return {
      type: MessageTypeDraft18.GOAWAY,
      newSessionUri,
    };
  }

  private static encodeTrackStatus(writer: Draft18BufferWriter, message: TrackStatusMessageDraft18): void {
    writer.writeVarInt(message.requestId);
    Draft18MessageCodec.encodeTrackNamespace(writer, message.trackNamespace);
    Draft18MessageCodec.encodeString(writer, message.trackName);
  }

  private static decodeTrackStatus(reader: Draft18BufferReader): TrackStatusMessageDraft18 {
    const requestId = reader.readVarInt();
    const trackNamespace = Draft18MessageCodec.decodeTrackNamespace(reader);
    const trackName = Draft18MessageCodec.decodeString(reader);

    return {
      type: MessageTypeDraft18.TRACK_STATUS,
      requestId,
      trackNamespace,
      trackName,
    };
  }

  // ============================================================================
  // PUBLISH_DONE Message
  // ============================================================================

  private static encodePublishDone(writer: Draft18BufferWriter, message: PublishDoneMessageDraft18): void {
    writer.writeVarInt(message.requestId);
    Draft18MessageCodec.encodeLocation(writer, message.finalLocation);
    if (message.reasonPhrase !== undefined) {
      Draft18MessageCodec.encodeString(writer, message.reasonPhrase);
    }
  }

  private static decodePublishDone(reader: Draft18BufferReader): PublishDoneMessageDraft18 {
    const requestId = reader.readVarInt();
    const finalLocation = Draft18MessageCodec.decodeLocation(reader);
    const reasonPhrase = reader.hasMore ? Draft18MessageCodec.decodeString(reader) : undefined;

    return {
      type: MessageTypeDraft18.PUBLISH_DONE,
      requestId,
      finalLocation,
      reasonPhrase,
    };
  }

  // ============================================================================
  // REQUEST_UPDATE Message
  // ============================================================================

  private static encodeRequestUpdate(writer: Draft18BufferWriter, message: RequestUpdateMessageDraft18): void {
    writer.writeVarInt(message.requestId);
    writer.writeByte(message.forwardState ? 0x80 : 0x00);
    if (message.parameters) {
      Draft18MessageCodec.encodeKeyValuePairs(writer, message.parameters);
    }
  }

  private static decodeRequestUpdate(reader: Draft18BufferReader): RequestUpdateMessageDraft18 {
    const requestId = reader.readVarInt();
    const flags = reader.readByte();
    const forwardState = (flags & 0x80) !== 0;
    const parameters = reader.hasMore
      ? Draft18MessageCodec.decodeKeyValuePairsToEnd(reader)
      : undefined;

    return {
      type: MessageTypeDraft18.REQUEST_UPDATE,
      requestId,
      forwardState,
      parameters: parameters?.size ? parameters : undefined,
    };
  }

  // ============================================================================
  // PUBLISH_NAMESPACE Message
  // ============================================================================

  private static encodePublishNamespace(writer: Draft18BufferWriter, message: PublishNamespaceMessageDraft18): void {
    writer.writeVarInt(message.requestId);
    Draft18MessageCodec.encodeTrackNamespace(writer, message.trackNamespacePrefix);
    if (message.parameters) {
      const paramsWriter = new Draft18BufferWriter();
      Draft18MessageCodec.encodeKeyValuePairs(paramsWriter, message.parameters);
      const paramsBytes = paramsWriter.toUint8Array();
      writer.writeVarInt(paramsBytes.length);
      writer.writeBytes(paramsBytes);
    } else {
      writer.writeVarInt(0);
    }
  }

  private static decodePublishNamespace(reader: Draft18BufferReader): PublishNamespaceMessageDraft18 {
    const requestId = reader.readVarInt();
    const trackNamespacePrefix = Draft18MessageCodec.decodeTrackNamespace(reader);
    const paramsLength = reader.readVarIntNumber();
    const parameters = paramsLength > 0
      ? Draft18MessageCodec.decodeKeyValuePairs(reader, reader.offset + paramsLength)
      : undefined;

    return {
      type: MessageTypeDraft18.PUBLISH_NAMESPACE,
      requestId,
      trackNamespacePrefix,
      parameters: parameters?.size ? parameters : undefined,
    };
  }

  // ============================================================================
  // SUBSCRIBE_NAMESPACE Message
  // ============================================================================

  private static encodeSubscribeNamespace(writer: Draft18BufferWriter, message: SubscribeNamespaceMessageDraft18): void {
    writer.writeVarInt(message.requestId);
    Draft18MessageCodec.encodeTrackNamespace(writer, message.trackNamespacePrefix);
    if (message.parameters) {
      const paramsWriter = new Draft18BufferWriter();
      Draft18MessageCodec.encodeKeyValuePairs(paramsWriter, message.parameters);
      const paramsBytes = paramsWriter.toUint8Array();
      writer.writeVarInt(paramsBytes.length);
      writer.writeBytes(paramsBytes);
    } else {
      writer.writeVarInt(0);
    }
  }

  private static decodeSubscribeNamespace(reader: Draft18BufferReader): SubscribeNamespaceMessageDraft18 {
    const requestId = reader.readVarInt();
    const trackNamespacePrefix = Draft18MessageCodec.decodeTrackNamespace(reader);
    const paramsLength = reader.readVarIntNumber();
    const parameters = paramsLength > 0
      ? Draft18MessageCodec.decodeKeyValuePairs(reader, reader.offset + paramsLength)
      : undefined;

    return {
      type: MessageTypeDraft18.SUBSCRIBE_NAMESPACE,
      requestId,
      trackNamespacePrefix,
      parameters: parameters?.size ? parameters : undefined,
    };
  }

  // ============================================================================
  // NAMESPACE Message
  // ============================================================================

  private static encodeNamespaceMessage(writer: Draft18BufferWriter, message: NamespaceMessageDraft18): void {
    Draft18MessageCodec.encodeTrackNamespace(writer, message.trackNamespace);
    if (message.trackNamespaceParameters) {
      Draft18MessageCodec.encodeKeyValuePairs(writer, message.trackNamespaceParameters);
    }
  }

  private static decodeNamespaceMessage(reader: Draft18BufferReader): NamespaceMessageDraft18 {
    const trackNamespace = Draft18MessageCodec.decodeTrackNamespace(reader);
    const trackNamespaceParameters = reader.hasMore
      ? Draft18MessageCodec.decodeKeyValuePairsToEnd(reader)
      : undefined;

    return {
      type: MessageTypeDraft18.NAMESPACE,
      trackNamespace,
      trackNamespaceParameters: trackNamespaceParameters?.size ? trackNamespaceParameters : undefined,
    };
  }

  // ============================================================================
  // NAMESPACE_DONE Message
  // ============================================================================

  private static encodeNamespaceDone(writer: Draft18BufferWriter, message: NamespaceDoneMessageDraft18): void {
    Draft18MessageCodec.encodeTrackNamespace(writer, message.finalNamespace);
  }

  private static decodeNamespaceDone(reader: Draft18BufferReader): NamespaceDoneMessageDraft18 {
    const finalNamespace = Draft18MessageCodec.decodeTrackNamespace(reader);

    return {
      type: MessageTypeDraft18.NAMESPACE_DONE,
      finalNamespace,
    };
  }

  // ============================================================================
  // SUBSCRIBE_TRACKS Message
  // ============================================================================

  private static encodeSubscribeTracks(writer: Draft18BufferWriter, message: SubscribeTracksMessageDraft18): void {
    writer.writeVarInt(message.requestId);
    Draft18MessageCodec.encodeTrackNamespace(writer, message.trackNamespacePrefix);
    if (message.trackNamePattern !== undefined) {
      Draft18MessageCodec.encodeString(writer, message.trackNamePattern);
    } else {
      writer.writeVarInt(0);
    }

    writer.writeByte(message.forwardState ? 0x80 : 0x00);

    Draft18MessageCodec.encodeSubscriptionFilter(writer, message);

    const params = message.parameters ?? new Map();
    const paramsWriter = new Draft18BufferWriter();
    Draft18MessageCodec.encodeKeyValuePairs(paramsWriter, params);
    const paramsBytes = paramsWriter.toUint8Array();
    writer.writeVarInt(paramsBytes.length);
    writer.writeBytes(paramsBytes);
  }

  private static decodeSubscribeTracks(reader: Draft18BufferReader): SubscribeTracksMessageDraft18 {
    const requestId = reader.readVarInt();
    const trackNamespacePrefix = Draft18MessageCodec.decodeTrackNamespace(reader);
    const patternLength = reader.readVarIntNumber();
    const trackNamePattern = patternLength > 0
      ? new TextDecoder().decode(reader.readBytes(patternLength))
      : undefined;

    const flags = reader.readByte();
    const forwardState = (flags & 0x80) !== 0;

    const { filter, startLocation, endGroupDelta } = Draft18MessageCodec.decodeSubscriptionFilter(reader);

    const paramsLength = reader.readVarIntNumber();
    const paramsEnd = reader.offset + paramsLength;
    const parameters = Draft18MessageCodec.decodeKeyValuePairs(reader, paramsEnd);

    return {
      type: MessageTypeDraft18.SUBSCRIBE_TRACKS,
      requestId,
      trackNamespacePrefix,
      trackNamePattern,
      forwardState,
      filter,
      startLocation,
      endGroupDelta,
      parameters: parameters.size > 0 ? parameters : undefined,
    };
  }

  // ============================================================================
  // PUBLISH_BLOCKED Message
  // ============================================================================

  private static encodePublishBlocked(writer: Draft18BufferWriter, message: PublishBlockedMessageDraft18): void {
    writer.writeVarInt(message.trackAlias);
  }

  private static decodePublishBlocked(reader: Draft18BufferReader): PublishBlockedMessageDraft18 {
    const trackAlias = reader.readVarInt();

    return {
      type: MessageTypeDraft18.PUBLISH_BLOCKED,
      trackAlias,
    };
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  private static encodeTrackNamespace(writer: Draft18BufferWriter, namespace: TrackNamespace): void {
    writer.writeVarInt(namespace.length);
    for (const field of namespace) {
      const bytes = new TextEncoder().encode(field);
      writer.writeVarInt(bytes.length);
      writer.writeBytes(bytes);
    }
  }

  private static decodeTrackNamespace(reader: Draft18BufferReader): TrackNamespace {
    const count = reader.readVarIntNumber();
    const namespace: string[] = [];
    for (let i = 0; i < count; i++) {
      const length = reader.readVarIntNumber();
      const bytes = reader.readBytes(length);
      namespace.push(new TextDecoder().decode(bytes));
    }
    return namespace;
  }

  private static encodeString(writer: Draft18BufferWriter, str: string): void {
    const bytes = new TextEncoder().encode(str);
    writer.writeVarInt(bytes.length);
    writer.writeBytes(bytes);
  }

  private static decodeString(reader: Draft18BufferReader): string {
    const length = reader.readVarIntNumber();
    const bytes = reader.readBytes(length);
    return new TextDecoder().decode(bytes);
  }

  private static encodeLocation(writer: Draft18BufferWriter, location: Location): void {
    writer.writeVarInt(location.group);
    writer.writeVarInt(location.object);
  }

  private static decodeLocation(reader: Draft18BufferReader): Location {
    const group = reader.readVarInt();
    const object = reader.readVarInt();
    return { group, object };
  }

  private static encodeSubscriptionFilter(
    writer: Draft18BufferWriter,
    message: SubscribeMessageDraft18 | SubscribeTracksMessageDraft18
  ): void {
    writer.writeVarInt(message.filter);

    if (message.filter === SubscriptionFilterDraft18.ABSOLUTE_START ||
        message.filter === SubscriptionFilterDraft18.ABSOLUTE_RANGE) {
      if (message.startLocation) {
        Draft18MessageCodec.encodeLocation(writer, message.startLocation);
      } else {
        writer.writeVarInt(0);
        writer.writeVarInt(0);
      }
    }

    if (message.filter === SubscriptionFilterDraft18.ABSOLUTE_RANGE) {
      writer.writeVarInt(message.endGroupDelta ?? 0n);
    }
  }

  private static decodeSubscriptionFilter(reader: Draft18BufferReader): {
    filter: SubscriptionFilterDraft18;
    startLocation?: Location;
    endGroupDelta?: bigint;
  } {
    const filter = reader.readVarIntNumber() as SubscriptionFilterDraft18;
    let startLocation: Location | undefined;
    let endGroupDelta: bigint | undefined;

    if (filter === SubscriptionFilterDraft18.ABSOLUTE_START ||
        filter === SubscriptionFilterDraft18.ABSOLUTE_RANGE) {
      startLocation = Draft18MessageCodec.decodeLocation(reader);
    }

    if (filter === SubscriptionFilterDraft18.ABSOLUTE_RANGE) {
      endGroupDelta = reader.readVarInt();
    }

    return { filter, startLocation, endGroupDelta };
  }

  private static encodeKeyValuePairs(writer: Draft18BufferWriter, pairs: Map<number, Uint8Array>): void {
    const sortedEntries = Array.from(pairs.entries()).sort((a, b) => a[0] - b[0]);
    let previousKey = 0;

    for (const [key, value] of sortedEntries) {
      writer.writeVarInt(key - previousKey);
      previousKey = key;

      if (key % 2 === 0) {
        writer.writeBytes(value);
      } else {
        writer.writeVarInt(value.length);
        writer.writeBytes(value);
      }
    }
  }

  private static decodeKeyValuePairs(reader: Draft18BufferReader, endOffset: number): Map<number, Uint8Array> {
    const pairs = new Map<number, Uint8Array>();
    let previousKey = 0;

    while (reader.offset < endOffset) {
      const deltaKey = reader.readVarIntNumber();
      const key = previousKey + deltaKey;
      previousKey = key;

      if (key % 2 === 0) {
        const value = reader.readVarInt();
        pairs.set(key, MOQTVarInt.encode(value));
      } else {
        const length = reader.readVarIntNumber();
        pairs.set(key, reader.readBytes(length));
      }
    }

    return pairs;
  }

  private static decodeKeyValuePairsToEnd(reader: Draft18BufferReader): Map<number, Uint8Array> {
    const pairs = new Map<number, Uint8Array>();
    let previousKey = 0;

    while (reader.hasMore) {
      const deltaKey = reader.readVarIntNumber();
      const key = previousKey + deltaKey;
      previousKey = key;

      if (key % 2 === 0) {
        const value = reader.readVarInt();
        pairs.set(key, MOQTVarInt.encode(value));
      } else {
        const length = reader.readVarIntNumber();
        pairs.set(key, reader.readBytes(length));
      }
    }

    return pairs;
  }
}
