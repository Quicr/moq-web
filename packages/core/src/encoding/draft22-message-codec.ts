// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Draft-22 Message Encoding and Decoding
 *
 * Extends draft-18 wire format with draft-22 additions.
 * Delegates to Draft18MessageCodec for all shared message types.
 *
 * Differences from draft-18:
 * - PUBLISH_SKIPPED (0x0F) replaces PUBLISH_BLOCKED with different format
 * - PUBLISH_STATE_NOTIFY (0x22) is a new message type
 * - 0x1E is reserved (draft-18 PUBLISH_OK)
 * - New setup options: MAX_FILTER_RANGES, MAX_REQUEST_UPDATES
 * - Message Parameters (§9.20) are framed by their defined type and only
 *   allowed in the messages that list them; see draft22-parameters.ts
 */

import { MOQTVarInt } from './moqt-varint.js';
import { Draft18BufferWriter, Draft18BufferReader } from './protocol-codec.js';
import { Draft18MessageCodec, Draft18CodecError, CODEC_MALFORMED, type ErrorCodeNormalizers } from './draft18-message-codec.js';
import {
  normalizeRequestErrorCodeDraft22,
  normalizePublishDoneErrorCodeDraft22,
} from './grease.js';
import {
  encodeTrackNamespace,
  decodeTrackNamespace,
  encodeString,
  encodeTrackName,
  decodeTrackName,
  encodeKeyValuePairs,
  DEFAULT_SUBSCRIBER_PRIORITY,
  decodeKeyValuePairsToEnd,
  encodeFramed,
  decodeFramed,
  peekMessageType,
  FRAMING_LENGTH16,
  type ControlFraming,
} from './codec-helpers.js';
import {
  ParameterScopeDraft22,
  PARAMETERS_DRAFT22,
  encodeParameters,
  decodeParameters,
  type ParameterDialect,
  type ParameterSetDraft22,
} from './draft22-parameters.js';
import {
  MessageTypeDraft18,
  MessageTypeDraft22,
  GroupOrder,
  RequestParameterDraft22,
  RequestParameterDraft23,
  type ControlMessageDraft18,
  type ControlMessageDraft22,
  type ClientSetupMessageDraft18,
  type ServerSetupMessageDraft18,
  type SubscribeMessageDraft22,
  type PublishMessageDraft22,
  type RequestUpdateMessageDraft22,
  type TrackStatusMessageDraft22,
  type SubscribeTracksMessageDraft22,
  type PublishSkippedMessageDraft22,
  type PublishStateNotifyMessageDraft22,
  type FetchMessageDraft22,
  type SubscribeOkMessageDraft18,
  type RequestOkMessageDraft18,
  type FetchOkMessageDraft18,
  type Location,
  type PublishNamespaceMessageDraft18,
  type SubscribeNamespaceMessageDraft18,
} from '../messages/types.js';

/** Table 5: 0x1E is reserved in draft-22 (draft-18 PUBLISH_OK) */
const RESERVED_MESSAGE_TYPE = 0x1e;

/** §12: draft-22 error code registries, for the messages delegated to draft-18 */
const DRAFT22_NORMALIZERS: ErrorCodeNormalizers = {
  requestError: normalizeRequestErrorCodeDraft22,
  publishDone: normalizePublishDoneErrorCodeDraft22,
};

/**
 * What a draft from 22 on changes about the shared message bodies: framing,
 * error code registries and the parameter table. Draft-23 passes its own.
 */
export interface WireDialect {
  readonly framing: ControlFraming;
  readonly normalizers: ErrorCodeNormalizers;
  readonly parameters: ParameterDialect;
  /** Draft-23 §2.4.1: a Track Name must hold at least one byte */
  readonly requireTrackName: boolean;
}

export const DIALECT_DRAFT22: WireDialect = {
  framing: FRAMING_LENGTH16,
  normalizers: DRAFT22_NORMALIZERS,
  parameters: PARAMETERS_DRAFT22,
  requireTrackName: false,
};

