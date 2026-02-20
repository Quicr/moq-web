// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview MOQT Variable-Length Integer Codec
 *
 * Implements encoding and decoding of MOQT variable-length integers
 * as specified in draft-ietf-moq-transport Section 1.4.1. This format
 * differs from QUIC varints by using leading 1-bits to indicate length.
 *
 * Variable-length integers use 1, 2, 3, 4, 5, 6, 8, or 9 bytes depending on value:
 * - 1 byte:  0xxxxxxx                    (7-bit values,  0 to 127)
 * - 2 bytes: 10xxxxxx xxxxxxxx           (14-bit values, 0 to 16,383)
 * - 3 bytes: 110xxxxx xxxxxxxx xxxxxxxx  (21-bit values, 0 to 2,097,151)
 * - 4 bytes: 1110xxxx ...                (28-bit values, 0 to 268,435,455)
 * - 5 bytes: 11110xxx ...                (35-bit values, 0 to 34,359,738,367)
 * - 6 bytes: 111110xx ...                (42-bit values, 0 to 4,398,046,511,103)
 * - 8 bytes: 11111110 ...                (56-bit values, 0 to 72,057,594,037,927,935)
 * - 9 bytes: 11111111 ...                (64-bit values, full uint64)
 *
 * Invalid pattern: 11111100 (MUST close session with PROTOCOL_VIOLATION)
 *
 * @see https://moq-wg.github.io/moq-transport/draft-ietf-moq-transport.html#section-1.4.1
 */

import { Logger } from '../utils/logger.js';

const log = Logger.create('moqt:core:moqt-varint');

/**
 * Maximum values for each encoding length
 */
export const MOQT_VARINT_MAX_1BYTE = 127n;                        // 2^7 - 1
export const MOQT_VARINT_MAX_2BYTE = 16383n;                      // 2^14 - 1
export const MOQT_VARINT_MAX_3BYTE = 2097151n;                    // 2^21 - 1
export const MOQT_VARINT_MAX_4BYTE = 268435455n;                  // 2^28 - 1
export const MOQT_VARINT_MAX_5BYTE = 34359738367n;                // 2^35 - 1
export const MOQT_VARINT_MAX_6BYTE = 4398046511103n;              // 2^42 - 1
export const MOQT_VARINT_MAX_8BYTE = 72057594037927935n;          // 2^56 - 1
export const MOQT_VARINT_MAX = 18446744073709551615n;             // 2^64 - 1 (full uint64)

/**
 * Invalid byte pattern that triggers PROTOCOL_VIOLATION
 */
export const MOQT_VARINT_INVALID_PATTERN = 0b11111100;

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
 * MOQT Variable-Length Integer Codec
 *
 * @remarks
 * This class provides static methods for encoding and decoding
 * MOQT variable-length integers. The encoding uses leading 1-bits
 * in the first byte to indicate the total length.
 *
 * Key differences from QUIC varints:
 * - Uses leading 1-bits (not 2-bit prefix) to indicate length
 * - Supports 3, 5, 6 byte lengths (finer granularity)
 * - Maximum value is 2^64-1 (9 bytes) vs QUIC's 2^62-1 (8 bytes)
 * - Single-byte range is 0-127 (vs 0-63 for QUIC)
 */
export class MOQTVarInt {
  /**
   * Count leading one bits in a byte
   */
  private static countLeadingOnes(byte: number): number {
    let count = 0;
    for (let i = 7; i >= 0; i--) {
      if ((byte & (1 << i)) !== 0) {
        count++;
      } else {
        break;
      }
    }
    return count;
  }

