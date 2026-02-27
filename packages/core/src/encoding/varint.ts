// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview QUIC Variable-Length Integer Codec
 *
 * Implements encoding and decoding of QUIC variable-length integers
 * as specified in RFC 9000 Section 16. These integers are used
 * extensively in MOQT protocol messages.
 *
 * Variable-length integers use 1, 2, 4, or 8 bytes depending on value:
 * - 1 byte:  0 to 63 (6-bit values)
 * - 2 bytes: 0 to 16,383 (14-bit values)
 * - 4 bytes: 0 to 1,073,741,823 (30-bit values)
 * - 8 bytes: 0 to 4,611,686,018,427,387,903 (62-bit values)
 *
 * @see https://www.rfc-editor.org/rfc/rfc9000.html#section-16
 *
 * @example
 * ```typescript
 * import { VarInt } from 'moqt-core';
 *
 * // Encode a value
 * const encoded = VarInt.encode(16384);
 * console.log(encoded); // Uint8Array(4) [128, 0, 64, 0]
 *
 * // Decode a value
 * const [value, bytesRead] = VarInt.decode(encoded);
 * console.log(value); // 16384
 * console.log(bytesRead); // 4
 * ```
 */

import { Logger } from '../utils/logger.js';

const log = Logger.create('moqt:core:varint');

// Singleton instances to avoid repeated allocations
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Maximum value that can be encoded as a variable-length integer (62 bits)
 */
export const VARINT_MAX = BigInt('4611686018427387903'); // 2^62 - 1

/**
 * Maximum values for each encoding length
 */
export const VARINT_MAX_1BYTE = 63; // 2^6 - 1
export const VARINT_MAX_2BYTE = 16383; // 2^14 - 1
export const VARINT_MAX_4BYTE = 1073741823; // 2^30 - 1

/**
 * Length prefix bits indicating encoded length
 */
const LENGTH_PREFIX_1BYTE = 0b00;
const LENGTH_PREFIX_2BYTE = 0b01;
const LENGTH_PREFIX_4BYTE = 0b10;
const LENGTH_PREFIX_8BYTE = 0b11;

/**
 * Error thrown when varint encoding/decoding fails
 */
export class VarIntError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VarIntError';
  }
}

/**
 * QUIC Variable-Length Integer Codec
 *
 * @remarks
 * This class provides static methods for encoding and decoding
 * QUIC variable-length integers. These are used throughout the
 * MOQT protocol for efficient encoding of integer values.
 *
 * The encoding uses the two most significant bits to indicate
 * the total length of the encoded integer:
 * - 00: 1 byte (6-bit value)
 * - 01: 2 bytes (14-bit value)
 * - 10: 4 bytes (30-bit value)
 * - 11: 8 bytes (62-bit value)
 */
export class VarInt {
  /**
   * Determine the encoded length of a value
   *
   * @param value - The value to encode (number or bigint)
   * @returns Number of bytes needed to encode the value
   * @throws {VarIntError} If value is negative or too large
   *
   * @example
   * ```typescript
   * VarInt.encodedLength(63);     // 1
   * VarInt.encodedLength(64);     // 2
   * VarInt.encodedLength(16383);  // 2
   * VarInt.encodedLength(16384);  // 4
   * ```
   */
  static encodedLength(value: number | bigint): 1 | 2 | 4 | 8 {
    const v = BigInt(value);

    if (v < 0n) {
      throw new VarIntError('VarInt cannot encode negative values');
    }

    if (v <= BigInt(VARINT_MAX_1BYTE)) {
      return 1;
    } else if (v <= BigInt(VARINT_MAX_2BYTE)) {
      return 2;
    } else if (v <= BigInt(VARINT_MAX_4BYTE)) {
      return 4;
    } else if (v <= VARINT_MAX) {
      return 8;
    } else {
      throw new VarIntError(`Value ${value} exceeds maximum VarInt (${VARINT_MAX})`);
    }
  }