/** Read a Track Name; draft-23 (§2.4.1) rejects an empty one */
function readTrackName(
  dialect: WireDialect,
  reader: Draft18BufferReader,
  messageType?: MessageTypeDraft18,
  namespace?: string[],
): string {
  const name = decodeTrackName(reader, messageType, namespace);
  if (dialect.requireTrackName && name.length === 0) {
    throw new Draft18CodecError('Track Name is empty (PROTOCOL_VIOLATION)', messageType, CODEC_MALFORMED, 'protocol-violation');
  }

  return name;
}

const S = ParameterScopeDraft22;
const P = RequestParameterDraft22;
const P23 = RequestParameterDraft23;

/**
 * Draft-22 Message Codec
 *
 * For messages shared with draft-18 (the vast majority), delegates directly
 * to Draft18MessageCodec. Only PUBLISH_SKIPPED and PUBLISH_STATE_NOTIFY
 * have different wire formats.
 */
export class Draft22MessageCodec {
  /**
   * Encode a draft-22 control message to bytes.
   * Delegates to Draft18MessageCodec for shared message types.
   */
  static encode(message: ControlMessageDraft22, dialect: WireDialect = DIALECT_DRAFT22): Uint8Array {
    const { framing } = dialect;
    switch (message.type) {
      case MessageTypeDraft22.PUBLISH_SKIPPED:
        return encodeFramed(
          message.type,
          (w) => Draft22MessageCodec.encodePublishSkipped(w, message as PublishSkippedMessageDraft22), framing,
        );
      case MessageTypeDraft22.PUBLISH_STATE_NOTIFY:
        return encodeFramed(
          message.type,
          (w) => Draft22MessageCodec.encodePublishStateNotify(w, message as PublishStateNotifyMessageDraft22, dialect), framing,
        );
      case MessageTypeDraft22.FETCH:
        return encodeFramed(
          message.type,
          (w) => Draft22MessageCodec.encodeFetch(w, message as FetchMessageDraft22, dialect), framing,
        );
      case MessageTypeDraft22.SUBSCRIBE:
        return Draft22MessageCodec.encodeSubscribeDraft22(message as SubscribeMessageDraft22, dialect);
      case MessageTypeDraft22.PUBLISH:
        return encodeFramed(
          message.type,
          (w) => Draft22MessageCodec.encodePublish(w, message as PublishMessageDraft22, dialect), framing,
        );
      case MessageTypeDraft22.REQUEST_UPDATE:
        return encodeFramed(
          message.type,
          (w) => Draft22MessageCodec.encodeRequestUpdate(w, message as RequestUpdateMessageDraft22, dialect), framing,
        );
      case MessageTypeDraft22.TRACK_STATUS:
        return encodeFramed(
          message.type,
          (w) => Draft22MessageCodec.encodeTrackStatus(w, message as TrackStatusMessageDraft22, dialect), framing,
        );
      case MessageTypeDraft22.SUBSCRIBE_TRACKS:
        return encodeFramed(
          message.type,
          (w) => Draft22MessageCodec.encodeSubscribeTracks(w, message as SubscribeTracksMessageDraft22, dialect), framing,
        );
      case MessageTypeDraft18.PUBLISH_NAMESPACE:
        return encodeFramed(
          message.type,
          (w) => Draft22MessageCodec.encodeNamespaceRequest(w, message as PublishNamespaceMessageDraft18, S.PUBLISH_NAMESPACE, dialect), framing,
        );
      case MessageTypeDraft18.SUBSCRIBE_NAMESPACE:
        return encodeFramed(
          message.type,
          (w) => Draft22MessageCodec.encodeNamespaceRequest(w, message as SubscribeNamespaceMessageDraft18, S.SUBSCRIBE_NAMESPACE, dialect), framing,
        );
      case MessageTypeDraft18.SUBSCRIBE_OK:
        return encodeFramed(
          message.type,
          (w) => Draft22MessageCodec.encodeSubscribeOk(w, message as unknown as SubscribeOkMessageDraft18, dialect), framing,
        );
      case MessageTypeDraft18.REQUEST_OK:
        return encodeFramed(
          message.type,
          (w) => Draft22MessageCodec.encodeRequestOk(w, message as unknown as RequestOkMessageDraft18, dialect), framing,
        );
      case MessageTypeDraft18.FETCH_OK:
        return encodeFramed(
          message.type,
          (w) => Draft22MessageCodec.encodeFetchOk(w, message as unknown as FetchOkMessageDraft18, dialect), framing,
        );
      default:
        // All other messages share draft-18 wire format
        return Draft18MessageCodec.encode(message as unknown as ControlMessageDraft18, framing);
    }
  }

