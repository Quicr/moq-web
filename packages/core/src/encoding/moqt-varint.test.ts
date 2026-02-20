// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview MOQT VarInt Codec Tests
 */

import { describe, it, expect } from 'vitest';
import {
  MOQTVarInt,
  MOQTVarIntError,
  MOQT_VARINT_MAX_1BYTE,
  MOQT_VARINT_MAX_2BYTE,
  MOQT_VARINT_MAX_3BYTE,
  MOQT_VARINT_MAX_4BYTE,
  MOQT_VARINT_MAX_5BYTE,
  MOQT_VARINT_MAX_6BYTE,
  MOQT_VARINT_MAX_8BYTE,
  MOQT_VARINT_MAX,
  MOQT_VARINT_INVALID_PATTERN,
} from './moqt-varint';

describe('MOQTVarInt', () => {
  describe('encodedLength', () => {
    it('returns 1 for values 0-127', () => {
      expect(MOQTVarInt.encodedLength(0)).toBe(1);
      expect(MOQTVarInt.encodedLength(127)).toBe(1);
      expect(MOQTVarInt.encodedLength(MOQT_VARINT_MAX_1BYTE)).toBe(1);
    });

    it('returns 2 for values 128-16383', () => {
      expect(MOQTVarInt.encodedLength(128)).toBe(2);
      expect(MOQTVarInt.encodedLength(16383)).toBe(2);
      expect(MOQTVarInt.encodedLength(MOQT_VARINT_MAX_2BYTE)).toBe(2);
    });

    it('returns 3 for values 16384-2097151', () => {
      expect(MOQTVarInt.encodedLength(16384)).toBe(3);
      expect(MOQTVarInt.encodedLength(2097151)).toBe(3);
      expect(MOQTVarInt.encodedLength(MOQT_VARINT_MAX_3BYTE)).toBe(3);
    });

    it('returns 4 for values 2097152-268435455', () => {
      expect(MOQTVarInt.encodedLength(2097152)).toBe(4);
      expect(MOQTVarInt.encodedLength(268435455)).toBe(4);
      expect(MOQTVarInt.encodedLength(MOQT_VARINT_MAX_4BYTE)).toBe(4);
    });

    it('returns 5 for values up to 2^35-1', () => {
      expect(MOQTVarInt.encodedLength(268435456n)).toBe(5);
      expect(MOQTVarInt.encodedLength(MOQT_VARINT_MAX_5BYTE)).toBe(5);
    });

    it('returns 6 for values up to 2^42-1', () => {
      expect(MOQTVarInt.encodedLength(MOQT_VARINT_MAX_5BYTE + 1n)).toBe(6);
      expect(MOQTVarInt.encodedLength(MOQT_VARINT_MAX_6BYTE)).toBe(6);
    });

    it('returns 8 for values up to 2^56-1', () => {
      expect(MOQTVarInt.encodedLength(MOQT_VARINT_MAX_6BYTE + 1n)).toBe(8);
      expect(MOQTVarInt.encodedLength(MOQT_VARINT_MAX_8BYTE)).toBe(8);
    });

    it('returns 9 for values up to 2^64-1', () => {
      expect(MOQTVarInt.encodedLength(MOQT_VARINT_MAX_8BYTE + 1n)).toBe(9);
      expect(MOQTVarInt.encodedLength(MOQT_VARINT_MAX)).toBe(9);
    });

    it('throws for negative values', () => {
      expect(() => MOQTVarInt.encodedLength(-1)).toThrow(MOQTVarIntError);
    });

    it('throws for values exceeding max', () => {
      expect(() => MOQTVarInt.encodedLength(MOQT_VARINT_MAX + 1n)).toThrow(MOQTVarIntError);
    });
  });

  describe('encode and decode', () => {
    it('roundtrips 1-byte values (0-127)', () => {
      for (const value of [0, 1, 63, 64, 100, 127]) {
        const encoded = MOQTVarInt.encode(value);
        expect(encoded.length).toBe(1);
        // First byte should not have bit 7 set for 1-byte encoding
        expect(encoded[0] & 0x80).toBe(0);
        const [decoded, bytesRead] = MOQTVarInt.decode(encoded);
        expect(Number(decoded)).toBe(value);
        expect(bytesRead).toBe(1);
      }
    });

    it('roundtrips 2-byte values (128-16383)', () => {
      for (const value of [128, 256, 1000, 15293, 16383]) {
        const encoded = MOQTVarInt.encode(value);
        expect(encoded.length).toBe(2);
        // First byte should be 10xxxxxx
        expect(encoded[0] & 0xc0).toBe(0x80);
        const [decoded, bytesRead] = MOQTVarInt.decode(encoded);
        expect(Number(decoded)).toBe(value);
        expect(bytesRead).toBe(2);
      }
    });

    it('roundtrips 3-byte values (16384-2097151)', () => {
      for (const value of [16384, 100000, 1000000, 2097151]) {
        const encoded = MOQTVarInt.encode(value);
        expect(encoded.length).toBe(3);
        // First byte should be 110xxxxx
        expect(encoded[0] & 0xe0).toBe(0xc0);
        const [decoded, bytesRead] = MOQTVarInt.decode(encoded);
        expect(Number(decoded)).toBe(value);
        expect(bytesRead).toBe(3);
      }
    });

    it('roundtrips 4-byte values (2097152-268435455)', () => {
      for (const value of [2097152, 10000000, 268435455]) {
        const encoded = MOQTVarInt.encode(value);
        expect(encoded.length).toBe(4);
        // First byte should be 1110xxxx
        expect(encoded[0] & 0xf0).toBe(0xe0);
        const [decoded, bytesRead] = MOQTVarInt.decode(encoded);
        expect(Number(decoded)).toBe(value);
        expect(bytesRead).toBe(4);
      }
    });

    it('roundtrips 5-byte values', () => {
      const value = 10000000000n; // 10 billion
      const encoded = MOQTVarInt.encode(value);
      expect(encoded.length).toBe(5);
      // First byte should be 11110xxx
      expect(encoded[0] & 0xf8).toBe(0xf0);
      const [decoded, bytesRead] = MOQTVarInt.decode(encoded);
      expect(decoded).toBe(value);
      expect(bytesRead).toBe(5);
    });

    it('roundtrips 6-byte values', () => {
      const value = 1000000000000n; // 1 trillion
      const encoded = MOQTVarInt.encode(value);
      expect(encoded.length).toBe(6);
      // First byte should be 111110xx
      expect(encoded[0] & 0xfc).toBe(0xf8);
      const [decoded, bytesRead] = MOQTVarInt.decode(encoded);
      expect(decoded).toBe(value);
      expect(bytesRead).toBe(6);
    });

    it('roundtrips 8-byte values', () => {
      const value = 10000000000000000n; // 10 quadrillion
      const encoded = MOQTVarInt.encode(value);
      expect(encoded.length).toBe(8);
      // First byte should be 11111110
      expect(encoded[0]).toBe(0xfe);
      const [decoded, bytesRead] = MOQTVarInt.decode(encoded);
      expect(decoded).toBe(value);
      expect(bytesRead).toBe(8);
    });

    it('roundtrips 9-byte values (full uint64)', () => {
      const value = MOQT_VARINT_MAX_8BYTE + 1n;
      const encoded = MOQTVarInt.encode(value);
      expect(encoded.length).toBe(9);
      // First byte should be 11111111
      expect(encoded[0]).toBe(0xff);
      const [decoded, bytesRead] = MOQTVarInt.decode(encoded);
      expect(decoded).toBe(value);
      expect(bytesRead).toBe(9);
    });

    it('roundtrips maximum value', () => {
      const value = MOQT_VARINT_MAX;
      const encoded = MOQTVarInt.encode(value);
      expect(encoded.length).toBe(9);
      const [decoded, bytesRead] = MOQTVarInt.decode(encoded);
      expect(decoded).toBe(value);
      expect(bytesRead).toBe(9);
    });

    it('decodeNumber returns number type', () => {
      const encoded = MOQTVarInt.encode(12345);
      const [value] = MOQTVarInt.decodeNumber(encoded);
      expect(typeof value).toBe('number');
      expect(value).toBe(12345);
    });

    it('decodeNumber throws for values exceeding MAX_SAFE_INTEGER', () => {
      const value = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
      const encoded = MOQTVarInt.encode(value);
      expect(() => MOQTVarInt.decodeNumber(encoded)).toThrow(MOQTVarIntError);
    });
  });

  describe('decode with offset', () => {
    it('decodes at specified offset', () => {
      const buffer = new Uint8Array([0xff, 0xff, 0x25, 0xff]); // 0x25 = 37
      const [value, bytesRead] = MOQTVarInt.decode(buffer, 2);
      expect(Number(value)).toBe(37);
      expect(bytesRead).toBe(1);
    });
  });

  describe('lengthFromFirstByte', () => {
    it('returns correct length from first byte', () => {
      // 0xxxxxxx = 1 byte
      expect(MOQTVarInt.lengthFromFirstByte(0b00000000)).toBe(1);
      expect(MOQTVarInt.lengthFromFirstByte(0b01111111)).toBe(1);

      // 10xxxxxx = 2 bytes
      expect(MOQTVarInt.lengthFromFirstByte(0b10000000)).toBe(2);
      expect(MOQTVarInt.lengthFromFirstByte(0b10111111)).toBe(2);

      // 110xxxxx = 3 bytes
      expect(MOQTVarInt.lengthFromFirstByte(0b11000000)).toBe(3);
      expect(MOQTVarInt.lengthFromFirstByte(0b11011111)).toBe(3);

      // 1110xxxx = 4 bytes
      expect(MOQTVarInt.lengthFromFirstByte(0b11100000)).toBe(4);
      expect(MOQTVarInt.lengthFromFirstByte(0b11101111)).toBe(4);

      // 11110xxx = 5 bytes
      expect(MOQTVarInt.lengthFromFirstByte(0b11110000)).toBe(5);
      expect(MOQTVarInt.lengthFromFirstByte(0b11110111)).toBe(5);

      // 111110xx = 6 bytes
      expect(MOQTVarInt.lengthFromFirstByte(0b11111000)).toBe(6);
      expect(MOQTVarInt.lengthFromFirstByte(0b11111011)).toBe(6);

      // 11111110 = 8 bytes
      expect(MOQTVarInt.lengthFromFirstByte(0b11111110)).toBe(8);

      // 11111111 = 9 bytes
      expect(MOQTVarInt.lengthFromFirstByte(0b11111111)).toBe(9);
    });

    it('throws for invalid pattern 0xFC', () => {
      expect(() => MOQTVarInt.lengthFromFirstByte(MOQT_VARINT_INVALID_PATTERN)).toThrow(
        MOQTVarIntError
      );
    });
  });

  describe('invalid pattern detection', () => {
    it('throws on decode of invalid 0xFC pattern', () => {
      const buffer = new Uint8Array([MOQT_VARINT_INVALID_PATTERN, 0, 0, 0, 0, 0, 0, 0]);
      expect(() => MOQTVarInt.decode(buffer)).toThrow('PROTOCOL_VIOLATION');
    });
  });

  describe('buffer underflow', () => {
    it('throws when buffer is too short for 2-byte value', () => {
      const buffer = new Uint8Array([0x80]); // 10xxxxxx indicates 2 bytes
      expect(() => MOQTVarInt.decode(buffer)).toThrow(MOQTVarIntError);
    });

    it('throws when buffer is too short for 3-byte value', () => {
      const buffer = new Uint8Array([0xc0, 0x00]); // 110xxxxx indicates 3 bytes
      expect(() => MOQTVarInt.decode(buffer)).toThrow(MOQTVarIntError);
    });

    it('throws when offset exceeds buffer length', () => {
      const buffer = new Uint8Array([0x25]);
      expect(() => MOQTVarInt.decode(buffer, 5)).toThrow(MOQTVarIntError);
    });
  });

  describe('encodeTo', () => {
    it('writes to buffer at specified offset', () => {
      const buffer = new Uint8Array(10);
      const bytesWritten = MOQTVarInt.encodeTo(12345, buffer, 2);
      expect(bytesWritten).toBe(2); // 12345 fits in 2 bytes for MOQT varint

      const [value, bytesRead] = MOQTVarInt.decode(buffer, 2);
      expect(Number(value)).toBe(12345);
      expect(bytesRead).toBe(2);
    });

    it('throws when buffer is too small', () => {
      const buffer = new Uint8Array(2);
      expect(() => MOQTVarInt.encodeTo(12345, buffer, 1)).toThrow(MOQTVarIntError);
    });
  });

  describe('comparison with QUIC varints', () => {
    it('encodes small values more efficiently', () => {
      // Values 64-127 use 2 bytes in QUIC but only 1 byte in MOQT
      const value = 100;
      const encoded = MOQTVarInt.encode(value);
      expect(encoded.length).toBe(1);
      expect(Number(MOQTVarInt.decode(encoded)[0])).toBe(value);
    });

    it('supports 3-byte encoding not available in QUIC', () => {
      const value = 100000;
      const encoded = MOQTVarInt.encode(value);
      expect(encoded.length).toBe(3);
      expect(Number(MOQTVarInt.decode(encoded)[0])).toBe(value);
    });

    it('supports values up to 2^64-1 (larger than QUIC max of 2^62-1)', () => {
      const value = MOQT_VARINT_MAX;
      const encoded = MOQTVarInt.encode(value);
      const [decoded] = MOQTVarInt.decode(encoded);
      expect(decoded).toBe(value);
    });
  });
});
