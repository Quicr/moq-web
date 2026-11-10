// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Shared codec helpers used by both draft-18 and draft-22 message codecs.
 *
 * These functions were extracted from the draft-18 codec to eliminate
 * duplication with draft-22 (which uses the same wire format for
 * track namespace tuples, strings, framing, and bounds checking).
 */

import { MOQTVarInt, MOQT_VARINT_MAX } from './moqt-varint.js';
import { Draft18BufferWriter, Draft18BufferReader } from './protocol-codec.js';
import { Draft18CodecError, CODEC_INCOMPLETE, CODEC_MALFORMED } from './draft18-message-codec.js';
import type { AuthorizationToken, MessageTypeDraft18, TrackNamespace } from '../messages/types.js';

// Module-level singletons shared across helpers
const TE = new TextEncoder();
const TD = new TextDecoder();
/** Names must be UTF-8: invalid bytes throw instead of becoming U+FFFD */
const TD_FATAL = new TextDecoder('utf-8', { fatal: true });

// =============================================================================
// Codec Safety Bounds (B1 SEC)
// =============================================================================
export const MAX_PARAMETER_COUNT = 64;
export const MAX_STRING_LENGTH = 4096;
/** §9.2: the New Session URI of a GOAWAY is at most 8,192 bytes */
export const MAX_GOAWAY_URI_LENGTH = 8192;
export const MAX_NAMESPACE_TUPLE_COUNT = 32;
export const MAX_TRACK_NAME_LENGTH = 4096;
export const MAX_AUTH_TOKEN_LENGTH = 16384;
/** §8.3: "The maximum length of a value is 2^16-1 bytes." */
export const MAX_KVP_VALUE_LENGTH = 0xFFFF;
/** §8.5: Reason Phrase length limit */
export const MAX_REASON_PHRASE_LENGTH = 1024;
/** UTF-8 continuation bytes are 10xxxxxx */
const UTF8_CONTINUATION_MASK = 0xC0;
const UTF8_CONTINUATION_BITS = 0x80;
/** §9: Message Length is 16 bits */
export const MAX_CONTROL_MESSAGE_LENGTH = 0xFFFF;
/** §10.2.7: SUBSCRIBER_PRIORITY value when the parameter is omitted */
export const DEFAULT_SUBSCRIBER_PRIORITY = 128;

/**
 * Assert a decoded numeric value is within safety bounds.
 * Rejects NaN/negatives from a corrupt varint decode as well as overflows.
 */
export function assertBound(
  actual: number,
  limit: number,
  what: string,
  messageType?: MessageTypeDraft18 | number,
): void {
  if (!Number.isFinite(actual) || actual < 0 || actual > limit) {
    throw new Draft18CodecError(
      `${what} ${actual} exceeds safety bound ${limit}`,
      messageType as MessageTypeDraft18 | undefined,
      'bounds-exceeded',
    );
  }
}

// =============================================================================
// Key-Value-Pair Codepoints
// =============================================================================

/**
 * Largest KVP key kept as a number. Grease codepoints (0x7f * N + 0x9D, §13)
 * mostly lie above it; they are unknown by definition and skipped.
 */
export const MAX_SAFE_KEY = BigInt(Number.MAX_SAFE_INTEGER);

/** Read a delta-encoded KVP key as a bigint so grease codepoints survive. */
export function readKvpKey(reader: Draft18BufferReader, previousKey: bigint): bigint {
  const key = previousKey + reader.readVarInt();
  if (key > MOQT_VARINT_MAX) {
    throw new Draft18CodecError(`KVP key ${key} exceeds 2^64-1`, undefined, undefined, 'delta-overflow');
  }

  return key;
}

/** Read a length-prefixed KVP value length, bounded by §8.3. */
export function readKvpLength(reader: Draft18BufferReader, what: string): number {
  const length = reader.readVarIntNumber();
  assertBound(length, MAX_KVP_VALUE_LENGTH, what);

  return length;
}