  /**
   * Decode a draft-22 control message from bytes.
   * Delegates to Draft18MessageCodec for shared message types.
   * Rejects the reserved message type 0x1E.
   */
  static decode(
    buffer: Uint8Array,
    offset = 0,
    dialect: WireDialect = DIALECT_DRAFT22,
  ): [ControlMessageDraft22, number] {
    const { framing } = dialect;
    // Peek at message type to decide which codec to use
    const typeValue = peekMessageType(buffer, offset);

    switch (typeValue) {
      case RESERVED_MESSAGE_TYPE:
        throw new Draft18CodecError(`Reserved message type 0x${typeValue.toString(16)} (PROTOCOL_VIOLATION)`, undefined, CODEC_MALFORMED, 'unexpected-message');
      case MessageTypeDraft22.PUBLISH_SKIPPED:
        return decodeFramed(buffer, offset, (reader) =>
          Draft22MessageCodec.decodePublishSkipped(reader, dialect), framing,
        );
      case MessageTypeDraft22.PUBLISH_STATE_NOTIFY:
        return decodeFramed(buffer, offset, (reader) =>
          Draft22MessageCodec.decodePublishStateNotify(reader, dialect), framing,
        );
      case MessageTypeDraft22.FETCH:
        return decodeFramed(buffer, offset, (reader) =>
          Draft22MessageCodec.decodeFetch(reader, dialect), framing,
        );
      case MessageTypeDraft22.SUBSCRIBE:
        return decodeFramed(buffer, offset, (reader) =>
          Draft22MessageCodec.decodeSubscribeDraft22(reader, dialect), framing,
        );
      case MessageTypeDraft22.PUBLISH:
        return decodeFramed(buffer, offset, (reader) =>
          Draft22MessageCodec.decodePublish(reader, dialect), framing,
        );
      case MessageTypeDraft22.REQUEST_UPDATE:
        return decodeFramed(buffer, offset, (reader) =>
          Draft22MessageCodec.decodeRequestUpdate(reader, dialect), framing,
        );
      case MessageTypeDraft22.TRACK_STATUS:
        return decodeFramed(buffer, offset, (reader) =>
          Draft22MessageCodec.decodeTrackStatus(reader, dialect), framing,
        );
      case MessageTypeDraft22.SUBSCRIBE_TRACKS:
        return decodeFramed(buffer, offset, (reader) =>
          Draft22MessageCodec.decodeSubscribeTracks(reader, dialect), framing,
        );
      case MessageTypeDraft18.SUBSCRIBE_OK:
        return decodeFramed(buffer, offset, (reader) =>
          Draft22MessageCodec.decodeSubscribeOk(reader, dialect), framing,
        );
      case MessageTypeDraft18.REQUEST_OK:
        return decodeFramed(buffer, offset, (reader) =>
          Draft22MessageCodec.decodeRequestOk(reader, dialect), framing,
        );
      case MessageTypeDraft18.FETCH_OK:
        return decodeFramed(buffer, offset, (reader) =>
          Draft22MessageCodec.decodeFetchOk(reader, dialect), framing,
        );
      case MessageTypeDraft22.PUBLISH_NAMESPACE:
        return decodeFramed(buffer, offset, (reader) =>
          Draft22MessageCodec.decodePublishNamespace(reader, dialect), framing,
        );
      case MessageTypeDraft22.SUBSCRIBE_NAMESPACE:
        return decodeFramed(buffer, offset, (reader) =>
          Draft22MessageCodec.decodeSubscribeNamespace(reader, dialect), framing,
        );
      case MessageTypeDraft18.GOAWAY:
        return decodeFramed(buffer, offset, (reader) =>
          Draft18MessageCodec.decodeGoAway(reader, false) as unknown as ControlMessageDraft22, framing,
        );
      default: {
        // Delegate to draft-18 for all shared messages
        const [msg, bytesRead] = Draft18MessageCodec.decode(buffer, offset, dialect.normalizers, framing);
        return [msg as unknown as ControlMessageDraft22, bytesRead];
      }
    }
  }