  /**
   * Determine the encoded length of a value
   *
   * @param value - The value to encode (number or bigint)
   * @returns Number of bytes needed to encode the value
   * @throws {MOQTVarIntError} If value is negative or too large
   */
  static encodedLength(value: number | bigint): 1 | 2 | 3 | 4 | 5 | 6 | 8 | 9 {
    const v = BigInt(value);

    if (v < 0n) {
      throw new MOQTVarIntError('MOQT VarInt cannot encode negative values');
    }

    if (v <= MOQT_VARINT_MAX_1BYTE) return 1;
    if (v <= MOQT_VARINT_MAX_2BYTE) return 2;
    if (v <= MOQT_VARINT_MAX_3BYTE) return 3;
    if (v <= MOQT_VARINT_MAX_4BYTE) return 4;
    if (v <= MOQT_VARINT_MAX_5BYTE) return 5;
    if (v <= MOQT_VARINT_MAX_6BYTE) return 6;
    if (v <= MOQT_VARINT_MAX_8BYTE) return 8;
    if (v <= MOQT_VARINT_MAX) return 9;

    throw new MOQTVarIntError(`Value ${value} exceeds maximum MOQT VarInt (${MOQT_VARINT_MAX})`);
  }

  /**
   * Encode a value as a MOQT variable-length integer
   *
   * @param value - The value to encode (number or bigint)
   * @returns Uint8Array containing the encoded bytes
   * @throws {MOQTVarIntError} If value is negative or too large
   */
  static encode(value: number | bigint): Uint8Array {
    const v = BigInt(value);
    const length = MOQTVarInt.encodedLength(v);
    const result = new Uint8Array(length);

    log.trace('Encoding MOQT varint', { value: v.toString(), length });

    switch (length) {
      case 1:
        // 0xxxxxxx
        result[0] = Number(v);
        break;

      case 2: {
        // 10xxxxxx xxxxxxxx
        result[0] = 0b10000000 | Number((v >> 8n) & 0x3fn);
        result[1] = Number(v & 0xffn);
        break;
      }

      case 3: {
        // 110xxxxx xxxxxxxx xxxxxxxx
        result[0] = 0b11000000 | Number((v >> 16n) & 0x1fn);
        result[1] = Number((v >> 8n) & 0xffn);
        result[2] = Number(v & 0xffn);
        break;
      }

      case 4: {
        // 1110xxxx xxxxxxxx xxxxxxxx xxxxxxxx
        result[0] = 0b11100000 | Number((v >> 24n) & 0x0fn);
        result[1] = Number((v >> 16n) & 0xffn);
        result[2] = Number((v >> 8n) & 0xffn);
        result[3] = Number(v & 0xffn);
        break;
      }

      case 5: {
        // 11110xxx xxxxxxxx xxxxxxxx xxxxxxxx xxxxxxxx
        result[0] = 0b11110000 | Number((v >> 32n) & 0x07n);
        result[1] = Number((v >> 24n) & 0xffn);
        result[2] = Number((v >> 16n) & 0xffn);
        result[3] = Number((v >> 8n) & 0xffn);
        result[4] = Number(v & 0xffn);
        break;
      }

      case 6: {
        // 111110xx xxxxxxxx xxxxxxxx xxxxxxxx xxxxxxxx xxxxxxxx
        result[0] = 0b11111000 | Number((v >> 40n) & 0x03n);
        result[1] = Number((v >> 32n) & 0xffn);
        result[2] = Number((v >> 24n) & 0xffn);
        result[3] = Number((v >> 16n) & 0xffn);
        result[4] = Number((v >> 8n) & 0xffn);
        result[5] = Number(v & 0xffn);
        break;
      }

      case 8: {
        // 11111110 (56 bits of data in remaining 7 bytes)
        result[0] = 0b11111110;
        result[1] = Number((v >> 48n) & 0xffn);
        result[2] = Number((v >> 40n) & 0xffn);
        result[3] = Number((v >> 32n) & 0xffn);
        result[4] = Number((v >> 24n) & 0xffn);
        result[5] = Number((v >> 16n) & 0xffn);
        result[6] = Number((v >> 8n) & 0xffn);
        result[7] = Number(v & 0xffn);
        break;
      }

      case 9: {
        // 11111111 (64 bits of data in remaining 8 bytes)
        result[0] = 0b11111111;
        result[1] = Number((v >> 56n) & 0xffn);
        result[2] = Number((v >> 48n) & 0xffn);
        result[3] = Number((v >> 40n) & 0xffn);
        result[4] = Number((v >> 32n) & 0xffn);
        result[5] = Number((v >> 24n) & 0xffn);
        result[6] = Number((v >> 16n) & 0xffn);
        result[7] = Number((v >> 8n) & 0xffn);
        result[8] = Number(v & 0xffn);
        break;
      }
    }

    return result;
  }

