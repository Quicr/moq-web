// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview MOQT Secure Objects Cipher Suite Definitions
 *
 * Cipher suite parameters as defined in draft-ietf-moq-secure-objects.
 */

import { CipherSuite, type CipherSuiteParams } from './types.js';

/**
 * Cipher suite parameter lookup table.
 */
export const CIPHER_SUITES: Record<CipherSuite, CipherSuiteParams> = {
  [CipherSuite.AES_128_CTR_HMAC_SHA256_80]: {
    id: CipherSuite.AES_128_CTR_HMAC_SHA256_80,
    name: 'AES_128_CTR_HMAC_SHA256_80',
    hashLength: 32,           // Nh: SHA-256 output
    aeadKeyLength: 16,        // Nka: AES-128 key
    keyLength: 48,            // Nk: 16 (AES) + 32 (HMAC)
    nonceLength: 12,          // Nn: standard nonce size
    tagLength: 10,            // Nt: 80 bits
    recommended: true,
    hashAlgorithm: 'SHA-256',
    aeadAlgorithm: 'AES-CTR-HMAC',
  },
  [CipherSuite.AES_128_CTR_HMAC_SHA256_64]: {
    id: CipherSuite.AES_128_CTR_HMAC_SHA256_64,
    name: 'AES_128_CTR_HMAC_SHA256_64',
    hashLength: 32,
    aeadKeyLength: 16,
    keyLength: 48,
    nonceLength: 12,
    tagLength: 8,             // Nt: 64 bits
    recommended: true,
    hashAlgorithm: 'SHA-256',
    aeadAlgorithm: 'AES-CTR-HMAC',
  },
  [CipherSuite.AES_128_CTR_HMAC_SHA256_32]: {
    id: CipherSuite.AES_128_CTR_HMAC_SHA256_32,
    name: 'AES_128_CTR_HMAC_SHA256_32',
    hashLength: 32,
    aeadKeyLength: 16,
    keyLength: 48,
    nonceLength: 12,
    tagLength: 4,             // Nt: 32 bits (NOT recommended)
    recommended: false,
    hashAlgorithm: 'SHA-256',
    aeadAlgorithm: 'AES-CTR-HMAC',
  },
  [CipherSuite.AES_128_GCM_SHA256_128]: {
    id: CipherSuite.AES_128_GCM_SHA256_128,
    name: 'AES_128_GCM_SHA256_128',
    hashLength: 32,
    keyLength: 16,            // Nk: AES-128 key
    nonceLength: 12,
    tagLength: 16,            // Nt: 128 bits (full GCM tag)
    recommended: true,
    hashAlgorithm: 'SHA-256',
    aeadAlgorithm: 'AES-GCM',
  },
  [CipherSuite.AES_256_GCM_SHA512_128]: {
    id: CipherSuite.AES_256_GCM_SHA512_128,
    name: 'AES_256_GCM_SHA512_128',
    hashLength: 64,           // Nh: SHA-512 output
    keyLength: 32,            // Nk: AES-256 key
    nonceLength: 12,
    tagLength: 16,            // Nt: 128 bits (full GCM tag)
    recommended: true,
    hashAlgorithm: 'SHA-512',
    aeadAlgorithm: 'AES-GCM',
  },
};

/**
 * Get cipher suite parameters by ID.
 * @throws Error if cipher suite is unknown
 */
export function getCipherSuiteParams(id: CipherSuite): CipherSuiteParams {
  const params = CIPHER_SUITES[id];
  if (!params) {
    throw new Error(`Unknown cipher suite: 0x${id.toString(16).padStart(4, '0')}`);
  }
  return params;
}

/**
 * Check if a cipher suite is recommended.
 */
export function isRecommended(id: CipherSuite): boolean {
  return getCipherSuiteParams(id).recommended;
}

/**
 * Get all recommended cipher suites.
 */
export function getRecommendedCipherSuites(): CipherSuite[] {
  return Object.values(CipherSuite)
    .filter((id): id is CipherSuite => typeof id === 'number' && isRecommended(id));
}

/**
 * Default cipher suite (AES-128-GCM for best WebCrypto performance).
 */
export const DEFAULT_CIPHER_SUITE = CipherSuite.AES_128_GCM_SHA256_128;
