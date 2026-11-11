// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview MOQT Variable-Length Integer Codec
 *
 * Implements encoding and decoding of MOQT variable-length integers
 * as specified in draft-ietf-moq-transport Section 1.4.1. This format
 * differs from QUIC varints by using leading 1-bits to indicate length.
 *
 * Variable-length integers use 1, 2, 3, 4, 5, 6, 7, 8, or 9 bytes depending on value:
 * - 1 byte:  0xxxxxxx                    (7-bit values,  0 to 127)
 * - 2 bytes: 10xxxxxx xxxxxxxx           (14-bit values, 0 to 16,383)
 * - 3 bytes: 110xxxxx xxxxxxxx xxxxxxxx  (21-bit values, 0 to 2,097,151)
 * - 4 bytes: 1110xxxx ...                (28-bit values, 0 to 268,435,455)
 * - 5 bytes: 11110xxx ...                (35-bit values, 0 to 34,359,738,367)
 * - 6 bytes: 111110xx ...                (42-bit values, 0 to 4,398,046,511,103)
 * - 7 bytes: 1111110x ...                (49-bit values, 0 to 562,949,953,421,311)
 * - 8 bytes: 11111110 ...                (56-bit values, 0 to 72,057,594,037,927,935)
 * - 9 bytes: 11111111 ...                (64-bit values, full uint64)
 *
 * @see https://moq-wg.github.io/moq-transport/draft-ietf-moq-transport.html#section-1.4.1
 */

/**
 * Maximum values for each encoding length
 */
export const MOQT_VARINT_MAX_1BYTE = 127n;                        // 2^7 - 1
export const MOQT_VARINT_MAX_2BYTE = 16383n;                      // 2^14 - 1
export const MOQT_VARINT_MAX_3BYTE = 2097151n;                    // 2^21 - 1
export const MOQT_VARINT_MAX_4BYTE = 268435455n;                  // 2^28 - 1
export const MOQT_VARINT_MAX_5BYTE = 34359738367n;                // 2^35 - 1
export const MOQT_VARINT_MAX_6BYTE = 4398046511103n;              // 2^42 - 1
export const MOQT_VARINT_MAX_7BYTE = 562949953421311n;            // 2^49 - 1
export const MOQT_VARINT_MAX_8BYTE = 72057594037927935n;          // 2^56 - 1
export const MOQT_VARINT_MAX = 18446744073709551615n;             // 2^64 - 1 (full uint64)

/**
 * Error thrown when MOQT varint encoding/decoding fails
 */
export class MOQTVarIntError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MOQTVarIntError';
  }
}

/**
 * Narrow a vi64 ID to a number, refusing values that a number cannot hold
 * exactly (above 2^53-1) instead of rounding them onto a neighbouring ID.
 */
export function toSafeNumber(value: bigint, what: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new MOQTVarIntError(`${what} ${value} exceeds Number.MAX_SAFE_INTEGER`);
  }

  return Number(value);
}

/**
 * MOQT Variable-Length Integer Codec
 *
 * @remarks
 * This class provides static methods for encoding and decoding
 * MOQT variable-length integers. The encoding uses leading 1-bits
 * in the first byte to indicate the total length.
 *
 * Key differences from QUIC varints:
 * - Uses leading 1-bits (not 2-bit prefix) to indicate length
 * - Supports 3, 5, 6, 7 byte lengths (finer granularity)
 * - Maximum value is 2^64-1 (9 bytes) vs QUIC's 2^62-1 (8 bytes)
 * - Single-byte range is 0-127 (vs 0-63 for QUIC)
 */
/** Bounds as numbers, for the paths that never touch BigInt */
const MAX_1 = 0x7f;
const MAX_2 = 0x3fff;
const MAX_3 = 0x1fffff;
const MAX_4 = 0xfffffff;
const MAX_5 = 0x7ffffffff;
const MAX_6 = 0x3ffffffffff;
const MAX_7 = 0x1ffffffffffff;
const TWO_32 = 0x100000000;
const MAX_SAFE_BIG = BigInt(Number.MAX_SAFE_INTEGER);
const MASK_32 = 0xffffffffn;

function underflow(need: number, offset: number, length: number): MOQTVarIntError {
  return new MOQTVarIntError(
    `Buffer underflow: need ${need} bytes at offset ${offset}, but only ${length - offset} bytes available`,
  );
}

