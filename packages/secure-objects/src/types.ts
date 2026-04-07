// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview MOQT Secure Objects Types
 *
 * Type definitions for the MOQT Secure Objects encryption scheme.
 * Based on draft-ietf-moq-secure-objects.
 */

/**
 * Cipher suite identifier as defined in the MOQT Secure Objects spec.
 */
export enum CipherSuite {
  /** AES-128-CTR with HMAC-SHA256, 80-bit tag (recommended) */
  AES_128_CTR_HMAC_SHA256_80 = 0x0001,
  /** AES-128-CTR with HMAC-SHA256, 64-bit tag (recommended) */
  AES_128_CTR_HMAC_SHA256_64 = 0x0002,
  /** AES-128-CTR with HMAC-SHA256, 32-bit tag (not recommended) */
  AES_128_CTR_HMAC_SHA256_32 = 0x0003,
  /** AES-128-GCM with SHA256, 128-bit tag (recommended) */
  AES_128_GCM_SHA256_128 = 0x0004,
  /** AES-256-GCM with SHA512, 128-bit tag (recommended) */
  AES_256_GCM_SHA512_128 = 0x0005,
}

/**
 * Cipher suite parameters.
 */
export interface CipherSuiteParams {
  /** Cipher suite ID */
  id: CipherSuite;
  /** Human-readable name */
  name: string;
  /** Hash output length in bytes (Nh) */
  hashLength: number;
  /** AEAD key length in bytes (Nka) - only for CTR-HMAC */
  aeadKeyLength?: number;
  /** Encryption key length in bytes (Nk) */
  keyLength: number;
  /** Nonce length in bytes (Nn) - always 12 */
  nonceLength: number;
  /** Authentication tag length in bytes (Nt) */
  tagLength: number;
  /** Whether this cipher suite is recommended */
  recommended: boolean;
  /** Hash algorithm for HKDF */
  hashAlgorithm: 'SHA-256' | 'SHA-512';
  /** AEAD algorithm */
  aeadAlgorithm: 'AES-GCM' | 'AES-CTR-HMAC';
}

/**
 * Track identifier for key derivation.
 */
export interface TrackIdentifier {
  /** Track namespace as tuple of strings */
  namespace: string[];
  /** Track name */
  trackName: string;
}

/**
 * Object identifier for nonce construction.
 */
export interface ObjectIdentifier {
  /** Group ID (max 2^64 - 1) */
  groupId: bigint;
  /** Object ID (max 2^32 - 1) */
  objectId: number;
}

/**
 * Encryption context containing derived keys and parameters.
 */
export interface EncryptionContext {
  /** Cipher suite in use */
  cipherSuite: CipherSuite;
  /** Key ID for this context */
  keyId: bigint;
  /** Derived encryption key */
  key: CryptoKey;
  /** Derived salt for nonce construction */
  salt: Uint8Array;
  /** Track identifier */
  track: TrackIdentifier;
  /** HMAC key for CTR-HMAC cipher suites */
  hmacKey?: CryptoKey;
}

/**
 * Configuration for creating an encryption context.
 */
export interface EncryptionConfig {
  /** Track base key (secret key material) */
  trackBaseKey: Uint8Array;
  /** Key ID (default: 0) */
  keyId?: bigint;
  /** Cipher suite (default: AES_128_GCM_SHA256_128) */
  cipherSuite?: CipherSuite;
  /** Track identifier */
  track: TrackIdentifier;
}

/**
 * Encrypted object with metadata.
 */
export interface EncryptedObject {
  /** Encrypted ciphertext (includes auth tag for GCM) */
  ciphertext: Uint8Array;
  /** Key ID used for encryption */
  keyId: bigint;
  /** Cipher suite used */
  cipherSuite: CipherSuite;
}

/**
 * AAD (Additional Authenticated Data) components.
 */
export interface AADComponents {
  /** Key ID */
  keyId: bigint;
  /** Group ID */
  groupId: bigint;
  /** Object ID */
  objectId: number;
  /** Track namespace */
  namespace: string[];
  /** Track name */
  trackName: string;
}

/**
 * Decryption result.
 */
export interface DecryptedObject {
  /** Decrypted plaintext */
  plaintext: Uint8Array;
  /** Any encrypted properties that were included */
  encryptedProperties?: Uint8Array;
}

/**
 * MOQT property type IDs.
 */
export const PropertyType = {
  /** Key ID property */
  KEY_ID: 0x02,
  /** Encrypted properties list */
  ENCRYPTED_PROPERTIES: 0x0a,
} as const;

/**
 * Maximum values for object identifiers.
 */
export const Limits = {
  /** Maximum Group ID (2^64 - 1) */
  MAX_GROUP_ID: BigInt('0xFFFFFFFFFFFFFFFF'),
  /** Maximum Object ID (2^32 - 1) */
  MAX_OBJECT_ID: 0xFFFFFFFF,
} as const;
