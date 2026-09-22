// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview MOQT Secure Objects
 *
 * WebCrypto-based end-to-end encryption for Media over QUIC Transport.
 * Implements draft-ietf-moq-secure-objects specification.
 *
 * @packageDocumentation
 *
 * @example
 * ```typescript
 * import {
 *   SecureObjectsContext,
 *   CipherSuite,
 * } from '@moq-web/secure-objects';
 *
 * // Create encryption context
 * const ctx = await SecureObjectsContext.create({
 *   trackBaseKey: new Uint8Array(32), // Your secret key
 *   track: { namespace: ['conference', 'room-1'], trackName: 'video' },
 *   cipherSuite: CipherSuite.AES_128_GCM_SHA256_128,
 * });
 *
 * // Encrypt an object
 * const encrypted = await ctx.encrypt(plaintext, { groupId: 0n, objectId: 0 });
 *
 * // Decrypt an object
 * const decrypted = await ctx.decrypt(encrypted.ciphertext, { groupId: 0n, objectId: 0 });
 * ```
 */

// Types
export {
  CipherSuite,
  PropertyType,
  Limits,
  type CipherSuiteParams,
  type TrackIdentifier,
  type ObjectIdentifier,
  type EncryptionConfig,
  type EncryptedObject,
  type DecryptedObject,
  type AADComponents,
} from './types.js';

// Cipher suites
export {
  CIPHER_SUITES,
  getCipherSuiteParams,
  isRecommended,
  getRecommendedCipherSuites,
  DEFAULT_CIPHER_SUITE,
} from './cipher-suites.js';

// Key derivation
export {
  deriveKeys,
  deriveEncryptionKey,
  deriveSalt,
  serializeTrackName,
} from './key-derivation.js';

// Crypto operations
export { SecureObjectsContext } from './crypto.js';

// Structured error classes — callers should branch on these instead of
// parsing message strings.
export {
  SecureObjectsError,
  AuthenticationError,
  NonceReuseError,
  DisposedError,
  InvalidFramingError,
  EncryptionLimitError,
} from './errors.js';

// NOTE: `constructNonce` and `constructAAD` are intentionally NOT re-exported
// from the public entry point.  They are internal crypto primitives — exposing
// them lets callers assemble AAD out-of-band and skew from the encrypt path
// (weak API contract).  Tests import them from `./crypto.js` directly.
