// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { describe, it, expect } from 'vitest';
import {
  SecureObjectsContext,
  CipherSuite,
  constructNonce,
  constructAAD,
  Limits,
} from '../index.js';

function randomBytes(len: number): Uint8Array {
  const buf = new Uint8Array(len);
  const chunkSize = 65536;
  for (let offset = 0; offset < len; offset += chunkSize) {
    const size = Math.min(chunkSize, len - offset);
    crypto.getRandomValues(buf.subarray(offset, offset + size));
  }
  return buf;
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min)) + min;
}

function randomBigInt(maxBits: number): bigint {
  const bytes = randomBytes(Math.ceil(maxBits / 8));
  let result = 0n;
  for (const b of bytes) {
    result = (result << 8n) | BigInt(b);
  }
  const mask = (1n << BigInt(maxBits)) - 1n;
  return result & mask;
}

describe('Fuzz Testing', () => {
  const ITERATIONS = 25;

  describe('encrypt/decrypt round-trip with random inputs', { timeout: 30_000 }, () => {
    it('AES-128-GCM survives random plaintext sizes and object IDs', async () => {
      const key = randomBytes(32);
      const ctx = await SecureObjectsContext.create({
        trackBaseKey: key,
        track: { namespace: ['fuzz'], trackName: 'test' },
        cipherSuite: CipherSuite.AES_128_GCM_SHA256_128,
      });

      for (let i = 0; i < ITERATIONS; i++) {
        const size = randomInt(0, 50_000);
        const plaintext = randomBytes(size);
        const groupId = randomBigInt(61);
        const objectId = randomInt(0, Limits.MAX_OBJECT_ID);

        const encrypted = await ctx.encrypt(plaintext, { groupId, objectId });
        const decrypted = await ctx.decrypt(encrypted.ciphertext, { groupId, objectId });

        expect(decrypted.plaintext).toEqual(plaintext);
      }
    });

    it('AES-256-GCM survives random plaintext sizes and object IDs', async () => {
      const key = randomBytes(32);
      const ctx = await SecureObjectsContext.create({
        trackBaseKey: key,
        track: { namespace: ['fuzz', 'deep'], trackName: 'video' },
        cipherSuite: CipherSuite.AES_256_GCM_SHA512_128,
      });

      for (let i = 0; i < ITERATIONS; i++) {
        const size = randomInt(0, 50_000);
        const plaintext = randomBytes(size);
        const groupId = randomBigInt(61);
        const objectId = randomInt(0, Limits.MAX_OBJECT_ID);

        const encrypted = await ctx.encrypt(plaintext, { groupId, objectId });
        const decrypted = await ctx.decrypt(encrypted.ciphertext, { groupId, objectId });

        expect(decrypted.plaintext).toEqual(plaintext);
      }
    });

    it('AES-CTR-HMAC-80 survives random plaintext sizes and object IDs', async () => {
      const key = randomBytes(32);
      const ctx = await SecureObjectsContext.create({
        trackBaseKey: key,
        track: { namespace: ['fuzz'], trackName: 'ctr' },
        cipherSuite: CipherSuite.AES_128_CTR_HMAC_SHA256_80,
      });

      for (let i = 0; i < ITERATIONS; i++) {
        const size = randomInt(0, 50_000);
        const plaintext = randomBytes(size);
        const groupId = randomBigInt(61);
        const objectId = randomInt(0, Limits.MAX_OBJECT_ID);

        const encrypted = await ctx.encrypt(plaintext, { groupId, objectId });
        const decrypted = await ctx.decrypt(encrypted.ciphertext, { groupId, objectId });

        expect(decrypted.plaintext).toEqual(plaintext);
      }
    });

    it('AES-CTR-HMAC-64 survives random plaintext sizes and object IDs', async () => {
      const key = randomBytes(32);
      const ctx = await SecureObjectsContext.create({
        trackBaseKey: key,
        track: { namespace: ['fuzz'], trackName: 'ctr64' },
        cipherSuite: CipherSuite.AES_128_CTR_HMAC_SHA256_64,
      });

      for (let i = 0; i < ITERATIONS; i++) {
        const size = randomInt(0, 50_000);
        const plaintext = randomBytes(size);
        const groupId = randomBigInt(61);
        const objectId = randomInt(0, Limits.MAX_OBJECT_ID);

        const encrypted = await ctx.encrypt(plaintext, { groupId, objectId });
        const decrypted = await ctx.decrypt(encrypted.ciphertext, { groupId, objectId });

        expect(decrypted.plaintext).toEqual(plaintext);
      }
    });

    it('AES-CTR-HMAC-32 survives random plaintext sizes and object IDs', async () => {
      const key = randomBytes(32);
      const ctx = await SecureObjectsContext.create({
        trackBaseKey: key,
        track: { namespace: ['fuzz'], trackName: 'ctr32' },
        cipherSuite: CipherSuite.AES_128_CTR_HMAC_SHA256_32,
      });

      for (let i = 0; i < ITERATIONS; i++) {
        const size = randomInt(0, 50_000);
        const plaintext = randomBytes(size);
        const groupId = randomBigInt(61);
        const objectId = randomInt(0, Limits.MAX_OBJECT_ID);

        const encrypted = await ctx.encrypt(plaintext, { groupId, objectId });
        const decrypted = await ctx.decrypt(encrypted.ciphertext, { groupId, objectId });

        expect(decrypted.plaintext).toEqual(plaintext);
      }
    });
  });

  describe('tampered ciphertext always rejected', () => {
    it('single-bit flips in ciphertext are always detected (GCM)', async () => {
      const key = randomBytes(32);
      const ctx = await SecureObjectsContext.create({
        trackBaseKey: key,
        track: { namespace: ['fuzz'], trackName: 'tamper' },
        cipherSuite: CipherSuite.AES_128_GCM_SHA256_128,
      });

      for (let i = 0; i < 50; i++) {
        const plaintext = randomBytes(randomInt(1, 10_000));
        const objectId = { groupId: BigInt(i), objectId: i };

        const encrypted = await ctx.encrypt(plaintext, objectId);
        const tampered = new Uint8Array(encrypted.ciphertext);

        const bitPos = randomInt(0, tampered.length);
        tampered[bitPos] ^= (1 << randomInt(0, 8));

        await expect(ctx.decrypt(tampered, objectId)).rejects.toThrow();
      }
    });

    it('single-bit flips in ciphertext are always detected (CTR-HMAC)', async () => {
      const key = randomBytes(32);
      const ctx = await SecureObjectsContext.create({
        trackBaseKey: key,
        track: { namespace: ['fuzz'], trackName: 'tamper-ctr' },
        cipherSuite: CipherSuite.AES_128_CTR_HMAC_SHA256_80,
      });

      for (let i = 0; i < 50; i++) {
        const plaintext = randomBytes(randomInt(1, 10_000));
        const objectId = { groupId: BigInt(i), objectId: i };

        const encrypted = await ctx.encrypt(plaintext, objectId);
        const tampered = new Uint8Array(encrypted.ciphertext);

        const bitPos = randomInt(0, tampered.length);
        tampered[bitPos] ^= (1 << randomInt(0, 8));

        await expect(ctx.decrypt(tampered, objectId)).rejects.toThrow();
      }
    });
  });

  describe('truncated ciphertext always rejected', () => {
    it('truncated ciphertext is rejected (GCM)', async () => {
      const key = randomBytes(32);
      const ctx = await SecureObjectsContext.create({
        trackBaseKey: key,
        track: { namespace: ['fuzz'], trackName: 'trunc' },
        cipherSuite: CipherSuite.AES_128_GCM_SHA256_128,
      });

      const plaintext = randomBytes(1000);
      const objectId = { groupId: 0n, objectId: 0 };
      const encrypted = await ctx.encrypt(plaintext, objectId);

      for (let i = 0; i < 20; i++) {
        const truncLen = randomInt(0, encrypted.ciphertext.length);
        const truncated = encrypted.ciphertext.slice(0, truncLen);
        await expect(ctx.decrypt(truncated, objectId)).rejects.toThrow();
      }
    });

    it('truncated ciphertext is rejected (CTR-HMAC)', async () => {
      const key = randomBytes(32);
      const ctx = await SecureObjectsContext.create({
        trackBaseKey: key,
        track: { namespace: ['fuzz'], trackName: 'trunc-ctr' },
        cipherSuite: CipherSuite.AES_128_CTR_HMAC_SHA256_80,
      });

      const plaintext = randomBytes(1000);
      const objectId = { groupId: 0n, objectId: 0 };
      const encrypted = await ctx.encrypt(plaintext, objectId);

      for (let i = 0; i < 20; i++) {
        const truncLen = randomInt(0, encrypted.ciphertext.length);
        const truncated = encrypted.ciphertext.slice(0, truncLen);
        await expect(ctx.decrypt(truncated, objectId)).rejects.toThrow();
      }
    });
  });

  describe('random garbage ciphertext always rejected', () => {
    it('random bytes never decrypt successfully (GCM)', async () => {
      const key = randomBytes(32);
      const ctx = await SecureObjectsContext.create({
        trackBaseKey: key,
        track: { namespace: ['fuzz'], trackName: 'garbage' },
        cipherSuite: CipherSuite.AES_128_GCM_SHA256_128,
      });

      for (let i = 0; i < 50; i++) {
        const garbage = randomBytes(randomInt(1, 10_000));
        const objectId = { groupId: BigInt(i), objectId: i };
        await expect(ctx.decrypt(garbage, objectId)).rejects.toThrow();
      }
    });

    it('random bytes never decrypt successfully (CTR-HMAC)', async () => {
      const key = randomBytes(32);
      const ctx = await SecureObjectsContext.create({
        trackBaseKey: key,
        track: { namespace: ['fuzz'], trackName: 'garbage-ctr' },
        cipherSuite: CipherSuite.AES_128_CTR_HMAC_SHA256_80,
      });

      for (let i = 0; i < 50; i++) {
        const garbage = randomBytes(randomInt(11, 10_000));
        const objectId = { groupId: BigInt(i), objectId: i };
        await expect(ctx.decrypt(garbage, objectId)).rejects.toThrow();
      }
    });
  });

  describe('nonce construction edge cases', () => {
    it('handles maximum valid group and object IDs', () => {
      const salt = randomBytes(12);
      const nonce = constructNonce(salt, {
        groupId: Limits.MAX_GROUP_ID,
        objectId: Limits.MAX_OBJECT_ID,
      });
      expect(nonce.length).toBe(12);
    });

    it('handles zero group and object IDs', () => {
      const salt = randomBytes(12);
      const nonce = constructNonce(salt, { groupId: 0n, objectId: 0 });
      expect(nonce).toEqual(salt);
    });

    it('all valid group/object ID combinations produce 12-byte nonces', () => {
      const salt = randomBytes(12);
      for (let i = 0; i < ITERATIONS; i++) {
        const groupId = randomBigInt(61);
        const objectId = randomInt(0, Limits.MAX_OBJECT_ID);
        const nonce = constructNonce(salt, { groupId, objectId });
        expect(nonce.length).toBe(12);
      }
    });
  });

  describe('AAD construction with adversarial inputs', () => {
    it('handles empty namespace', () => {
      const aad = constructAAD({
        keyId: 0n,
        groupId: 0n,
        objectId: 0,
        namespace: [],
        trackName: 'test',
      });
      expect(aad.length).toBeGreaterThan(0);
    });

    it('handles very long namespace tuples', () => {
      const longStr = 'x'.repeat(1000);
      const aad = constructAAD({
        keyId: 0n,
        groupId: 0n,
        objectId: 0,
        namespace: [longStr, longStr, longStr],
        trackName: longStr,
      });
      expect(aad.length).toBeGreaterThan(3000);
    });

    it('handles unicode in namespace and track name', () => {
      const aad = constructAAD({
        keyId: 0n,
        groupId: 0n,
        objectId: 0,
        namespace: ['会议', '房间-🔐'],
        trackName: '视频/音频',
      });
      expect(aad.length).toBeGreaterThan(0);
    });

    it('different namespace orderings produce different AAD', () => {
      const aad1 = constructAAD({
        keyId: 0n,
        groupId: 0n,
        objectId: 0,
        namespace: ['a', 'b'],
        trackName: 't',
      });
      const aad2 = constructAAD({
        keyId: 0n,
        groupId: 0n,
        objectId: 0,
        namespace: ['b', 'a'],
        trackName: 't',
      });
      expect(aad1).not.toEqual(aad2);
    });

    it('namespace/trackName boundary confusion is prevented', () => {
      // Ensure that namespace ["a", "b"] + trackName "c" differs from
      // namespace ["a"] + trackName "bc" due to length-prefixing
      const aad1 = constructAAD({
        keyId: 0n,
        groupId: 0n,
        objectId: 0,
        namespace: ['a', 'b'],
        trackName: 'c',
      });
      const aad2 = constructAAD({
        keyId: 0n,
        groupId: 0n,
        objectId: 0,
        namespace: ['a'],
        trackName: 'bc',
      });
      expect(aad1).not.toEqual(aad2);
    });
  });

  describe('key isolation', () => {
    it('different base keys produce completely different ciphertexts', async () => {
      const track = { namespace: ['ns'], trackName: 'track' };
      const plaintext = randomBytes(100);
      const objectId = { groupId: 0n, objectId: 0 };

      const ciphertexts = new Set<string>();

      for (let i = 0; i < 20; i++) {
        const key = randomBytes(32);
        const ctx = await SecureObjectsContext.create({
          trackBaseKey: key,
          track,
          cipherSuite: CipherSuite.AES_128_GCM_SHA256_128,
        });
        const encrypted = await ctx.encrypt(plaintext, objectId);
        ciphertexts.add(Buffer.from(encrypted.ciphertext).toString('hex'));
      }

      expect(ciphertexts.size).toBe(20);
    });
  });

  describe('encrypted properties round-trip', () => {
    it('survives random encrypted properties', async () => {
      const key = randomBytes(32);
      const ctx = await SecureObjectsContext.create({
        trackBaseKey: key,
        track: { namespace: ['fuzz'], trackName: 'props' },
        cipherSuite: CipherSuite.AES_128_GCM_SHA256_128,
      });

      for (let i = 0; i < 50; i++) {
        const plaintext = randomBytes(randomInt(0, 10_000));
        const props = randomBytes(randomInt(1, 500));
        const objectId = { groupId: BigInt(i), objectId: i };

        const encrypted = await ctx.encrypt(plaintext, objectId, props);
        const decrypted = await ctx.decrypt(encrypted.ciphertext, objectId);

        expect(decrypted.plaintext).toEqual(plaintext);
        expect(decrypted.encryptedProperties).toEqual(props);
      }
    });
  });
});
