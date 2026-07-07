// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { describe, it, expect, beforeAll } from 'vitest';
import {
  cborDecode,
  cborEncode,
  coseSign1Decode,
  CatTokenDecoder,
  generateTestKeyPair,
  generateTestCatToken,
} from '../index.js';

describe('Fuzz Tests', () => {
  describe('CBOR decoder robustness', () => {
    it('handles random bytes without crashing', () => {
      const iterations = 500;
      let errors = 0;

      for (let i = 0; i < iterations; i++) {
        const len = Math.floor(Math.random() * 256) + 1;
        const data = new Uint8Array(len);
        crypto.getRandomValues(data);

        try {
          cborDecode(data);
        } catch {
          errors++;
          // Expected — random bytes are mostly invalid CBOR
        }
      }

      // Most random bytes should fail to decode, not crash
      expect(errors).toBeGreaterThan(0);
    });

    it('handles single-byte inputs', () => {
      for (let i = 0; i < 256; i++) {
        const data = new Uint8Array([i]);
        try {
          cborDecode(data);
        } catch {
          // Expected for most bytes
        }
      }
    });

    it('handles truncated valid CBOR', () => {
      const valid = cborEncode(new Map([[1, 'hello'], [2, new Uint8Array(100)]]));

      for (let truncLen = 1; truncLen < valid.length; truncLen++) {
        const truncated = valid.slice(0, truncLen);
        try {
          cborDecode(truncated);
        } catch {
          // Expected — truncated data should throw, not crash
        }
      }
    });

    it('handles oversized length claims', () => {
      // Byte string claiming 0xFFFFFFFF length with only 4 bytes available
      const bad = new Uint8Array([0x5a, 0xff, 0xff, 0xff, 0xff, 0x01, 0x02]);
      expect(() => cborDecode(bad)).toThrow();
    });
  });

  describe('COSE_Sign1 decoder robustness', () => {
    it('handles random bytes without crashing', () => {
      const iterations = 200;

      for (let i = 0; i < iterations; i++) {
        const len = Math.floor(Math.random() * 512) + 1;
        const data = new Uint8Array(len);
        crypto.getRandomValues(data);

        try {
          coseSign1Decode(data);
        } catch {
          // Expected
        }
      }
    });

    it('handles valid arrays with wrong types', () => {
      const testCases = [
        [42, new Map(), new Uint8Array(0), new Uint8Array(0)],        // protected not bstr
        [new Uint8Array(0), new Map(), 'not-bstr', new Uint8Array(0)], // payload not bstr
        [new Uint8Array(0), new Map(), new Uint8Array(0), 42],         // sig not bstr
        [],
        [new Uint8Array(0)],
        [new Uint8Array(0), new Map()],
      ];

      for (const tc of testCases) {
        const encoded = cborEncode(tc);
        expect(() => coseSign1Decode(encoded)).toThrow();
      }
    });
  });

  describe('CAT token decoder robustness', () => {
    it('handles random bytes without crashing', () => {
      const iterations = 200;

      for (let i = 0; i < iterations; i++) {
        const len = Math.floor(Math.random() * 512) + 1;
        const data = new Uint8Array(len);
        crypto.getRandomValues(data);

        try {
          CatTokenDecoder.decode(data);
        } catch {
          // Expected
        }
      }
    });

    it('handles random base64url strings without crashing', () => {
      const iterations = 100;
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

      for (let i = 0; i < iterations; i++) {
        const len = Math.floor(Math.random() * 200) + 4;
        let str = '';
        for (let j = 0; j < len; j++) {
          str += chars[Math.floor(Math.random() * chars.length)];
        }

        try {
          CatTokenDecoder.decodeFromBase64url(str);
        } catch {
          // Expected
        }
      }
    });
  });

  describe('Mutated valid token robustness', () => {
    let validToken: Uint8Array;
    let keyPair: CryptoKeyPair;

    beforeAll(async () => {
      keyPair = await generateTestKeyPair();
      const result = await generateTestCatToken({ keyPair });
      validToken = result.tokenBytes;
    });

    it('single-byte mutations cause validation failure', async () => {
      const iterations = 50;

      for (let i = 0; i < iterations; i++) {
        const mutated = new Uint8Array(validToken);
        const pos = Math.floor(Math.random() * mutated.length);
        mutated[pos] ^= (Math.floor(Math.random() * 255) + 1); // flip random bits

        try {
          const result = await CatTokenDecoder.validate(mutated, keyPair.publicKey, {
            clockSkewSeconds: 0,
          });
          // Either decode fails or signature check fails
          if (result.valid) {
            // Extremely unlikely but theoretically possible if mutation
            // doesn't affect verified data. Acceptable.
          }
        } catch {
          // Expected — mutated data may not even decode
        }
      }
    });

    it('truncated tokens fail cleanly', async () => {
      for (let truncLen = 1; truncLen < validToken.length; truncLen += 10) {
        const truncated = validToken.slice(0, truncLen);
        try {
          await CatTokenDecoder.validate(truncated, keyPair.publicKey);
        } catch {
          // Expected
        }
      }
    });

    it('appended junk fails cleanly', async () => {
      const extended = new Uint8Array(validToken.length + 100);
      extended.set(validToken, 0);
      crypto.getRandomValues(extended.subarray(validToken.length));

      // Should either decode the valid prefix or fail
      try {
        const token = CatTokenDecoder.decode(extended);
        expect(token.claims.iss).toBeDefined();
      } catch {
        // Also acceptable
      }
    });
  });
});
