// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview VarInt Codec Tests
 */

import { describe, it, expect } from 'vitest';
import { VarInt, VarIntError, BufferReader, BufferWriter } from './varint';

describe('VarInt', () => {
  describe('encodedLength', () => {
    it('returns 1 for values 0-63', () => {
      expect(VarInt.encodedLength(0)).toBe(1);
      expect(VarInt.encodedLength(63)).toBe(1);
    });

    it('returns 2 for values 64-16383', () => {
      expect(VarInt.encodedLength(64)).toBe(2);
      expect(VarInt.encodedLength(16383)).toBe(2);
    });

    it('returns 4 for values 16384-1073741823', () => {
      expect(VarInt.encodedLength(16384)).toBe(4);
      expect(VarInt.encodedLength(1073741823)).toBe(4);
    });

    it('returns 8 for larger values', () => {
      expect(VarInt.encodedLength(1073741824)).toBe(8);
    });

    it('throws for negative values', () => {
      expect(() => VarInt.encodedLength(-1)).toThrow(VarIntError);
    });
  });

  describe('encode and decode', () => {
    it('roundtrips 1-byte values', () => {
      for (const value of [0, 1, 37, 63]) {
        const encoded = VarInt.encode(value);
        expect(encoded.length).toBe(1);
        const [decoded, bytesRead] = VarInt.decode(encoded);
        expect(Number(decoded)).toBe(value);
        expect(bytesRead).toBe(1);
      }
    });

    it('roundtrips 2-byte values', () => {
      for (const value of [64, 100, 15293, 16383]) {
        const encoded = VarInt.encode(value);
        expect(encoded.length).toBe(2);
        const [decoded, bytesRead] = VarInt.decode(encoded);
        expect(Number(decoded)).toBe(value);
        expect(bytesRead).toBe(2);
      }
    });

    it('roundtrips 4-byte values', () => {
      for (const value of [16384, 100000, 494878333, 1073741823]) {
        const encoded = VarInt.encode(value);
        expect(encoded.length).toBe(4);
        const [decoded, bytesRead] = VarInt.decode(encoded);
        expect(Number(decoded)).toBe(value);
        expect(bytesRead).toBe(4);
      }
    });

    it('roundtrips 8-byte values', () => {
      const value = BigInt('151288809941952652');
      const encoded = VarInt.encode(value);
      expect(encoded.length).toBe(8);
      const [decoded, bytesRead] = VarInt.decode(encoded);
      expect(decoded).toBe(value);
      expect(bytesRead).toBe(8);
    });

    it('decodeNumber returns number type', () => {
      const encoded = VarInt.encode(12345);
      const [value] = VarInt.decodeNumber(encoded);
      expect(typeof value).toBe('number');
      expect(value).toBe(12345);
    });
  });

  describe('decode with offset', () => {
    it('decodes at specified offset', () => {
      const buffer = new Uint8Array([0xff, 0xff, 0x25, 0xff]);
      const [value, bytesRead] = VarInt.decode(buffer, 2);
      expect(Number(value)).toBe(37);
      expect(bytesRead).toBe(1);
    });
  });

  describe('lengthFromFirstByte', () => {
    it('returns correct length from first byte', () => {
      expect(VarInt.lengthFromFirstByte(0b00111111)).toBe(1); // 00xxxxxx
      expect(VarInt.lengthFromFirstByte(0b01111111)).toBe(2); // 01xxxxxx
      expect(VarInt.lengthFromFirstByte(0b10111111)).toBe(4); // 10xxxxxx
      expect(VarInt.lengthFromFirstByte(0b11111111)).toBe(8); // 11xxxxxx
    });
  });
});

describe('BufferReader', () => {
  it('reads bytes sequentially', () => {
    const buffer = new Uint8Array([1, 2, 3, 4, 5]);
    const reader = new BufferReader(buffer);

    expect(reader.readByte()).toBe(1);
    expect(reader.readByte()).toBe(2);
    expect(reader.offset).toBe(2);
    expect(reader.remaining).toBe(3);
  });

  it('reads multiple bytes', () => {
    const buffer = new Uint8Array([1, 2, 3, 4, 5]);
    const reader = new BufferReader(buffer);

    const bytes = reader.readBytes(3);
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
    expect(reader.remaining).toBe(2);
  });

  it('reads varint', () => {
    const encoded = VarInt.encode(12345);
    const reader = new BufferReader(encoded);

    const value = reader.readVarIntNumber();
    expect(value).toBe(12345);
  });

  it('reads string with length prefix', () => {
    const writer = new BufferWriter();
    writer.writeString('hello');
    const buffer = writer.toUint8Array();

    const reader = new BufferReader(buffer);
    expect(reader.readString()).toBe('hello');
  });

  it('throws on underflow', () => {
    const buffer = new Uint8Array([1, 2]);
    const reader = new BufferReader(buffer);
    reader.readBytes(2);

    expect(() => reader.readByte()).toThrow(VarIntError);
  });
});

describe('BufferWriter', () => {
  it('writes bytes', () => {
    const writer = new BufferWriter();
    writer.writeByte(1);
    writer.writeByte(2);
    writer.writeByte(3);

    const result = writer.toUint8Array();
    expect(Array.from(result)).toEqual([1, 2, 3]);
  });

  it('writes byte arrays', () => {
    const writer = new BufferWriter();
    writer.writeBytes(new Uint8Array([1, 2, 3]));
    writer.writeBytes(new Uint8Array([4, 5]));

    const result = writer.toUint8Array();
    expect(Array.from(result)).toEqual([1, 2, 3, 4, 5]);
  });

  it('writes varints', () => {
    const writer = new BufferWriter();
    writer.writeVarInt(37);
    writer.writeVarInt(15293);

    const reader = new BufferReader(writer.toUint8Array());
    expect(reader.readVarIntNumber()).toBe(37);
    expect(reader.readVarIntNumber()).toBe(15293);
  });

  it('writes strings with length prefix', () => {
    const writer = new BufferWriter();
    writer.writeString('hello');

    const reader = new BufferReader(writer.toUint8Array());
    const length = reader.readVarIntNumber();
    expect(length).toBe(5);
    const bytes = reader.readBytes(length);
    expect(new TextDecoder().decode(bytes)).toBe('hello');
  });

  it('tracks total length', () => {
    const writer = new BufferWriter();
    writer.writeByte(1);
    expect(writer.length).toBe(1);

    writer.writeBytes(new Uint8Array([2, 3, 4]));
    expect(writer.length).toBe(4);
  });

  it('can be reset', () => {
    const writer = new BufferWriter();
    writer.writeByte(1);
    writer.writeByte(2);
    writer.reset();

    expect(writer.length).toBe(0);
    writer.writeByte(3);
    expect(Array.from(writer.toUint8Array())).toEqual([3]);
  });
});
