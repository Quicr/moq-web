// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Draft-18 Message Encoding and Decoding
 *
 * Implements wire format encoding/decoding for MOQT draft-18 control messages.
 * Uses MOQT varints (leading 1-bits) instead of QUIC varints.
 */

import { Logger } from '../utils/logger.js';
import { MOQTVarInt, MOQT_VARINT_MAX } from './moqt-varint.js';
import { Draft18BufferWriter, Draft18BufferReader } from './protocol-codec.js';
import {
  normalizePublishDoneErrorCode,
  normalizeRequestErrorCode,
} from './grease.js';
import {
  assertBound,
  assertControlLength,
  encodeTrackNamespace,
  decodeTrackNamespace,
  encodeString,
  encodeTrackName,
  decodeString,
  encodeReasonPhrase,
  decodeReasonPhrase,
  decodeTrackName,
  encodeKeyValuePairs,
  decodeDraft18AuthToken,
  decodeKeyValuePairsToEnd,
  DEFAULT_SUBSCRIBER_PRIORITY,
  MAX_SAFE_KEY,
  readKvpKey,
  readKvpLength,
  readVarIntSaturating,
  skipKvpValue,
  encodeFramed,
  decodeFramed,
  peekMessageType,
  MAX_PARAMETER_COUNT,
  MAX_GOAWAY_URI_LENGTH,
  MAX_STRING_LENGTH,
  MAX_AUTH_TOKEN_LENGTH,
} from './codec-helpers.js';
import {
  MessageTypeDraft18,
  Version,
  GroupOrder,
  SubscriptionFilterDraft18,
  SetupOptionDraft18,
  RequestParameterDraft18,
  RequestErrorCodeDraft18,
  FetchTypeDraft18,
  type ControlMessageDraft18,
  type ClientSetupMessageDraft18,
  type ServerSetupMessageDraft18,
  type SubscribeMessageDraft18,
  type SubscribeOkMessageDraft18,
  type PublishMessageDraft18,
  type PublishDoneMessageDraft18,
  type RequestErrorMessageDraft18,
  type RequestErrorRedirectDraft18,
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
  type SetupExtensionValue,
} from '../messages/types.js';

const log = Logger.create('moqt:core:draft18-codec');

// Module-level singletons — TextEncoder/TextDecoder are safe to reuse and
// allocating per-call showed up as measurable overhead on the encode/decode
// hot path.
const TE = new TextEncoder();
const TD = new TextDecoder();

/** `Draft18CodecError.code` for a message that has not fully arrived yet. */
export const CODEC_INCOMPLETE = 'incomplete';

/** `Draft18CodecError.code` for a message whose body disagrees with its Length (§9). */
export const CODEC_MALFORMED = 'malformed';

/**
 * True when `err` only says more bytes are needed. Every other decode error
 * is a violation of the peer's framing or syntax.
 */
export function isIncompleteDecode(err: unknown): boolean {
  return err instanceof Draft18CodecError && err.code === CODEC_INCOMPLETE;
}

export class Draft18CodecError extends Error {
  messageType?: MessageTypeDraft18;
  /**
   * Machine-readable error tag. Set to `'bounds-exceeded'` when a decoded
   * length or count exceeds a codec safety bound (B1 SEC). Callers may key on
   * this to distinguish untrusted-peer DoS attempts from other decode failures
   * and to terminate the session with PROTOCOL_VIOLATION.
   */
  code?: string;

  constructor(message: string, messageType?: MessageTypeDraft18, code?: string) {
    super(message);
    this.name = 'Draft18CodecError';
    this.messageType = messageType;
    this.code = code;
  }
}

/**
 * Maps raw wire error codes onto a draft's registry (§14 grease: unknown
 * codes become INTERNAL_ERROR). Draft-22 supplies its own registry.
 */
export interface ErrorCodeNormalizers {
  requestError: (code: number) => number;
  publishDone: (code: number) => number;
}

const DRAFT18_NORMALIZERS: ErrorCodeNormalizers = {
  requestError: normalizeRequestErrorCode,
  publishDone: normalizePublishDoneErrorCode,
};

const P18 = RequestParameterDraft18;

/**
 * §10.2.2-10.2.14: the Message Parameters each message may carry. REQUEST_OK
 * is the union over the replies that use it (PUBLISH_OK, REQUEST_UPDATE_OK,
 * TRACK_STATUS_OK, ...).
 */
const PARAMETER_SCOPES: ReadonlyMap<MessageTypeDraft18, ReadonlySet<number>> = new Map([
  [MessageTypeDraft18.SUBSCRIBE, new Set([
    P18.AUTHORIZATION_TOKEN, P18.OBJECT_DELIVERY_TIMEOUT, P18.SUBGROUP_DELIVERY_TIMEOUT, P18.RENDEZVOUS_TIMEOUT,
    P18.FORWARD, P18.SUBSCRIBER_PRIORITY, P18.SUBSCRIPTION_FILTER, P18.GROUP_ORDER, P18.NEW_GROUP_REQUEST,
  ])],
  [MessageTypeDraft18.SUBSCRIBE_OK, new Set([P18.EXPIRES, P18.LARGEST_OBJECT])],
  [MessageTypeDraft18.PUBLISH, new Set([P18.AUTHORIZATION_TOKEN, P18.EXPIRES, P18.LARGEST_OBJECT, P18.FORWARD])],
  [MessageTypeDraft18.REQUEST_OK, new Set([
    P18.OBJECT_DELIVERY_TIMEOUT, P18.SUBGROUP_DELIVERY_TIMEOUT, P18.EXPIRES, P18.LARGEST_OBJECT, P18.FORWARD,
    P18.SUBSCRIBER_PRIORITY, P18.SUBSCRIPTION_FILTER, P18.GROUP_ORDER, P18.NEW_GROUP_REQUEST,
  ])],
  [MessageTypeDraft18.FETCH, new Set([
    P18.AUTHORIZATION_TOKEN, P18.FILL_TIMEOUT, P18.SUBSCRIBER_PRIORITY, P18.GROUP_ORDER,
  ])],
  [MessageTypeDraft18.FETCH_OK, new Set<number>()],
  [MessageTypeDraft18.TRACK_STATUS, new Set([P18.AUTHORIZATION_TOKEN])],
  [MessageTypeDraft18.REQUEST_UPDATE, new Set([
    P18.AUTHORIZATION_TOKEN, P18.OBJECT_DELIVERY_TIMEOUT, P18.SUBGROUP_DELIVERY_TIMEOUT, P18.FORWARD,
    P18.SUBSCRIBER_PRIORITY, P18.SUBSCRIPTION_FILTER, P18.NEW_GROUP_REQUEST, P18.TRACK_NAMESPACE_PREFIX,
  ])],
  [MessageTypeDraft18.PUBLISH_NAMESPACE, new Set([P18.AUTHORIZATION_TOKEN])],
  [MessageTypeDraft18.SUBSCRIBE_NAMESPACE, new Set([P18.AUTHORIZATION_TOKEN])],
  [MessageTypeDraft18.SUBSCRIBE_TRACKS, new Set([P18.AUTHORIZATION_TOKEN, P18.FORWARD])],
]);

/** §10.2.8 / §10.2.12: uint8 parameters with a restricted range */
const UINT8_RANGES: ReadonlyMap<number, readonly [min: number, max: number]> = new Map([
  [P18.FORWARD, [0, 1]],
  [P18.GROUP_ORDER, [GroupOrder.ASCENDING, GroupOrder.DESCENDING]],
]);

