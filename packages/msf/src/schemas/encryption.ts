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
 * Recommended `encryptionScheme` value (MSF §3).
 */
export const RECOMMENDED_ENCRYPTION_SCHEME = 'moq-secure-objects' as const;

/**
 * `encryptionScheme` identifier (MSF §3, §6).
 *
 * The spec calls out `moq-secure-objects` as the RECOMMENDED value; any other
 * identifier MUST use reverse Domain Name Notation (e.g.
 * `com.example.custom-scheme`). We accept the recommended value or any
 * reverse-DNS-shaped string and reject bare shortnames.
 */
export const EncryptionSchemeEnum = z
  .string()
  .min(1)
  .refine(
    (v) =>
      v === RECOMMENDED_ENCRYPTION_SCHEME ||
      /^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z][A-Za-z0-9-]*){2,}$/.test(v),
    {
      message:
        "encryptionScheme must be 'moq-secure-objects' or a reverse-DNS identifier (e.g. 'com.example.scheme')",
    }
  );

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
