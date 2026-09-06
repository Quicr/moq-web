// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * A small, deterministic CBOR codec for CAT/COSE/CWT.
 *
 * The codec deliberately supports the complete set of CBOR primitives used by
 * CTA-5007-B: integers, preferred floating point values, byte/text strings,
 * arrays, maps, and tags. Indefinite-length items are rejected because they
 * are not deterministic and are unnecessary for CAT messages.
 */

import type { CborMapKey, CborTagged, CborValue } from './types.js';

const MAX_DECODE_DEPTH = 32;
const MAX_ENCODE_DEPTH = 32;
const MAX_DECODE_LENGTH = 1_048_576;
const textEncoder = new TextEncoder();
const fatalTextDecoder = new TextDecoder('utf-8', { fatal: true });

export function cborEncode(value: CborValue): Uint8Array {
  const parts: Uint8Array[] = [];
  encodeValue(parts, value, 0);
  return concatenate(parts);
}

export function cborEncodeTagged(tag: number, value: CborValue): Uint8Array {
  if (!Number.isSafeInteger(tag) || tag < 0) throw new CborError('CBOR tag must be a non-negative safe integer');
  return cborEncode({ tag, value });
}

function encodeValue(parts: Uint8Array[], value: CborValue, depth: number): void {
  if (depth > MAX_ENCODE_DEPTH) throw new CborError('CBOR encoding depth exceeded');

  if (value === null) { parts.push(new Uint8Array([0xf6])); return; }
  if (value === false) { parts.push(new Uint8Array([0xf4])); return; }
  if (value === true) { parts.push(new Uint8Array([0xf5])); return; }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new CborError('NaN and infinity are not valid CAT values');
    if (Object.is(value, -0)) throw new CborError('Negative zero is not a valid CAT value');
    if (Number.isInteger(value)) {
      if (!Number.isSafeInteger(value)) throw new CborError('Unsafe integer; use bigint');
      parts.push(value >= 0 ? encodeHead(0, BigInt(value)) : encodeHead(1, BigInt(-1 - value)));
    } else {
      parts.push(encodePreferredFloat(value));
    }
    return;
  }

  if (typeof value === 'bigint') {
    if (value >= 0n) parts.push(encodeHead(0, value));
    else parts.push(encodeHead(1, -1n - value));
    return;
  }

  if (typeof value === 'string') {
    const bytes = textEncoder.encode(value);
    parts.push(encodeHead(3, BigInt(bytes.length)), bytes);
    return;
  }

  if (value instanceof Uint8Array) {
    parts.push(encodeHead(2, BigInt(value.length)), value);
    return;
  }

  if (isCborTagged(value)) {
    if (!Number.isSafeInteger(value.tag) || value.tag < 0) throw new CborError('Invalid CBOR tag');
    parts.push(encodeHead(6, BigInt(value.tag)));
    encodeValue(parts, value.value, depth + 1);
    return;
  }

  if (Array.isArray(value)) {
    parts.push(encodeHead(4, BigInt(value.length)));
    for (const item of value) encodeValue(parts, item, depth + 1);
    return;
  }

  if (value instanceof Map) {
    const entries: { key: CborValue; keyBytes: Uint8Array; value: CborValue }[] = [];
    const seen = new Set<string>();
    for (const [key, item] of value.entries()) {
      if (typeof key !== 'number' && typeof key !== 'string' && typeof key !== 'bigint' && !Array.isArray(key)) {
        throw new CborError('CBOR map keys must be integers or text strings');
      }
      const keyBytes = cborEncode(key);
      const fingerprint = bytesToHex(keyBytes);
      if (seen.has(fingerprint)) throw new CborError('Duplicate CBOR map key');
      seen.add(fingerprint);
      entries.push({ key: key as CborValue, keyBytes, value: item });
    }
    // RFC 8949 deterministic ordering: shortest encoded key first, then bytes.
    entries.sort((a, b) => compareBytes(a.keyBytes, b.keyBytes));
    parts.push(encodeHead(5, BigInt(entries.length)));
    for (const entry of entries) {
      parts.push(entry.keyBytes);
      encodeValue(parts, entry.value, depth + 1);
    }
    return;
  }

  throw new CborError(`Unsupported CBOR value type: ${typeof value}`);
}

