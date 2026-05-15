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
  RoleDraft18,
  SetupOptionDraft18,
  type ControlMessageDraft18,
  type ClientSetupMessageDraft18,
  type ServerSetupMessageDraft18,
  type SubscribeMessageDraft18,
  type SubscribeOkMessageDraft18,
  type PublishMessageDraft18,
  type RequestErrorMessageDraft18,
  type RequestOkMessageDraft18,
  type FetchMessageDraft18,
  type FetchOkMessageDraft18,
  type GoAwayMessageDraft18,
  type TrackStatusMessageDraft18,
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
      case MessageTypeDraft18.CLIENT_SETUP:
        Draft18MessageCodec.encodeClientSetup(payloadWriter, message);
        break;
      case MessageTypeDraft18.SERVER_SETUP:
        Draft18MessageCodec.encodeServerSetup(payloadWriter, message);
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
      default:
        throw new Draft18CodecError(`Unknown message type: ${(message as ControlMessageDraft18).type}`);
    }

    const payload = payloadWriter.toUint8Array();

    // Draft-18: Message Type (varint) + Payload (no length prefix for control messages)
    const writer = new Draft18BufferWriter();
    writer.writeVarInt(message.type);
    writer.writeBytes(payload);

    return writer.toUint8Array();
  }

  /**
   * Decode a draft-18 control message from bytes
   */
  static decode(buffer: Uint8Array, offset = 0): [ControlMessageDraft18, number] {
    const reader = new Draft18BufferReader(buffer, offset);
    const startOffset = reader.offset;

    const messageType = reader.readVarIntNumber() as MessageTypeDraft18;
    log.trace('Decoding draft-18 message', { type: MessageTypeDraft18[messageType] ?? messageType });

    let message: ControlMessageDraft18;

    switch (messageType) {
      case MessageTypeDraft18.CLIENT_SETUP:
        message = Draft18MessageCodec.decodeClientSetup(reader);
        break;
      case MessageTypeDraft18.SERVER_SETUP:
        message = Draft18MessageCodec.decodeServerSetup(reader);
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
        message = Draft18MessageCodec.decodeRequestOk(reader);
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
      default:
        throw new Draft18CodecError(`Unknown message type: ${messageType}`, messageType);
    }

    return [message, reader.offset - startOffset];
  }

  // ============================================================================
  // Setup Messages
  // ============================================================================

  private static encodeClientSetup(writer: Draft18BufferWriter, message: ClientSetupMessageDraft18): void {
    // Number of Supported Versions + Versions[]
    writer.writeVarInt(message.supportedVersions.length);
    for (const version of message.supportedVersions) {
      writer.writeVarInt(version);
    }

    // Setup Options Length + Options
    const optionsWriter = new Draft18BufferWriter();
    Draft18MessageCodec.encodeSetupOptions(optionsWriter, message);
    const options = optionsWriter.toUint8Array();
    writer.writeVarInt(options.length);
    writer.writeBytes(options);
  }

  private static decodeClientSetup(reader: Draft18BufferReader): ClientSetupMessageDraft18 {
    const versionCount = reader.readVarIntNumber();
    const supportedVersions: Version[] = [];
    for (let i = 0; i < versionCount; i++) {
      supportedVersions.push(reader.readVarIntNumber() as Version);
    }

    const optionsLength = reader.readVarIntNumber();
    const optionsEnd = reader.offset + optionsLength;
    const { role, path, authority, maxAuthTokenCacheSize, authToken } =
      Draft18MessageCodec.decodeSetupOptions(reader, optionsEnd);

    return {
      type: MessageTypeDraft18.CLIENT_SETUP,
      supportedVersions,
      role,
      path,
      authority,
      maxAuthTokenCacheSize,
      authToken,
    };
  }

  private static encodeServerSetup(writer: Draft18BufferWriter, message: ServerSetupMessageDraft18): void {
    // Selected Version
    writer.writeVarInt(message.selectedVersion);

    // Setup Options Length + Options
    const optionsWriter = new Draft18BufferWriter();
    Draft18MessageCodec.encodeSetupOptions(optionsWriter, message);
    const options = optionsWriter.toUint8Array();
    writer.writeVarInt(options.length);
    writer.writeBytes(options);
  }

  private static decodeServerSetup(reader: Draft18BufferReader): ServerSetupMessageDraft18 {
    const selectedVersion = reader.readVarIntNumber() as Version;

    const optionsLength = reader.readVarIntNumber();
    const optionsEnd = reader.offset + optionsLength;
    const { role, path, authority, maxAuthTokenCacheSize } =
      Draft18MessageCodec.decodeSetupOptions(reader, optionsEnd);

    return {
      type: MessageTypeDraft18.SERVER_SETUP,
      selectedVersion,
      role,
      path,
      authority,
      maxAuthTokenCacheSize,
    };
  }

  private static encodeSetupOptions(
    writer: Draft18BufferWriter,
    message: ClientSetupMessageDraft18 | ServerSetupMessageDraft18
  ): void {
    let previousKey = 0;

    if (message.role !== undefined) {
      writer.writeVarInt(SetupOptionDraft18.ROLE - previousKey);
      previousKey = SetupOptionDraft18.ROLE;
      writer.writeVarInt(message.role);
    }

    if (message.path !== undefined) {
      writer.writeVarInt(SetupOptionDraft18.PATH - previousKey);
      previousKey = SetupOptionDraft18.PATH;
      const bytes = new TextEncoder().encode(message.path);
      writer.writeVarInt(bytes.length);
      writer.writeBytes(bytes);
    }

    if (message.authority !== undefined) {
      writer.writeVarInt(SetupOptionDraft18.AUTHORITY - previousKey);
      previousKey = SetupOptionDraft18.AUTHORITY;
      const bytes = new TextEncoder().encode(message.authority);
      writer.writeVarInt(bytes.length);
      writer.writeBytes(bytes);
    }

    if (message.maxAuthTokenCacheSize !== undefined) {
      writer.writeVarInt(SetupOptionDraft18.MAX_AUTH_TOKEN_CACHE_SIZE - previousKey);
      previousKey = SetupOptionDraft18.MAX_AUTH_TOKEN_CACHE_SIZE;
      writer.writeVarInt(message.maxAuthTokenCacheSize);
    }

    if ('authToken' in message && message.authToken !== undefined) {
      writer.writeVarInt(SetupOptionDraft18.AUTH_TOKEN - previousKey);
      writer.writeVarInt(message.authToken.length);
      writer.writeBytes(message.authToken);
    }
  }

  private static decodeSetupOptions(
    reader: Draft18BufferReader,
    endOffset: number
  ): {
    role?: RoleDraft18;
    path?: string;
    authority?: string;
    maxAuthTokenCacheSize?: number;
    authToken?: Uint8Array;
  } {
    let role: RoleDraft18 | undefined;
    let path: string | undefined;
    let authority: string | undefined;
    let maxAuthTokenCacheSize: number | undefined;
    let authToken: Uint8Array | undefined;

    let previousKey = 0;
    while (reader.offset < endOffset) {
      const deltaKey = reader.readVarIntNumber();
      const key = previousKey + deltaKey;
      previousKey = key;

      switch (key) {
        case SetupOptionDraft18.ROLE:
          role = reader.readVarIntNumber() as RoleDraft18;
          break;
        case SetupOptionDraft18.PATH: {
          const length = reader.readVarIntNumber();
          path = new TextDecoder().decode(reader.readBytes(length));
          break;
        }
        case SetupOptionDraft18.AUTHORITY: {
          const length = reader.readVarIntNumber();
          authority = new TextDecoder().decode(reader.readBytes(length));
          break;
        }
        case SetupOptionDraft18.MAX_AUTH_TOKEN_CACHE_SIZE:
          maxAuthTokenCacheSize = reader.readVarIntNumber();
          break;
        case SetupOptionDraft18.AUTH_TOKEN: {
          const length = reader.readVarIntNumber();
          authToken = reader.readBytes(length);
          break;
        }
        default:
          // Skip unknown options
          if (key % 2 === 0) {
            reader.readVarInt();
          } else {
            const length = reader.readVarIntNumber();
            reader.skip(length);
          }
      }
    }

    return { role, path, authority, maxAuthTokenCacheSize, authToken };
  }

  // ============================================================================
  // Subscribe Messages
  // ============================================================================

  private static encodeSubscribe(writer: Draft18BufferWriter, message: SubscribeMessageDraft18): void {
    writer.writeVarInt(message.requestId);
    Draft18MessageCodec.encodeNamespace(writer, message.trackNamespace);
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
    const trackNamespace = Draft18MessageCodec.decodeNamespace(reader);
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
    Draft18MessageCodec.encodeNamespace(writer, message.trackNamespace);
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
    const trackNamespace = Draft18MessageCodec.decodeNamespace(reader);
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
      Draft18MessageCodec.encodeNamespace(writer, message.trackNamespace);
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
      trackNamespace = Draft18MessageCodec.decodeNamespace(reader);
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
    Draft18MessageCodec.encodeNamespace(writer, message.trackNamespace);
    Draft18MessageCodec.encodeString(writer, message.trackName);
  }

  private static decodeTrackStatus(reader: Draft18BufferReader): TrackStatusMessageDraft18 {
    const requestId = reader.readVarInt();
    const trackNamespace = Draft18MessageCodec.decodeNamespace(reader);
    const trackName = Draft18MessageCodec.decodeString(reader);

    return {
      type: MessageTypeDraft18.TRACK_STATUS,
      requestId,
      trackNamespace,
      trackName,
    };
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  private static encodeNamespace(writer: Draft18BufferWriter, namespace: TrackNamespace): void {
    writer.writeVarInt(namespace.length);
    for (const field of namespace) {
      const bytes = new TextEncoder().encode(field);
      writer.writeVarInt(bytes.length);
      writer.writeBytes(bytes);
    }
  }

  private static decodeNamespace(reader: Draft18BufferReader): TrackNamespace {
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

  private static encodeSubscriptionFilter(writer: Draft18BufferWriter, message: SubscribeMessageDraft18): void {
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
