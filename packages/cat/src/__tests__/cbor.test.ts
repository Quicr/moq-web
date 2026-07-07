// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { describe, it, expect } from 'vitest';
import { cborEncode, cborDecode, cborDecodeTagged, cborEncodeTagged, CborError } from '../index.js';
import type { CborValue } from '../index.js';

describe('CBOR Codec', () => {
  describe('unsigned integers', () => {
    it('encodes/decodes small integers (0-23)', () => {
      for (const n of [0, 1, 10, 23]) {
        const encoded = cborEncode(n);
        const { value, bytesRead } = cborDecode(encoded);
        expect(value).toBe(n);
        expect(bytesRead).toBe(encoded.length);
      }
    });

    it('encodes/decodes 1-byte integers (24-255)', () => {
      for (const n of [24, 100, 255]) {
        const encoded = cborEncode(n);
        const { value } = cborDecode(encoded);
        expect(value).toBe(n);
      }
    });

    it('encodes/decodes 2-byte integers (256-65535)', () => {
      for (const n of [256, 1000, 65535]) {
        const encoded = cborEncode(n);
        const { value } = cborDecode(encoded);
        expect(value).toBe(n);
      }
    });

    it('encodes/decodes 4-byte integers', () => {
      for (const n of [65536, 1_000_000, 0xFFFFFFFF]) {
        const encoded = cborEncode(n);
        const { value } = cborDecode(encoded);
        expect(value).toBe(n);
      }
    });

    it('encodes/decodes bigint values', () => {
      const n = 0x100000000n;
      const encoded = cborEncode(n);
      const { value } = cborDecode(encoded);
      expect(value).toBe(Number(n));
    });

    it('encodes/decodes large bigint values beyond Number.MAX_SAFE_INTEGER', () => {
      const n = BigInt('18446744073709551615'); // 2^64 - 1
      const encoded = cborEncode(n);
      const { value } = cborDecode(encoded);
      expect(value).toBe(n);
    });
  });

  describe('negative integers', () => {
    it('encodes/decodes small negative integers', () => {
      for (const n of [-1, -10, -24]) {
        const encoded = cborEncode(n);
        const { value } = cborDecode(encoded);
        expect(value).toBe(n);
      }
    });

    it('encodes/decodes larger negative integers', () => {
      for (const n of [-25, -100, -256, -1000, -65536]) {
        const encoded = cborEncode(n);
        const { value } = cborDecode(encoded);
        expect(value).toBe(n);
      }
    });

    // COSE algorithm IDs are negative: ES256 = -7, ES384 = -35, ES512 = -36
    it('encodes/decodes COSE algorithm negative values', () => {
      for (const n of [-7, -35, -36]) {
        const encoded = cborEncode(n);
        const { value } = cborDecode(encoded);
        expect(value).toBe(n);
      }
    });
  });

  describe('byte strings', () => {
    it('encodes/decodes empty byte string', () => {
      const data = new Uint8Array(0);
      const encoded = cborEncode(data);
      const { value } = cborDecode(encoded);
      expect(value).toBeInstanceOf(Uint8Array);
      expect((value as Uint8Array).length).toBe(0);
    });

    it('encodes/decodes byte strings of various lengths', () => {
      for (const len of [1, 23, 24, 100, 255, 256, 1000]) {
        const data = new Uint8Array(len);
        crypto.getRandomValues(data);
        const encoded = cborEncode(data);
        const { value } = cborDecode(encoded);
        expect(value).toEqual(data);
      }
    });
  });

  describe('text strings', () => {
    it('encodes/decodes empty string', () => {
      const encoded = cborEncode('');
      const { value } = cborDecode(encoded);
      expect(value).toBe('');
    });

    it('encodes/decodes ASCII strings', () => {
      for (const s of ['hello', 'Signature1', 'https://auth.example.com']) {
        const encoded = cborEncode(s);
        const { value } = cborDecode(encoded);
        expect(value).toBe(s);
      }
    });

    it('encodes/decodes UTF-8 strings', () => {
      const s = 'Hello \u{1F30D}'; // globe emoji
      const encoded = cborEncode(s);
      const { value } = cborDecode(encoded);
      expect(value).toBe(s);
    });
  });

  describe('arrays', () => {
    it('encodes/decodes empty array', () => {
      const encoded = cborEncode([]);
      const { value } = cborDecode(encoded);
      expect(value).toEqual([]);
    });

    it('encodes/decodes array of integers', () => {
      const arr = [1, 2, 3, 4, 5];
      const encoded = cborEncode(arr);
      const { value } = cborDecode(encoded);
      expect(value).toEqual(arr);
    });

    it('encodes/decodes mixed-type arrays', () => {
      const arr: CborValue[] = ['Signature1', new Uint8Array([1, 2, 3]), new Uint8Array(0), new Uint8Array([4, 5])];
      const encoded = cborEncode(arr);
      const { value } = cborDecode(encoded);
      expect(Array.isArray(value)).toBe(true);
      const decoded = value as CborValue[];
      expect(decoded[0]).toBe('Signature1');
      expect(decoded[1]).toEqual(new Uint8Array([1, 2, 3]));
      expect((decoded[2] as Uint8Array).length).toBe(0);
      expect(decoded[3]).toEqual(new Uint8Array([4, 5]));
    });

    it('encodes/decodes nested arrays', () => {
      const arr: CborValue[] = [[1, 2], [3, [4, 5]]];
      const encoded = cborEncode(arr);
      const { value } = cborDecode(encoded);
      expect(value).toEqual(arr);
    });

    it('encodes/decodes COSE_Sign1 structure (4-element array)', () => {
      const sign1: CborValue[] = [
        new Uint8Array([0xa1, 0x01, 0x26]), // protected header
        new Map<number, CborValue>(),        // unprotected header
        new Uint8Array([1, 2, 3]),           // payload
        new Uint8Array(64),                  // signature
      ];
      const encoded = cborEncode(sign1);
      const { value } = cborDecode(encoded);
      expect(Array.isArray(value)).toBe(true);
      expect((value as CborValue[]).length).toBe(4);
    });
  });

  describe('maps', () => {
    it('encodes/decodes empty map', () => {
      const map = new Map<number, CborValue>();
      const encoded = cborEncode(map);
      const { value } = cborDecode(encoded);
      expect(value).toBeInstanceOf(Map);
      expect((value as Map<number, CborValue>).size).toBe(0);
    });

    it('encodes/decodes map with integer keys', () => {
      const map = new Map<number, CborValue>([
        [1, -7],    // alg: ES256
        [3, 'cwt'], // cty
        [4, new Uint8Array([1, 2, 3])], // kid
      ]);
      const encoded = cborEncode(map);
      const { value } = cborDecode(encoded);
      const decoded = value as Map<number, CborValue>;
      expect(decoded.get(1)).toBe(-7);
      expect(decoded.get(3)).toBe('cwt');
      expect(decoded.get(4)).toEqual(new Uint8Array([1, 2, 3]));
    });

    it('encodes maps with canonical key ordering', () => {
      // Keys should be sorted by encoded length, then lexicographically
      const map = new Map<number, CborValue>([
        [100, 'b'],
        [1, 'a'],
        [1000, 'c'],
      ]);
      const encoded = cborEncode(map);
      const { value } = cborDecode(encoded);
      const keys = Array.from((value as Map<number, CborValue>).keys());
      // 1 (1 byte) < 100 (2 bytes) < 1000 (3 bytes)
      expect(keys).toEqual([1, 100, 1000]);
    });

    it('encodes/decodes CWT claims map', () => {
      const now = Math.floor(Date.now() / 1000);
      const claims = new Map<number, CborValue>([
        [1, 'https://auth.example.com'],   // iss
        [2, 'user-123'],                    // sub
        [3, 'moq-relay'],                   // aud
        [4, now + 3600],                    // exp
        [6, now],                           // iat
      ]);
      const encoded = cborEncode(claims);
      const { value } = cborDecode(encoded);
      const decoded = value as Map<number, CborValue>;
      expect(decoded.get(1)).toBe('https://auth.example.com');
      expect(decoded.get(2)).toBe('user-123');
      expect(decoded.get(4)).toBe(now + 3600);
    });

    it('encodes/decodes nested map in array', () => {
      const inner = new Map<number, CborValue>([[1, 'test']]);
      const arr: CborValue[] = [inner, 42];
      const encoded = cborEncode(arr);
      const { value } = cborDecode(encoded);
      const decoded = value as CborValue[];
      expect(decoded[0]).toBeInstanceOf(Map);
      expect((decoded[0] as Map<number, CborValue>).get(1)).toBe('test');
      expect(decoded[1]).toBe(42);
    });
  });

  describe('simple values', () => {
    it('encodes/decodes true', () => {
      const encoded = cborEncode(true);
      const { value } = cborDecode(encoded);
      expect(value).toBe(true);
    });

    it('encodes/decodes false', () => {
      const encoded = cborEncode(false);
      const { value } = cborDecode(encoded);
      expect(value).toBe(false);
    });

    it('encodes/decodes null', () => {
      const encoded = cborEncode(null);
      const { value } = cborDecode(encoded);
      expect(value).toBe(null);
    });
  });

  describe('tags', () => {
    it('encodes/decodes tagged values', () => {
      const data = [1, 2, 3];
      const encoded = cborEncodeTagged(18, data); // COSE_Sign1 tag
      // cborDecode strips tags, returning inner value
      const { value } = cborDecode(encoded);
      expect(value).toEqual([1, 2, 3]);
    });

    it('decodes tagged values with tag info via cborDecodeTagged', () => {
      const data = [1, 2, 3];
      const encoded = cborEncodeTagged(18, data);
      const { tag, value } = cborDecodeTagged(encoded);
      expect(tag).toBe(18);
      expect(value).toEqual([1, 2, 3]);
    });

    it('returns tag=-1 for untagged values', () => {
      const encoded = cborEncode([1, 2, 3]);
      const { tag, value } = cborDecodeTagged(encoded);
      expect(tag).toBe(-1);
      expect(value).toEqual([1, 2, 3]);
    });
  });

  describe('round-trip consistency', () => {
    it('maintains byte-level equality on re-encode', () => {
      const map = new Map<number, CborValue>([
        [1, -7],
        [4, new Uint8Array([0xde, 0xad, 0xbe, 0xef])],
      ]);
      const encoded1 = cborEncode(map);
      const { value } = cborDecode(encoded1);
      const encoded2 = cborEncode(value);
      expect(encoded2).toEqual(encoded1);
    });

    it('deterministic encoding produces same bytes', () => {
      const map1 = new Map<number, CborValue>([[1, 'a'], [2, 'b'], [3, 'c']]);
      const map2 = new Map<number, CborValue>([[3, 'c'], [1, 'a'], [2, 'b']]);
      const encoded1 = cborEncode(map1);
      const encoded2 = cborEncode(map2);
      expect(encoded1).toEqual(encoded2);
    });
  });

  describe('error handling', () => {
    it('throws on empty input', () => {
      expect(() => cborDecode(new Uint8Array(0))).toThrow(CborError);
    });

    it('throws on truncated byte string', () => {
      // Byte string header says 10 bytes but only 3 available
      const bad = new Uint8Array([0x4a, 0x01, 0x02, 0x03]);
      expect(() => cborDecode(bad)).toThrow(CborError);
    });

    it('throws on truncated array', () => {
      // Array header says 5 elements but only 1 available
      const bad = new Uint8Array([0x85, 0x01]);
      expect(() => cborDecode(bad)).toThrow(CborError);
    });

    it('throws on excessive nesting depth', () => {
      // Create deeply nested arrays: [[[[...]]]]
      let data = cborEncode(42);
      for (let i = 0; i < 40; i++) {
        // Wrap in a 1-element array
        const arr = new Uint8Array(1 + data.length);
        arr[0] = 0x81; // array(1)
        arr.set(data, 1);
        data = arr;
      }
      expect(() => cborDecode(data)).toThrow(CborError);
    });

    it('throws on float values', () => {
      // CBOR half-float: 0xf9 0x3c 0x00 = 1.0
      const floatData = new Uint8Array([0xf9, 0x3c, 0x00]);
      expect(() => cborDecode(floatData)).toThrow(CborError);
    });

    it('throws on unsupported value types', () => {
      expect(() => cborEncode({} as unknown as CborValue)).toThrow(CborError);
    });
  });

  describe('bytesRead tracking', () => {
    it('returns correct bytesRead for multi-value buffer', () => {
      const val1 = cborEncode(42);
      const val2 = cborEncode('hello');
      const combined = new Uint8Array(val1.length + val2.length);
      combined.set(val1, 0);
      combined.set(val2, val1.length);

      const { value: v1, bytesRead: br1 } = cborDecode(combined);
      expect(v1).toBe(42);
      expect(br1).toBe(val1.length);

      const { value: v2 } = cborDecode(combined, br1);
      expect(v2).toBe('hello');
    });
  });
});