function encodeHead(majorType: number, value: bigint): Uint8Array {
  if (value < 0n) throw new CborError('CBOR argument cannot be negative');
  const first = majorType << 5;
  if (value < 24n) return new Uint8Array([first | Number(value)]);
  if (value <= 0xffn) return new Uint8Array([first | 24, Number(value)]);
  if (value <= 0xffffn) return new Uint8Array([first | 25, Number(value >> 8n), Number(value & 0xffn)]);
  if (value <= 0xffffffffn) {
    return new Uint8Array([first | 26, Number(value >> 24n), Number(value >> 16n) & 0xff, Number(value >> 8n) & 0xff, Number(value) & 0xff]);
  }
  if (value > 0xffffffffffffffffn) throw new CborError('CBOR argument exceeds uint64');
  const result = new Uint8Array(9);
  result[0] = first | 27;
  new DataView(result.buffer).setBigUint64(1, value, false);
  return result;
}

function encodePreferredFloat(value: number): Uint8Array {
  const half = numberToHalf(value);
  if (half !== undefined && halfToNumber(half) === value) return new Uint8Array([0xf9, half >> 8, half & 0xff]);

  const float32 = new Float32Array([value]);
  if (Number(float32[0]) === value) {
    const result = new Uint8Array(5);
    result[0] = 0xfa;
    new DataView(result.buffer).setFloat32(1, value, false);
    return result;
  }
  const result = new Uint8Array(9);
  result[0] = 0xfb;
  new DataView(result.buffer).setFloat64(1, value, false);
  return result;
}

function numberToHalf(value: number): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  const sign = value < 0 ? 0x8000 : 0;
  const abs = Math.abs(value);
  if (abs === 0) return sign;
  if (abs > 65504) return undefined;
  // Preserve exactly representable half-float subnormals. Values below the
  // smallest subnormal are left to float32/float64 rather than rounded to 0.
  if (abs < 2 ** -24) return undefined;
  if (abs < 2 ** -14) return sign | Math.round(abs / 2 ** -24);
  const exponent = Math.floor(Math.log2(abs));
  const mantissa = abs / 2 ** exponent - 1;
  const expBits = exponent + 15;
  const mantissaBits = Math.round(mantissa * 1024);
  if (mantissaBits === 1024) {
    if (expBits + 1 >= 31) return undefined;
    return sign | ((expBits + 1) << 10);
  }
  return sign | (expBits << 10) | mantissaBits;
}

function halfToNumber(bits: number): number {
  const sign = (bits & 0x8000) ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const mantissa = bits & 0x3ff;
  if (exponent === 0) return sign * 2 ** -14 * (mantissa / 1024);
  return sign * 2 ** (exponent - 15) * (1 + mantissa / 1024);
}

export function cborDecode(data: Uint8Array, offset = 0): { value: CborValue; bytesRead: number } {
  if (!(data instanceof Uint8Array) || offset < 0 || offset >= data.length) throw new CborError('Empty CBOR input');
  const result = decodeValue(data, offset, 0);
  return { value: result.value, bytesRead: result.offset - offset };
}

/** Decode exactly one complete CBOR data item. */
export function cborDecodeExact(data: Uint8Array): CborValue {
  const result = cborDecode(data);
  if (result.bytesRead !== data.length) throw new CborError('Trailing bytes after CBOR data item');
  return result.value;
}

