// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { describe, it, expect } from 'vitest';
import {
  CipherSuite,
  CIPHER_SUITES,
  getCipherSuiteParams,
  isRecommended,
  getRecommendedCipherSuites,
  DEFAULT_CIPHER_SUITE,
} from '../index.js';

describe('CipherSuites', () => {
  describe('getCipherSuiteParams', () => {
    it('returns correct params for AES_128_GCM_SHA256_128', () => {
      const params = getCipherSuiteParams(CipherSuite.AES_128_GCM_SHA256_128);

      expect(params.id).toBe(CipherSuite.AES_128_GCM_SHA256_128);
      expect(params.name).toBe('AES_128_GCM_SHA256_128');
      expect(params.hashLength).toBe(32);
      expect(params.keyLength).toBe(16);
      expect(params.nonceLength).toBe(12);
      expect(params.tagLength).toBe(16);
      expect(params.recommended).toBe(true);
      expect(params.hashAlgorithm).toBe('SHA-256');
      expect(params.aeadAlgorithm).toBe('AES-GCM');
    });

    it('returns correct params for AES_256_GCM_SHA512_128', () => {
      const params = getCipherSuiteParams(CipherSuite.AES_256_GCM_SHA512_128);

      expect(params.keyLength).toBe(32);
      expect(params.hashLength).toBe(64);
      expect(params.hashAlgorithm).toBe('SHA-512');
    });

    it('returns correct params for AES_128_CTR_HMAC_SHA256_80', () => {
      const params = getCipherSuiteParams(CipherSuite.AES_128_CTR_HMAC_SHA256_80);

      expect(params.aeadAlgorithm).toBe('AES-CTR-HMAC');
      expect(params.keyLength).toBe(48); // 16 AES + 32 HMAC
      expect(params.aeadKeyLength).toBe(16);
      expect(params.tagLength).toBe(10);
    });

    it('throws for unknown cipher suite', () => {
      expect(() => getCipherSuiteParams(0x9999 as CipherSuite)).toThrow('Unknown cipher suite');
    });
  });

  describe('isRecommended', () => {
    it('returns true for recommended cipher suites', () => {
      expect(isRecommended(CipherSuite.AES_128_GCM_SHA256_128)).toBe(true);
      expect(isRecommended(CipherSuite.AES_256_GCM_SHA512_128)).toBe(true);
      expect(isRecommended(CipherSuite.AES_128_CTR_HMAC_SHA256_80)).toBe(true);
      expect(isRecommended(CipherSuite.AES_128_CTR_HMAC_SHA256_64)).toBe(true);
    });

    it('returns false for non-recommended cipher suites', () => {
      expect(isRecommended(CipherSuite.AES_128_CTR_HMAC_SHA256_32)).toBe(false);
    });
  });

  describe('getRecommendedCipherSuites', () => {
    it('returns only recommended cipher suites', () => {
      const recommended = getRecommendedCipherSuites();

      expect(recommended).toContain(CipherSuite.AES_128_GCM_SHA256_128);
      expect(recommended).toContain(CipherSuite.AES_256_GCM_SHA512_128);
      expect(recommended).not.toContain(CipherSuite.AES_128_CTR_HMAC_SHA256_32);
      expect(recommended.length).toBe(4);
    });
  });

  describe('DEFAULT_CIPHER_SUITE', () => {
    it('is AES_128_GCM_SHA256_128', () => {
      expect(DEFAULT_CIPHER_SUITE).toBe(CipherSuite.AES_128_GCM_SHA256_128);
    });
  });

  describe('CIPHER_SUITES', () => {
    it('has all 5 cipher suites', () => {
      expect(Object.keys(CIPHER_SUITES).length).toBe(5);
    });

    it('all cipher suites have 12-byte nonces', () => {
      for (const params of Object.values(CIPHER_SUITES)) {
        expect(params.nonceLength).toBe(12);
      }
    });
  });
});