  /**
   * Encode a value into an existing buffer at a specific offset
   *
   * @param value - The value to encode
   * @param buffer - Target buffer
   * @param offset - Offset in the buffer to write to
   * @returns Number of bytes written
   * @throws {MOQTVarIntError} If value is invalid or buffer is too small
   */
  static encodeTo(value: number | bigint, buffer: Uint8Array, offset: number): number {
    const encoded = MOQTVarInt.encode(value);

    if (offset + encoded.length > buffer.length) {
      throw new MOQTVarIntError(
        `Buffer too small: need ${encoded.length} bytes at offset ${offset}, ` +
        `but buffer is only ${buffer.length} bytes`
      );
    }

    buffer.set(encoded, offset);
    return encoded.length;
  }

  /**
   * Decode a MOQT variable-length integer from a buffer
   *
   * @param buffer - Buffer containing the encoded integer
   * @param offset - Offset to start reading from (default: 0)
   * @returns Tuple of [decoded value, number of bytes read]
   * @throws {MOQTVarIntError} If buffer is too short, data is invalid, or invalid pattern detected
   */
  static decode(buffer: Uint8Array, offset = 0): [bigint, number] {
    if (offset >= buffer.length) {
      throw new MOQTVarIntError(`Buffer underflow: offset ${offset} >= length ${buffer.length}`);
    }

    const firstByte = buffer[offset];

    // Check for invalid pattern
    if (firstByte === MOQT_VARINT_INVALID_PATTERN) {
      throw new MOQTVarIntError('Invalid MOQT VarInt pattern 0xFC (PROTOCOL_VIOLATION)');
    }

    // Determine length based on first byte pattern
    // The pattern uses leading 1-bits to indicate length:
    // - 0xxxxxxx (0 leading 1s) = 1 byte
    // - 10xxxxxx (1 leading 1) = 2 bytes
    // - 110xxxxx (2 leading 1s) = 3 bytes
    // - 1110xxxx (3 leading 1s) = 4 bytes
    // - 11110xxx (4 leading 1s) = 5 bytes
    // - 111110xx (5 leading 1s) = 6 bytes
    // - 11111100 (6 leading 1s, invalid) = PROTOCOL_VIOLATION
    // - 11111101 (6 leading 1s, invalid) = PROTOCOL_VIOLATION
    // - 11111110 (7 leading 1s) = 8 bytes
    // - 11111111 (8 leading 1s) = 9 bytes

    let length: number;

    // Check for special exact-match patterns first
    if (firstByte === 0b11111111) {
      length = 9;
    } else if (firstByte === 0b11111110) {
      length = 8;
    } else if ((firstByte & 0b11111100) === 0b11111100) {
      // Patterns 11111100 and 11111101 are invalid
      throw new MOQTVarIntError(`Invalid MOQT VarInt first byte: 0x${firstByte.toString(16)} (PROTOCOL_VIOLATION)`);
    } else {
      // Count leading ones for other patterns
      const leadingOnes = MOQTVarInt.countLeadingOnes(firstByte);
      switch (leadingOnes) {
        case 0: length = 1; break;
        case 1: length = 2; break;
        case 2: length = 3; break;
        case 3: length = 4; break;
        case 4: length = 5; break;
        case 5: length = 6; break;
        default:
          throw new MOQTVarIntError(`Invalid MOQT VarInt first byte: 0x${firstByte.toString(16)}`);
      }
    }

    if (offset + length > buffer.length) {
      throw new MOQTVarIntError(
        `Buffer underflow: need ${length} bytes at offset ${offset}, ` +
        `but only ${buffer.length - offset} bytes available`
      );
    }

    let value: bigint;

    switch (length) {
      case 1:
        value = BigInt(firstByte & 0x7f);
        break;

      case 2:
        value = (BigInt(firstByte & 0x3f) << 8n) |
                BigInt(buffer[offset + 1]);
        break;

      case 3:
        value = (BigInt(firstByte & 0x1f) << 16n) |
                (BigInt(buffer[offset + 1]) << 8n) |
                BigInt(buffer[offset + 2]);
        break;

      case 4:
        value = (BigInt(firstByte & 0x0f) << 24n) |
                (BigInt(buffer[offset + 1]) << 16n) |
                (BigInt(buffer[offset + 2]) << 8n) |
                BigInt(buffer[offset + 3]);
        break;

      case 5:
        value = (BigInt(firstByte & 0x07) << 32n) |
                (BigInt(buffer[offset + 1]) << 24n) |
                (BigInt(buffer[offset + 2]) << 16n) |
                (BigInt(buffer[offset + 3]) << 8n) |
                BigInt(buffer[offset + 4]);
        break;

      case 6:
        value = (BigInt(firstByte & 0x03) << 40n) |
                (BigInt(buffer[offset + 1]) << 32n) |
                (BigInt(buffer[offset + 2]) << 24n) |
                (BigInt(buffer[offset + 3]) << 16n) |
                (BigInt(buffer[offset + 4]) << 8n) |
                BigInt(buffer[offset + 5]);
        break;

      case 8:
        // 11111110 followed by 7 bytes (56 bits)
        value = (BigInt(buffer[offset + 1]) << 48n) |
                (BigInt(buffer[offset + 2]) << 40n) |
                (BigInt(buffer[offset + 3]) << 32n) |
                (BigInt(buffer[offset + 4]) << 24n) |
                (BigInt(buffer[offset + 5]) << 16n) |
                (BigInt(buffer[offset + 6]) << 8n) |
                BigInt(buffer[offset + 7]);
        break;

      case 9:
        // 11111111 followed by 8 bytes (64 bits)
        value = (BigInt(buffer[offset + 1]) << 56n) |
                (BigInt(buffer[offset + 2]) << 48n) |
                (BigInt(buffer[offset + 3]) << 40n) |
                (BigInt(buffer[offset + 4]) << 32n) |
                (BigInt(buffer[offset + 5]) << 24n) |
                (BigInt(buffer[offset + 6]) << 16n) |
                (BigInt(buffer[offset + 7]) << 8n) |
                BigInt(buffer[offset + 8]);
        break;

      default:
        throw new MOQTVarIntError(`Invalid length: ${length}`);
    }

    log.trace('Decoded MOQT varint', { value: value.toString(), length });

    return [value, length];
  }

