// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { describe, it, expect, beforeEach } from 'vitest';
import {
  SecureObjectsContext,
  CipherSuite,
  constructNonce,
  constructAAD,
  Limits,
} from '../index.js';

describe('SecureObjectsContext', () => {
  const testTrack = {
    namespace: ['conference', 'room-1'],
    trackName: 'video',
  };

  // Generate a random 32-byte key for testing
  const testKey = new Uint8Array(32);
  crypto.getRandomValues(testKey);

  describe('create', () => {
    it('creates context with default cipher suite', async () => {
      const ctx = await SecureObjectsContext.create({
        trackBaseKey: testKey,
        track: testTrack,
      });

      expect(ctx.cipherSuite).toBe(CipherSuite.AES_128_GCM_SHA256_128);
      expect(ctx.keyId).toBe(0n);
    });

    it('creates context with specified cipher suite', async () => {
      const ctx = await SecureObjectsContext.create({
        trackBaseKey: testKey,
        track: testTrack,
        cipherSuite: CipherSuite.AES_256_GCM_SHA512_128,
      });

      expect(ctx.cipherSuite).toBe(CipherSuite.AES_256_GCM_SHA512_128);
    });

    it('creates context with specified key ID', async () => {
      const ctx = await SecureObjectsContext.create({
        trackBaseKey: testKey,
        track: testTrack,
        keyId: 42n,
      });

      expect(ctx.keyId).toBe(42n);
    });
  });

  describe('AES-GCM encrypt/decrypt', () => {
    let ctx: SecureObjectsContext;

    beforeEach(async () => {
      ctx = await SecureObjectsContext.create({
        trackBaseKey: testKey,
        track: testTrack,
        cipherSuite: CipherSuite.AES_128_GCM_SHA256_128,
      });
    });

    it('encrypts and decrypts small data', async () => {
      const plaintext = new TextEncoder().encode('Hello, World!');
      const objectId = { groupId: 0n, objectId: 0 };

      const encrypted = await ctx.encrypt(plaintext, objectId);
      const decrypted = await ctx.decrypt(encrypted.ciphertext, objectId);

      expect(new TextDecoder().decode(decrypted.plaintext)).toBe('Hello, World!');
    });

    it('encrypts and decrypts empty data', async () => {
      const plaintext = new Uint8Array(0);
      const objectId = { groupId: 1n, objectId: 1 };

      const encrypted = await ctx.encrypt(plaintext, objectId);
      const decrypted = await ctx.decrypt(encrypted.ciphertext, objectId);

      expect(decrypted.plaintext.length).toBe(0);
    });

    it('encrypts and decrypts large data', async () => {
      const plaintext = new Uint8Array(65536);
      crypto.getRandomValues(plaintext);
      const objectId = { groupId: 100n, objectId: 999 };

      const encrypted = await ctx.encrypt(plaintext, objectId);
      const decrypted = await ctx.decrypt(encrypted.ciphertext, objectId);

      expect(decrypted.plaintext).toEqual(plaintext);
    });

    it('produces different ciphertext for same plaintext with different object IDs', async () => {
      const plaintext = new TextEncoder().encode('Same content');

      const encrypted1 = await ctx.encrypt(plaintext, { groupId: 0n, objectId: 0 });
      const encrypted2 = await ctx.encrypt(plaintext, { groupId: 0n, objectId: 1 });

      expect(encrypted1.ciphertext).not.toEqual(encrypted2.ciphertext);
    });

    it('fails to decrypt with wrong object ID', async () => {
      const plaintext = new TextEncoder().encode('Secret');
      const objectId = { groupId: 0n, objectId: 0 };

      const encrypted = await ctx.encrypt(plaintext, objectId);

      await expect(
        ctx.decrypt(encrypted.ciphertext, { groupId: 0n, objectId: 1 })
      ).rejects.toThrow();
    });

    it('fails to decrypt tampered ciphertext', async () => {
      const plaintext = new TextEncoder().encode('Secret');
      const objectId = { groupId: 0n, objectId: 0 };

      const encrypted = await ctx.encrypt(plaintext, objectId);

      // Tamper with ciphertext
      encrypted.ciphertext[0] ^= 0xff;

      await expect(ctx.decrypt(encrypted.ciphertext, objectId)).rejects.toThrow();
    });
  });

  describe('AES-256-GCM encrypt/decrypt', () => {
    it('works with AES-256-GCM cipher suite', async () => {
      const ctx = await SecureObjectsContext.create({
        trackBaseKey: testKey,
        track: testTrack,
        cipherSuite: CipherSuite.AES_256_GCM_SHA512_128,
      });

      const plaintext = new TextEncoder().encode('AES-256 test');
      const objectId = { groupId: 0n, objectId: 0 };

      const encrypted = await ctx.encrypt(plaintext, objectId);
      const decrypted = await ctx.decrypt(encrypted.ciphertext, objectId);

      expect(new TextDecoder().decode(decrypted.plaintext)).toBe('AES-256 test');
    });
  });

  describe('AES-CTR-HMAC encrypt/decrypt', () => {
    it('works with AES-128-CTR-HMAC-SHA256-80 cipher suite', async () => {
      const ctx = await SecureObjectsContext.create({
        trackBaseKey: testKey,
        track: testTrack,
        cipherSuite: CipherSuite.AES_128_CTR_HMAC_SHA256_80,
      });

      const plaintext = new TextEncoder().encode('CTR-HMAC test');
      const objectId = { groupId: 5n, objectId: 10 };

      const encrypted = await ctx.encrypt(plaintext, objectId);
      const decrypted = await ctx.decrypt(encrypted.ciphertext, objectId);

      expect(new TextDecoder().decode(decrypted.plaintext)).toBe('CTR-HMAC test');
    });

    it('fails to decrypt with tampered HMAC', async () => {
      const ctx = await SecureObjectsContext.create({
        trackBaseKey: testKey,
        track: testTrack,
        cipherSuite: CipherSuite.AES_128_CTR_HMAC_SHA256_80,
      });

      const plaintext = new TextEncoder().encode('Secret');
      const objectId = { groupId: 0n, objectId: 0 };

      const encrypted = await ctx.encrypt(plaintext, objectId);

      // Tamper with the last byte (part of HMAC tag)
      encrypted.ciphertext[encrypted.ciphertext.length - 1] ^= 0xff;

      await expect(ctx.decrypt(encrypted.ciphertext, objectId)).rejects.toThrow(
        'Authentication failed'
      );
    });
  });

  describe('encrypted properties', () => {
    it('includes encrypted properties in ciphertext', async () => {
      const ctx = await SecureObjectsContext.create({
        trackBaseKey: testKey,
        track: testTrack,
      });

      const plaintext = new TextEncoder().encode('Data');
      const encryptedProps = new Uint8Array([0x0a, 0x02, 0x01, 0x02]); // Some property data
      const objectId = { groupId: 0n, objectId: 0 };

      const encrypted = await ctx.encrypt(plaintext, objectId, encryptedProps);
      const decrypted = await ctx.decrypt(encrypted.ciphertext, objectId);

      expect(new TextDecoder().decode(decrypted.plaintext)).toBe('Data');
      expect(decrypted.encryptedProperties).toBeDefined();
      expect(decrypted.encryptedProperties).toEqual(encryptedProps);
    });
  });

  describe('verifyAAD', () => {
    it('returns true for valid ciphertext', async () => {
      const ctx = await SecureObjectsContext.create({
        trackBaseKey: testKey,
        track: testTrack,
      });

      const plaintext = new TextEncoder().encode('Verify me');
      const objectId = { groupId: 0n, objectId: 0 };

      const encrypted = await ctx.encrypt(plaintext, objectId);
      const isValid = await ctx.verifyAAD(encrypted.ciphertext, objectId);

      expect(isValid).toBe(true);
    });

    it('returns false for tampered ciphertext', async () => {
      const ctx = await SecureObjectsContext.create({
        trackBaseKey: testKey,
        track: testTrack,
      });

      const plaintext = new TextEncoder().encode('Verify me');
      const objectId = { groupId: 0n, objectId: 0 };

      const encrypted = await ctx.encrypt(plaintext, objectId);
      encrypted.ciphertext[0] ^= 0xff;

      const isValid = await ctx.verifyAAD(encrypted.ciphertext, objectId);

      expect(isValid).toBe(false);
    });
  });

  describe('cross-context compatibility', () => {
    it('decrypts with separate context using same key', async () => {
      const encryptCtx = await SecureObjectsContext.create({
        trackBaseKey: testKey,
        track: testTrack,
        keyId: 1n,
      });

      const decryptCtx = await SecureObjectsContext.create({
        trackBaseKey: testKey,
        track: testTrack,
        keyId: 1n,
      });

      const plaintext = new TextEncoder().encode('Cross-context test');
      const objectId = { groupId: 42n, objectId: 100 };

      const encrypted = await encryptCtx.encrypt(plaintext, objectId);
      const decrypted = await decryptCtx.decrypt(encrypted.ciphertext, objectId);

      expect(new TextDecoder().decode(decrypted.plaintext)).toBe('Cross-context test');
    });

    it('fails to decrypt with different key ID', async () => {
      const encryptCtx = await SecureObjectsContext.create({
        trackBaseKey: testKey,
        track: testTrack,
        keyId: 1n,
      });

      const decryptCtx = await SecureObjectsContext.create({
        trackBaseKey: testKey,
        track: testTrack,
        keyId: 2n, // Different key ID
      });

      const plaintext = new TextEncoder().encode('Secret');
      const objectId = { groupId: 0n, objectId: 0 };

      const encrypted = await encryptCtx.encrypt(plaintext, objectId);

      await expect(decryptCtx.decrypt(encrypted.ciphertext, objectId)).rejects.toThrow();
    });

    it('fails to decrypt with different track', async () => {
      const encryptCtx = await SecureObjectsContext.create({
        trackBaseKey: testKey,
        track: testTrack,
      });

      const decryptCtx = await SecureObjectsContext.create({
        trackBaseKey: testKey,
        track: { namespace: ['different'], trackName: 'track' },
      });

      const plaintext = new TextEncoder().encode('Secret');
      const objectId = { groupId: 0n, objectId: 0 };

      const encrypted = await encryptCtx.encrypt(plaintext, objectId);

      await expect(decryptCtx.decrypt(encrypted.ciphertext, objectId)).rejects.toThrow();
    });
  });
});

