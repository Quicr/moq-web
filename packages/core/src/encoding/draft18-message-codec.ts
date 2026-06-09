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
  RequestParameterDraft18,
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
    // Draft-18 SUBSCRIBE: Request ID | Track Namespace | Track Name | Number of Parameters | Parameters
    writer.writeVarInt(message.requestId);
    Draft18MessageCodec.encodeTrackNamespace(writer, message.trackNamespace);
    Draft18MessageCodec.encodeString(writer, message.trackName);

    // Build parameters list including subscription filter
    const params: Array<{ type: number; encode: (w: Draft18BufferWriter) => void }> = [];

    // FORWARD parameter (0x10): even type = single byte value
    // 0x01 = forward new objects to subscriber
    if (message.forwardState !== false) {
      params.push({
        type: RequestParameterDraft18.FORWARD,
        encode: (w) => { w.writeByte(0x01); },
      });
    }

    if (message.filter !== undefined) {
      params.push({
        type: RequestParameterDraft18.SUBSCRIPTION_FILTER,
        encode: (w) => {
          // Length-prefixed: encode filter into temp buffer, write length + bytes
          const filterWriter = new Draft18BufferWriter();
          filterWriter.writeVarInt(BigInt(message.filter));
          if (message.filter === SubscriptionFilterDraft18.ABSOLUTE_START ||
              message.filter === SubscriptionFilterDraft18.ABSOLUTE_RANGE) {
            const loc = message.startLocation ?? { group: 0n, object: 0n };
            filterWriter.writeVarInt(loc.group);
            filterWriter.writeVarInt(loc.object);
          }
          if (message.filter === SubscriptionFilterDraft18.ABSOLUTE_RANGE) {
            filterWriter.writeVarInt(message.endGroupDelta ?? 0n);
          }
          const filterBytes = filterWriter.toUint8Array();
          w.writeVarInt(BigInt(filterBytes.length));
          w.writeBytes(filterBytes);
        },
      });
    }

    // Add any additional raw parameters
    if (message.parameters) {
      for (const [type, value] of message.parameters) {
        params.push({ type, encode: (w) => w.writeBytes(value) });
      }
    }

    Draft18MessageCodec.encodeMessageParameters(writer, params);
  }

  private static decodeSubscribe(reader: Draft18BufferReader): SubscribeMessageDraft18 {
    const requestId = reader.readVarInt();
    const trackNamespace = Draft18MessageCodec.decodeTrackNamespace(reader);
    const trackName = Draft18MessageCodec.decodeString(reader);

    const numParams = reader.readVarIntNumber();
    let filter = SubscriptionFilterDraft18.NEXT_GROUP_START;
    let startLocation: Location | undefined;
    let endGroupDelta: bigint | undefined;
    const parameters = new Map<number, Uint8Array>();

    let previousType = 0;
    for (let i = 0; i < numParams; i++) {
      const delta = reader.readVarIntNumber();
      const type = previousType + delta;
      previousType = type;

      if (type === RequestParameterDraft18.SUBSCRIPTION_FILTER) {
        const length = reader.readVarIntNumber();
        const filterBytes = reader.readBytes(length);
        const filterReader = new Draft18BufferReader(filterBytes, 0);
        filter = filterReader.readVarIntNumber() as SubscriptionFilterDraft18;
        if (filter === SubscriptionFilterDraft18.ABSOLUTE_START ||
            filter === SubscriptionFilterDraft18.ABSOLUTE_RANGE) {
          startLocation = { group: filterReader.readVarInt(), object: filterReader.readVarInt() };
        }
        if (filter === SubscriptionFilterDraft18.ABSOLUTE_RANGE) {
          endGroupDelta = filterReader.readVarInt();
        }
      } else {
        const value = Draft18MessageCodec.readParameterValue(reader, type);
        parameters.set(type, value);
      }
    }

    return {
      type: MessageTypeDraft18.SUBSCRIBE,
      requestId,
      trackNamespace,
      trackName,
      forwardState: true,
      filter,
      startLocation,
      endGroupDelta,
      parameters: parameters.size > 0 ? parameters : undefined,
    };
  }

  private static encodeSubscribeOk(writer: Draft18BufferWriter, message: SubscribeOkMessageDraft18): void {
    // Draft-18 SUBSCRIBE_OK: Track Alias | Number of Parameters | Parameters | Track Properties (..)
    writer.writeVarInt(message.trackAlias ?? 0n);

    // Parameters (count-prefixed)
    const params: Array<{ type: number; encode: (w: Draft18BufferWriter) => void }> = [];
    if (message.largestLocation && (message.largestLocation.group > 0n || message.largestLocation.object > 0n)) {
      params.push({
        type: RequestParameterDraft18.LARGEST_OBJECT,
        encode: (w) => {
          w.writeVarInt(message.largestLocation.group);
          w.writeVarInt(message.largestLocation.object);
        },
      });
    }
    Draft18MessageCodec.encodeMessageParameters(writer, params);

    // Track Properties (KVPs to end)
    if (message.trackProperties) {
      Draft18MessageCodec.encodeKeyValuePairs(writer, message.trackProperties);
    }
  }

  private static decodeSubscribeOk(reader: Draft18BufferReader): SubscribeOkMessageDraft18 {
    // Draft-18 SUBSCRIBE_OK: Track Alias | Number of Parameters | Parameters | Track Properties (..)
    const trackAlias = reader.readVarInt();

    const numParams = reader.readVarIntNumber();
    let largestLocation: Location = { group: 0n, object: 0n };

    let previousType = 0;
    for (let i = 0; i < numParams; i++) {
      const delta = reader.readVarIntNumber();
      const type = previousType + delta;
      previousType = type;

      if (type === RequestParameterDraft18.LARGEST_OBJECT) {
        largestLocation = { group: reader.readVarInt(), object: reader.readVarInt() };
      } else {
        Draft18MessageCodec.readParameterValue(reader, type);
      }
    }

    // Track Properties fill remaining bytes
    const trackProperties = reader.hasMore
      ? Draft18MessageCodec.decodeKeyValuePairsToEnd(reader)
      : undefined;

    return {
      type: MessageTypeDraft18.SUBSCRIBE_OK,
      requestId: trackAlias,
      trackAlias,
      largestLocation,
      trackProperties: trackProperties?.size ? trackProperties : undefined,
    };
  }

  // ============================================================================
  // Publish Messages
  // ============================================================================

  private static encodePublish(writer: Draft18BufferWriter, message: PublishMessageDraft18): void {
    // Draft-18 PUBLISH: Request ID | Track Namespace | Track Name | Track Alias | Num Params | Params | Track Properties
    writer.writeVarInt(message.requestId);
    Draft18MessageCodec.encodeTrackNamespace(writer, message.trackNamespace);
    Draft18MessageCodec.encodeString(writer, message.trackName);
    writer.writeVarInt(message.trackAlias);

    // Message Parameters (count-prefixed)
    const params: Array<{ type: number; encode: (w: Draft18BufferWriter) => void }> = [];
    Draft18MessageCodec.encodeMessageParameters(writer, params);

    // Track Properties (KVPs to end)
    if (message.trackProperties) {
      Draft18MessageCodec.encodeKeyValuePairs(writer, message.trackProperties);
    }
  }

  private static decodePublish(reader: Draft18BufferReader): PublishMessageDraft18 {
    const requestId = reader.readVarInt();
    const trackNamespace = Draft18MessageCodec.decodeTrackNamespace(reader);
    const trackName = Draft18MessageCodec.decodeString(reader);
    const trackAlias = reader.readVarInt();

    // Message Parameters (count-prefixed)
    const numParams = reader.readVarIntNumber();
    let previousType = 0;
    for (let i = 0; i < numParams; i++) {
      const delta = reader.readVarIntNumber();
      const type = previousType + delta;
      previousType = type;
      Draft18MessageCodec.readParameterValue(reader, type);
    }

    // Track Properties (KVPs to end)
    const trackProperties = reader.hasMore
      ? Draft18MessageCodec.decodeKeyValuePairsToEnd(reader)
      : undefined;

    return {
      type: MessageTypeDraft18.PUBLISH,
      requestId,
      trackAlias,
      trackNamespace,
      trackName,
      forwardState: true,
      largestLocation: { group: 0n, object: 0n },
      trackProperties: trackProperties?.size ? trackProperties : undefined,
    };
  }

  // ============================================================================
  // Request Messages
  // ============================================================================

  private static encodeRequestError(writer: Draft18BufferWriter, message: RequestErrorMessageDraft18): void {
    // Draft-18: Error Code | Retry Interval | Error Reason
    writer.writeVarInt(message.errorCode);
    writer.writeVarInt(message.retryInterval ?? 0n);
    Draft18MessageCodec.encodeString(writer, message.reasonPhrase);
  }

  private static decodeRequestError(reader: Draft18BufferReader): RequestErrorMessageDraft18 {
    // Draft-18: Error Code | Retry Interval | Error Reason
    const errorCode = reader.readVarIntNumber();
    const retryInterval = reader.readVarInt();
    const reasonPhrase = Draft18MessageCodec.decodeString(reader);

    return {
      type: MessageTypeDraft18.REQUEST_ERROR,
      requestId: 0n,
      errorCode,
      retryInterval,
      reasonPhrase,
    };
  }

  private static encodeRequestOk(writer: Draft18BufferWriter, message: RequestOkMessageDraft18): void {
    // Draft-18 REQUEST_OK: Number of Parameters | Parameters | Track Properties (..)
    const params: Array<{ type: number; encode: (w: Draft18BufferWriter) => void }> = [];
    if (message.expires !== undefined) {
      params.push({
        type: RequestParameterDraft18.EXPIRES,
        encode: (w) => w.writeVarInt(message.expires!),
      });
    }
    Draft18MessageCodec.encodeMessageParameters(writer, params);
  }

  private static decodeRequestOk(reader: Draft18BufferReader): RequestOkMessageDraft18 {
    // Draft-18 REQUEST_OK: Number of Parameters | Parameters | Track Properties (..)
    const numParams = reader.readVarIntNumber();
    let expires: bigint | undefined;

    let previousType = 0;
    for (let i = 0; i < numParams; i++) {
      const delta = reader.readVarIntNumber();
      const type = previousType + delta;
      previousType = type;

      if (type === RequestParameterDraft18.EXPIRES) {
        expires = reader.readVarInt();
      } else {
        Draft18MessageCodec.readParameterValue(reader, type);
      }
    }

    return {
      type: MessageTypeDraft18.REQUEST_OK,
      requestId: 0n,
      expires,
    };
  }

  // ============================================================================
  // Fetch Messages
  // ============================================================================

  private static encodeFetch(writer: Draft18BufferWriter, message: FetchMessageDraft18): void {
    // Draft-18: Request ID | Fetch Type | [Standalone/Joining] | Num Params | Params
    writer.writeVarInt(message.requestId);

    if (message.joiningFlag && message.subscribeRequestId !== undefined) {
      // Joining fetch (type 0x2 = relative)
      writer.writeVarInt(2n);
      writer.writeVarInt(message.subscribeRequestId);
      writer.writeVarInt(0n); // Joining Start
    } else {
      // Standalone fetch (type 0x1)
      writer.writeVarInt(1n);
      Draft18MessageCodec.encodeTrackNamespace(writer, message.trackNamespace!);
      Draft18MessageCodec.encodeString(writer, message.trackName!);
      Draft18MessageCodec.encodeLocation(writer, message.startLocation);
      Draft18MessageCodec.encodeLocation(writer, message.endLocation);
    }

    // Parameters (count-prefixed)
    const params: Array<{ type: number; encode: (w: Draft18BufferWriter) => void }> = [];
    if (message.subscriberPriority !== 0) {
      params.push({
        type: RequestParameterDraft18.SUBSCRIBER_PRIORITY,
        encode: (w) => w.writeByte(message.subscriberPriority),
      });
    }
    if (message.groupOrder) {
      params.push({
        type: RequestParameterDraft18.GROUP_ORDER,
        encode: (w) => w.writeByte(message.groupOrder),
      });
    }
    Draft18MessageCodec.encodeMessageParameters(writer, params);
  }

  private static decodeFetch(reader: Draft18BufferReader): FetchMessageDraft18 {
    const requestId = reader.readVarInt();
    const fetchType = reader.readVarIntNumber();

    let trackNamespace: TrackNamespace | undefined;
    let trackName: string | undefined;
    let subscribeRequestId: bigint | undefined;
    let startLocation: Location = { group: 0n, object: 0n };
    let endLocation: Location = { group: 0n, object: 0n };
    const joiningFlag = fetchType !== 1;

    if (fetchType === 1) {
      // Standalone
      trackNamespace = Draft18MessageCodec.decodeTrackNamespace(reader);
      trackName = Draft18MessageCodec.decodeString(reader);
      startLocation = Draft18MessageCodec.decodeLocation(reader);
      endLocation = Draft18MessageCodec.decodeLocation(reader);
    } else {
      // Joining (relative=0x2 or absolute=0x3)
      subscribeRequestId = reader.readVarInt();
      reader.readVarInt(); // Joining Start
    }

    // Parameters
    const numParams = reader.readVarIntNumber();
    let subscriberPriority = 0;
    let groupOrder = GroupOrder.ASCENDING as GroupOrder;
    let previousType = 0;
    for (let i = 0; i < numParams; i++) {
      const delta = reader.readVarIntNumber();
      const type = previousType + delta;
      previousType = type;
      if (type === RequestParameterDraft18.SUBSCRIBER_PRIORITY) {
        subscriberPriority = reader.readByte();
      } else if (type === RequestParameterDraft18.GROUP_ORDER) {
        groupOrder = reader.readByte() as GroupOrder;
      } else {
        Draft18MessageCodec.readParameterValue(reader, type);
      }
    }

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
    };
  }

  private static encodeFetchOk(writer: Draft18BufferWriter, message: FetchOkMessageDraft18): void {
    // Draft-18: End Of Track (8) | End Location | Num Params | Params | Track Properties
    writer.writeByte(message.endOfTrack ? 1 : 0);
    Draft18MessageCodec.encodeLocation(writer, message.endLocation);
    Draft18MessageCodec.encodeMessageParameters(writer, []);
    if (message.trackProperties) {
      Draft18MessageCodec.encodeKeyValuePairs(writer, message.trackProperties);
    }
  }

  private static decodeFetchOk(reader: Draft18BufferReader): FetchOkMessageDraft18 {
    // Draft-18: End Of Track (8) | End Location | Num Params | Params | Track Properties
    const endOfTrack = reader.readByte() !== 0;
    const endLocation = Draft18MessageCodec.decodeLocation(reader);

    const numParams = reader.readVarIntNumber();
    let previousType = 0;
    for (let i = 0; i < numParams; i++) {
      const delta = reader.readVarIntNumber();
      const type = previousType + delta;
      previousType = type;
      Draft18MessageCodec.readParameterValue(reader, type);
    }

    const trackProperties = reader.hasMore
      ? Draft18MessageCodec.decodeKeyValuePairsToEnd(reader)
      : undefined;

    return {
      type: MessageTypeDraft18.FETCH_OK,
      requestId: 0n,
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
    // Same format as SUBSCRIBE: Request ID | Track Namespace | Track Name | Num Params | Params
    writer.writeVarInt(message.requestId);
    Draft18MessageCodec.encodeTrackNamespace(writer, message.trackNamespace);
    Draft18MessageCodec.encodeString(writer, message.trackName);
    Draft18MessageCodec.encodeMessageParameters(writer, []);
  }

  private static decodeTrackStatus(reader: Draft18BufferReader): TrackStatusMessageDraft18 {
    const requestId = reader.readVarInt();
    const trackNamespace = Draft18MessageCodec.decodeTrackNamespace(reader);
    const trackName = Draft18MessageCodec.decodeString(reader);
    const numParams = reader.readVarIntNumber();
    let previousType = 0;
    for (let i = 0; i < numParams; i++) {
      const delta = reader.readVarIntNumber();
      const type = previousType + delta;
      previousType = type;
      Draft18MessageCodec.readParameterValue(reader, type);
    }

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
    // Draft-18: Status Code (vi64) | Stream Count (vi64) | Error Reason (Reason Phrase)
    writer.writeVarInt(message.statusCode ?? 0n);
    writer.writeVarInt(message.streamCount ?? 0n);
    Draft18MessageCodec.encodeString(writer, message.reasonPhrase ?? '');
  }

  private static decodePublishDone(reader: Draft18BufferReader): PublishDoneMessageDraft18 {
    const statusCode = reader.readVarInt();
    const streamCount = reader.readVarInt();
    const reasonPhrase = Draft18MessageCodec.decodeString(reader);

    return {
      type: MessageTypeDraft18.PUBLISH_DONE,
      requestId: 0n,
      finalLocation: { group: 0n, object: 0n },
      statusCode,
      streamCount,
      reasonPhrase: reasonPhrase || undefined,
    };
  }

  // ============================================================================
  // REQUEST_UPDATE Message
  // ============================================================================

  private static encodeRequestUpdate(writer: Draft18BufferWriter, message: RequestUpdateMessageDraft18): void {
    // Draft-18: Request ID | Number of Parameters | Parameters
    writer.writeVarInt(message.requestId);
    const params: Array<{ type: number; encode: (w: Draft18BufferWriter) => void }> = [];
    Draft18MessageCodec.encodeMessageParameters(writer, params);
  }

  private static decodeRequestUpdate(reader: Draft18BufferReader): RequestUpdateMessageDraft18 {
    const requestId = reader.readVarInt();
    const numParams = reader.readVarIntNumber();
    let previousType = 0;
    for (let i = 0; i < numParams; i++) {
      const delta = reader.readVarIntNumber();
      const type = previousType + delta;
      previousType = type;
      Draft18MessageCodec.readParameterValue(reader, type);
    }

    return {
      type: MessageTypeDraft18.REQUEST_UPDATE,
      requestId,
      forwardState: true,
    };
  }

  // ============================================================================
  // PUBLISH_NAMESPACE Message
  // ============================================================================

  private static encodePublishNamespace(writer: Draft18BufferWriter, message: PublishNamespaceMessageDraft18): void {
    // Draft-18: Request ID | Track Namespace | Number of Parameters | Parameters
    writer.writeVarInt(message.requestId);
    Draft18MessageCodec.encodeTrackNamespace(writer, message.trackNamespacePrefix);
    Draft18MessageCodec.encodeMessageParameters(writer, []);
  }

  private static decodePublishNamespace(reader: Draft18BufferReader): PublishNamespaceMessageDraft18 {
    const requestId = reader.readVarInt();
    const trackNamespacePrefix = Draft18MessageCodec.decodeTrackNamespace(reader);
    const numParams = reader.readVarIntNumber();
    let previousType = 0;
    for (let i = 0; i < numParams; i++) {
      const delta = reader.readVarIntNumber();
      const type = previousType + delta;
      previousType = type;
      Draft18MessageCodec.readParameterValue(reader, type);
    }

    return {
      type: MessageTypeDraft18.PUBLISH_NAMESPACE,
      requestId,
      trackNamespacePrefix,
    };
  }

  // ============================================================================
  // SUBSCRIBE_NAMESPACE Message
  // ============================================================================

  private static encodeSubscribeNamespace(writer: Draft18BufferWriter, message: SubscribeNamespaceMessageDraft18): void {
    // Draft-18: Request ID | Track Namespace Prefix | Number of Parameters | Parameters
    writer.writeVarInt(message.requestId);
    Draft18MessageCodec.encodeTrackNamespace(writer, message.trackNamespacePrefix);
    Draft18MessageCodec.encodeMessageParameters(writer, []);
  }

  private static decodeSubscribeNamespace(reader: Draft18BufferReader): SubscribeNamespaceMessageDraft18 {
    const requestId = reader.readVarInt();
    const trackNamespacePrefix = Draft18MessageCodec.decodeTrackNamespace(reader);
    const numParams = reader.readVarIntNumber();
    let previousType = 0;
    for (let i = 0; i < numParams; i++) {
      const delta = reader.readVarIntNumber();
      const type = previousType + delta;
      previousType = type;
      Draft18MessageCodec.readParameterValue(reader, type);
    }

    return {
      type: MessageTypeDraft18.SUBSCRIBE_NAMESPACE,
      requestId,
      trackNamespacePrefix,
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
    // Draft-18: Request ID | Track Namespace Prefix | Number of Parameters | Parameters
    writer.writeVarInt(message.requestId);
    Draft18MessageCodec.encodeTrackNamespace(writer, message.trackNamespacePrefix);
    Draft18MessageCodec.encodeMessageParameters(writer, []);
  }

  private static decodeSubscribeTracks(reader: Draft18BufferReader): SubscribeTracksMessageDraft18 {
    const requestId = reader.readVarInt();
    const trackNamespacePrefix = Draft18MessageCodec.decodeTrackNamespace(reader);
    const numParams = reader.readVarIntNumber();
    let previousType = 0;
    for (let i = 0; i < numParams; i++) {
      const delta = reader.readVarIntNumber();
      const type = previousType + delta;
      previousType = type;
      Draft18MessageCodec.readParameterValue(reader, type);
    }

    return {
      type: MessageTypeDraft18.SUBSCRIBE_TRACKS,
      requestId,
      trackNamespacePrefix,
      forwardState: true,
      filter: SubscriptionFilterDraft18.NEXT_GROUP_START,
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



  /**
   * Encode Message Parameters (count-prefixed, per-type encoding)
   */
  private static encodeMessageParameters(
    writer: Draft18BufferWriter,
    params: Array<{ type: number; encode: (w: Draft18BufferWriter) => void }>
  ): void {
    params.sort((a, b) => a.type - b.type);
    writer.writeVarInt(BigInt(params.length));
    let previousType = 0;
    for (const param of params) {
      writer.writeVarInt(BigInt(param.type - previousType));
      previousType = param.type;
      param.encode(writer);
    }
  }

  /**
   * Read a parameter value based on type (for skipping unknown parameters)
   */
  private static readParameterValue(reader: Draft18BufferReader, type: number): Uint8Array {
    switch (type) {
      case RequestParameterDraft18.FORWARD:
      case RequestParameterDraft18.SUBSCRIBER_PRIORITY:
      case RequestParameterDraft18.GROUP_ORDER: {
        const b = reader.readByte();
        return new Uint8Array([b]);
      }
      case RequestParameterDraft18.EXPIRES:
      case RequestParameterDraft18.OBJECT_DELIVERY_TIMEOUT:
      case RequestParameterDraft18.SUBGROUP_DELIVERY_TIMEOUT:
      case RequestParameterDraft18.RENDEZVOUS_TIMEOUT:
      case RequestParameterDraft18.FILL_TIMEOUT:
      case RequestParameterDraft18.NEW_GROUP_REQUEST:
        return MOQTVarInt.encode(reader.readVarInt());
      case RequestParameterDraft18.LARGEST_OBJECT: {
        const g = reader.readVarInt();
        const o = reader.readVarInt();
        const gBytes = MOQTVarInt.encode(g);
        const oBytes = MOQTVarInt.encode(o);
        const result = new Uint8Array(gBytes.length + oBytes.length);
        result.set(gBytes, 0);
        result.set(oBytes, gBytes.length);
        return result;
      }
      case RequestParameterDraft18.AUTHORIZATION_TOKEN:
      case RequestParameterDraft18.SUBSCRIPTION_FILTER:
      case RequestParameterDraft18.TRACK_NAMESPACE_PREFIX:
      default: {
        const length = reader.readVarIntNumber();
        return reader.readBytes(length);
      }
    }
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