  /**
   * Setup stream encoding/decoding - identical to draft-18
   */
  static encodeSetupStream(message: ClientSetupMessageDraft18, dialect: WireDialect = DIALECT_DRAFT22): Uint8Array {
    return Draft18MessageCodec.encodeSetupStream(message, dialect.framing);
  }

  static decodeSetupStream(
    buffer: Uint8Array,
    offset = 0,
    dialect: WireDialect = DIALECT_DRAFT22,
  ): [ServerSetupMessageDraft18, number] {
    return Draft18MessageCodec.decodeSetupStream(buffer, offset, dialect.framing);
  }

  // encodeFramed / decodeFramed — imported from codec-helpers.ts

  // ============================================================================
  // PUBLISH_SKIPPED (0x0F) - Draft-22 replaces PUBLISH_BLOCKED
  // ============================================================================

  private static encodePublishSkipped(writer: Draft18BufferWriter, message: PublishSkippedMessageDraft22): void {
    // Track Namespace Suffix | Track Name Length | Track Name
    encodeTrackNamespace(writer, message.trackNamespaceSuffix);
    encodeString(writer, message.trackName);
  }

  private static decodePublishSkipped(reader: Draft18BufferReader, dialect: WireDialect): PublishSkippedMessageDraft22 {
    const trackNamespaceSuffix = decodeTrackNamespace(reader);
    const trackName = readTrackName(dialect, reader);

    return {
      type: MessageTypeDraft22.PUBLISH_SKIPPED,
      trackNamespaceSuffix,
      trackName,
    };
  }

  // ============================================================================
  // PUBLISH_STATE_NOTIFY (0x22) - New in draft-22
  // ============================================================================

  private static encodePublishStateNotify(writer: Draft18BufferWriter, message: PublishStateNotifyMessageDraft22, dialect: WireDialect): void {
    // Number of Parameters (vi64) | Parameters (..)
    encodeParameters(writer, S.PUBLISH_STATE_NOTIFY, message, dialect.parameters);
  }

  private static decodePublishStateNotify(reader: Draft18BufferReader, dialect: WireDialect): PublishStateNotifyMessageDraft22 {
    const { forwardState, largestLocation, locationFilter } = decodeParameters(reader, S.PUBLISH_STATE_NOTIFY, dialect.parameters);

    return {
      type: MessageTypeDraft22.PUBLISH_STATE_NOTIFY,
      forwardState,
      largestLocation,
      locationFilter,
    };
  }

  // ============================================================================
  // SUBSCRIBE (0x03) - Draft-22 §9.6
  // ============================================================================

  private static decodeSubscribeDraft22(reader: Draft18BufferReader, dialect: WireDialect): SubscribeMessageDraft22 {
    const requestId = reader.readVarInt();
    const trackNamespace = decodeTrackNamespace(reader);
    const trackName = readTrackName(dialect, reader, undefined, trackNamespace);
    const params = decodeParameters(reader, S.SUBSCRIBE, dialect.parameters);

    return {
      type: MessageTypeDraft22.SUBSCRIBE,
      requestId,
      trackNamespace,
      trackName,
      // §9.20.18: FORWARD defaults to 1 when omitted
      forwardState: params.forwardState ?? true,
      locationFilter: params.locationFilter,
      fill: params.fill,
      rangeFilters: params.rangeFilters,
      authTokens: params.authTokens,
      parameters: params.parameters,
    };
  }

  /**
   * Encode SUBSCRIBE with draft-22 parameters.
   */
  static encodeSubscribeDraft22(message: SubscribeMessageDraft22, dialect: WireDialect = DIALECT_DRAFT22): Uint8Array {
    const { framing } = dialect;
    return encodeFramed(MessageTypeDraft22.SUBSCRIBE, (w) => {
      w.writeVarInt(message.requestId);
      encodeTrackNamespace(w, message.trackNamespace);
      encodeTrackName(w, message.trackName, message.trackNamespace);

      // FORWARD is always sent (forwardState is not optional here); the
      // omitted default (1) would unpause
      encodeParameters(w, S.SUBSCRIBE, message, dialect.parameters);
    }, framing);
  }