describe('constructNonce', () => {
  it('XORs salt with CTR correctly', () => {
    const salt = new Uint8Array(12).fill(0xff);
    const objectId = { groupId: 0n, objectId: 0 };

    const nonce = constructNonce(salt, objectId);

    // CTR is all zeros, so nonce should equal salt
    expect(nonce).toEqual(salt);
  });

  it('produces different nonces for different group IDs', () => {
    const salt = new Uint8Array(12).fill(0);
    const nonce1 = constructNonce(salt, { groupId: 0n, objectId: 0 });
    const nonce2 = constructNonce(salt, { groupId: 1n, objectId: 0 });

    expect(nonce1).not.toEqual(nonce2);
  });

  it('produces different nonces for different object IDs', () => {
    const salt = new Uint8Array(12).fill(0);
    const nonce1 = constructNonce(salt, { groupId: 0n, objectId: 0 });
    const nonce2 = constructNonce(salt, { groupId: 0n, objectId: 1 });

    expect(nonce1).not.toEqual(nonce2);
  });

  it('throws for group ID exceeding limit', () => {
    const salt = new Uint8Array(12).fill(0);
    const objectId = { groupId: Limits.MAX_GROUP_ID + 1n, objectId: 0 };

    expect(() => constructNonce(salt, objectId)).toThrow('Group ID exceeds maximum');
  });

  it('throws for object ID exceeding limit', () => {
    const salt = new Uint8Array(12).fill(0);
    const objectId = { groupId: 0n, objectId: Limits.MAX_OBJECT_ID + 1 };

    expect(() => constructNonce(salt, objectId)).toThrow('Object ID exceeds maximum');
  });
});

describe('constructAAD', () => {
  it('constructs AAD with all components', () => {
    const aad = constructAAD({
      keyId: 1n,
      groupId: 2n,
      objectId: 3,
      namespace: ['ns1', 'ns2'],
      trackName: 'track',
    });

    expect(aad.length).toBeGreaterThan(0);
    expect(aad instanceof Uint8Array).toBe(true);
  });

  it('produces different AAD for different key IDs', () => {
    const base = {
      groupId: 0n,
      objectId: 0,
      namespace: ['ns'],
      trackName: 'track',
    };

    const aad1 = constructAAD({ ...base, keyId: 0n });
    const aad2 = constructAAD({ ...base, keyId: 1n });

    expect(aad1).not.toEqual(aad2);
  });

  it('produces different AAD for different namespaces', () => {
    const base = {
      keyId: 0n,
      groupId: 0n,
      objectId: 0,
      trackName: 'track',
    };

    const aad1 = constructAAD({ ...base, namespace: ['ns1'] });
    const aad2 = constructAAD({ ...base, namespace: ['ns2'] });

    expect(aad1).not.toEqual(aad2);
  });
});