/** Skip the value of an unrepresentable (grease) key: even = vi64, odd = length-prefixed. */
export function skipKvpValue(reader: Draft18BufferReader, key: bigint): void {
  if (key % 2n === 0n) {
    reader.readVarInt();
    return;
  }

  reader.readBytes(readKvpLength(reader, 'KVP value length'));
}

/** Read an integer value, saturating at MAX_SAFE_INTEGER (limits above 2^53 are effectively unbounded). */
export function readVarIntSaturating(reader: Draft18BufferReader): number {
  const value = reader.readVarInt();

  return value > MAX_SAFE_KEY ? Number.MAX_SAFE_INTEGER : Number(value);
}

// =============================================================================
// Track Namespace / String Helpers
// =============================================================================

/**
 * Decode the bytes of a Track Namespace field or Track Name. They are bytes
 * on the wire (d22 §2.4.1), but we carry them as strings, so bytes that are
 * not UTF-8 are a malformed message (PROTOCOL_VIOLATION), never mangled.
 */
export function decodeName(bytes: Uint8Array, what: string, messageType?: MessageTypeDraft18): string {
  try {
    return TD_FATAL.decode(bytes);
  } catch {
    throw new Draft18CodecError(`${what} is not valid UTF-8 (PROTOCOL_VIOLATION)`, messageType);
  }
}

/** Total byte length of a Track Namespace: the sum of its field lengths (§8.7) */
function namespaceLength(namespace: TrackNamespace): number {
  return namespace.reduce((total, field) => total + TE.encode(field).length, 0);
}

export function encodeTrackNamespace(writer: Draft18BufferWriter, namespace: TrackNamespace): void {
  assertBound(namespace.length, MAX_NAMESPACE_TUPLE_COUNT, 'TrackNamespace tuple count');
  assertBound(namespaceLength(namespace), MAX_TRACK_NAME_LENGTH, 'TrackNamespace length');

  writer.writeVarInt(namespace.length);
  for (const field of namespace) {
    const bytes = TE.encode(field);
    if (bytes.length === 0) {
      throw new Draft18CodecError('TrackNamespace Field length 0 (PROTOCOL_VIOLATION)');
    }
    writer.writeVarInt(bytes.length);
    writer.writeBytes(bytes);
  }
}

export function decodeTrackNamespace(reader: Draft18BufferReader, messageType?: MessageTypeDraft18): TrackNamespace {
  const count = reader.readVarIntNumber();
  assertBound(count, MAX_NAMESPACE_TUPLE_COUNT, 'TrackNamespace tuple count', messageType);
  const namespace: string[] = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    const length = reader.readVarIntNumber();
    // §8.7: an empty field, or a Track Namespace over 4,096 bytes, closes the session
    if (length === 0) {
      throw new Draft18CodecError('TrackNamespace Field length 0 (PROTOCOL_VIOLATION)', messageType);
    }
    assertBound(length, MAX_STRING_LENGTH, 'TrackNamespace field length', messageType);
    total += length;
    assertBound(total, MAX_TRACK_NAME_LENGTH, 'TrackNamespace length', messageType);
    const bytes = reader.readBytes(length);
    namespace.push(decodeName(bytes, 'Track Namespace Field', messageType));
  }
  return namespace;
}

/** Encode a Track Name; §8.7 limits the Full Track Name (namespace + name) to 4,096 bytes. */
export function encodeTrackName(writer: Draft18BufferWriter, name: string, namespace: TrackNamespace): void {
  const bytes = TE.encode(name);
  assertBound(namespaceLength(namespace) + bytes.length, MAX_TRACK_NAME_LENGTH, 'Full Track Name length');

  writer.writeVarInt(bytes.length);
  writer.writeBytes(bytes);
}

export function encodeString(writer: Draft18BufferWriter, str: string): void {
  const bytes = TE.encode(str);
  writer.writeVarInt(bytes.length);
  writer.writeBytes(bytes);
}