  // ============================================================================
  // FETCH (0x16) - Draft-22 §9.11: range carried in LOCATION_FILTER
  // ============================================================================

  private static encodeFetch(writer: Draft18BufferWriter, message: FetchMessageDraft22, dialect: WireDialect): void {
    writer.writeVarInt(message.requestId);
    encodeTrackNamespace(writer, message.trackNamespace);
    encodeTrackName(writer, message.trackName, message.trackNamespace);

    const parameters = new Map(message.parameters);
    parameters.set(P.SUBSCRIBER_PRIORITY, new Uint8Array([message.subscriberPriority]));
    parameters.set(P.GROUP_ORDER, new Uint8Array([message.groupOrder]));
    if (message.fillTimeoutMs !== undefined) {
      parameters.set(P.FILL_TIMEOUT, MOQTVarInt.encode(message.fillTimeoutMs));
    }

    encodeParameters(writer, S.FETCH, {
      locationFilter: message.locationFilter,
      rangeFilters: message.rangeFilters,
      authTokens: message.authTokens,
      parameters,
    }, dialect.parameters);
  }

  private static decodeFetch(reader: Draft18BufferReader, dialect: WireDialect): FetchMessageDraft22 {
    const requestId = reader.readVarInt();
    const trackNamespace = decodeTrackNamespace(reader, MessageTypeDraft18.FETCH);
    const trackName = readTrackName(dialect, reader, MessageTypeDraft18.FETCH, trackNamespace);
    const params = decodeParameters(reader, S.FETCH, dialect.parameters);

    // Parameters FETCH carries as fields; the rest stay in `parameters`
    const rest = params.parameters ?? new Map<number, Uint8Array>();
    const priority = Draft22MessageCodec.takeParameter(rest, P.SUBSCRIBER_PRIORITY);
    const order = Draft22MessageCodec.takeParameter(rest, P.GROUP_ORDER);
    const fillTimeout = Draft22MessageCodec.takeParameter(rest, P.FILL_TIMEOUT);

    return {
      type: MessageTypeDraft22.FETCH,
      requestId,
      trackNamespace,
      trackName,
      // §9.20: omitted SUBSCRIBER_PRIORITY is 128, omitted GROUP_ORDER is ascending
      subscriberPriority: priority ? priority[0] : DEFAULT_SUBSCRIBER_PRIORITY,
      groupOrder: order ? order[0] : GroupOrder.ASCENDING,
      locationFilter: params.locationFilter,
      rangeFilters: params.rangeFilters,
      fillTimeoutMs: fillTimeout ? MOQTVarInt.decode(fillTimeout)[0] : undefined,
      authTokens: params.authTokens,
      parameters: rest.size > 0 ? rest : undefined,
    };
  }

  private static takeParameter(parameters: Map<number, Uint8Array>, type: number): Uint8Array | undefined {
    const value = parameters.get(type);
    parameters.delete(type);
    return value;
  }

  // ============================================================================
  // PUBLISH (0x1D) - Draft-22 §9.8
  // ============================================================================

  private static encodePublish(writer: Draft18BufferWriter, message: PublishMessageDraft22, dialect: WireDialect): void {
    // Request ID | Track Namespace | Track Name | Track Alias | Parameters | Track Properties
    writer.writeVarInt(message.requestId);
    encodeTrackNamespace(writer, message.trackNamespace);
    encodeTrackName(writer, message.trackName, message.trackNamespace);
    writer.writeVarInt(message.trackAlias);
    encodeParameters(writer, S.PUBLISH, Draft22MessageCodec.publishParameters(message), dialect.parameters);

    // Track Properties (KVPs to end)
    if (message.trackProperties) {
      encodeKeyValuePairs(writer, message.trackProperties);
    }
  }

