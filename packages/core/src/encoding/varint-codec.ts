// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview VarInt Codec Abstraction Layer
 *
 * Provides a unified interface for variable-length integer encoding/decoding
 * that can switch between QUIC varints (RFC 9000) and MOQT varints
 * (draft-ietf-moq-transport Section 1.4.1) at runtime.
 *
 * @example
 * ```typescript
 * import { VarIntCodec, VarIntType, setVarIntType } from 'moqt-core';
 *
 * // Use QUIC varints (default)
 * setVarIntType(VarIntType.QUIC);
 *
 * // Switch to MOQT varints
 * setVarIntType(VarIntType.MOQT);
 *
 * // Encode/decode using current type
 * const encoded = VarIntCodec.encode(12345);
 * const [value, bytesRead] = VarIntCodec.decode(encoded);
 * ```
 */

import { VarInt } from './varint.js';
import { MOQTVarInt } from './moqt-varint.js';
import { Logger } from '../utils/logger.js';

const log = Logger.create('moqt:core:varint-codec');

/**
 * VarInt encoding type
 */
export enum VarIntType {
  /** QUIC variable-length integers (RFC 9000 Section 16) */
  QUIC = 'quic',
  /** MOQT variable-length integers (draft-ietf-moq-transport Section 1.4.1) */
  MOQT = 'moqt',
}

/**
 * Current varint type (module-level state)
 */
let currentVarIntType: VarIntType = VarIntType.QUIC;

/**
 * Get the current VarInt type
 */
export function getVarIntType(): VarIntType {
  return currentVarIntType;
}

/**
 * Set the VarInt type to use for encoding/decoding
 *
 * @param type - The VarInt type to use
 */
export function setVarIntType(type: VarIntType): void {
  if (currentVarIntType !== type) {
    log.info('Switching VarInt type', { from: currentVarIntType, to: type });
    currentVarIntType = type;
  }
}

/**
 * Unified error type for varint operations
 */
export class VarIntCodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VarIntCodecError';
  }
}

/**
 * VarInt Codec - Unified interface for variable-length integer encoding
 *
 * @remarks
 * This class provides a unified API that delegates to either QUIC or MOQT
 * varint implementations based on the current configuration.
 *
 * Key differences between QUIC and MOQT varints:
 *
 * QUIC (RFC 9000):
 * - Uses 2-bit prefix in top bits to indicate length
 * - Supports 1, 2, 4, 8 byte encodings
 * - Max value: 2^62 - 1
 * - 1-byte range: 0-63
 *
 * MOQT (draft-ietf-moq-transport):
 * - Uses leading 1-bits to indicate length
 * - Supports 1, 2, 3, 4, 5, 6, 8, 9 byte encodings
 * - Max value: 2^64 - 1
 * - 1-byte range: 0-127
 */
export class VarIntCodec {
  /**
   * Determine the encoded length of a value
   *
   * @param value - The value to encode (number or bigint)
   * @returns Number of bytes needed to encode the value
   * @throws {VarIntCodecError} If value is negative or too large
   */
  static encodedLength(value: number | bigint): number {
    try {
      return currentVarIntType === VarIntType.MOQT
        ? MOQTVarInt.encodedLength(value)
        : VarInt.encodedLength(value);
    } catch (err) {
      throw new VarIntCodecError((err as Error).message);
    }
  }

  /**
   * Encode a value as a variable-length integer
   *
   * @param value - The value to encode (number or bigint)
   * @returns Uint8Array containing the encoded bytes
   * @throws {VarIntCodecError} If value is negative or too large
   */
  static encode(value: number | bigint): Uint8Array {
    try {
      return currentVarIntType === VarIntType.MOQT
        ? MOQTVarInt.encode(value)
        : VarInt.encode(value);
    } catch (err) {
      throw new VarIntCodecError((err as Error).message);
    }
  }