export function decodeString(
  reader: Draft18BufferReader,
  messageType?: MessageTypeDraft18,
  maxLength = MAX_STRING_LENGTH,
): string {
  const length = reader.readVarIntNumber();
  assertBound(length, maxLength, 'string length', messageType);
  const bytes = reader.readBytes(length);
  return TD.decode(bytes);
}

/**
 * Encode a Reason Phrase. §8.5 caps it at 1024 bytes; a longer diagnostic is
 * cut on a UTF-8 character boundary rather than failing the message.
 */
export function encodeReasonPhrase(writer: Draft18BufferWriter, reason: string): void {
  const bytes = TE.encode(reason);
  let end = Math.min(bytes.length, MAX_REASON_PHRASE_LENGTH);
  while (end < bytes.length && end > 0 && (bytes[end] & UTF8_CONTINUATION_MASK) === UTF8_CONTINUATION_BITS) {
    end--;
  }

  writer.writeVarInt(end);
  writer.writeBytes(bytes.subarray(0, end));
}

/** Decode a Reason Phrase; §8.5: a length over 1024 bytes closes the session. */
export function decodeReasonPhrase(reader: Draft18BufferReader, messageType?: MessageTypeDraft18): string {
  const length = reader.readVarIntNumber();
  if (length > MAX_REASON_PHRASE_LENGTH) {
    throw new Draft18CodecError(
      `Reason Phrase length ${length} exceeds ${MAX_REASON_PHRASE_LENGTH} (PROTOCOL_VIOLATION)`,
      messageType,
      'bounds-exceeded',
    );
  }

  return TD.decode(reader.readBytes(length));
}

/**
 * Decode a Track Name. §8.7 bounds the Full Track Name: the namespace field
 * lengths plus the name length may not exceed MAX_TRACK_NAME_LENGTH.
 */
export function decodeTrackName(
  reader: Draft18BufferReader,
  messageType?: MessageTypeDraft18,
  namespace: TrackNamespace = [],
): string {
  const length = reader.readVarIntNumber();
  assertBound(
    namespaceLength(namespace) + length,
    MAX_TRACK_NAME_LENGTH,
    'Full Track Name length',
    messageType,
  );
  const bytes = reader.readBytes(length);
  return decodeName(bytes, 'Track Name', messageType);
}

// =============================================================================
// Key-Value-Pairs (Track Properties, Namespace Parameters)
// =============================================================================

