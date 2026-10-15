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
import { Draft18CodecError } from './draft18-message-codec.js';
import type { AuthorizationToken, MessageTypeDraft18, TrackNamespace } from '../messages/types.js';

// Module-level singletons shared across helpers
const TE = new TextEncoder();
const TD = new TextDecoder();

// =============================================================================
// Codec Safety Bounds (B1 SEC)
// =============================================================================
export const MAX_PARAMETER_COUNT = 64;
export const MAX_STRING_LENGTH = 4096;
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
    throw new Draft18CodecError(`KVP key ${key} exceeds 2^64-1`);
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
    namespace.push(TD.decode(bytes));
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

export function decodeString(reader: Draft18BufferReader, messageType?: MessageTypeDraft18): string {
  const length = reader.readVarIntNumber();
  assertBound(length, MAX_STRING_LENGTH, 'string length', messageType);
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
  return TD.decode(bytes);
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

/** Decode a Token structure (see {@link encodeDraft18AuthToken}). */
export function decodeDraft18AuthToken(data: Uint8Array): AuthorizationToken {
  try {
    return readAuthToken(new Draft18BufferReader(data));
  } catch (error) {
    if (error instanceof Draft18CodecError) {
      throw error;
    }
    throw new Draft18CodecError(`Undecodable auth token: ${(error as Error).message}`);
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

/** Reject a body that the 16-bit Message Length cannot represent (§9). */
export function assertControlLength(length: number): void {
  if (length > MAX_CONTROL_MESSAGE_LENGTH) {
    throw new Draft18CodecError(
      `Control message body ${length} exceeds ${MAX_CONTROL_MESSAGE_LENGTH} bytes`,
      undefined,
      'bounds-exceeded',
    );
  }
}

/**
 * Encode a control message with the standard framing:
 *   Message Type (MOQT varint) | Message Length (16-bit BE) | Payload
 */
export function encodeFramed(
  messageType: number,
  encodePayload: (writer: Draft18BufferWriter) => void,
): Uint8Array {
  const payloadWriter = new Draft18BufferWriter();
  encodePayload(payloadWriter);
  const payload = payloadWriter.toUint8Array();
  assertControlLength(payload.length);

  const typeBytes = MOQTVarInt.encode(BigInt(messageType));
  const result = new Uint8Array(typeBytes.length + 2 + payload.length);
  result.set(typeBytes, 0);
  result[typeBytes.length] = (payload.length >> 8) & 0xFF;
  result[typeBytes.length + 1] = payload.length & 0xFF;
  result.set(payload, typeBytes.length + 2);
  return result;
}

/**
 * Decode a framed control message:
 *   Message Type (MOQT varint) | Message Length (16-bit BE) | Payload
 *
 * Returns the decoded message and total bytes consumed (header + payload).
 */
export function decodeFramed<T>(
  buffer: Uint8Array,
  offset: number,
  decodePayload: (reader: Draft18BufferReader) => T,
): [T, number] {
  const [, typeBytesRead] = MOQTVarInt.decodeNumber(buffer, offset);

  if (buffer.length < offset + typeBytesRead + 2) {
    throw new Draft18CodecError('Incomplete message: missing length field');
  }
  const payloadLength = (buffer[offset + typeBytesRead] << 8) | buffer[offset + typeBytesRead + 1];
  const headerSize = typeBytesRead + 2;

  if (buffer.length < offset + headerSize + payloadLength) {
    throw new Draft18CodecError('Incomplete message: not enough payload bytes');
  }

  const reader = new Draft18BufferReader(
    buffer.subarray(offset + headerSize, offset + headerSize + payloadLength),
  );

  const message = decodePayload(reader);
  return [message, headerSize + payloadLength];
}
