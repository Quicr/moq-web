// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview MOQT Secure Objects Key Derivation
 *
 * Implements HKDF-based key derivation as specified in draft-ietf-moq-secure-objects.
 */

import { CipherSuite, type TrackIdentifier } from './types.js';
import { getCipherSuiteParams } from './cipher-suites.js';

/**
 * Label prefix for key derivation.
 */
const KEY_LABEL_PREFIX = 'MOQ 1.0 Secure Objects Secret key';

/**
 * Label prefix for salt derivation.
 */
const SALT_LABEL_PREFIX = 'MOQ 1.0 Secret salt';

/**
 * Fixed application-specific salt for HKDF-Extract domain separation.
 */
const HKDF_SALT = new TextEncoder().encode('MOQ Secure Objects v1');

/**
 * Text encoder for label construction.
 */
const textEncoder = new TextEncoder();

/**
 * Convert Uint8Array to ArrayBuffer for WebCrypto API compatibility.
 * Handles the TypeScript strict mode issue with SharedArrayBuffer.
 */
function toArrayBuffer(arr: Uint8Array): ArrayBuffer {
  return arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength) as ArrayBuffer;
}

/**
 * Encode a value as a QUIC-style varint.
 */
function encodeVarInt(value: number): Uint8Array {
  if (value < 0x40) {
    return new Uint8Array([value]);
  } else if (value < 0x4000) {
    return new Uint8Array([0x40 | (value >> 8), value & 0xff]);
  } else if (value < 0x40000000) {
    return new Uint8Array([
      0x80 | (value >> 24),
      (value >> 16) & 0xff,
      (value >> 8) & 0xff,
      value & 0xff,
    ]);
  } else {
    throw new Error(`Length value ${value} exceeds varint 4-byte range`);
  }
}

/**
 * Serialize a track name for use in key derivation labels.
 * Format: namespace tuple count (varint) + each tuple as length-prefixed bytes + track name length + track name bytes
 */
export function serializeTrackName(track: TrackIdentifier): Uint8Array {
  const parts: Uint8Array[] = [];

  parts.push(encodeVarInt(track.namespace.length));

  for (const tuple of track.namespace) {
    const tupleBytes = textEncoder.encode(tuple);
    parts.push(encodeVarInt(tupleBytes.length));
    parts.push(tupleBytes);
  }

  const trackNameBytes = textEncoder.encode(track.trackName);
  parts.push(encodeVarInt(trackNameBytes.length));
  parts.push(trackNameBytes);

  // Concatenate all parts
  const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }

  return result;
}

/**
 * Construct the label for HKDF-Expand.
 * Label format: prefix + serialized_full_track_name + cipher_suite (2 bytes BE) + key_id (8 bytes BE)
 */
function constructLabel(
  prefix: string,
  track: TrackIdentifier,
  cipherSuite: CipherSuite,
  keyId: bigint
): Uint8Array {
  const prefixBytes = textEncoder.encode(prefix);
  const trackNameBytes = serializeTrackName(track);

  // Cipher suite as 2-byte big-endian
  const cipherSuiteBytes = new Uint8Array(2);
  cipherSuiteBytes[0] = (cipherSuite >> 8) & 0xff;
  cipherSuiteBytes[1] = cipherSuite & 0xff;

  // Key ID as 8-byte big-endian
  const keyIdBytes = new Uint8Array(8);
  const keyIdView = new DataView(keyIdBytes.buffer);
  keyIdView.setBigUint64(0, keyId, false); // big-endian

  // Concatenate all parts
  const totalLength = prefixBytes.length + trackNameBytes.length + 2 + 8;
  const label = new Uint8Array(totalLength);
  let offset = 0;

  label.set(prefixBytes, offset);
  offset += prefixBytes.length;

  label.set(trackNameBytes, offset);
  offset += trackNameBytes.length;

  label.set(cipherSuiteBytes, offset);
  offset += 2;

  label.set(keyIdBytes, offset);

  return label;
}

const MIN_KEY_LENGTH = 16;

/**
 * Derive the MOQ secret using HKDF-Extract.
 * moq_secret = HKDF-Extract("", track_base_key)
 */
async function deriveSecret(trackBaseKey: Uint8Array): Promise<CryptoKey> {
  if (trackBaseKey.length < MIN_KEY_LENGTH) {
    throw new Error(`trackBaseKey must be at least ${MIN_KEY_LENGTH} bytes (got ${trackBaseKey.length})`);
  }

  // Import track_base_key as HKDF key material
  const baseKey = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(trackBaseKey),
    'HKDF',
    false,
    ['deriveBits', 'deriveKey']
  );

  return baseKey;
}

/**
 * Derive encryption key using HKDF-Expand.
 */