/** A non-negative integer as a number when it is exact as one, else as a bigint. Throws if invalid. */
function normalize(value: number | bigint): number | bigint {
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new MOQTVarIntError(`MOQT VarInt cannot encode ${value}: not an integer`);
    }
    if (value < 0) {
      throw new MOQTVarIntError('MOQT VarInt cannot encode negative values');
    }
    if (value > Number.MAX_SAFE_INTEGER) {
      // Not exact, so a bigint keeps the value the caller holds
      return normalize(BigInt(value));
    }
    return value;
  }
  if (value < 0n) {
    throw new MOQTVarIntError('MOQT VarInt cannot encode negative values');
  }
  if (value > MOQT_VARINT_MAX) {
    throw new MOQTVarIntError(`Value ${value} exceeds maximum MOQT VarInt (${MOQT_VARINT_MAX})`);
  }

  return value <= MAX_SAFE_BIG ? Number(value) : value;
}

/** The encoded length of a normalized value */
function lengthOf(v: number | bigint): 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 {
  if (typeof v === 'number') {
    if (v <= MAX_1) return 1;
    if (v <= MAX_2) return 2;
    if (v <= MAX_3) return 3;
    if (v <= MAX_4) return 4;
    if (v <= MAX_5) return 5;
    if (v <= MAX_6) return 6;
    if (v <= MAX_7) return 7;
    return 8;
  }

  return v <= MOQT_VARINT_MAX_8BYTE ? 8 : 9;
}

/** Write `length` bytes of `v` (already normalized and sized) at `offset` */
function write(v: number | bigint, length: number, buffer: Uint8Array, offset: number): void {
  if (length <= 4) {
    // 28 bits or fewer: 32-bit integer arithmetic
    const n = v as number;
    switch (length) {
      case 1:
        buffer[offset] = n;
        return;
      case 2:
        buffer[offset] = 0x80 | (n >>> 8);
        buffer[offset + 1] = n & 0xff;
        return;
      case 3:
        buffer[offset] = 0xc0 | (n >>> 16);
        buffer[offset + 1] = (n >>> 8) & 0xff;
        buffer[offset + 2] = n & 0xff;
        return;
      default:
        buffer[offset] = 0xe0 | (n >>> 24);
        buffer[offset + 1] = (n >>> 16) & 0xff;
        buffer[offset + 2] = (n >>> 8) & 0xff;
        buffer[offset + 3] = n & 0xff;
        return;
    }
  }

  // Split into a high word and a low 32-bit word
  let hi: number;
  let lo: number;
  if (typeof v === 'number') {
    hi = Math.floor(v / TWO_32);
    lo = v >>> 0;
  } else {
    hi = Number(v >> 32n);
    lo = Number(v & MASK_32);
  }

  // First byte: the length prefix, plus the top high-word bits for lengths 5-7.
  // Then the rest of the high word (3 bytes for length 8, 4 for 9), then the low word.
  const middle = length === 9 ? 4 : length === 8 ? 3 : length - 5;
  const prefix = (0xff00 >> (length - 1)) & 0xff;
  buffer[offset] = length <= 7 ? prefix | (hi >>> (8 * middle)) : prefix;
  let at = offset + 1;
  for (let shift = 8 * (middle - 1); shift >= 0; shift -= 8) {
    buffer[at++] = (hi >>> shift) & 0xff;
  }
  buffer[at] = lo >>> 24;
  buffer[at + 1] = (lo >>> 16) & 0xff;
  buffer[at + 2] = (lo >>> 8) & 0xff;
  buffer[at + 3] = lo & 0xff;
}

/**
 * MOQT Variable-Length Integer Codec
 *
 * @remarks
 * The encoding uses leading 1-bits in the first byte to indicate the total
 * length. Values below 2^49 (lengths 1-7) are encoded and decoded with
 * number arithmetic; only lengths 8 and 9 touch BigInt, once per value.
 * Nothing is allocated except the result of {@link MOQTVarInt.encode}.
 *
 * Key differences from QUIC varints:
 * - Uses leading 1-bits (not 2-bit prefix) to indicate length
 * - Supports 3, 5, 6, 7 byte lengths (finer granularity)
 * - Maximum value is 2^64-1 (9 bytes) vs QUIC's 2^62-1 (8 bytes)
 * - Single-byte range is 0-127 (vs 0-63 for QUIC)
 */
export class MOQTVarInt {
  /**
   * Determine the encoded length of a value
   *
   * @throws {MOQTVarIntError} If value is negative, not an integer or too large
   */
  static encodedLength(value: number | bigint): 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 {
    return lengthOf(normalize(value));
  }

  /**
   * Encode a value as a MOQT variable-length integer
   *
   * @throws {MOQTVarIntError} If value is negative, not an integer or too large
   */
  static encode(value: number | bigint): Uint8Array {
    const v = normalize(value);
    const length = lengthOf(v);
    const result = new Uint8Array(length);
    write(v, length, result, 0);

    return result;
  }