  private static decodePublish(reader: Draft18BufferReader, dialect: WireDialect): PublishMessageDraft22 {
    const requestId = reader.readVarInt();
    const trackNamespace = decodeTrackNamespace(reader, MessageTypeDraft18.PUBLISH);
    const trackName = readTrackName(dialect, reader, MessageTypeDraft18.PUBLISH, trackNamespace);
    const trackAlias = reader.readVarInt();
    const params = decodeParameters(reader, S.PUBLISH, dialect.parameters);
    const trackProperties = reader.hasMore ? decodeKeyValuePairsToEnd(reader) : undefined;
    const rest = params.parameters;
    const subscribeTracksId = rest && Draft22MessageCodec.takeParameter(rest, P23.SUBSCRIBE_TRACKS_ID);

    return {
      type: MessageTypeDraft22.PUBLISH,
      requestId,
      trackAlias,
      trackNamespace,
      trackName,
      // §9.20.18: FORWARD defaults to 1 when omitted
      forwardState: params.forwardState ?? true,
      largestLocation: params.largestLocation,
      locationFilter: params.locationFilter,
      fill: params.fill,
      subscribeTracksId: subscribeTracksId ? MOQTVarInt.decode(subscribeTracksId)[0] : undefined,
      authTokens: params.authTokens,
      parameters: rest?.size ? rest : undefined,
      trackProperties: trackProperties?.size ? trackProperties : undefined,
    };
  }

  /** A PUBLISH's parameter block: SUBSCRIBE_TRACKS_ID (draft-23) is a typed field, sent raw */
  private static publishParameters(message: PublishMessageDraft22): ParameterSetDraft22 {
    if (message.subscribeTracksId === undefined) {
      return message;
    }
    const parameters = new Map(message.parameters);
    parameters.set(P23.SUBSCRIBE_TRACKS_ID, MOQTVarInt.encode(message.subscribeTracksId));

    return { ...message, parameters };
  }

  // ============================================================================
  // REQUEST_UPDATE (0x02) - Draft-22 §9.5
  // ============================================================================

  private static encodeRequestUpdate(writer: Draft18BufferWriter, message: RequestUpdateMessageDraft22, dialect: WireDialect): void {
    writer.writeVarInt(message.requestId);
    encodeParameters(writer, S.REQUEST_UPDATE, message, dialect.parameters);
  }

  private static decodeRequestUpdate(reader: Draft18BufferReader, dialect: WireDialect): RequestUpdateMessageDraft22 {
    const requestId = reader.readVarInt();
    const params = decodeParameters(reader, S.REQUEST_UPDATE, dialect.parameters);

    return {
      type: MessageTypeDraft22.REQUEST_UPDATE,
      requestId,
      // §9.20.18: omitted means the request's FORWARD is unchanged
      forwardState: params.forwardState,
      locationFilter: params.locationFilter,
      fill: params.fill,
      rangeFilters: params.rangeFilters,
      authTokens: params.authTokens,
      parameters: params.parameters,
    };
  }

  // ============================================================================
  // TRACK_STATUS (0x0D) - Draft-22 §9.13
  // ============================================================================

  private static encodeTrackStatus(writer: Draft18BufferWriter, message: TrackStatusMessageDraft22, dialect: WireDialect): void {
    writer.writeVarInt(message.requestId);
    encodeTrackNamespace(writer, message.trackNamespace);
    encodeTrackName(writer, message.trackName, message.trackNamespace);
    encodeParameters(writer, S.TRACK_STATUS, message, dialect.parameters);
  }

  private static decodeTrackStatus(reader: Draft18BufferReader, dialect: WireDialect): TrackStatusMessageDraft22 {
    const requestId = reader.readVarInt();
    const trackNamespace = decodeTrackNamespace(reader, MessageTypeDraft18.TRACK_STATUS);
    const trackName = readTrackName(dialect, reader, MessageTypeDraft18.TRACK_STATUS, trackNamespace);
    const params = decodeParameters(reader, S.TRACK_STATUS, dialect.parameters);

    return {
      type: MessageTypeDraft22.TRACK_STATUS,
      requestId,
      trackNamespace,
      trackName,
      authTokens: params.authTokens,
      parameters: params.parameters,
    };
  }

