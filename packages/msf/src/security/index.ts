// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview MSF ↔ moq-secure-objects security bridge.
 *
 * Runtime integration for MSF §3 (Content Protection & Encryption). Callers
 * that publish or subscribe to tracks with
 * `encryptionScheme = "moq-secure-objects"` route each MOQT Object payload
 * through {@link MsfSecurityGateway} to encrypt/decrypt with the correct
 * per-track keys, cipher suite, and MOQT extension handling.
 */

export {
  CipherSuiteMappingError,
  MSF_TO_SO_CIPHER_SUITE,
  SO_TO_MSF_CIPHER_SUITE,
  toSoCipherSuite,
  toMsfCipherSuite,
} from './cipher-suite-map.js';

export {
  TrackSecurityError,
  isSecureObjectsTrack,
  createTrackContext,
  parseKeyIdToBigInt,
  type CreateTrackContextOptions,
} from './track-secure-context.js';

export {
  MsfSecurityGateway,
  ENCRYPTED_PROPERTIES_EXTENSION_ID,
  trackRequiresGateway,
  type SealedObject,
  type OpenedObject,
  type EncryptedPropertiesExtension,
} from './gateway.js';