  /**
   * Encode a value as a variable-length integer
   *
   * @param value - The value to encode (number or bigint)
   * @returns Uint8Array containing the encoded bytes
   * @throws {VarIntError} If value is negative or too large
   *
   * @example
   * ```typescript
   * // Encode small value (1 byte)
   * VarInt.encode(37); // Uint8Array [37]
   *
   * // Encode medium value (2 bytes)
   * VarInt.encode(15293); // Uint8Array [126, 189]
   *
   * // Encode large value (4 bytes)
   * VarInt.encode(494878333); // Uint8Array [157, 122, 195, 125]
   * ```
   */
  static encode(value: number | bigint): Uint8Array {
    const v = BigInt(value);
    const length = VarInt.encodedLength(v);
    const result = new Uint8Array(length);

    log.trace('Encoding varint', { value: v.toString(), length });

    switch (length) {
      case 1:
        result[0] = Number(v) | (LENGTH_PREFIX_1BYTE << 6);
        break;

      case 2: {
        const val = Number(v) | (LENGTH_PREFIX_2BYTE << 14);
        result[0] = (val >> 8) & 0xff;
        result[1] = val & 0xff;
        break;
      }

      case 4: {
        const val = Number(v) | (LENGTH_PREFIX_4BYTE << 30);
        result[0] = (val >> 24) & 0xff;
        result[1] = (val >> 16) & 0xff;
        result[2] = (val >> 8) & 0xff;
        result[3] = val & 0xff;
        break;
      }

      case 8: {
        const val = v | (BigInt(LENGTH_PREFIX_8BYTE) << 62n);
        result[0] = Number((val >> 56n) & 0xffn);
        result[1] = Number((val >> 48n) & 0xffn);
        result[2] = Number((val >> 40n) & 0xffn);
        result[3] = Number((val >> 32n) & 0xffn);
        result[4] = Number((val >> 24n) & 0xffn);
        result[5] = Number((val >> 16n) & 0xffn);
        result[6] = Number((val >> 8n) & 0xffn);
        result[7] = Number(val & 0xffn);
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
   * @throws {VarIntError} If value is invalid or buffer is too small
   *
   * @example
   * ```typescript
   * const buffer = new Uint8Array(10);
   * const bytesWritten = VarInt.encodeTo(15293, buffer, 2);
   * // buffer[2] and buffer[3] now contain the encoded value
   * ```
   */
  static encodeTo(value: number | bigint, buffer: Uint8Array, offset: number): number {
    const encoded = VarInt.encode(value);

    if (offset + encoded.length > buffer.length) {
      throw new VarIntError(
        `Buffer too small: need ${encoded.length} bytes at offset ${offset}, ` +
        `but buffer is only ${buffer.length} bytes`
      );
    }

    buffer.set(encoded, offset);
    return encoded.length;
  }

  /**
   * Decode a variable-length integer from a buffer
   *
   * @param buffer - Buffer containing the encoded integer
   * @param offset - Offset to start reading from (default: 0)
   * @returns Tuple of [decoded value, number of bytes read]
   * @throws {VarIntError} If buffer is too short or data is invalid
   *
   * @example
   * ```typescript
   * const buffer = new Uint8Array([126, 189, 0, 0]);
   * const [value, bytesRead] = VarInt.decode(buffer);
   * console.log(value);     // 15293
   * console.log(bytesRead); // 2
   *
   * // Decode at offset
   * const [value2, bytesRead2] = VarInt.decode(buffer, 2);
   * console.log(value2); // 0
   * ```
   */
  static decode(buffer: Uint8Array, offset = 0): [bigint, number] {
    if (offset >= buffer.length) {
      throw new VarIntError(`Buffer underflow: offset ${offset} >= length ${buffer.length}`);
    }

    const firstByte = buffer[offset];
    const lengthPrefix = (firstByte >> 6) & 0b11;

    let length: number;
    switch (lengthPrefix) {
      case LENGTH_PREFIX_1BYTE:
        length = 1;
        break;
      case LENGTH_PREFIX_2BYTE:
        length = 2;
        break;
      case LENGTH_PREFIX_4BYTE:
        length = 4;
        break;
      case LENGTH_PREFIX_8BYTE:
        length = 8;
        break;
      default:
        throw new VarIntError(`Invalid length prefix: ${lengthPrefix}`);
    }

    if (offset + length > buffer.length) {
      throw new VarIntError(
        `Buffer underflow: need ${length} bytes at offset ${offset}, ` +
        `but only ${buffer.length - offset} bytes available`
      );
    }

    let value: bigint;

    switch (length) {
      case 1:
        value = BigInt(firstByte & 0x3f);
        break;

      case 2:
        value = BigInt(
          ((firstByte & 0x3f) << 8) |
          buffer[offset + 1]
        );
        break;

      case 4:
        value = BigInt(
          ((firstByte & 0x3f) << 24) |
          (buffer[offset + 1] << 16) |
          (buffer[offset + 2] << 8) |
          buffer[offset + 3]
        );
        break;

      case 8: {
        value =
          (BigInt(firstByte & 0x3f) << 56n) |
          (BigInt(buffer[offset + 1]) << 48n) |
          (BigInt(buffer[offset + 2]) << 40n) |
          (BigInt(buffer[offset + 3]) << 32n) |
          (BigInt(buffer[offset + 4]) << 24n) |
          (BigInt(buffer[offset + 5]) << 16n) |
          (BigInt(buffer[offset + 6]) << 8n) |
          BigInt(buffer[offset + 7]);
        break;
      }

      default:
        throw new VarIntError(`Invalid length: ${length}`);
    }

    log.trace('Decoded varint', { value: value.toString(), length });

    return [value, length];
  }

  /**
   * Decode a variable-length integer and return as a number
   *
   * @param buffer - Buffer containing the encoded integer
   * @param offset - Offset to start reading from (default: 0)
   * @returns Tuple of [decoded value as number, bytes read]
   * @throws {VarIntError} If buffer is invalid or value exceeds Number.MAX_SAFE_INTEGER
   *
   * @remarks
   * Use this method when you expect values within JavaScript's safe integer range.
   * For potentially large values, use decode() which returns bigint.
   *
   * @example
   * ```typescript
   * const [value, bytesRead] = VarInt.decodeNumber(buffer);
   * console.log(value); // Regular number type
   * ```
   */
  static decodeNumber(buffer: Uint8Array, offset = 0): [number, number] {
    const [value, bytesRead] = VarInt.decode(buffer, offset);

    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new VarIntError(
        `Value ${value} exceeds Number.MAX_SAFE_INTEGER. Use decode() for large values.`
      );
    }

    return [Number(value), bytesRead];
  }

  /**
   * Get the encoded length by inspecting the first byte
   *
   * @param firstByte - The first byte of an encoded varint
   * @returns Number of bytes in the encoded value
   *
   * @example
   * ```typescript
   * const length = VarInt.lengthFromFirstByte(buffer[0]);
   * // Now you know how many bytes to read
   * ```
   */
  static lengthFromFirstByte(firstByte: number): 1 | 2 | 4 | 8 {
    const prefix = (firstByte >> 6) & 0b11;
    return [1, 2, 4, 8][prefix] as 1 | 2 | 4 | 8;
  }
}

/**
 * BufferReader provides sequential reading of bytes and varints from a buffer
 *
 * @remarks
 * This utility class simplifies parsing of MOQT messages by maintaining
 * a read position and providing convenient methods for reading different
 * data types.
 *
 * @example
 * ```typescript
 * const reader = new BufferReader(messageBytes);
 *
 * const messageType = reader.readVarInt();
 * const length = reader.readVarInt();
 * const data = reader.readBytes(Number(length));
 * ```
 */
export class BufferReader {
  private readonly buffer: Uint8Array;
  private position: number;

  /**
   * Create a new BufferReader
   *
   * @param buffer - The buffer to read from
   * @param offset - Initial read position (default: 0)
   */
  constructor(buffer: Uint8Array, offset = 0) {
    this.buffer = buffer;
    this.position = offset;
  }

  /**
   * Get current read position
   */
  get offset(): number {
    return this.position;
  }

  /**
   * Get remaining bytes available to read
   */
  get remaining(): number {
    return this.buffer.length - this.position;
  }

  /**
   * Check if more bytes are available
   */
  get hasMore(): boolean {
    return this.position < this.buffer.length;
  }

  /**
   * Read a single byte
   *
   * @returns The byte value
   * @throws {VarIntError} If no bytes remain
   */
  readByte(): number {
    if (this.position >= this.buffer.length) {
      throw new VarIntError('Buffer underflow: no bytes remaining');
    }
    return this.buffer[this.position++];
  }

  /**
   * Read multiple bytes
   *
   * @param count - Number of bytes to read
   * @returns Uint8Array containing the bytes
   * @throws {VarIntError} If insufficient bytes remain
   */
  readBytes(count: number): Uint8Array {
    if (this.position + count > this.buffer.length) {
      throw new VarIntError(
        `Buffer underflow: need ${count} bytes, but only ${this.remaining} remain`
      );
    }
    const result = this.buffer.slice(this.position, this.position + count);
    this.position += count;
    return result;
  }

  /**
   * Read remaining bytes
   *
   * @returns Uint8Array containing all remaining bytes
   */
  readRemaining(): Uint8Array {
    const result = this.buffer.slice(this.position);
    this.position = this.buffer.length;
    return result;
  }

  /**
   * Read a variable-length integer as bigint
   *
   * @returns The decoded bigint value
   */
  readVarInt(): bigint {
    const [value, bytesRead] = VarInt.decode(this.buffer, this.position);
    this.position += bytesRead;
    return value;
  }

  /**
   * Read a variable-length integer as number
   *
   * @returns The decoded number value
   * @throws {VarIntError} If value exceeds Number.MAX_SAFE_INTEGER
   */
  readVarIntNumber(): number {
    const [value, bytesRead] = VarInt.decodeNumber(this.buffer, this.position);
    this.position += bytesRead;
    return value;
  }

  /**
   * Read a string with varint length prefix
   *
   * @returns The decoded string
   */
  readString(): string {
    const length = this.readVarIntNumber();
    const bytes = this.readBytes(length);
    return textDecoder.decode(bytes);
  }

  /**
   * Peek at the next byte without advancing position
   *
   * @returns The byte value, or undefined if no bytes remain
   */
  peek(): number | undefined {
    return this.buffer[this.position];
  }

  /**
   * Skip a number of bytes
   *
   * @param count - Number of bytes to skip
   */
  skip(count: number): void {
    this.position += count;
    if (this.position > this.buffer.length) {
      this.position = this.buffer.length;
    }
  }

}

/**
 * BufferWriter provides sequential writing of bytes and varints to a buffer
 *
 * @remarks
 * This utility class simplifies building MOQT messages by managing
 * buffer allocation and providing convenient write methods.
 *
 * @example
 * ```typescript
 * const writer = new BufferWriter();
 * writer.writeVarInt(MessageType.SUBSCRIBE);
 * writer.writeString('track-name');
 * writer.writeBytes(payload);
 * const message = writer.toUint8Array();
 * ```
 */
export class BufferWriter {
  private chunks: Uint8Array[] = [];
  private totalLength = 0;

  /**
   * Get total bytes written
   */
  get length(): number {
    return this.totalLength;
  }

  /**
   * Write a single byte
   *
   * @param value - Byte value (0-255)
   */
  writeByte(value: number): void {
    const chunk = new Uint8Array(1);
    chunk[0] = value & 0xff;
    this.chunks.push(chunk);
    this.totalLength += 1;
  }

  /**
   * Write multiple bytes
   *
   * @param bytes - Bytes to write
   */
  writeBytes(bytes: Uint8Array): void {
    this.chunks.push(bytes);
    this.totalLength += bytes.length;
  }

  /**
   * Write a variable-length integer
   *
   * @param value - Value to encode and write
   */
  writeVarInt(value: number | bigint): void {
    const encoded = VarInt.encode(value);
    this.chunks.push(encoded);
    this.totalLength += encoded.length;
  }

  /**
   * Write a string with varint length prefix
   *
   * @param value - String to write
   */
  writeString(value: string): void {
    const bytes = textEncoder.encode(value);
    this.writeVarInt(bytes.length);
    this.writeBytes(bytes);
  }

  /**
   * Combine all chunks into a single Uint8Array
   *
   * @returns Complete buffer with all written data
   */
  toUint8Array(): Uint8Array {
    const result = new Uint8Array(this.totalLength);
    let offset = 0;
    for (const chunk of this.chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }

  /**
   * Reset the writer for reuse
   */
  reset(): void {
    this.chunks = [];
    this.totalLength = 0;
  }
}

/**
 * Pre-allocated BufferWriter for zero-copy operations
 *
 * @remarks
 * This variant of BufferWriter uses a pre-allocated buffer for writes,
 * avoiding intermediate allocations. Use this when you know the maximum
 * size upfront for better performance.
 *
 * @example
 * ```typescript
 * // Pre-allocate 1KB buffer
 * const writer = new PreallocBufferWriter(1024);
 * writer.writeVarInt(123);
 * writer.writeBytes(payload);
 *
 * // Get a view of written data (no copy)
 * const data = writer.getWrittenView();
 *
 * // Or get a copy if needed
 * const copy = writer.toUint8Array();
 * ```
 */
export class PreallocBufferWriter {
  private buffer: Uint8Array;
  private position = 0;

  /**
   * Create a pre-allocated buffer writer
   *
   * @param capacity - Initial buffer capacity in bytes
   */
  constructor(capacity: number) {
    this.buffer = new Uint8Array(capacity);
  }

  /**
   * Get current write position (bytes written)
   */
  get length(): number {
    return this.position;
  }

  /**
   * Get remaining capacity
   */
  get remaining(): number {
    return this.buffer.length - this.position;
  }

  /**
   * Ensure capacity for additional bytes
   *
   * @param additional - Additional bytes needed
   */
  ensureCapacity(additional: number): void {
    const needed = this.position + additional;
    if (needed > this.buffer.length) {
      // Grow by 2x or to needed size, whichever is larger
      const newSize = Math.max(this.buffer.length * 2, needed);
      const newBuffer = new Uint8Array(newSize);
      newBuffer.set(this.buffer.subarray(0, this.position));
      this.buffer = newBuffer;
    }
  }

  /**
   * Write a single byte
   */
  writeByte(value: number): void {
    this.ensureCapacity(1);
    this.buffer[this.position++] = value & 0xff;
  }

  /**
   * Write multiple bytes
   */
  writeBytes(bytes: Uint8Array): void {
    this.ensureCapacity(bytes.length);
    this.buffer.set(bytes, this.position);
    this.position += bytes.length;
  }

  /**
   * Write a variable-length integer
   */
  writeVarInt(value: number | bigint): void {
    const v = BigInt(value);
    const length = VarInt.encodedLength(v);
    this.ensureCapacity(length);

    // Write directly to buffer (avoid allocation)
    const encoded = VarInt.encode(v);
    this.buffer.set(encoded, this.position);
    this.position += length;
  }

  /**
   * Write a string with varint length prefix
   */
  writeString(value: string): void {
    const bytes = textEncoder.encode(value);
    this.writeVarInt(bytes.length);
    this.writeBytes(bytes);
  }

  /**
   * Get a view of the written data (zero-copy)
   *
   * @returns A view into the buffer containing only written bytes
   */
  getWrittenView(): Uint8Array {
    return this.buffer.subarray(0, this.position);
  }

  /**
   * Get a copy of the written data
   *
   * @returns A new Uint8Array containing the written bytes
   */
  toUint8Array(): Uint8Array {
    return this.buffer.slice(0, this.position);
  }

  /**
   * Reset for reuse (keeps allocated buffer)
   */
  reset(): void {
    this.position = 0;
  }

  /**
   * Reset and optionally resize buffer
   */
  resetWithCapacity(capacity: number): void {
    this.position = 0;
    if (capacity > this.buffer.length) {
      this.buffer = new Uint8Array(capacity);
    }
  }
}