  // ============================================================================
  // SUBSCRIBE_TRACKS (0x51) - Draft-22 §9.18
  // ============================================================================

  private static encodeSubscribeTracks(writer: Draft18BufferWriter, message: SubscribeTracksMessageDraft22, dialect: WireDialect): void {
    // Request ID | Track Namespace Prefix | Parameters
    writer.writeVarInt(message.requestId);
    encodeTrackNamespace(writer, message.trackNamespacePrefix);
    encodeParameters(writer, S.SUBSCRIBE_TRACKS, message, dialect.parameters);
  }

  private static decodeSubscribeTracks(reader: Draft18BufferReader, dialect: WireDialect): SubscribeTracksMessageDraft22 {
    const requestId = reader.readVarInt();
    const trackNamespacePrefix = decodeTrackNamespace(reader, MessageTypeDraft18.SUBSCRIBE_TRACKS);
    const params = decodeParameters(reader, S.SUBSCRIBE_TRACKS, dialect.parameters);

    return {
      type: MessageTypeDraft22.SUBSCRIBE_TRACKS,
      requestId,
      trackNamespacePrefix,
      // §9.20.18: FORWARD defaults to 1 when omitted
      forwardState: params.forwardState ?? true,
      locationFilter: params.locationFilter,
      fill: params.fill,
      rangeFilters: params.rangeFilters,
      authTokens: params.authTokens,
      parameters: params.parameters,
    };
  }

  // ============================================================================
  // SUBSCRIBE_OK / REQUEST_OK / FETCH_OK - Draft-22 §9.7, §9.3, §9.12
  // ============================================================================

  // Fields are the draft-18 ones: EXPIRES and LARGEST_OBJECT are all these
  // messages can carry.

  private static okParameters(message: { expires?: bigint; largestLocation?: Location }): ParameterSetDraft22 {
    return {
      largestLocation: message.largestLocation,
      parameters: message.expires === undefined
        ? undefined
        : new Map([[P.EXPIRES, MOQTVarInt.encode(message.expires)]]),
    };
  }

  private static decodeExpires(params: ParameterSetDraft22): bigint | undefined {
    const expires = params.parameters?.get(P.EXPIRES);
    return expires ? MOQTVarInt.decode(expires)[0] : undefined;
  }

  private static encodeSubscribeOk(writer: Draft18BufferWriter, message: SubscribeOkMessageDraft18, dialect: WireDialect): void {
    // Track Alias | Parameters | Track Properties (..)
    writer.writeVarInt(message.trackAlias ?? 0n);

    // §9.20.17: LARGEST_OBJECT is omitted until Objects have been published
    encodeParameters(writer, S.SUBSCRIBE_OK, Draft22MessageCodec.okParameters(message), dialect.parameters);

    if (message.trackProperties) {
      encodeKeyValuePairs(writer, message.trackProperties);
    }
  }

  private static decodeSubscribeOk(reader: Draft18BufferReader, dialect: WireDialect): SubscribeOkMessageDraft18 {
    const trackAlias = reader.readVarInt();
    const params = decodeParameters(reader, S.SUBSCRIBE_OK, dialect.parameters);
    const trackProperties = reader.hasMore ? decodeKeyValuePairsToEnd(reader) : undefined;

    return {
      type: MessageTypeDraft18.SUBSCRIBE_OK,
      requestId: trackAlias,
      trackAlias,
      largestLocation: params.largestLocation,
      expires: Draft22MessageCodec.decodeExpires(params),
      trackProperties: trackProperties?.size ? trackProperties : undefined,
    };
  }

  private static encodeRequestOk(writer: Draft18BufferWriter, message: RequestOkMessageDraft18, dialect: WireDialect): void {
    // Parameters | Track Properties (..)
    encodeParameters(writer, S.REQUEST_OK, Draft22MessageCodec.okParameters(message), dialect.parameters);

    if (message.trackProperties) {
      encodeKeyValuePairs(writer, message.trackProperties);
    }
  }