  /**
   * Encode a value into an existing buffer, without allocating
   *
   * @returns Number of bytes written
   * @throws {MOQTVarIntError} If value is invalid or buffer is too small
   */
  static encodeTo(value: number | bigint, buffer: Uint8Array, offset: number): number {
    const v = normalize(value);
    const length = lengthOf(v);
    if (offset + length > buffer.length) {
      throw new MOQTVarIntError(
        `Buffer too small: need ${length} bytes at offset ${offset}, ` +
        `but buffer is only ${buffer.length} bytes`
      );
    }
    write(v, length, buffer, offset);

    return length;
  }

  /**
   * Decode a MOQT variable-length integer from a buffer
   *
   * @returns Tuple of [decoded value, number of bytes read]
   * @throws {MOQTVarIntError} If the buffer is too short
   */
  static decode(buffer: Uint8Array, offset = 0): [bigint, number] {
    const length = MOQTVarInt.checkedLength(buffer, offset);
    if (length <= 7) {
      return [BigInt(MOQTVarInt.readSmall(buffer, offset, length)), length];
    }

    // 8 bytes carry 56 bits after a 0xFE prefix, 9 bytes 64 bits after 0xFF
    const start = offset + 1;
    const hi = length === 8
      ? (buffer[start] << 16) | (buffer[start + 1] << 8) | buffer[start + 2]
      : ((buffer[start] << 24) | (buffer[start + 1] << 16) | (buffer[start + 2] << 8) | buffer[start + 3]) >>> 0;
    const lo = MOQTVarInt.readUint32(buffer, start + length - 5);

    return [(BigInt(hi) << 32n) | BigInt(lo), length];
  }

  /**
   * Decode a MOQT variable-length integer as a number
   *
   * @returns Tuple of [decoded value as number, bytes read]
   * @throws {MOQTVarIntError} If buffer is invalid or value exceeds Number.MAX_SAFE_INTEGER
   */
  static decodeNumber(buffer: Uint8Array, offset = 0): [number, number] {
    const length = MOQTVarInt.checkedLength(buffer, offset);
    if (length <= 7) {
      return [MOQTVarInt.readSmall(buffer, offset, length), length];
    }

    const [value] = MOQTVarInt.decode(buffer, offset);
    if (value > MAX_SAFE_BIG) {
      throw new MOQTVarIntError(
        `Value ${value} exceeds Number.MAX_SAFE_INTEGER. Use decode() for large values.`
      );
    }

    return [Number(value), length];
  }

  /**
   * Get the encoded length by inspecting the first byte
   *
   * @param firstByte - The first byte of an encoded MOQT varint
   * @returns Number of bytes in the encoded value
   */
  static lengthFromFirstByte(firstByte: number): 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 {
    // Leading ones of the byte = leading zeros of its complement in the top 8 bits
    const ones = Math.clz32(~(firstByte << 24));

    return (ones + 1) as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
  }

  private static checkedLength(buffer: Uint8Array, offset: number): 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 {
    if (offset >= buffer.length) {
      throw new MOQTVarIntError(`Buffer underflow: offset ${offset} >= length ${buffer.length}`);
    }
    const length = MOQTVarInt.lengthFromFirstByte(buffer[offset]);
    if (offset + length > buffer.length) {
      throw underflow(length, offset, buffer.length);
    }

    return length;
  }

  /** Lengths 1-7: at most 49 bits, exact as a number */
  private static readSmall(buffer: Uint8Array, offset: number, length: number): number {
    const first = buffer[offset];
    switch (length) {
      case 1:
        return first;
      case 2:
        return ((first & 0x3f) << 8) | buffer[offset + 1];
      case 3:
        return ((first & 0x1f) << 16) | (buffer[offset + 1] << 8) | buffer[offset + 2];
      case 4:
        return (((first & 0x0f) << 24) | (buffer[offset + 1] << 16) | (buffer[offset + 2] << 8) | buffer[offset + 3]) >>> 0;
      default: {
        // 5-7: high bits from the first byte and the bytes before the low word
        let hi = first & (0xff >> length);
        for (let i = 1; i <= length - 5; i++) {
          hi = hi * 256 + buffer[offset + i];
        }
        return hi * TWO_32 + MOQTVarInt.readUint32(buffer, offset + length - 4);
      }
    }
  }

  private static readUint32(buffer: Uint8Array, at: number): number {
    return ((buffer[at] << 24) | (buffer[at + 1] << 16) | (buffer[at + 2] << 8) | buffer[at + 3]) >>> 0;
  }
}