/** Encode delta-keyed KVPs: even keys carry a varint, odd keys are length-prefixed. */
export function encodeKeyValuePairs(writer: Draft18BufferWriter, pairs: Map<number, Uint8Array>): void {
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

/** Decode delta-keyed KVPs until the reader is exhausted. */
export function decodeKeyValuePairsToEnd(reader: Draft18BufferReader): Map<number, Uint8Array> {
  const pairs = new Map<number, Uint8Array>();
  let previousKey = 0n;

  while (reader.hasMore) {
    const bigKey = readKvpKey(reader, previousKey);
    previousKey = bigKey;

    if (bigKey > MAX_SAFE_KEY) {
      skipKvpValue(reader, bigKey);
      continue;
    }

    const key = Number(bigKey);
    if (key % 2 === 0) {
      const value = reader.readVarInt();
      pairs.set(key, MOQTVarInt.encode(value));
    } else {
      pairs.set(key, reader.readBytes(readKvpLength(reader, 'KVP value length')));
    }
  }

  return pairs;
}

// =============================================================================
// Authorization Token (§8.9)
// =============================================================================

/** Token structure Alias Type code points (§8.9). */
export enum AuthTokenAliasType {
  DELETE = 0,
  REGISTER = 1,
  USE_ALIAS = 2,
  USE_VALUE = 3,
}

/**
 * Encode a Token structure: Alias Type (vi64) | [Token Alias (vi64)] |
 * [Token Type (vi64)] | [Token Value (..)]. Unlike the draft-14/16 token,
 * every integer is a MOQT vi64.
 */
export function encodeDraft18AuthToken(token: AuthorizationToken): Uint8Array {
  if (token.aliasType < AuthTokenAliasType.DELETE || token.aliasType > AuthTokenAliasType.USE_VALUE) {
    throw new Draft18CodecError(`Unknown auth token aliasType: ${token.aliasType}`);
  }

  const hasAlias = token.aliasType !== AuthTokenAliasType.USE_VALUE;
  const hasValue = token.aliasType === AuthTokenAliasType.REGISTER ||
    token.aliasType === AuthTokenAliasType.USE_VALUE;

  const writer = new Draft18BufferWriter();
  writer.writeVarInt(token.aliasType);

  if (hasAlias) {
    if (token.tokenAlias === undefined) {
      throw new Draft18CodecError('tokenAlias required for this aliasType');
    }
    writer.writeVarInt(token.tokenAlias);
  }

  if (hasValue) {
    if (token.tokenType === undefined || !token.tokenValue) {
      throw new Draft18CodecError('tokenType and tokenValue required for this aliasType');
    }
    writer.writeVarInt(token.tokenType);
    writer.writeBytes(token.tokenValue);
  }

  return writer.toUint8Array();
}

/**
 * Error tag for a Token structure that cannot be decoded: the receiver MUST
 * close the session with KEY_VALUE_FORMATTING_ERROR (§8.9).
 */
export const AUTH_TOKEN_FORMAT_ERROR = 'key-value-formatting-error';

/**
 * Error tag for a Token that registers an Alias with no token cache: the
 * receiver MUST close the session with AUTH_TOKEN_CACHE_OVERFLOW (§8.9).
 */
export const AUTH_TOKEN_CACHE_OVERFLOW_ERROR = 'auth-token-cache-overflow';

/**
 * Error tag for a Token that uses or deletes an Alias that is not registered:
 * the receiver rejects the message with UNKNOWN_AUTH_TOKEN_ALIAS (§8.9). With
 * no token cache no Alias can be registered.
 */
export const AUTH_TOKEN_UNKNOWN_ALIAS_ERROR = 'unknown-auth-token-alias';

/** Decode a Token structure (see {@link encodeDraft18AuthToken}). */
export function decodeDraft18AuthToken(data: Uint8Array): AuthorizationToken {
  try {
    return readAuthToken(new Draft18BufferReader(data));
  } catch (error) {
    throw new Draft18CodecError(
      `Undecodable auth token: ${(error as Error).message} (KEY_VALUE_FORMATTING_ERROR)`,
      undefined,
      AUTH_TOKEN_FORMAT_ERROR,
    );
  }
}

function readAuthToken(reader: Draft18BufferReader): AuthorizationToken {
  const aliasType = reader.readVarIntNumber();

  switch (aliasType) {
    case AuthTokenAliasType.DELETE:
    case AuthTokenAliasType.USE_ALIAS: {
      const tokenAlias = reader.readVarIntNumber();
      if (reader.hasMore) {
        throw new Draft18CodecError('Unexpected Token Type/Value for this aliasType');
      }
      return { aliasType, tokenAlias };
    }

    case AuthTokenAliasType.REGISTER: {
      const tokenAlias = reader.readVarIntNumber();
      const tokenType = reader.readVarIntNumber();
      return { aliasType, tokenAlias, tokenType, tokenValue: reader.readBytes(reader.remaining).slice() };
    }

    case AuthTokenAliasType.USE_VALUE: {
      const tokenType = reader.readVarIntNumber();
      return { aliasType, tokenType, tokenValue: reader.readBytes(reader.remaining).slice() };
    }

    default:
      throw new Draft18CodecError(`Unknown auth token aliasType: ${aliasType}`);
  }
}

// =============================================================================
// Message Framing
// =============================================================================

/**
 * How a control message's Message Length is framed (§9), and the size limits
 * on each direction. Drafts 18-22 use a 16-bit length; draft-23 a vi64,
 * bounded by MAX_CONTROL_MESSAGE_SIZE (§9.1.8).
 */
export interface ControlFraming {
  readonly varintLength: boolean;
  /** Largest body this endpoint may send: the peer's limit */
  readonly maxSendLength: number;
  /** Largest body this endpoint accepts: its own limit */
  readonly maxReceiveLength: number;
}

/** Drafts 18-22: Message Length (16) */
export const FRAMING_LENGTH16: ControlFraming = {
  varintLength: false,
  maxSendLength: MAX_CONTROL_MESSAGE_LENGTH,
  maxReceiveLength: MAX_CONTROL_MESSAGE_LENGTH,
};

/** Draft-23 §9.1.8: MAX_CONTROL_MESSAGE_SIZE when absent, and its minimum */
export const DEFAULT_MAX_CONTROL_MESSAGE_SIZE = 65535;

/** Reject a body larger than the framing lets this endpoint send (§9). */
export function assertControlLength(length: number, framing: ControlFraming = FRAMING_LENGTH16): void {
  if (length > framing.maxSendLength) {
    throw new Draft18CodecError(
      `Control message body ${length} exceeds ${framing.maxSendLength} bytes`,
      undefined,
      'bounds-exceeded',
      'field-length',
    );
  }
}

/**
 * Write `prefix | Message Length | body` in one allocation; the body is never
 * copied into an intermediate buffer.
 */
function writeFrame(prefix: Uint8Array | undefined, body: Draft18BufferWriter, framing: ControlFraming): Uint8Array {
  const length = body.length;
  assertControlLength(length, framing);

  const lengthBytes = framing.varintLength
    ? MOQTVarInt.encode(length)
    : new Uint8Array([(length >> 8) & 0xff, length & 0xff]);

  return prefix ? body.toUint8ArrayWithPrefix(prefix, lengthBytes) : body.toUint8ArrayWithPrefix(lengthBytes);
}

/**
 * Read the Message Length at `offset`. Returns the length and the size of the
 * field, or undefined if `buffer` ends inside the field. A length above the
 * receive limit throws before any of the body is buffered (§9, §15.5).
 */
export function readFrameLength(
  buffer: Uint8Array,
  offset: number,
  framing: ControlFraming = FRAMING_LENGTH16,
): [number, number] | undefined {
  if (!framing.varintLength) {
    if (buffer.length < offset + 2) {
      return undefined;
    }

    return [(buffer[offset] << 8) | buffer[offset + 1], 2];
  }

  if (buffer.length <= offset || buffer.length < offset + MOQTVarInt.lengthFromFirstByte(buffer[offset])) {
    return undefined;
  }
  const [length, fieldSize] = MOQTVarInt.decode(buffer, offset);
  if (length > BigInt(framing.maxReceiveLength)) {
    throw new Draft18CodecError(
      `Control message length ${length} exceeds ${framing.maxReceiveLength} bytes`,
      undefined,
      'bounds-exceeded',
      'field-length',
    );
  }

  return [Number(length), fieldSize];
}

/**
 * Total size of the framed control message at `offset` (type, length and
 * body), or undefined if the header is not all there yet. Lets a stream
 * reader wait for a whole message before decoding it once.
 */
export function controlFrameSize(
  buffer: Uint8Array,
  offset: number,
  framing: ControlFraming = FRAMING_LENGTH16,
): number | undefined {
  if (buffer.length <= offset) {
    return undefined;
  }
  const typeSize = MOQTVarInt.lengthFromFirstByte(buffer[offset]);
  const header = readFrameLength(buffer, offset + typeSize, framing);

  return header ? typeSize + header[1] + header[0] : undefined;
}

/**
 * Encode a control message with the standard framing:
 *   Message Type (MOQT varint) | Message Length | Payload
 */
export function encodeFramed(
  messageType: number,
  encodePayload: (writer: Draft18BufferWriter) => void,
  framing: ControlFraming = FRAMING_LENGTH16,
): Uint8Array {
  const payloadWriter = new Draft18BufferWriter();
  encodePayload(payloadWriter);

  return writeFrame(MOQTVarInt.encode(messageType), payloadWriter, framing);
}

/**
 * Encode a SETUP for the setup stream, where the type is the stream type:
 *   Message Length | Setup Options
 */
export function encodeUntypedFrame(
  encodePayload: (writer: Draft18BufferWriter) => void,
  framing: ControlFraming = FRAMING_LENGTH16,
): Uint8Array {
  const payloadWriter = new Draft18BufferWriter();
  encodePayload(payloadWriter);

  return writeFrame(undefined, payloadWriter, framing);
}

/**
 * Read the Message Type of a framed control message. A type cut short by the
 * end of `buffer` is "incomplete", not malformed.
 */
export function peekMessageType(buffer: Uint8Array, offset: number): number {
  try {
    return MOQTVarInt.decodeNumber(buffer, offset)[0];
  } catch (err) {
    if (/underflow/i.test((err as Error).message)) {
      throw new Draft18CodecError('Incomplete message: truncated message type', undefined, CODEC_INCOMPLETE);
    }
    throw new Draft18CodecError(`Invalid message type: ${(err as Error).message} (PROTOCOL_VIOLATION)`, undefined, CODEC_MALFORMED);
  }
}

/**
 * Decode a framed control message:
 *   Message Type (MOQT varint) | Message Length | Payload
 *
 * Returns the decoded message and total bytes consumed (header + payload).
 */
export function decodeFramed<T>(
  buffer: Uint8Array,
  offset: number,
  decodePayload: (reader: Draft18BufferReader) => T,
  framing: ControlFraming = FRAMING_LENGTH16,
): [T, number] {
  peekMessageType(buffer, offset);
  const typeBytesRead = MOQTVarInt.lengthFromFirstByte(buffer[offset]);
  const [message, frameBytes] = decodeUntypedFrame(buffer, offset + typeBytesRead, decodePayload, framing);

  return [message, typeBytesRead + frameBytes];
}

/**
 * Decode `Message Length | Payload` at `offset`.
 *
 * A body that is not exactly consumed by its fields breaks §9 ("If the length
 * does not match the length of the Message Body, the receiver MUST close the
 * session"), so it is `malformed`, never `incomplete`: only the framing can be
 * incomplete.
 */
export function decodeUntypedFrame<T>(
  buffer: Uint8Array,
  offset: number,
  decodePayload: (reader: Draft18BufferReader) => T,
  framing: ControlFraming = FRAMING_LENGTH16,
): [T, number] {
  const header = readFrameLength(buffer, offset, framing);
  if (!header) {
    throw new Draft18CodecError('Incomplete message: missing length field', undefined, CODEC_INCOMPLETE);
  }
  const [payloadLength, lengthSize] = header;

  if (buffer.length < offset + lengthSize + payloadLength) {
    throw new Draft18CodecError('Incomplete message: not enough payload bytes', undefined, CODEC_INCOMPLETE);
  }

  const bodyStart = offset + lengthSize;
  const reader = new Draft18BufferReader(buffer.subarray(bodyStart, bodyStart + payloadLength));

  let message: T;
  try {
    message = decodePayload(reader);
  } catch (err) {
    if (err instanceof Draft18CodecError) {
      throw err;
    }
    throw new Draft18CodecError(
      `Message body shorter than its fields: ${(err as Error).message} (PROTOCOL_VIOLATION)`,
      undefined,
      CODEC_MALFORMED,
      'malformed-message',
    );
  }
  if (reader.hasMore) {
    throw new Draft18CodecError(
      `Message body has ${reader.remaining} trailing bytes (PROTOCOL_VIOLATION)`,
      undefined,
      CODEC_MALFORMED,
      'malformed-message',
    );
  }

  return [message, lengthSize + payloadLength];
}
