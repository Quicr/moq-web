// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Minimal CBOR Encoder/Decoder
 *
 * Implements the subset of CBOR (RFC 8949) needed for COSE/CWT:
 * - Major types 0-5, 6 (tags), 7 (simple values)
 * - Definite-length only
 * - Deterministic map key ordering for COSE Sig_structure
 *
 * Does NOT support: indefinite-length, floats, break codes.
 */

import type { CborValue } from './types.js';

// ============================================================================
// Constants
// ============================================================================

const MAX_SAFE_DECODE_DEPTH = 32;
const MAX_DECODE_LENGTH = 1_048_576; // 1 MiB

// ============================================================================
// Encoder
// ============================================================================

/**
 * Encode a CBOR value to bytes.
 */
export function cborEncode(value: CborValue): Uint8Array {
  const parts: Uint8Array[] = [];
  encodeValue(parts, value);
  return concatenate(parts);
}

/**
 * Encode a CBOR tagged value.
 */
export function cborEncodeTagged(tag: number, value: CborValue): Uint8Array {
  const parts: Uint8Array[] = [];
  parts.push(encodeHead(6, tag));
  encodeValue(parts, value);
  return concatenate(parts);
}

function encodeValue(parts: Uint8Array[], value: CborValue): void {
  if (value === null) {
    parts.push(new Uint8Array([0xf6])); // simple(22)
    return;
  }
  if (value === true) {
    parts.push(new Uint8Array([0xf5])); // simple(21)
    return;
  }
  if (value === false) {
    parts.push(new Uint8Array([0xf4])); // simple(20)
    return;
  }
  if (typeof value === 'number') {
    if (value >= 0) {
      parts.push(encodeHead(0, value));
    } else {
      parts.push(encodeHead(1, -1 - value));
    }
    return;
  }
  if (typeof value === 'bigint') {
    if (value >= 0n) {
      parts.push(encodeHeadBigInt(0, value));
    } else {
      parts.push(encodeHeadBigInt(1, -1n - value));
    }
    return;
  }
  if (typeof value === 'string') {
    const encoded = new TextEncoder().encode(value);
    parts.push(encodeHead(3, encoded.length));
    parts.push(encoded);
    return;
  }
  if (value instanceof Uint8Array) {
    parts.push(encodeHead(2, value.length));
    parts.push(value);
    return;
  }
  if (Array.isArray(value)) {
    parts.push(encodeHead(4, value.length));
    for (const item of value) {
      encodeValue(parts, item);
    }
    return;
  }
  if (value instanceof Map) {
    // Deterministic encoding: sort by encoded key bytes (CBOR canonical)
    const entries = Array.from(value.entries());
    const encodedEntries: { keyBytes: Uint8Array; key: number | string; val: CborValue }[] = [];
    for (const [key, val] of entries) {
      const keyParts: Uint8Array[] = [];
      encodeValue(keyParts, key);
      encodedEntries.push({ keyBytes: concatenate(keyParts), key, val });
    }
    // Sort by encoded key bytes (length first, then lexicographic)
    encodedEntries.sort((a, b) => {
      if (a.keyBytes.length !== b.keyBytes.length) return a.keyBytes.length - b.keyBytes.length;
      for (let i = 0; i < a.keyBytes.length; i++) {
        if (a.keyBytes[i] !== b.keyBytes[i]) return a.keyBytes[i] - b.keyBytes[i];
      }
      return 0;
    });

    parts.push(encodeHead(5, encodedEntries.length));
    for (const entry of encodedEntries) {
      parts.push(entry.keyBytes);
      encodeValue(parts, entry.val);
    }
    return;
  }

  throw new CborError(`Unsupported CBOR value type: ${typeof value}`);
}

/**
 * Encode CBOR major type + argument header.
 */
function encodeHead(majorType: number, value: number): Uint8Array {
  const mt = majorType << 5;
  if (value < 24) {
    return new Uint8Array([mt | value]);
  }
  if (value < 0x100) {
    return new Uint8Array([mt | 24, value]);
  }
  if (value < 0x10000) {
    return new Uint8Array([mt | 25, (value >> 8) & 0xff, value & 0xff]);
  }
  if (value < 0x100000000) {
    return new Uint8Array([
      mt | 26,
      (value >> 24) & 0xff,
      (value >> 16) & 0xff,
      (value >> 8) & 0xff,
      value & 0xff,
    ]);
  }
  // 8-byte encoding for large values
  const buf = new Uint8Array(9);
  buf[0] = mt | 27;
  const view = new DataView(buf.buffer);
  // Split into high/low 32-bit parts for values > 2^32
  view.setUint32(1, Math.floor(value / 0x100000000), false);
  view.setUint32(5, value >>> 0, false);
  return buf;
}

