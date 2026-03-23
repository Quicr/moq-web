// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Encryption schema fields per MSF spec
 *
 * Supports encryption schemes for secure media delivery.
 * Uses moq-secure-objects as the recommended encryption scheme.
 */

import { z } from 'zod';

/**
 * Encryption scheme identifiers per MSF spec
 * moq-secure-objects is the recommended scheme
 */
export const EncryptionSchemeEnum = z.enum([
  'moq-secure-objects',
  // Legacy/alternative schemes for compatibility
  'cenc',
  'cbc1',
  'cens',
  'cbcs',
]);

/**
 * Cipher suites for moq-secure-objects encryption
 * aes-128-gcm-sha256 is mandatory to implement
 */
export const CipherSuiteEnum = z.enum([
  'aes-128-gcm-sha256',
  'aes-256-gcm-sha512',
  'aes-128-ctr-hmac-sha256-80',
]);

/**
 * Base64-encoded key ID (16 bytes)
 */
export const KeyIdSchema = z.string().describe('Base64-encoded 16-byte key ID');

/**
 * Base64-encoded track base key
 */
export const TrackBaseKeySchema = z.string().describe('Base64-encoded track base key');

/**
 * Encryption fields that can be added to track definitions
 */
export const EncryptionFieldsSchema = z.object({
  /** Encryption scheme identifier (moq-secure-objects recommended) */
  encryptionScheme: EncryptionSchemeEnum.optional(),
  /** AEAD cipher suite (required when encryptionScheme is present) */
  cipherSuite: CipherSuiteEnum.optional(),
  /** Key ID for content decryption */
  keyId: KeyIdSchema.optional(),
  /** Track-specific base key */
  trackBaseKey: TrackBaseKeySchema.optional(),
});

export type EncryptionScheme = z.infer<typeof EncryptionSchemeEnum>;
export type CipherSuite = z.infer<typeof CipherSuiteEnum>;
export type EncryptionFields = z.infer<typeof EncryptionFieldsSchema>;