export async function deriveEncryptionKey(
  trackBaseKey: Uint8Array,
  track: TrackIdentifier,
  cipherSuite: CipherSuite,
  keyId: bigint
): Promise<CryptoKey> {
  const params = getCipherSuiteParams(cipherSuite);
  const label = constructLabel(KEY_LABEL_PREFIX, track, cipherSuite, keyId);

  // Import base key for HKDF
  const baseKey = await deriveSecret(trackBaseKey);

  // Convert label to ArrayBuffer for WebCrypto API
  const labelBuffer = toArrayBuffer(label);
  const salt = toArrayBuffer(HKDF_SALT);

  if (params.aeadAlgorithm === 'AES-GCM') {
    // Derive AES-GCM key directly
    return crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: params.hashAlgorithm,
        salt,
        info: labelBuffer,
      },
      baseKey,
      {
        name: 'AES-GCM',
        length: params.keyLength * 8, // bits
      },
      false, // not extractable for security
      ['encrypt', 'decrypt']
    );
  } else {
    // For AES-CTR-HMAC, derive raw bits and import as AES-CTR key
    // The full key is 48 bytes: 16 for AES + 32 for HMAC
    const keyBits = await crypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: params.hashAlgorithm,
        salt,
        info: labelBuffer,
      },
      baseKey,
      params.keyLength * 8 // 48 * 8 = 384 bits
    );

    // First 16 bytes for AES-CTR
    const aesKeyBytes = new Uint8Array(keyBits, 0, 16);
    const key = await crypto.subtle.importKey(
      'raw',
      toArrayBuffer(aesKeyBytes),
      { name: 'AES-CTR' },
      false,
      ['encrypt', 'decrypt']
    );
    new Uint8Array(keyBits).fill(0);
    return key;
  }
}

/**
 * Derive HMAC key for CTR-HMAC cipher suites.
 */
export async function deriveHmacKey(
  trackBaseKey: Uint8Array,
  track: TrackIdentifier,
  cipherSuite: CipherSuite,
  keyId: bigint
): Promise<CryptoKey> {
  const params = getCipherSuiteParams(cipherSuite);

  if (params.aeadAlgorithm !== 'AES-CTR-HMAC') {
    throw new Error('HMAC key only needed for AES-CTR-HMAC cipher suites');
  }

  const label = constructLabel(KEY_LABEL_PREFIX, track, cipherSuite, keyId);
  const baseKey = await deriveSecret(trackBaseKey);

  // Convert to ArrayBuffer for WebCrypto API
  const labelBuffer = toArrayBuffer(label);
  const salt = toArrayBuffer(HKDF_SALT);

  // Derive full key material
  const keyBits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: params.hashAlgorithm,
      salt,
      info: labelBuffer,
    },
    baseKey,
    params.keyLength * 8 // 48 * 8 = 384 bits
  );

  // Last 32 bytes for HMAC-SHA256
  const hmacKeyBytes = new Uint8Array(keyBits, 16, 32);
  const key = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(hmacKeyBytes),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
  new Uint8Array(keyBits).fill(0);
  return key;
}

/**
 * Derive salt for nonce construction using HKDF-Expand.
 */
export async function deriveSalt(
  trackBaseKey: Uint8Array,
  track: TrackIdentifier,
  cipherSuite: CipherSuite,
  keyId: bigint
): Promise<Uint8Array> {
  const params = getCipherSuiteParams(cipherSuite);
  const label = constructLabel(SALT_LABEL_PREFIX, track, cipherSuite, keyId);

  // Import base key for HKDF
  const baseKey = await deriveSecret(trackBaseKey);

  // Convert to ArrayBuffer for WebCrypto API
  const labelBuffer = toArrayBuffer(label);
  const hkdfSalt = toArrayBuffer(HKDF_SALT);

  // Derive salt bytes
  const saltBits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: params.hashAlgorithm,
      salt: hkdfSalt,
      info: labelBuffer,
    },
    baseKey,
    params.nonceLength * 8 // 12 * 8 = 96 bits
  );

  return new Uint8Array(saltBits);
}

/**
 * Derive all keys needed for encryption/decryption.
 */
export async function deriveKeys(
  trackBaseKey: Uint8Array,
  track: TrackIdentifier,
  cipherSuite: CipherSuite,
  keyId: bigint
): Promise<{
  encryptionKey: CryptoKey;
  salt: Uint8Array;
  hmacKey?: CryptoKey;
}> {
  const params = getCipherSuiteParams(cipherSuite);

  const [encryptionKey, salt] = await Promise.all([
    deriveEncryptionKey(trackBaseKey, track, cipherSuite, keyId),
    deriveSalt(trackBaseKey, track, cipherSuite, keyId),
  ]);

  let hmacKey: CryptoKey | undefined;
  if (params.aeadAlgorithm === 'AES-CTR-HMAC') {
    hmacKey = await deriveHmacKey(trackBaseKey, track, cipherSuite, keyId);
  }

  return { encryptionKey, salt, hmacKey };
}