/**
 * Encode CBOR major type + argument header for bigint values.
 */
function encodeHeadBigInt(majorType: number, value: bigint): Uint8Array {
  if (value < 24n) {
    return new Uint8Array([(majorType << 5) | Number(value)]);
  }
  if (value < 0x100n) {
    return new Uint8Array([(majorType << 5) | 24, Number(value)]);
  }
  if (value < 0x10000n) {
    const n = Number(value);
    return new Uint8Array([(majorType << 5) | 25, (n >> 8) & 0xff, n & 0xff]);
  }
  if (value < 0x100000000n) {
    const n = Number(value);
    return new Uint8Array([
      (majorType << 5) | 26,
      (n >> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff,
    ]);
  }
  const buf = new Uint8Array(9);
  buf[0] = (majorType << 5) | 27;
  const view = new DataView(buf.buffer);
  view.setBigUint64(1, value, false);
  return buf;
}

// ============================================================================
// Decoder
// ============================================================================

/**
 * Decode a CBOR value from bytes.
 *
 * @param data - The CBOR bytes
 * @param offset - Starting offset (default 0)
 * @returns Decoded value and number of bytes consumed
 */
export function cborDecode(data: Uint8Array, offset = 0): { value: CborValue; bytesRead: number } {
  if (data.length === 0 || offset >= data.length) {
    throw new CborError('Empty CBOR input');
  }
  const result = decodeValue(data, offset, 0);
  return { value: result.value, bytesRead: result.offset - offset };
}

/**
 * Decode a CBOR tagged value. If the data starts with a tag, returns the tag
 * and inner value. Otherwise returns tag=-1 and the decoded value.
 */
export function cborDecodeTagged(data: Uint8Array, offset = 0): {
  tag: number;
  value: CborValue;
  bytesRead: number;
} {
  if (offset >= data.length) {
    throw new CborError('Empty CBOR input');
  }
  const initial = data[offset];
  const majorType = initial >> 5;

  if (majorType === 6) {
    // Tag
    const { value: tag, newOffset } = readArgument(data, offset);
    const inner = decodeValue(data, newOffset, 0);
    return { tag: Number(tag), value: inner.value, bytesRead: inner.offset - offset };
  }

  const result = decodeValue(data, offset, 0);
  return { tag: -1, value: result.value, bytesRead: result.offset - offset };
}

interface DecodeResult {
  value: CborValue;
  offset: number;
}

function decodeValue(data: Uint8Array, offset: number, depth: number): DecodeResult {
  if (depth > MAX_SAFE_DECODE_DEPTH) {
    throw new CborError('CBOR nesting depth exceeded');
  }
  if (offset >= data.length) {
    throw new CborError('Unexpected end of CBOR data');
  }

  const initial = data[offset];
  const majorType = initial >> 5;

  switch (majorType) {
    case 0: { // unsigned integer
      const { value, newOffset } = readArgument(data, offset);
      return { value: value <= Number.MAX_SAFE_INTEGER ? Number(value) : value, offset: newOffset };
    }
    case 1: { // negative integer
      const { value, newOffset } = readArgument(data, offset);
      if (value <= Number.MAX_SAFE_INTEGER) {
        return { value: -1 - Number(value), offset: newOffset };
      }
      return { value: -1n - value, offset: newOffset };
    }
    case 2: { // byte string
      const { value: len, newOffset } = readArgument(data, offset);
      const length = Number(len);
      validateLength(length, data.length - newOffset);
      const bytes = data.slice(newOffset, newOffset + length);
      return { value: bytes, offset: newOffset + length };
    }
    case 3: { // text string
      const { value: len, newOffset } = readArgument(data, offset);
      const length = Number(len);
      validateLength(length, data.length - newOffset);
      const bytes = data.slice(newOffset, newOffset + length);
      return { value: new TextDecoder().decode(bytes), offset: newOffset + length };
    }
    case 4: { // array
      const { value: len, newOffset } = readArgument(data, offset);
      const length = Number(len);
      if (length > MAX_DECODE_LENGTH) {
        throw new CborError(`Array too large: ${length}`);
      }
      const arr: CborValue[] = [];
      let pos = newOffset;
      for (let i = 0; i < length; i++) {
        const item = decodeValue(data, pos, depth + 1);
        arr.push(item.value);
        pos = item.offset;
      }
      return { value: arr, offset: pos };
    }
    case 5: { // map
      const { value: len, newOffset } = readArgument(data, offset);
      const length = Number(len);
      if (length > MAX_DECODE_LENGTH) {
        throw new CborError(`Map too large: ${length}`);
      }
      const map = new Map<number | string, CborValue>();
      let pos = newOffset;
      for (let i = 0; i < length; i++) {
        const keyResult = decodeValue(data, pos, depth + 1);
        const key = keyResult.value;
        pos = keyResult.offset;
        const valResult = decodeValue(data, pos, depth + 1);
        pos = valResult.offset;
        if (typeof key === 'number' || typeof key === 'string') {
          map.set(key, valResult.value);
        } else if (typeof key === 'bigint') {
          map.set(Number(key), valResult.value);
        } else {
          throw new CborError(`Unsupported map key type: ${typeof key}`);
        }
      }
      return { value: map, offset: pos };
    }
    case 6: { // tag — skip tag number, decode inner value
      const { newOffset } = readArgument(data, offset);
      const inner = decodeValue(data, newOffset, depth + 1);
      return { value: inner.value, offset: inner.offset };
    }
    case 7: { // simple values
      const additionalInfo = initial & 0x1f;
      if (additionalInfo === 20) return { value: false, offset: offset + 1 };
      if (additionalInfo === 21) return { value: true, offset: offset + 1 };
      if (additionalInfo === 22) return { value: null, offset: offset + 1 };
      // Float16/32/64 not supported
      if (additionalInfo >= 25 && additionalInfo <= 27) {
        throw new CborError('Float CBOR values not supported');
      }
      return { value: additionalInfo, offset: offset + 1 };
    }
    default:
      throw new CborError(`Unknown CBOR major type: ${majorType}`);
  }
}

/**
 * Read CBOR argument (additional info + extended value).
 */
function readArgument(data: Uint8Array, offset: number): { value: bigint; newOffset: number } {
  const initial = data[offset];
  const additionalInfo = initial & 0x1f;
  offset++;

  if (additionalInfo < 24) {
    return { value: BigInt(additionalInfo), newOffset: offset };
  }
  if (additionalInfo === 24) {
    if (offset >= data.length) throw new CborError('Unexpected end of CBOR data');
    return { value: BigInt(data[offset]), newOffset: offset + 1 };
  }
  if (additionalInfo === 25) {
    if (offset + 2 > data.length) throw new CborError('Unexpected end of CBOR data');
    const value = (data[offset] << 8) | data[offset + 1];
    return { value: BigInt(value), newOffset: offset + 2 };
  }
  if (additionalInfo === 26) {
    if (offset + 4 > data.length) throw new CborError('Unexpected end of CBOR data');
    const value = ((data[offset] << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3]) >>> 0;
    return { value: BigInt(value), newOffset: offset + 4 };
  }
  if (additionalInfo === 27) {
    if (offset + 8 > data.length) throw new CborError('Unexpected end of CBOR data');
    const view = new DataView(data.buffer, data.byteOffset + offset, 8);
    const value = view.getBigUint64(0, false);
    return { value, newOffset: offset + 8 };
  }
  throw new CborError(`Invalid CBOR additional info: ${additionalInfo}`);
}

function validateLength(length: number, available: number): void {
  if (length > MAX_DECODE_LENGTH) {
    throw new CborError(`Data too large: ${length}`);
  }
  if (length > available) {
    throw new CborError(`Insufficient data: need ${length}, have ${available}`);
  }
}

// ============================================================================
// Helpers
// ============================================================================

function concatenate(parts: Uint8Array[]): Uint8Array {
  let totalLength = 0;
  for (const p of parts) totalLength += p.length;
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const p of parts) {
    result.set(p, offset);
    offset += p.length;
  }
  return result;
}

/**
 * CBOR encoding/decoding error.
 */
export class CborError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CborError';
  }
}