export function cborDecodeTagged(data: Uint8Array, offset = 0): { tag: number; value: CborValue; bytesRead: number } {
  if (offset < 0 || offset >= data.length) throw new CborError('Empty CBOR input');
  const initial = data[offset];
  if ((initial >> 5) !== 6) {
    const result = decodeValue(data, offset, 0);
    return { tag: -1, value: result.value, bytesRead: result.offset - offset };
  }
  const { value: tag, newOffset } = readArgument(data, offset);
  if (tag > BigInt(Number.MAX_SAFE_INTEGER)) throw new CborError('CBOR tag exceeds supported range');
  const inner = decodeValue(data, newOffset, 0);
  return { tag: Number(tag), value: inner.value, bytesRead: inner.offset - offset };
}

interface DecodeResult { value: CborValue; offset: number }

function decodeValue(data: Uint8Array, offset: number, depth: number): DecodeResult {
  if (depth > MAX_DECODE_DEPTH) throw new CborError('CBOR nesting depth exceeded');
  if (offset >= data.length) throw new CborError('Unexpected end of CBOR data');
  const initial = data[offset];
  const majorType = initial >> 5;

  switch (majorType) {
    case 0: {
      const { value, newOffset } = readArgument(data, offset);
      return { value: value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value, offset: newOffset };
    }
    case 1: {
      const { value, newOffset } = readArgument(data, offset);
      const negative = -1n - value;
      return { value: negative >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(negative) : negative, offset: newOffset };
    }
    case 2:
    case 3: {
      const { value: lengthValue, newOffset } = readArgument(data, offset);
      if (lengthValue > BigInt(MAX_DECODE_LENGTH)) throw new CborError('CBOR string too large');
      const length = Number(lengthValue);
      if (length > data.length - newOffset) throw new CborError('Insufficient CBOR string data');
      const bytes = data.slice(newOffset, newOffset + length);
      if (majorType === 2) return { value: bytes, offset: newOffset + length };
      try {
        return { value: fatalTextDecoder.decode(bytes), offset: newOffset + length };
      } catch {
        throw new CborError('Invalid UTF-8 text string');
      }
    }
    case 4: {
      const { value: lengthValue, newOffset } = readArgument(data, offset);
      if (lengthValue > BigInt(MAX_DECODE_LENGTH) || lengthValue > BigInt(data.length - newOffset)) throw new CborError('CBOR array too large');
      const result: CborValue[] = [];
      let position = newOffset;
      for (let i = 0; i < Number(lengthValue); i++) {
        const item = decodeValue(data, position, depth + 1);
        result.push(item.value);
        position = item.offset;
      }
      return { value: result, offset: position };
    }
    case 5: {
      const { value: lengthValue, newOffset } = readArgument(data, offset);
      if (lengthValue > BigInt(MAX_DECODE_LENGTH) || lengthValue > BigInt(data.length - newOffset)) throw new CborError('CBOR map too large');
      const result = new Map<CborMapKey, CborValue>();
      const seen = new Set<string>();
      let position = newOffset;
      for (let i = 0; i < Number(lengthValue); i++) {
        const keyStart = position;
        const keyResult = decodeValue(data, position, depth + 1);
        position = keyResult.offset;
        const keyBytes = data.slice(keyStart, position);
        const key = keyResult.value;
        if (typeof key !== 'number' && typeof key !== 'string' && typeof key !== 'bigint' && !Array.isArray(key)) throw new CborError('Unsupported CBOR map key type');
        const fingerprint = bytesToHex(keyBytes);
        if (seen.has(fingerprint)) throw new CborError(`Duplicate CBOR map key: ${String(key)}`);
        seen.add(fingerprint);
        const valueResult = decodeValue(data, position, depth + 1);
        position = valueResult.offset;
        result.set(key, valueResult.value);
      }
      return { value: result, offset: position };
    }
    case 6: {
      const { value: tag, newOffset } = readArgument(data, offset);
      if (tag > BigInt(Number.MAX_SAFE_INTEGER)) throw new CborError('CBOR tag exceeds supported range');
      const inner = decodeValue(data, newOffset, depth + 1);
      // Preserve application tags. Tag 18 is unwrapped for compatibility with
      // existing callers; COSE decoders use cborDecodeTagged when tag identity
      // matters.
      if (tag === 18n) return inner;
      return { value: { tag: Number(tag), value: inner.value }, offset: inner.offset };
    }
    case 7: {
      const additional = initial & 0x1f;
      if (additional === 20) return { value: false, offset: offset + 1 };
      if (additional === 21) return { value: true, offset: offset + 1 };
      if (additional === 22) return { value: null, offset: offset + 1 };
      if (additional === 23) throw new CborError('Undefined CBOR value is not supported');
      if (additional === 24) throw new CborError('Unassigned CBOR simple value is not supported');
      if (additional === 25) {
        if (offset + 3 > data.length) throw new CborError('Unexpected end of CBOR float16');
        const bits = (data[offset + 1] << 8) | data[offset + 2];
        const value = halfToNumber(bits);
        if (!Number.isFinite(value) || Object.is(value, -0)) throw new CborError('Invalid CBOR float');
        return { value, offset: offset + 3 };
      }
      if (additional === 26) {
        if (offset + 5 > data.length) throw new CborError('Unexpected end of CBOR float32');
        const value = new DataView(data.buffer, data.byteOffset + offset + 1, 4).getFloat32(0, false);
        if (!Number.isFinite(value) || Object.is(value, -0)) throw new CborError('Invalid CBOR float');
        return { value, offset: offset + 5 };
      }
      if (additional === 27) {
        if (offset + 9 > data.length) throw new CborError('Unexpected end of CBOR float64');
        const value = new DataView(data.buffer, data.byteOffset + offset + 1, 8).getFloat64(0, false);
        if (!Number.isFinite(value) || Object.is(value, -0)) throw new CborError('Invalid CBOR float');
        return { value, offset: offset + 9 };
      }
      throw new CborError('Break code/indefinite-length CBOR is not supported');
    }
    default:
      throw new CborError(`Unknown CBOR major type: ${majorType}`);
  }
}

