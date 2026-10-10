// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Shared codec helpers used by both draft-18 and draft-22 message codecs.
 *
 * These functions were extracted from the draft-18 codec to eliminate
 * duplication with draft-22 (which uses the same wire format for
 * track namespace tuples, strings, framing, and bounds checking).
 */

import { MOQTVarInt } from './moqt-varint.js';
import { Draft18BufferWriter, Draft18BufferReader } from './protocol-codec.js';
import { Draft18CodecError } from './draft18-message-codec.js';
import type { MessageTypeDraft18, TrackNamespace } from '../messages/types.js';

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
// Track Namespace / String Helpers
// =============================================================================

export function encodeTrackNamespace(writer: Draft18BufferWriter, namespace: TrackNamespace): void {
  writer.writeVarInt(namespace.length);
  for (const field of namespace) {
    const bytes = TE.encode(field);
    writer.writeVarInt(bytes.length);
    writer.writeBytes(bytes);
  }
}

export function decodeTrackNamespace(reader: Draft18BufferReader, messageType?: MessageTypeDraft18): TrackNamespace {
  const count = reader.readVarIntNumber();
  assertBound(count, MAX_NAMESPACE_TUPLE_COUNT, 'TrackNamespace tuple count', messageType);
  const namespace: string[] = [];
  for (let i = 0; i < count; i++) {
    const length = reader.readVarIntNumber();
    assertBound(length, MAX_STRING_LENGTH, 'TrackNamespace field length', messageType);
    const bytes = reader.readBytes(length);
    namespace.push(TD.decode(bytes));
  }
  return namespace;
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
 * Decode a Track Name (§10.7) — same wire format as decodeString but caps at
 * MAX_TRACK_NAME_LENGTH (which happens to equal MAX_STRING_LENGTH today, but
 * is a distinct semantic bound so we tag errors appropriately).
 */
export function decodeTrackName(reader: Draft18BufferReader, messageType?: MessageTypeDraft18): string {
  const length = reader.readVarIntNumber();
  assertBound(length, MAX_TRACK_NAME_LENGTH, 'TrackName length', messageType);
  const bytes = reader.readBytes(length);
  return TD.decode(bytes);
}

// =============================================================================
// Message Framing
// =============================================================================

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