  private static decodeRequestOk(reader: Draft18BufferReader, dialect: WireDialect): RequestOkMessageDraft18 {
    const params = decodeParameters(reader, S.REQUEST_OK, dialect.parameters);
    const trackProperties = reader.hasMore ? decodeKeyValuePairsToEnd(reader) : undefined;

    return {
      type: MessageTypeDraft18.REQUEST_OK,
      requestId: 0n,
      expires: Draft22MessageCodec.decodeExpires(params),
      largestLocation: params.largestLocation,
      trackProperties: trackProperties?.size ? trackProperties : undefined,
    };
  }

  private static encodeFetchOk(writer: Draft18BufferWriter, message: FetchOkMessageDraft18, dialect: WireDialect): void {
    // End Of Track | End Location | Parameters | Track Properties (..)
    writer.writeByte(message.endOfTrack ? 1 : 0);
    writer.writeVarInt(message.endLocation.group);
    writer.writeVarInt(message.endLocation.object);
    encodeParameters(writer, S.FETCH_OK, {}, dialect.parameters);

    if (message.trackProperties) {
      encodeKeyValuePairs(writer, message.trackProperties);
    }
  }

  private static decodeFetchOk(reader: Draft18BufferReader, dialect: WireDialect): FetchOkMessageDraft18 {
    const endOfTrackByte = reader.readByte();
    if (endOfTrackByte > 1) {
      throw new Draft18CodecError(`Invalid End Of Track ${endOfTrackByte} (PROTOCOL_VIOLATION)`);
    }
    const endOfTrack = endOfTrackByte === 1;
    const endLocation = { group: reader.readVarInt(), object: reader.readVarInt() };
    decodeParameters(reader, S.FETCH_OK, dialect.parameters);
    const trackProperties = reader.hasMore ? decodeKeyValuePairsToEnd(reader) : undefined;

    return {
      type: MessageTypeDraft18.FETCH_OK,
      requestId: 0n,
      endOfTrack,
      endLocation,
      trackProperties: trackProperties?.size ? trackProperties : undefined,
    };
  }

  // ============================================================================
  // PUBLISH_NAMESPACE / SUBSCRIBE_NAMESPACE - Draft-22 §9.14, §9.15
  // ============================================================================

  // Only AUTHORIZATION_TOKEN is allowed; the receiver applies the Token rules of §8.9.

  private static encodeNamespaceRequest(
    writer: Draft18BufferWriter,
    message: PublishNamespaceMessageDraft18 | SubscribeNamespaceMessageDraft18,
    scope: typeof S.PUBLISH_NAMESPACE | typeof S.SUBSCRIBE_NAMESPACE,
    dialect: WireDialect,
  ): void {
    // Request ID | Track Namespace Prefix | Parameters
    writer.writeVarInt(message.requestId);
    encodeTrackNamespace(writer, message.trackNamespacePrefix);
    encodeParameters(writer, scope, { authTokens: message.authTokens }, dialect.parameters);
  }

  private static decodePublishNamespace(reader: Draft18BufferReader, dialect: WireDialect): PublishNamespaceMessageDraft18 {
    const requestId = reader.readVarInt();
    const trackNamespacePrefix = decodeTrackNamespace(reader, MessageTypeDraft18.PUBLISH_NAMESPACE);
    const { authTokens } = decodeParameters(reader, S.PUBLISH_NAMESPACE, dialect.parameters);

    return { type: MessageTypeDraft18.PUBLISH_NAMESPACE, requestId, trackNamespacePrefix, authTokens };
  }

  private static decodeSubscribeNamespace(reader: Draft18BufferReader, dialect: WireDialect): SubscribeNamespaceMessageDraft18 {
    const requestId = reader.readVarInt();
    const trackNamespacePrefix = decodeTrackNamespace(reader, MessageTypeDraft18.SUBSCRIBE_NAMESPACE);
    const { authTokens } = decodeParameters(reader, S.SUBSCRIBE_NAMESPACE, dialect.parameters);

    return { type: MessageTypeDraft18.SUBSCRIBE_NAMESPACE, requestId, trackNamespacePrefix, authTokens };
  }

  // encodeTrackNamespace, decodeTrackNamespace, encodeString, decodeTrackName
  // — imported from codec-helpers.ts
}