  /**
   * Encode a value into an existing buffer at a specific offset
   *
   * @param value - The value to encode
   * @param buffer - Target buffer
   * @param offset - Offset in the buffer to write to
   * @returns Number of bytes written
   * @throws {VarIntCodecError} If value is invalid or buffer is too small
   */
  static encodeTo(value: number | bigint, buffer: Uint8Array, offset: number): number {
    try {
      return currentVarIntType === VarIntType.MOQT
        ? MOQTVarInt.encodeTo(value, buffer, offset)
        : VarInt.encodeTo(value, buffer, offset);
    } catch (err) {
      throw new VarIntCodecError((err as Error).message);
    }
  }

  /**
   * Decode a variable-length integer from a buffer
   *
   * @param buffer - Buffer containing the encoded integer
   * @param offset - Offset to start reading from (default: 0)
   * @returns Tuple of [decoded value, number of bytes read]
   * @throws {VarIntCodecError} If buffer is too short or data is invalid
   */
  static decode(buffer: Uint8Array, offset = 0): [bigint, number] {
    try {
      return currentVarIntType === VarIntType.MOQT
        ? MOQTVarInt.decode(buffer, offset)
        : VarInt.decode(buffer, offset);
    } catch (err) {
      throw new VarIntCodecError((err as Error).message);
    }
  }

  /**
   * Decode a variable-length integer and return as a number
   *
   * @param buffer - Buffer containing the encoded integer
   * @param offset - Offset to start reading from (default: 0)
   * @returns Tuple of [decoded value as number, bytes read]
   * @throws {VarIntCodecError} If buffer is invalid or value exceeds Number.MAX_SAFE_INTEGER
   */
  static decodeNumber(buffer: Uint8Array, offset = 0): [number, number] {
    try {
      return currentVarIntType === VarIntType.MOQT
        ? MOQTVarInt.decodeNumber(buffer, offset)
        : VarInt.decodeNumber(buffer, offset);
    } catch (err) {
      throw new VarIntCodecError((err as Error).message);
    }
  }

  /**
   * Get the encoded length by inspecting the first byte
   *
   * @param firstByte - The first byte of an encoded varint
   * @returns Number of bytes in the encoded value
   */
  static lengthFromFirstByte(firstByte: number): number {
    try {
      return currentVarIntType === VarIntType.MOQT
        ? MOQTVarInt.lengthFromFirstByte(firstByte)
        : VarInt.lengthFromFirstByte(firstByte);
    } catch (err) {
      throw new VarIntCodecError((err as Error).message);
    }
  }

  /**
   * Get the current VarInt type being used
   */
  static get type(): VarIntType {
    return currentVarIntType;
  }

  /**
   * Check if currently using MOQT varints
   */
  static get isMOQT(): boolean {
    return currentVarIntType === VarIntType.MOQT;
  }

  /**
   * Check if currently using QUIC varints
   */
  static get isQUIC(): boolean {
    return currentVarIntType === VarIntType.QUIC;
  }
}

/**
 * Create a scoped VarInt codec that uses a specific type regardless of global setting
 *
 * @param type - The VarInt type to use
 * @returns Object with encode/decode methods using the specified type
 */
export function createScopedVarIntCodec(type: VarIntType) {
  const impl = type === VarIntType.MOQT ? MOQTVarInt : VarInt;

  return {
    type,
    encodedLength: (value: number | bigint) => impl.encodedLength(value),
    encode: (value: number | bigint) => impl.encode(value),
    encodeTo: (value: number | bigint, buffer: Uint8Array, offset: number) =>
      impl.encodeTo(value, buffer, offset),
    decode: (buffer: Uint8Array, offset = 0) => impl.decode(buffer, offset),
    decodeNumber: (buffer: Uint8Array, offset = 0) => impl.decodeNumber(buffer, offset),
    lengthFromFirstByte: (firstByte: number) => impl.lengthFromFirstByte(firstByte),
  };
}