  /**
   * Decode a MOQT variable-length integer and return as a number
   *
   * @param buffer - Buffer containing the encoded integer
   * @param offset - Offset to start reading from (default: 0)
   * @returns Tuple of [decoded value as number, bytes read]
   * @throws {MOQTVarIntError} If buffer is invalid or value exceeds Number.MAX_SAFE_INTEGER
   */
  static decodeNumber(buffer: Uint8Array, offset = 0): [number, number] {
    const [value, bytesRead] = MOQTVarInt.decode(buffer, offset);

    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new MOQTVarIntError(
        `Value ${value} exceeds Number.MAX_SAFE_INTEGER. Use decode() for large values.`
      );
    }

    return [Number(value), bytesRead];
  }

  /**
   * Get the encoded length by inspecting the first byte
   *
   * @param firstByte - The first byte of an encoded MOQT varint
   * @returns Number of bytes in the encoded value
   * @throws {MOQTVarIntError} If the byte pattern is invalid
   */
  static lengthFromFirstByte(firstByte: number): 1 | 2 | 3 | 4 | 5 | 6 | 8 | 9 {
    // Check for special exact-match patterns first
    if (firstByte === 0b11111111) {
      return 9;
    } else if (firstByte === 0b11111110) {
      return 8;
    } else if ((firstByte & 0b11111100) === 0b11111100) {
      // Patterns 11111100 and 11111101 are invalid
      throw new MOQTVarIntError(`Invalid MOQT VarInt pattern 0x${firstByte.toString(16)} (PROTOCOL_VIOLATION)`);
    }

    const leadingOnes = MOQTVarInt.countLeadingOnes(firstByte);

    switch (leadingOnes) {
      case 0: return 1;
      case 1: return 2;
      case 2: return 3;
      case 3: return 4;
      case 4: return 5;
      case 5: return 6;
      default:
        throw new MOQTVarIntError(`Invalid MOQT VarInt first byte: 0x${firstByte.toString(16)}`);
    }
  }
}
