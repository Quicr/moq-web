// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { describe, it, expect } from 'vitest';
import {
  deriveKeys,
  serializeTrackName,
  CipherSuite,
} from '../index.js';

describe('Key Derivation', () => {
  const testKey = new Uint8Array(32);
  crypto.getRandomValues(testKey);

  const testTrack = {
    namespace: ['conference', 'room-1'],
    trackName: 'video',
  };

  describe('serializeTrackName', () => {
    it('serializes simple track name', () => {
      const serialized = serializeTrackName({
        namespace: ['ns'],
        trackName: 'track',
      });

      expect(serialized.length).toBeGreaterThan(0);
      expect(serialized instanceof Uint8Array).toBe(true);
    });

    it('serializes multi-part namespace', () => {
      const serialized = serializeTrackName({
        namespace: ['a', 'b', 'c'],
        trackName: 'track',
      });

      // First byte should be namespace count (3)
      expect(serialized[0]).toBe(3);
    });

    it('produces different output for different namespaces', () => {
      const s1 = serializeTrackName({ namespace: ['a'], trackName: 't' });
      const s2 = serializeTrackName({ namespace: ['b'], trackName: 't' });

      expect(s1).not.toEqual(s2);
    });

    it('produces different output for different track names', () => {
      const s1 = serializeTrackName({ namespace: ['ns'], trackName: 'video' });
      const s2 = serializeTrackName({ namespace: ['ns'], trackName: 'audio' });

      expect(s1).not.toEqual(s2);
    });
  });

  describe('deriveKeys', () => {
    it('derives keys for AES-GCM cipher suite', async () => {
      const result = await deriveKeys(
        testKey,
        testTrack,
        CipherSuite.AES_128_GCM_SHA256_128,
        0n
      );

      expect(result.encryptionKey).toBeDefined();
      expect(result.salt).toBeDefined();
      expect(result.salt.length).toBe(12);
      expect(result.hmacKey).toBeUndefined(); // No HMAC key for GCM
    });

    it('derives keys for AES-CTR-HMAC cipher suite', async () => {
      const result = await deriveKeys(
        testKey,
        testTrack,
        CipherSuite.AES_128_CTR_HMAC_SHA256_80,
        0n
      );

      expect(result.encryptionKey).toBeDefined();
      expect(result.salt).toBeDefined();
      expect(result.hmacKey).toBeDefined(); // HMAC key required for CTR-HMAC
    });

    it('produces different keys for different key IDs', async () => {
      const result1 = await deriveKeys(
        testKey,
        testTrack,
        CipherSuite.AES_128_GCM_SHA256_128,
        0n
      );

      const result2 = await deriveKeys(
        testKey,
        testTrack,
        CipherSuite.AES_128_GCM_SHA256_128,
        1n
      );

      expect(result1.salt).not.toEqual(result2.salt);
    });

    it('produces different keys for different tracks', async () => {
      const result1 = await deriveKeys(
        testKey,
        { namespace: ['ns1'], trackName: 'track' },
        CipherSuite.AES_128_GCM_SHA256_128,
        0n
      );

      const result2 = await deriveKeys(
        testKey,
        { namespace: ['ns2'], trackName: 'track' },
        CipherSuite.AES_128_GCM_SHA256_128,
        0n
      );

      expect(result1.salt).not.toEqual(result2.salt);
    });

    it('produces different keys for different cipher suites', async () => {
      const result1 = await deriveKeys(
        testKey,
        testTrack,
        CipherSuite.AES_128_GCM_SHA256_128,
        0n
      );

      const result2 = await deriveKeys(
        testKey,
        testTrack,
        CipherSuite.AES_256_GCM_SHA512_128,
        0n
      );

      expect(result1.salt).not.toEqual(result2.salt);
    });

    it('produces consistent keys for same inputs', async () => {
      const result1 = await deriveKeys(
        testKey,
        testTrack,
        CipherSuite.AES_128_GCM_SHA256_128,
        0n
      );

      const result2 = await deriveKeys(
        testKey,
        testTrack,
        CipherSuite.AES_128_GCM_SHA256_128,
        0n
      );

      // Salt should be identical
      expect(result1.salt).toEqual(result2.salt);
    });
  });
});