// Re-export bounds constants for backward compatibility (consumers may import from here)
export { MAX_PARAMETER_COUNT, MAX_STRING_LENGTH, MAX_NAMESPACE_TUPLE_COUNT, MAX_TRACK_NAME_LENGTH, MAX_AUTH_TOKEN_LENGTH } from './codec-helpers.js';

/**
 * Draft-18 Message Codec
 */
export class Draft18MessageCodec {
  /**
   * Encode a draft-18 control message to bytes
   */
  static encode(message: ControlMessageDraft18): Uint8Array {
    log.debug('Encoding draft-18 message', { type: MessageTypeDraft18[message.type] });

    return encodeFramed(message.type, (payloadWriter) => {
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
    });
  }

  /**
   * Decode a draft-18 control message from bytes
   */
  static decode(
    buffer: Uint8Array,
    offset = 0,
    normalizers: ErrorCodeNormalizers = DRAFT18_NORMALIZERS,
  ): [ControlMessageDraft18, number] {
    // Peek at message type for logging before delegating to decodeFramed
    const typeValue = peekMessageType(buffer, offset);
    const messageType = typeValue as MessageTypeDraft18;

    return decodeFramed<ControlMessageDraft18>(buffer, offset, (reader) => {
      log.trace('Decoding draft-18 message', { type: MessageTypeDraft18[messageType] ?? messageType });

      switch (messageType) {
        case MessageTypeDraft18.SETUP:
          return Draft18MessageCodec.decodeSetup(reader, reader.remaining);
        case MessageTypeDraft18.SUBSCRIBE:
          return Draft18MessageCodec.decodeSubscribe(reader);
        case MessageTypeDraft18.SUBSCRIBE_OK:
          return Draft18MessageCodec.decodeSubscribeOk(reader);
        case MessageTypeDraft18.PUBLISH:
          return Draft18MessageCodec.decodePublish(reader);
        case MessageTypeDraft18.REQUEST_ERROR:
          return Draft18MessageCodec.decodeRequestError(reader, normalizers);
        case MessageTypeDraft18.REQUEST_OK:
        case MessageTypeDraft18.PUBLISH_OK: {
          const msg = Draft18MessageCodec.decodeRequestOk(reader);
          (msg as RequestOkMessageDraft18).type = messageType as MessageTypeDraft18.REQUEST_OK;
          return msg;
        }
        case MessageTypeDraft18.FETCH:
          return Draft18MessageCodec.decodeFetch(reader);
        case MessageTypeDraft18.FETCH_OK:
          return Draft18MessageCodec.decodeFetchOk(reader);
        case MessageTypeDraft18.GOAWAY:
          return Draft18MessageCodec.decodeGoAway(reader);
        case MessageTypeDraft18.TRACK_STATUS:
          return Draft18MessageCodec.decodeTrackStatus(reader);
        case MessageTypeDraft18.PUBLISH_DONE:
          return Draft18MessageCodec.decodePublishDone(reader, normalizers);
        case MessageTypeDraft18.REQUEST_UPDATE:
          return Draft18MessageCodec.decodeRequestUpdate(reader);
        case MessageTypeDraft18.PUBLISH_NAMESPACE:
          return Draft18MessageCodec.decodePublishNamespace(reader);
        case MessageTypeDraft18.SUBSCRIBE_NAMESPACE:
          return Draft18MessageCodec.decodeSubscribeNamespace(reader);
        case MessageTypeDraft18.NAMESPACE:
          return Draft18MessageCodec.decodeNamespaceMessage(reader);
        case MessageTypeDraft18.NAMESPACE_DONE:
          return Draft18MessageCodec.decodeNamespaceDone(reader);
        case MessageTypeDraft18.SUBSCRIBE_TRACKS:
          return Draft18MessageCodec.decodeSubscribeTracks(reader);
        case MessageTypeDraft18.PUBLISH_BLOCKED:
          return Draft18MessageCodec.decodePublishBlocked(reader);
        default:
          throw new Draft18CodecError(`Unknown message type: ${messageType}`, messageType);
      }
    });
  }