function readArgument(data: Uint8Array, offset: number): { value: bigint; newOffset: number } {
  const additional = data[offset] & 0x1f;
  let value: bigint;
  let newOffset = offset + 1;
  if (additional < 24) return { value: BigInt(additional), newOffset };
  if (additional === 24) {
    if (newOffset >= data.length) throw new CborError('Unexpected end of CBOR argument');
    value = BigInt(data[newOffset++]);
    if (value < 24n) throw new CborError('Non-deterministic CBOR integer encoding');
    return { value, newOffset };
  }
  if (additional === 25) {
    if (newOffset + 2 > data.length) throw new CborError('Unexpected end of CBOR argument');
    value = BigInt((data[newOffset] << 8) | data[newOffset + 1]);
    newOffset += 2;
    if (value <= 0xffn) throw new CborError('Non-deterministic CBOR integer encoding');
    return { value, newOffset };
  }
  if (additional === 26) {
    if (newOffset + 4 > data.length) throw new CborError('Unexpected end of CBOR argument');
    value = BigInt(new DataView(data.buffer, data.byteOffset + newOffset, 4).getUint32(0, false));
    newOffset += 4;
    if (value <= 0xffffn) throw new CborError('Non-deterministic CBOR integer encoding');
    return { value, newOffset };
  }
  if (additional === 27) {
    if (newOffset + 8 > data.length) throw new CborError('Unexpected end of CBOR argument');
    value = new DataView(data.buffer, data.byteOffset + newOffset, 8).getBigUint64(0, false);
    newOffset += 8;
    if (value <= 0xffffffffn) throw new CborError('Non-deterministic CBOR integer encoding');
    return { value, newOffset };
  }
  throw new CborError('Invalid CBOR additional information');
}

function isCborTagged(value: CborValue): value is CborTagged {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Uint8Array) && !(value instanceof Map) && 'tag' in value && 'value' in value;
}

function concatenate(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return a.length - b.length;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

function bytesToHex(bytes: Uint8Array): string {
  let result = '';
  for (const byte of bytes) result += byte.toString(16).padStart(2, '0');
  return result;
}

export class CborError extends Error {
  constructor(message: string) { super(message); this.name = 'CborError'; }
}