  /**
   * Decode a SETUP message from the setup stream.
   * On the setup stream, the message type is implicit (stream type = 0x2F00),
   * so the wire format is just: Length (16-bit BE) | Setup Options
   */
  static decodeSetupStream(buffer: Uint8Array, offset = 0): [ServerSetupMessageDraft18, number] {
    if (buffer.length < offset + 2) {
      throw new Draft18CodecError('Incomplete setup message: missing length field', undefined, CODEC_INCOMPLETE);
    }
    const payloadLength = (buffer[offset] << 8) | buffer[offset + 1];
    if (buffer.length < offset + 2 + payloadLength) {
      throw new Draft18CodecError('Incomplete setup message: not enough payload bytes', undefined, CODEC_INCOMPLETE);
    }
    const reader = new Draft18BufferReader(buffer.subarray(offset + 2, offset + 2 + payloadLength));
    let message: ServerSetupMessageDraft18;
    try {
      message = Draft18MessageCodec.decodeSetup(reader, payloadLength);
    } catch (err) {
      if (err instanceof Draft18CodecError) {
        throw err;
      }
      throw new Draft18CodecError(
        `SETUP body shorter than its options: ${(err as Error).message} (PROTOCOL_VIOLATION)`,
        undefined,
        CODEC_MALFORMED,
      );
    }
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
    assertControlLength(payload.length);
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
          const bytes = TE.encode(message.path!);
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
          const bytes = TE.encode(message.authority!);
          w.writeVarInt(BigInt(bytes.length));
          w.writeBytes(bytes);
        },
      });
    }
    if (message.moqtImplementation !== undefined) {
      options.push({
        key: SetupOptionDraft18.MOQT_IMPLEMENTATION,
        encode: (w) => {
          const bytes = TE.encode(message.moqtImplementation!);
          w.writeVarInt(BigInt(bytes.length));
          w.writeBytes(bytes);
        },
      });
    }
    if (message.maxFilterRanges !== undefined) {
      options.push({
        key: 0x06, // MAX_FILTER_RANGES
        encode: (w) => {
          w.writeVarInt(BigInt(message.maxFilterRanges!));
        },
      });
    }
    if (message.maxRequestUpdates !== undefined) {
      options.push({
        key: 0x08, // MAX_REQUEST_UPDATES
        encode: (w) => {
          w.writeVarInt(BigInt(message.maxRequestUpdates!));
        },
      });
    }
    // §3.2 application extensions. Reject collisions with known SetupOptions
    // so callers don't accidentally overwrite a codec-managed field.
    if (message.extensions) {
      const reserved = new Set<number>([
        SetupOptionDraft18.PATH,
        SetupOptionDraft18.AUTHORIZATION_TOKEN,
        SetupOptionDraft18.MAX_AUTH_TOKEN_CACHE_SIZE,
        SetupOptionDraft18.AUTHORITY,
        SetupOptionDraft18.MOQT_IMPLEMENTATION,
        0x06, // MAX_FILTER_RANGES (draft-22)
        0x08, // MAX_REQUEST_UPDATES (draft-22)
      ]);
      for (const [key, value] of message.extensions) {
        if (reserved.has(key)) {
          throw new Error(`SETUP extension key 0x${key.toString(16)} collides with a reserved SetupOption`);
        }
        const isVarint = 'varint' in value;
        const parityIsEven = key % 2 === 0;
        if (isVarint !== parityIsEven) {
          throw new Error(
            `SETUP extension key 0x${key.toString(16)} parity mismatch: ` +
            `even keys carry varints, odd keys carry length-prefixed bytes`,
          );
        }
        options.push({
          key,
          encode: (w) => {
            if ('varint' in value) {
              w.writeVarInt(value.varint);
            } else {
              w.writeVarInt(BigInt(value.bytes.length));
              w.writeBytes(value.bytes);
            }
          },
        });
      }
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
    let authToken: Uint8Array | undefined;
    let moqtImplementation: string | undefined;
    let maxFilterRanges: number | undefined;
    let maxRequestUpdates: number | undefined;
    // §3.2: retain unknown KVPs so callers can inspect peer-advertised
    // extensions (e.g. custom auth schemes, feature flags). Even keys carry
    // a varint value; odd keys carry length-prefixed bytes.
    let extensions: Map<number, SetupExtensionValue> | undefined;
    let previousKey = 0n;

    while (reader.offset < endOffset) {
      const bigKey = readKvpKey(reader, previousKey);
      previousKey = bigKey;

      // §13: grease codepoints above 2^53 are unknown options; skip them.
      if (bigKey > MAX_SAFE_KEY) {
        skipKvpValue(reader, bigKey);
        continue;
      }

      const key = Number(bigKey);
      switch (key) {
        case SetupOptionDraft18.PATH: {
          const length = reader.readVarIntNumber();
          assertBound(length, MAX_STRING_LENGTH, 'SETUP PATH length', MessageTypeDraft18.SETUP);
          path = TD.decode(reader.readBytes(length));
          break;
        }
        case SetupOptionDraft18.MAX_AUTH_TOKEN_CACHE_SIZE:
          maxAuthTokenCacheSize = readVarIntSaturating(reader);
          break;
        case SetupOptionDraft18.AUTHORIZATION_TOKEN: {
          const length = reader.readVarIntNumber();
          assertBound(length, MAX_AUTH_TOKEN_LENGTH, 'SETUP AUTHORIZATION_TOKEN length', MessageTypeDraft18.SETUP);
          // Copy so callers can hold onto the token past the decode buffer's
          // lifetime; downstream code decodes via decodeDraft18AuthToken.
          authToken = new Uint8Array(reader.readBytes(length));
          break;
        }
        case SetupOptionDraft18.AUTHORITY: {
          const length = reader.readVarIntNumber();
          assertBound(length, MAX_STRING_LENGTH, 'SETUP AUTHORITY length', MessageTypeDraft18.SETUP);
          authority = TD.decode(reader.readBytes(length));
          break;
        }
        case SetupOptionDraft18.MOQT_IMPLEMENTATION: {
          const length = readKvpLength(reader, 'SETUP MOQT_IMPLEMENTATION length');
          moqtImplementation = TD.decode(reader.readBytes(length));
          break;
        }
        case 0x06:
          // MAX_FILTER_RANGES (draft-22 §9.1.6)
          maxFilterRanges = readVarIntSaturating(reader);
          break;
        case 0x08:
          // MAX_REQUEST_UPDATES (draft-22 §9.1.7)
          maxRequestUpdates = readVarIntSaturating(reader);
          break;
        default:
          // Unknown option: capture it so the caller can inspect §3.2
          // extensions the peer advertised. Even keys are varints, odd keys
          // are length-prefixed bytes.
          if (!extensions) extensions = new Map();
          if (key % 2 === 0) {
            extensions.set(key, { varint: reader.readVarInt() });
          } else {
            const length = readKvpLength(reader, 'SETUP extension length');
            const bytes = reader.readBytes(length);
            // Copy so callers can hold on to the slice beyond the decode
            // scratch buffer's lifetime.
            extensions.set(key, { bytes: new Uint8Array(bytes) });
          }
      }
    }

    return {
      type: MessageTypeDraft18.SERVER_SETUP,
      selectedVersion: Version.DRAFT_18,
      path,
      authority,
      maxAuthTokenCacheSize,
      authToken,
      moqtImplementation,
      maxFilterRanges,
      maxRequestUpdates,
      extensions,
    };
  }

  // ============================================================================
  // Subscribe Messages
  // ============================================================================

  private static encodeSubscribe(writer: Draft18BufferWriter, message: SubscribeMessageDraft18): void {
    // Draft-18 SUBSCRIBE: Request ID | Track Namespace | Track Name | Number of Parameters | Parameters
    writer.writeVarInt(message.requestId);
    encodeTrackNamespace(writer, message.trackNamespace);
    encodeTrackName(writer, message.trackName, message.trackNamespace);

    // Build parameters list including subscription filter
    const params: Array<{ type: number; encode: (w: Draft18BufferWriter) => void }> = [];

    // FORWARD parameter (0x10): even type = single byte value
    // 0x01 = forward new objects to subscriber, 0x00 = start paused (§10.2.12)
    params.push({
      type: RequestParameterDraft18.FORWARD,
      encode: (w) => { w.writeByte(message.forwardState === false ? 0x00 : 0x01); },
    });

    if (message.filter !== undefined) {
      params.push(Draft18MessageCodec.filterParameter(message));
    }

    // Add any additional raw parameters. §10.2 wire convention: even keys
    // carry their value verbatim (single-byte or varint); odd keys are
    // length-prefixed byte strings. Callers pass raw payload bytes and we
    // length-prefix them when appropriate to match the decoder.
    if (message.parameters) {
      for (const [type, value] of message.parameters) {
        if (type % 2 === 0) {
          params.push({ type, encode: (w) => w.writeBytes(value) });
        } else {
          params.push({
            type,
            encode: (w) => {
              w.writeVarInt(BigInt(value.length));
              w.writeBytes(value);
            },
          });
        }
      }
    }

    Draft18MessageCodec.encodeMessageParameters(writer, params);
  }

  /** The SUBSCRIPTION_FILTER parameter (§10.2.9) for a message carrying `filter`. */
  private static filterParameter(message: {
    filter?: SubscriptionFilterDraft18;
    startLocation?: Location;
    endGroupDelta?: bigint;
  }): { type: number; encode: (w: Draft18BufferWriter) => void } {
    return {
      type: RequestParameterDraft18.SUBSCRIPTION_FILTER,
      encode: (w) => {
        // Length-prefixed: encode filter into temp buffer, write length + bytes
        const filterWriter = new Draft18BufferWriter();
        filterWriter.writeVarInt(BigInt(message.filter!));
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
    };
  }

  private static decodeSubscribe(reader: Draft18BufferReader): SubscribeMessageDraft18 {
    const requestId = reader.readVarInt();
    const trackNamespace = decodeTrackNamespace(reader, MessageTypeDraft18.SUBSCRIBE);
    const trackName = decodeTrackName(reader, MessageTypeDraft18.SUBSCRIBE, trackNamespace);

    const numParams = reader.readVarIntNumber();
    assertBound(numParams, MAX_PARAMETER_COUNT, 'SUBSCRIBE numParams', MessageTypeDraft18.SUBSCRIBE);
    // §10.2.9: an omitted filter means unfiltered, i.e. AbsoluteStart {0, 0}
    let filter = SubscriptionFilterDraft18.ABSOLUTE_START;
    let startLocation: Location | undefined = { group: 0n, object: 0n };
    let endGroupDelta: bigint | undefined;
    // §10.2.12: an omitted FORWARD is 1
    let forwardState = true;
    const parameters = new Map<number, Uint8Array>();

    let previousType = 0;
    for (let i = 0; i < numParams; i++) {
      const type = Draft18MessageCodec.nextParameterType(reader, MessageTypeDraft18.SUBSCRIBE, previousType, i);
      previousType = type;

      if (type === RequestParameterDraft18.SUBSCRIPTION_FILTER) {
        ({ filter, startLocation, endGroupDelta } = Draft18MessageCodec.readFilter(reader, MessageTypeDraft18.SUBSCRIBE));
      } else if (type === RequestParameterDraft18.FORWARD) {
        forwardState = Draft18MessageCodec.readUint8Parameter(reader, type) === 0x01;
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
      forwardState,
      filter,
      startLocation,
      endGroupDelta,
      parameters: parameters.size > 0 ? parameters : undefined,
    };
  }

  private static encodeSubscribeOk(writer: Draft18BufferWriter, message: SubscribeOkMessageDraft18): void {
    // Draft-18 SUBSCRIBE_OK: Track Alias | Number of Parameters | Parameters | Track Properties (..)
    writer.writeVarInt(message.trackAlias ?? 0n);

    // Parameters (count-prefixed). §10.2 wants deltas encoded in ascending key
    // order — pushing EXPIRES (0x08) before LARGEST_OBJECT (0x09) preserves that.
    const params: Array<{ type: number; encode: (w: Draft18BufferWriter) => void }> = [];
    if (message.expires !== undefined) {
      params.push({
        type: RequestParameterDraft18.EXPIRES,
        encode: (w) => w.writeVarInt(message.expires!),
      });
    }
    Draft18MessageCodec.pushLargestObject(params, message.largestLocation);
    Draft18MessageCodec.encodeMessageParameters(writer, params);

    // Track Properties (KVPs to end)
    if (message.trackProperties) {
      encodeKeyValuePairs(writer, message.trackProperties);
    }
  }

  /** Add LARGEST_OBJECT (§10.2.11) when Objects have been published */
  private static pushLargestObject(
    params: Array<{ type: number; encode: (w: Draft18BufferWriter) => void }>,
    largestLocation: Location | undefined,
  ): void {
    if (!largestLocation) {
      return;
    }

    params.push({
      type: RequestParameterDraft18.LARGEST_OBJECT,
      encode: (w) => {
        w.writeVarInt(largestLocation.group);
        w.writeVarInt(largestLocation.object);
      },
    });
  }

  private static decodeSubscribeOk(reader: Draft18BufferReader): SubscribeOkMessageDraft18 {
    // Draft-18 SUBSCRIBE_OK: Track Alias | Number of Parameters | Parameters | Track Properties (..)
    const trackAlias = reader.readVarInt();

    const numParams = reader.readVarIntNumber();
    assertBound(numParams, MAX_PARAMETER_COUNT, 'SUBSCRIBE_OK numParams', MessageTypeDraft18.SUBSCRIBE_OK);
    let largestLocation: Location | undefined;
    let expires: bigint | undefined;

    let previousType = 0;
    for (let i = 0; i < numParams; i++) {
      const type = Draft18MessageCodec.nextParameterType(reader, MessageTypeDraft18.SUBSCRIBE_OK, previousType, i);
      previousType = type;

      if (type === RequestParameterDraft18.LARGEST_OBJECT) {
        largestLocation = { group: reader.readVarInt(), object: reader.readVarInt() };
      } else if (type === RequestParameterDraft18.EXPIRES) {
        expires = reader.readVarInt();
      } else {
        Draft18MessageCodec.readParameterValue(reader, type);
      }
    }

    // Track Properties fill remaining bytes
    const trackProperties = reader.hasMore
      ? decodeKeyValuePairsToEnd(reader)
      : undefined;

    return {
      type: MessageTypeDraft18.SUBSCRIBE_OK,
      requestId: trackAlias,
      trackAlias,
      largestLocation,
      expires,
      trackProperties: trackProperties?.size ? trackProperties : undefined,
    };
  }

  // ============================================================================
  // Publish Messages
  // ============================================================================

  private static encodePublish(writer: Draft18BufferWriter, message: PublishMessageDraft18): void {
    // Draft-18 PUBLISH: Request ID | Track Namespace | Track Name | Track Alias | Num Params | Params | Track Properties
    writer.writeVarInt(message.requestId);
    encodeTrackNamespace(writer, message.trackNamespace);
    encodeTrackName(writer, message.trackName, message.trackNamespace);
    writer.writeVarInt(message.trackAlias);

    // Message Parameters (count-prefixed)
    const params: Array<{ type: number; encode: (w: Draft18BufferWriter) => void }> = [];

    // FORWARD parameter (0x10): even type = single byte
    // 0x01 = will forward new objects, 0x00 = starts paused (§10.2.12)
    params.push({
      type: RequestParameterDraft18.FORWARD,
      encode: (w) => { w.writeByte(message.forwardState === false ? 0x00 : 0x01); },
    });
    Draft18MessageCodec.pushLargestObject(params, message.largestLocation);

    Draft18MessageCodec.encodeMessageParameters(writer, params);

    // Track Properties (KVPs to end)
    if (message.trackProperties) {
      encodeKeyValuePairs(writer, message.trackProperties);
    }
  }

  private static decodePublish(reader: Draft18BufferReader): PublishMessageDraft18 {
    const requestId = reader.readVarInt();
    const trackNamespace = decodeTrackNamespace(reader, MessageTypeDraft18.PUBLISH);
    const trackName = decodeTrackName(reader, MessageTypeDraft18.PUBLISH, trackNamespace);
    const trackAlias = reader.readVarInt();

    // Message Parameters (count-prefixed)
    const numParams = reader.readVarIntNumber();
    assertBound(numParams, MAX_PARAMETER_COUNT, 'PUBLISH numParams', MessageTypeDraft18.PUBLISH);
    // §10.2.12: an omitted FORWARD is 1
    let forwardState = true;
    let largestLocation: Location | undefined;
    let previousType = 0;
    for (let i = 0; i < numParams; i++) {
      const type = Draft18MessageCodec.nextParameterType(reader, MessageTypeDraft18.PUBLISH, previousType, i);
      previousType = type;
      if (type === RequestParameterDraft18.LARGEST_OBJECT) {
        largestLocation = { group: reader.readVarInt(), object: reader.readVarInt() };
        continue;
      }

      const value = Draft18MessageCodec.readParameterValue(reader, type);
      if (type === RequestParameterDraft18.FORWARD) {
        forwardState = value[0] === 0x01;
      }
    }

    // Track Properties (KVPs to end)
    const trackProperties = reader.hasMore
      ? decodeKeyValuePairsToEnd(reader)
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
    // Draft-18 §10.6.2: Error Code | Retry Interval | Error Reason | [Redirect]
    writer.writeVarInt(message.errorCode);
    writer.writeVarInt(message.retryInterval ?? 0n);
    encodeReasonPhrase(writer, message.reasonPhrase);

    // Redirect is present only when Error Code === REDIRECT (0x34)
    if (message.errorCode === RequestErrorCodeDraft18.REDIRECT) {
      if (!message.redirect) {
        throw new Draft18CodecError(
          'REQUEST_ERROR with REDIRECT error code requires a redirect payload',
          MessageTypeDraft18.REQUEST_ERROR,
        );
      }
      Draft18MessageCodec.encodeRedirect(writer, message.redirect);
    }
  }

  private static decodeRequestError(
    reader: Draft18BufferReader,
    normalizers: ErrorCodeNormalizers,
  ): RequestErrorMessageDraft18 {
    // Draft-18 §10.6.2: Error Code | Retry Interval | Error Reason | [Redirect]
    // §14 grease: an unknown error code MUST be treated as INTERNAL_ERROR for
    // this registry. Normalize immediately so callers see stable enum values.
    const rawErrorCode = readVarIntSaturating(reader);
    const errorCode = normalizers.requestError(rawErrorCode);
    const retryInterval = reader.readVarInt();
    const reasonPhrase = decodeReasonPhrase(reader, MessageTypeDraft18.REQUEST_ERROR);

    const message: RequestErrorMessageDraft18 = {
      type: MessageTypeDraft18.REQUEST_ERROR,
      requestId: 0n,
      errorCode,
      retryInterval,
      reasonPhrase,
    };

    // Redirect is only defined on the concrete REDIRECT code — after §14
    // normalization, a grease code would have already been mapped to
    // INTERNAL_ERROR, so we correctly skip redirect parsing for it.
    if (errorCode === RequestErrorCodeDraft18.REDIRECT) {
      message.redirect = Draft18MessageCodec.decodeRedirect(reader);
    }

    return message;
  }

  private static encodeRedirect(writer: Draft18BufferWriter, redirect: RequestErrorRedirectDraft18): void {
    // Draft-18 §10.6.1: Connect URI Length | Connect URI | Track Namespace | Track Name Length | Track Name
    encodeString(writer, redirect.connectUri);
    encodeTrackNamespace(writer, redirect.trackNamespace);
    encodeString(writer, redirect.trackName);
  }

  private static decodeRedirect(reader: Draft18BufferReader): RequestErrorRedirectDraft18 {
    const connectUri = decodeString(reader);
    const trackNamespace = decodeTrackNamespace(reader);
    const trackName = decodeString(reader);
    return { connectUri, trackNamespace, trackName };
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
    if (message.largestLocation) {
      params.push({
        type: RequestParameterDraft18.LARGEST_OBJECT,
        encode: (w) => {
          w.writeVarInt(message.largestLocation!.group);
          w.writeVarInt(message.largestLocation!.object);
        },
      });
    }
    if (message.forwardState !== undefined) {
      params.push({
        type: RequestParameterDraft18.FORWARD,
        encode: (w) => { w.writeByte(message.forwardState ? 0x01 : 0x00); },
      });
    }
    if (message.filter !== undefined) {
      params.push(Draft18MessageCodec.filterParameter(message));
    }
    Draft18MessageCodec.encodeMessageParameters(writer, params);
  }

  private static decodeRequestOk(reader: Draft18BufferReader): RequestOkMessageDraft18 {
    // Draft-18 REQUEST_OK: Number of Parameters | Parameters | Track Properties (..)
    const numParams = reader.readVarIntNumber();
    assertBound(numParams, MAX_PARAMETER_COUNT, 'REQUEST_OK numParams', MessageTypeDraft18.REQUEST_OK);
    let expires: bigint | undefined;
    let largestLocation: Location | undefined;
    // §10.2.12: FORWARD in a PUBLISH_OK sets the initial state; omitted is 1
    let forwardState: boolean | undefined;
    let filterFields: ReturnType<typeof Draft18MessageCodec.readFilter> | undefined;

    let previousType = 0;
    for (let i = 0; i < numParams; i++) {
      const type = Draft18MessageCodec.nextParameterType(reader, MessageTypeDraft18.REQUEST_OK, previousType, i);
      previousType = type;

      if (type === RequestParameterDraft18.SUBSCRIPTION_FILTER) {
        filterFields = Draft18MessageCodec.readFilter(reader, MessageTypeDraft18.REQUEST_OK);
      } else if (type === RequestParameterDraft18.EXPIRES) {
        expires = reader.readVarInt();
      } else if (type === RequestParameterDraft18.FORWARD) {
        forwardState = Draft18MessageCodec.readUint8Parameter(reader, type) === 0x01;
      } else if (type === RequestParameterDraft18.LARGEST_OBJECT) {
        const group = reader.readVarInt();
        const object = reader.readVarInt();
        largestLocation = { group, object };
      } else {
        Draft18MessageCodec.readParameterValue(reader, type);
      }
    }

    return {
      type: MessageTypeDraft18.REQUEST_OK,
      requestId: 0n,
      expires,
      largestLocation,
      forwardState,
      ...filterFields,
    };
  }

  // ============================================================================
  // Fetch Messages
  // ============================================================================

  private static encodeFetch(writer: Draft18BufferWriter, message: FetchMessageDraft18): void {
    // Draft-18: Request ID | Fetch Type | [Standalone/Joining] | Num Params | Params
    writer.writeVarInt(message.requestId);

    // Resolve fetch type: explicit fetchType wins; fall back to legacy joiningFlag.
    let fetchType = message.fetchType;
    if (fetchType === undefined) {
      fetchType = message.joiningFlag && message.subscribeRequestId !== undefined
        ? FetchTypeDraft18.JOINING_RELATIVE
        : FetchTypeDraft18.STANDALONE;
    }

    if (
      fetchType === FetchTypeDraft18.JOINING_RELATIVE ||
      fetchType === FetchTypeDraft18.JOINING_ABSOLUTE
    ) {
      if (message.subscribeRequestId === undefined) {
        throw new Error('Joining FETCH requires subscribeRequestId');
      }
      writer.writeVarInt(BigInt(fetchType));
      writer.writeVarInt(message.subscribeRequestId);
      writer.writeVarInt(message.joiningStart ?? 0n);
    } else {
      // Standalone fetch (type 0x1)
      writer.writeVarInt(BigInt(FetchTypeDraft18.STANDALONE));
      encodeTrackNamespace(writer, message.trackNamespace!);
      encodeTrackName(writer, message.trackName!, message.trackNamespace!);
      Draft18MessageCodec.encodeLocation(writer, message.startLocation);
      Draft18MessageCodec.encodeLocation(writer, message.endLocation);
    }

    // Parameters (count-prefixed)
    const params: Array<{ type: number; encode: (w: Draft18BufferWriter) => void }> = [];
    params.push({
      type: RequestParameterDraft18.SUBSCRIBER_PRIORITY,
      encode: (w) => w.writeByte(message.subscriberPriority),
    });
    if (message.groupOrder) {
      params.push({
        type: RequestParameterDraft18.GROUP_ORDER,
        encode: (w) => w.writeByte(message.groupOrder),
      });
    }
    if (message.parameters) {
      for (const [type, value] of message.parameters) {
        if (type % 2 === 0) {
          params.push({ type, encode: (w) => w.writeBytes(value) });
        } else {
          params.push({
            type,
            encode: (w) => {
              w.writeVarInt(BigInt(value.length));
              w.writeBytes(value);
            },
          });
        }
      }
    }
    Draft18MessageCodec.encodeMessageParameters(writer, params);
  }

  private static decodeFetch(reader: Draft18BufferReader): FetchMessageDraft18 {
    const requestId = reader.readVarInt();
    const fetchTypeRaw = reader.readVarIntNumber();

    let trackNamespace: TrackNamespace | undefined;
    let trackName: string | undefined;
    let subscribeRequestId: bigint | undefined;
    let joiningStart: bigint | undefined;
    let startLocation: Location = { group: 0n, object: 0n };
    let endLocation: Location = { group: 0n, object: 0n };

    let fetchType: FetchTypeDraft18;
    switch (fetchTypeRaw) {
      case FetchTypeDraft18.STANDALONE:
      case FetchTypeDraft18.JOINING_RELATIVE:
      case FetchTypeDraft18.JOINING_ABSOLUTE:
        fetchType = fetchTypeRaw as FetchTypeDraft18;
        break;
      default:
        throw new Draft18CodecError(
          `Invalid FETCH type 0x${fetchTypeRaw.toString(16)} (PROTOCOL_VIOLATION)`,
        );
    }
    const joiningFlag = fetchType !== FetchTypeDraft18.STANDALONE;

    if (fetchType === FetchTypeDraft18.STANDALONE) {
      trackNamespace = decodeTrackNamespace(reader, MessageTypeDraft18.FETCH);
      trackName = decodeTrackName(reader, MessageTypeDraft18.FETCH, trackNamespace);
      startLocation = Draft18MessageCodec.decodeLocation(reader);
      endLocation = Draft18MessageCodec.decodeLocation(reader);
    } else {
      // Joining (relative=0x2 or absolute=0x3)
      subscribeRequestId = reader.readVarInt();
      joiningStart = reader.readVarInt();
    }

    // Parameters
    const numParams = reader.readVarIntNumber();
    assertBound(numParams, MAX_PARAMETER_COUNT, 'FETCH numParams', MessageTypeDraft18.FETCH);
    // §10.2.7: omitted SUBSCRIBER_PRIORITY is 128
    let subscriberPriority = DEFAULT_SUBSCRIBER_PRIORITY;
    let groupOrder = GroupOrder.ASCENDING as GroupOrder;
    const parameters = new Map<number, Uint8Array>();
    let previousType = 0;
    for (let i = 0; i < numParams; i++) {
      const type = Draft18MessageCodec.nextParameterType(reader, MessageTypeDraft18.FETCH, previousType, i);
      previousType = type;
      if (type === RequestParameterDraft18.SUBSCRIBER_PRIORITY) {
        subscriberPriority = reader.readByte();
      } else if (type === RequestParameterDraft18.GROUP_ORDER) {
        groupOrder = Draft18MessageCodec.readUint8Parameter(reader, type) as GroupOrder;
      } else {
        parameters.set(type, Draft18MessageCodec.readParameterValue(reader, type));
      }
    }

    return {
      type: MessageTypeDraft18.FETCH,
      requestId,
      fetchType,
      joiningFlag,
      trackNamespace,
      trackName,
      subscribeRequestId,
      joiningStart,
      subscriberPriority,
      groupOrder,
      startLocation,
      endLocation,
      parameters: parameters.size > 0 ? parameters : undefined,
    };
  }

  private static encodeFetchOk(writer: Draft18BufferWriter, message: FetchOkMessageDraft18): void {
    // Draft-18: End Of Track (8) | End Location | Num Params | Params | Track Properties
    writer.writeByte(message.endOfTrack ? 1 : 0);
    Draft18MessageCodec.encodeLocation(writer, message.endLocation);
    Draft18MessageCodec.encodeMessageParameters(writer, []);
    if (message.trackProperties) {
      encodeKeyValuePairs(writer, message.trackProperties);
    }
  }

  private static decodeFetchOk(reader: Draft18BufferReader): FetchOkMessageDraft18 {
    // Draft-18: End Of Track (8) | End Location | Num Params | Params | Track Properties
    const endOfTrack = reader.readByte() !== 0;
    const endLocation = Draft18MessageCodec.decodeLocation(reader);

    const numParams = reader.readVarIntNumber();
    assertBound(numParams, MAX_PARAMETER_COUNT, 'FETCH_OK numParams', MessageTypeDraft18.FETCH_OK);
    let previousType = 0;
    for (let i = 0; i < numParams; i++) {
      const type = Draft18MessageCodec.nextParameterType(reader, MessageTypeDraft18.FETCH_OK, previousType, i);
      previousType = type;
      Draft18MessageCodec.readParameterValue(reader, type);
    }

    const trackProperties = reader.hasMore
      ? decodeKeyValuePairsToEnd(reader)
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
    // Draft-18 §10.4: New Session URI Length | New Session URI | Timeout (vi) | [Request ID (vi)]
    encodeString(writer, message.newSessionUri ?? '');
    writer.writeVarInt(message.timeout);
    if (message.requestId !== undefined) {
      writer.writeVarInt(message.requestId);
    }
  }

  /** `requestId` is draft-18 only: draft-22 dropped the field (§9.2) */
  static decodeGoAway(reader: Draft18BufferReader, hasRequestId = true): GoAwayMessageDraft18 {
    // Draft-18 §10.4: New Session URI Length | New Session URI | Timeout (vi) | [Request ID (vi)]
    const newSessionUri = decodeString(reader, MessageTypeDraft18.GOAWAY, MAX_GOAWAY_URI_LENGTH);
    const timeout = reader.readVarInt();
    const requestId = hasRequestId && reader.hasMore ? reader.readVarInt() : undefined;

    return {
      type: MessageTypeDraft18.GOAWAY,
      newSessionUri: newSessionUri.length > 0 ? newSessionUri : undefined,
      timeout,
      requestId,
    };
  }

  private static encodeTrackStatus(writer: Draft18BufferWriter, message: TrackStatusMessageDraft18): void {
    // Same format as SUBSCRIBE: Request ID | Track Namespace | Track Name | Num Params | Params
    writer.writeVarInt(message.requestId);
    encodeTrackNamespace(writer, message.trackNamespace);
    encodeTrackName(writer, message.trackName, message.trackNamespace);
    Draft18MessageCodec.encodeMessageParameters(writer, []);
  }

  private static decodeTrackStatus(reader: Draft18BufferReader): TrackStatusMessageDraft18 {
    const requestId = reader.readVarInt();
    const trackNamespace = decodeTrackNamespace(reader, MessageTypeDraft18.TRACK_STATUS);
    const trackName = decodeTrackName(reader, MessageTypeDraft18.TRACK_STATUS, trackNamespace);
    const numParams = reader.readVarIntNumber();
    assertBound(numParams, MAX_PARAMETER_COUNT, 'TRACK_STATUS numParams', MessageTypeDraft18.TRACK_STATUS);
    let previousType = 0;
    for (let i = 0; i < numParams; i++) {
      const type = Draft18MessageCodec.nextParameterType(reader, MessageTypeDraft18.TRACK_STATUS, previousType, i);
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
    encodeReasonPhrase(writer, message.reasonPhrase ?? '');
  }

  private static decodePublishDone(
    reader: Draft18BufferReader,
    normalizers: ErrorCodeNormalizers,
  ): PublishDoneMessageDraft18 {
    const rawStatusCode = reader.readVarInt();
    // §14 grease: unknown PUBLISH_DONE codes MUST be treated as INTERNAL_ERROR
    // (0x0). Registry codes are small; anything outside Number.MAX_SAFE_INTEGER
    // is by definition unknown so we don't even need to inspect it — it can't
    // match a defined enum value.
    const normalizedStatusCode: bigint =
      rawStatusCode > BigInt(Number.MAX_SAFE_INTEGER)
        ? 0n
        : BigInt(normalizers.publishDone(Number(rawStatusCode)));
    const streamCount = reader.readVarInt();
    const reasonPhrase = decodeReasonPhrase(reader, MessageTypeDraft18.PUBLISH_DONE);

    return {
      type: MessageTypeDraft18.PUBLISH_DONE,
      requestId: 0n,
      finalLocation: { group: 0n, object: 0n },
      statusCode: normalizedStatusCode,
      streamCount,
      reasonPhrase: reasonPhrase || undefined,
    };
  }

  // ============================================================================
  // REQUEST_UPDATE Message
  // ============================================================================

  private static encodeRequestUpdate(writer: Draft18BufferWriter, message: RequestUpdateMessageDraft18): void {
    // Draft-18 §10.9: Request ID | Number of Parameters | Parameters.
    // The Request ID identifies the request being updated (there is no separate
    // Existing Request ID field).
    writer.writeVarInt(message.requestId);
    const params: Array<{ type: number; encode: (w: Draft18BufferWriter) => void }> = [];

    // FORWARD parameter (0x10): even type = single byte value (0 = pause, 1 = resume);
    // omitted leaves the subscription's state unchanged (§10.2.12)
    if (message.forwardState !== undefined) {
      params.push({
        type: RequestParameterDraft18.FORWARD,
        encode: (w) => { w.writeByte(message.forwardState ? 0x01 : 0x00); },
      });
    }

    if (message.filter !== undefined) {
      params.push(Draft18MessageCodec.filterParameter(message));
    }

    if (message.parameters) {
      for (const [type, value] of message.parameters) {
        params.push({ type, encode: (w) => w.writeBytes(value) });
      }
    }

    Draft18MessageCodec.encodeMessageParameters(writer, params);
  }

  private static decodeRequestUpdate(reader: Draft18BufferReader): RequestUpdateMessageDraft18 {
    const requestId = reader.readVarInt();
    const numParams = reader.readVarIntNumber();
    assertBound(numParams, MAX_PARAMETER_COUNT, 'REQUEST_UPDATE numParams', MessageTypeDraft18.REQUEST_UPDATE);
    let previousType = 0;
    let forwardState: boolean | undefined;
    let filterFields: ReturnType<typeof Draft18MessageCodec.readFilter> | undefined;
    const parameters = new Map<number, Uint8Array>();
    for (let i = 0; i < numParams; i++) {
      const type = Draft18MessageCodec.nextParameterType(reader, MessageTypeDraft18.REQUEST_UPDATE, previousType, i);
      previousType = type;
      if (type === RequestParameterDraft18.SUBSCRIPTION_FILTER) {
        filterFields = Draft18MessageCodec.readFilter(reader, MessageTypeDraft18.REQUEST_UPDATE);
        continue;
      }
      const value = Draft18MessageCodec.readParameterValue(reader, type);
      if (type === RequestParameterDraft18.FORWARD) {
        forwardState = value[0] === 0x01;
      } else {
        parameters.set(type, value);
      }
    }

    return {
      type: MessageTypeDraft18.REQUEST_UPDATE,
      requestId,
      forwardState,
      ...filterFields,
      parameters: parameters.size > 0 ? parameters : undefined,
    };
  }

  // ============================================================================
  // PUBLISH_NAMESPACE Message
  // ============================================================================

  private static encodePublishNamespace(writer: Draft18BufferWriter, message: PublishNamespaceMessageDraft18): void {
    // Draft-18: Request ID | Track Namespace | Number of Parameters | Parameters
    writer.writeVarInt(message.requestId);
    encodeTrackNamespace(writer, message.trackNamespacePrefix);
    Draft18MessageCodec.encodeMessageParameters(writer, []);
  }

  private static decodePublishNamespace(reader: Draft18BufferReader): PublishNamespaceMessageDraft18 {
    const requestId = reader.readVarInt();
    const trackNamespacePrefix = decodeTrackNamespace(reader, MessageTypeDraft18.PUBLISH_NAMESPACE);
    const numParams = reader.readVarIntNumber();
    assertBound(numParams, MAX_PARAMETER_COUNT, 'PUBLISH_NAMESPACE numParams', MessageTypeDraft18.PUBLISH_NAMESPACE);
    let previousType = 0;
    for (let i = 0; i < numParams; i++) {
      const type = Draft18MessageCodec.nextParameterType(reader, MessageTypeDraft18.PUBLISH_NAMESPACE, previousType, i);
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
    encodeTrackNamespace(writer, message.trackNamespacePrefix);
    Draft18MessageCodec.encodeMessageParameters(writer, []);
  }

  private static decodeSubscribeNamespace(reader: Draft18BufferReader): SubscribeNamespaceMessageDraft18 {
    const requestId = reader.readVarInt();
    const trackNamespacePrefix = decodeTrackNamespace(reader, MessageTypeDraft18.SUBSCRIBE_NAMESPACE);
    const numParams = reader.readVarIntNumber();
    assertBound(numParams, MAX_PARAMETER_COUNT, 'SUBSCRIBE_NAMESPACE numParams', MessageTypeDraft18.SUBSCRIBE_NAMESPACE);
    let previousType = 0;
    for (let i = 0; i < numParams; i++) {
      const type = Draft18MessageCodec.nextParameterType(reader, MessageTypeDraft18.SUBSCRIBE_NAMESPACE, previousType, i);
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
    encodeTrackNamespace(writer, message.trackNamespace);
    if (message.trackNamespaceParameters) {
      encodeKeyValuePairs(writer, message.trackNamespaceParameters);
    }
  }

  private static decodeNamespaceMessage(reader: Draft18BufferReader): NamespaceMessageDraft18 {
    const trackNamespace = decodeTrackNamespace(reader);
    const trackNamespaceParameters = reader.hasMore
      ? decodeKeyValuePairsToEnd(reader)
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
    encodeTrackNamespace(writer, message.finalNamespace);
  }

  private static decodeNamespaceDone(reader: Draft18BufferReader): NamespaceDoneMessageDraft18 {
    const finalNamespace = decodeTrackNamespace(reader);

    return {
      type: MessageTypeDraft18.NAMESPACE_DONE,
      finalNamespace,
    };
  }

  // ============================================================================
  // SUBSCRIBE_TRACKS Message
  // ============================================================================

  private static encodeSubscribeTracks(writer: Draft18BufferWriter, message: SubscribeTracksMessageDraft18): void {
    // Draft-18 §10.19: Request ID | Track Namespace Prefix | Number of Parameters | Parameters
    // SUBSCRIPTION_FILTER is NOT allowed in SUBSCRIBE_TRACKS per draft-18 —
    // the relay only permits it in SUBSCRIBE, PUBLISH_OK, REQUEST_OK, and
    // REQUEST_UPDATE. Only FORWARD is sent here.
    writer.writeVarInt(message.requestId);
    encodeTrackNamespace(writer, message.trackNamespacePrefix);

    const params: Array<{ type: number; encode: (w: Draft18BufferWriter) => void }> = [];

    // Always emit FORWARD so `forwardState=false` is representable on the wire
    // (§10.2.12 single-byte value: 0x00 pause / 0x01 forward).
    params.push({
      type: RequestParameterDraft18.FORWARD,
      encode: (w) => { w.writeByte(message.forwardState === false ? 0x00 : 0x01); },
    });

    if (message.parameters) {
      for (const [type, value] of message.parameters) {
        // Values are treated as length-prefixed byte strings on the wire so
        // an unknown key survives round-trip through `readParameterValue`.
        params.push({
          type,
          encode: (w) => {
            w.writeVarInt(BigInt(value.length));
            w.writeBytes(value);
          },
        });
      }
    }

    Draft18MessageCodec.encodeMessageParameters(writer, params);
  }

  private static decodeSubscribeTracks(reader: Draft18BufferReader): SubscribeTracksMessageDraft18 {
    const requestId = reader.readVarInt();
    const trackNamespacePrefix = decodeTrackNamespace(reader, MessageTypeDraft18.SUBSCRIBE_TRACKS);

    const numParams = reader.readVarIntNumber();
    assertBound(numParams, MAX_PARAMETER_COUNT, 'SUBSCRIBE_TRACKS numParams', MessageTypeDraft18.SUBSCRIBE_TRACKS);
    let forwardState = true;
    const parameters = new Map<number, Uint8Array>();

    let previousType = 0;
    for (let i = 0; i < numParams; i++) {
      const type = Draft18MessageCodec.nextParameterType(reader, MessageTypeDraft18.SUBSCRIBE_TRACKS, previousType, i);
      previousType = type;

      if (type === RequestParameterDraft18.FORWARD) {
        // §10.2.12: single-byte value, no length prefix.
        forwardState = Draft18MessageCodec.readUint8Parameter(reader, type) === 0x01;
      } else {
        const value = Draft18MessageCodec.readParameterValue(reader, type);
        parameters.set(type, value);
      }
    }

    return {
      type: MessageTypeDraft18.SUBSCRIBE_TRACKS,
      requestId,
      trackNamespacePrefix,
      forwardState,
      // §10.2: SUBSCRIBE_TRACKS carries no SUBSCRIPTION_FILTER
      filter: SubscriptionFilterDraft18.NEXT_GROUP_START,
      parameters: parameters.size > 0 ? parameters : undefined,
    };
  }

  // ============================================================================
  // PUBLISH_BLOCKED Message
  // ============================================================================

  private static encodePublishBlocked(writer: Draft18BufferWriter, message: PublishBlockedMessageDraft18): void {
    // Track Namespace Suffix | Track Name Length | Track Name
    encodeTrackNamespace(writer, message.trackNamespaceSuffix);
    encodeString(writer, message.trackName);
  }

  private static decodePublishBlocked(reader: Draft18BufferReader): PublishBlockedMessageDraft18 {
    const trackNamespaceSuffix = decodeTrackNamespace(reader, MessageTypeDraft18.PUBLISH_BLOCKED);
    const trackName = decodeTrackName(reader, MessageTypeDraft18.PUBLISH_BLOCKED);

    return {
      type: MessageTypeDraft18.PUBLISH_BLOCKED,
      trackNamespaceSuffix,
      trackName,
    };
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  // encodeTrackNamespace, decodeTrackNamespace, encodeString, decodeString,
  // decodeTrackName, assertBound — imported from codec-helpers.ts

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
   * Read a parameter's type. §10.2: an unknown parameter, or one the message
   * may not carry, closes the session; so does a repeat, except for
   * AUTHORIZATION_TOKEN (§10.2.2).
   */
  private static nextParameterType(
    reader: Draft18BufferReader,
    messageType: MessageTypeDraft18,
    previousType: number,
    index: number,
  ): number {
    const delta = reader.readVarIntNumber();
    const type = previousType + delta;
    const name = RequestParameterDraft18[type];
    const scope = MessageTypeDraft18[messageType];

    if (name === undefined) {
      throw new Draft18CodecError(`Unknown parameter 0x${type.toString(16)} in ${scope} (PROTOCOL_VIOLATION)`, messageType);
    }
    if (!PARAMETER_SCOPES.get(messageType)?.has(type)) {
      throw new Draft18CodecError(`${name} not allowed in ${scope} (PROTOCOL_VIOLATION)`, messageType);
    }
    if (index > 0 && delta === 0 && type !== RequestParameterDraft18.AUTHORIZATION_TOKEN) {
      throw new Draft18CodecError(`Duplicate parameter ${name} in ${scope} (PROTOCOL_VIOLATION)`, messageType);
    }

    return type;
  }

  /** Read a uint8 parameter, closing the session on a value outside its range (§10.2.8, §10.2.12). */
  private static readUint8Parameter(reader: Draft18BufferReader, type: number): number {
    const value = reader.readByte();
    const range = UINT8_RANGES.get(type);
    if (range && (value < range[0] || value > range[1])) {
      throw new Draft18CodecError(
        `Invalid ${RequestParameterDraft18[type]} ${value} (PROTOCOL_VIOLATION)`,
      );
    }

    return value;
  }

  /**
   * Read a length-prefixed Subscription Filter (§5.1.2). An unknown filter
   * type, or an AbsoluteRange ending past Group 2^64-1, closes the session.
   */
  private static readFilter(reader: Draft18BufferReader, messageType: MessageTypeDraft18): {
    filter: SubscriptionFilterDraft18;
    startLocation?: Location;
    endGroupDelta?: bigint;
  } {
    const length = reader.readVarIntNumber();
    assertBound(length, MAX_STRING_LENGTH, 'SUBSCRIPTION_FILTER length', messageType);
    const filterReader = new Draft18BufferReader(reader.readBytes(length), 0);

    const filter = filterReader.readVarIntNumber() as SubscriptionFilterDraft18;
    if (!SubscriptionFilterDraft18[filter]) {
      throw new Draft18CodecError(`Unknown filter type ${filter} (PROTOCOL_VIOLATION)`, messageType);
    }
    if (filter !== SubscriptionFilterDraft18.ABSOLUTE_START && filter !== SubscriptionFilterDraft18.ABSOLUTE_RANGE) {
      return { filter };
    }

    const startLocation = { group: filterReader.readVarInt(), object: filterReader.readVarInt() };
    if (filter === SubscriptionFilterDraft18.ABSOLUTE_START) {
      return { filter, startLocation };
    }

    const endGroupDelta = filterReader.readVarInt();
    if (startLocation.group + endGroupDelta > MOQT_VARINT_MAX) {
      throw new Draft18CodecError('AbsoluteRange end Group exceeds 2^64-1 (PROTOCOL_VIOLATION)', messageType);
    }

    return { filter, startLocation, endGroupDelta };
  }

  /**
   * Read a parameter value based on type (for skipping unknown parameters)
   */
  private static readParameterValue(reader: Draft18BufferReader, type: number): Uint8Array {
    switch (type) {
      case RequestParameterDraft18.FORWARD:
      case RequestParameterDraft18.SUBSCRIBER_PRIORITY:
      case RequestParameterDraft18.GROUP_ORDER:
        return new Uint8Array([Draft18MessageCodec.readUint8Parameter(reader, type)]);
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
      case RequestParameterDraft18.AUTHORIZATION_TOKEN: {
        const length = reader.readVarIntNumber();
        assertBound(length, MAX_AUTH_TOKEN_LENGTH, 'AUTHORIZATION_TOKEN parameter length');
        const token = reader.readBytes(length);
        decodeDraft18AuthToken(token);
        return token;
      }
      case RequestParameterDraft18.TRACK_NAMESPACE_PREFIX: {
        // §10.2.14: a Track Namespace, not a length-prefixed value
        const writer = new Draft18BufferWriter();
        encodeTrackNamespace(writer, decodeTrackNamespace(reader, MessageTypeDraft18.REQUEST_UPDATE));
        return writer.toUint8Array();
      }
      case RequestParameterDraft18.SUBSCRIPTION_FILTER:
      default: {
        const length = reader.readVarIntNumber();
        assertBound(length, MAX_STRING_LENGTH, 'parameter value length');
        return reader.readBytes(length);
      }
    }
  }
}
