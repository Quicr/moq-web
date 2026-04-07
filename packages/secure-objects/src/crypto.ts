// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview MOQT Secure Objects Cryptographic Operations
 *
 * Implements encryption/decryption using WebCrypto API.
 * Supports AES-GCM and AES-CTR-HMAC cipher suites.
 */

import {
  CipherSuite,
  Limits,
  type EncryptionConfig,
  type EncryptionContext,
  type EncryptedObject,
  type DecryptedObject,
  type ObjectIdentifier,
  type AADComponents,
} from './types.js';
import { getCipherSuiteParams, DEFAULT_CIPHER_SUITE } from './cipher-suites.js';
import { deriveKeys } from './key-derivation.js';

/**
 * Text encoder for AAD construction.
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
 * Construct nonce from object identifier and salt.
 * nonce = XOR(salt, CTR)
 * CTR = groupId (64 bits) || objectId (32 bits) in big-endian
 */
export function constructNonce(
  salt: Uint8Array,
  objectId: ObjectIdentifier
): Uint8Array {
  // Validate limits
  if (objectId.groupId > Limits.MAX_GROUP_ID) {
    throw new Error('Group ID exceeds maximum value (2^64 - 1)');
  }
  if (objectId.objectId > Limits.MAX_OBJECT_ID) {
    throw new Error('Object ID exceeds maximum value (2^32 - 1)');
  }

  // Construct CTR: groupId (8 bytes BE) || objectId (4 bytes BE)
  const ctr = new Uint8Array(12);
  const view = new DataView(ctr.buffer);
  view.setBigUint64(0, objectId.groupId, false); // big-endian
  view.setUint32(8, objectId.objectId, false);   // big-endian

  // XOR with salt
  const nonce = new Uint8Array(12);
  for (let i = 0; i < 12; i++) {
    nonce[i] = salt[i] ^ ctr[i];
  }

  return nonce;
}

/**
 * Encode a value as a varint (MOQT-style).
 * For simplicity, supports values up to 2^30 - 1.
 */
function encodeVarInt(value: number | bigint): Uint8Array {
  const n = typeof value === 'bigint' ? Number(value) : value;

  if (n < 0x40) {
    return new Uint8Array([n]);
  } else if (n < 0x4000) {
    return new Uint8Array([0x40 | (n >> 8), n & 0xff]);
  } else if (n < 0x40000000) {
    return new Uint8Array([
      0x80 | (n >> 24),
      (n >> 16) & 0xff,
      (n >> 8) & 0xff,
      n & 0xff,
    ]);
  } else {
    // 8-byte varint for larger values
    const bytes = new Uint8Array(8);
    const bigN = BigInt(n);
    bytes[0] = 0xc0 | Number((bigN >> 56n) & 0x3fn);
    bytes[1] = Number((bigN >> 48n) & 0xffn);
    bytes[2] = Number((bigN >> 40n) & 0xffn);
    bytes[3] = Number((bigN >> 32n) & 0xffn);
    bytes[4] = Number((bigN >> 24n) & 0xffn);
    bytes[5] = Number((bigN >> 16n) & 0xffn);
    bytes[6] = Number((bigN >> 8n) & 0xffn);
    bytes[7] = Number(bigN & 0xffn);
    return bytes;
  }
}

/**
 * Construct AAD (Additional Authenticated Data) from components.
 * AAD = keyId || groupId || objectId || namespace || trackNameLen || trackName || immutableProperties
 */
export function constructAAD(components: AADComponents): Uint8Array {
  const parts: Uint8Array[] = [];

  // Key ID as varint
  parts.push(encodeVarInt(components.keyId));

  // Group ID as varint
  parts.push(encodeVarInt(components.groupId));

  // Object ID as varint
  parts.push(encodeVarInt(components.objectId));

  // Namespace: tuple count + each tuple as length-prefixed
  parts.push(encodeVarInt(components.namespace.length));
  for (const tuple of components.namespace) {
    const tupleBytes = textEncoder.encode(tuple);
    parts.push(encodeVarInt(tupleBytes.length));
    parts.push(tupleBytes);
  }

  // Track name as length-prefixed
  const trackNameBytes = textEncoder.encode(components.trackName);
  parts.push(encodeVarInt(trackNameBytes.length));
  parts.push(trackNameBytes);

  // Immutable properties: Key ID property (type 0x02)
  // Property format: type (varint) + length (varint) + value
  const keyIdBytes = encodeVarInt(components.keyId);
  parts.push(encodeVarInt(0x02)); // KEY_ID type
  parts.push(encodeVarInt(keyIdBytes.length));
  parts.push(keyIdBytes);

  // Concatenate all parts
  const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
  const aad = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    aad.set(part, offset);
    offset += part.length;
  }

  return aad;
}

/**
 * Secure Objects encryption/decryption context.
 *
 * Provides a high-performance, zero-copy-where-possible API for
 * encrypting and decrypting MOQT objects.
 */
export class SecureObjectsContext {
  private readonly context: EncryptionContext;
  private readonly params;

  private constructor(context: EncryptionContext) {
    this.context = context;
    this.params = getCipherSuiteParams(context.cipherSuite);
  }

  /**
   * Create a new encryption context.
   *
   * @param config - Configuration for the encryption context
   * @returns Promise resolving to the context
   *
   * @example
   * ```typescript
   * const ctx = await SecureObjectsContext.create({
   *   trackBaseKey: secretKey,
   *   track: { namespace: ['room'], trackName: 'video' },
   * });
   * ```
   */
  static async create(config: EncryptionConfig): Promise<SecureObjectsContext> {
    const cipherSuite = config.cipherSuite ?? DEFAULT_CIPHER_SUITE;
    const keyId = config.keyId ?? 0n;

    const { encryptionKey, salt, hmacKey } = await deriveKeys(
      config.trackBaseKey,
      config.track,
      cipherSuite,
      keyId
    );

    const context: EncryptionContext = {
      cipherSuite,
      keyId,
      key: encryptionKey,
      salt,
      track: config.track,
      hmacKey,
    };

    return new SecureObjectsContext(context);
  }

  /**
   * Get the key ID for this context.
   */
  get keyId(): bigint {
    return this.context.keyId;
  }

  /**
   * Get the cipher suite for this context.
   */
  get cipherSuite(): CipherSuite {
    return this.context.cipherSuite;
  }

  /**
   * Encrypt a plaintext object.
   *
   * @param plaintext - The data to encrypt
   * @param objectId - The object identifier (groupId, objectId)
   * @param encryptedProperties - Optional encrypted properties to append
   * @returns Promise resolving to the encrypted object
   */
  async encrypt(
    plaintext: Uint8Array,
    objectId: ObjectIdentifier,
    encryptedProperties?: Uint8Array
  ): Promise<EncryptedObject> {
    const nonce = constructNonce(this.context.salt, objectId);

    const aad = constructAAD({
      keyId: this.context.keyId,
      groupId: objectId.groupId,
      objectId: objectId.objectId,
      namespace: this.context.track.namespace,
      trackName: this.context.track.trackName,
    });

    // Construct plaintext with optional encrypted properties
    // Format: payload_length (varint) + payload + [encrypted_properties]
    let plaintextWithProperties: Uint8Array;

    if (encryptedProperties && encryptedProperties.length > 0) {
      const lengthBytes = encodeVarInt(plaintext.length);
      plaintextWithProperties = new Uint8Array(
        lengthBytes.length + plaintext.length + encryptedProperties.length
      );
      plaintextWithProperties.set(lengthBytes, 0);
      plaintextWithProperties.set(plaintext, lengthBytes.length);
      plaintextWithProperties.set(encryptedProperties, lengthBytes.length + plaintext.length);
    } else {
      // No encrypted properties - just the payload with length prefix
      const lengthBytes = encodeVarInt(plaintext.length);
      plaintextWithProperties = new Uint8Array(lengthBytes.length + plaintext.length);
      plaintextWithProperties.set(lengthBytes, 0);
      plaintextWithProperties.set(plaintext, lengthBytes.length);
    }

    let ciphertext: Uint8Array;

    // Convert to ArrayBuffer for WebCrypto API
    const nonceBuffer = toArrayBuffer(nonce);
    const aadBuffer = toArrayBuffer(aad);
    const plaintextBuffer = toArrayBuffer(plaintextWithProperties);

    if (this.params.aeadAlgorithm === 'AES-GCM') {
      // AES-GCM encryption
      const encrypted = await crypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv: nonceBuffer,
          additionalData: aadBuffer,
          tagLength: this.params.tagLength * 8, // bits
        },
        this.context.key,
        plaintextBuffer
      );
      ciphertext = new Uint8Array(encrypted);
    } else {
      // AES-CTR-HMAC encryption (encrypt-then-MAC)
      ciphertext = await this.encryptCtrHmac(plaintextWithProperties, nonce, aad);
    }

    return {
      ciphertext,
      keyId: this.context.keyId,
      cipherSuite: this.context.cipherSuite,
    };
  }

  /**
   * Decrypt an encrypted object.
   *
   * @param ciphertext - The encrypted data
   * @param objectId - The object identifier (groupId, objectId)
   * @returns Promise resolving to the decrypted object
   */
  async decrypt(
    ciphertext: Uint8Array,
    objectId: ObjectIdentifier
  ): Promise<DecryptedObject> {
    const nonce = constructNonce(this.context.salt, objectId);

    const aad = constructAAD({
      keyId: this.context.keyId,
      groupId: objectId.groupId,
      objectId: objectId.objectId,
      namespace: this.context.track.namespace,
      trackName: this.context.track.trackName,
    });

    // Convert to ArrayBuffer for WebCrypto API
    const nonceBuffer = toArrayBuffer(nonce);
    const aadBuffer = toArrayBuffer(aad);
    const ciphertextBuffer = toArrayBuffer(ciphertext);

    let decryptedWithProperties: Uint8Array;

    if (this.params.aeadAlgorithm === 'AES-GCM') {
      // AES-GCM decryption
      const decrypted = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: nonceBuffer,
          additionalData: aadBuffer,
          tagLength: this.params.tagLength * 8,
        },
        this.context.key,
        ciphertextBuffer
      );
      decryptedWithProperties = new Uint8Array(decrypted);
    } else {
      // AES-CTR-HMAC decryption
      decryptedWithProperties = await this.decryptCtrHmac(ciphertext, nonce, aad);
    }

    // Parse decrypted data: payload_length (varint) + payload + [encrypted_properties]
    const { value: payloadLength, bytesRead } = this.readVarInt(decryptedWithProperties);
    const plaintext = decryptedWithProperties.slice(bytesRead, bytesRead + payloadLength);

    let encryptedProperties: Uint8Array | undefined;
    if (bytesRead + payloadLength < decryptedWithProperties.length) {
      encryptedProperties = decryptedWithProperties.slice(bytesRead + payloadLength);
    }

    return { plaintext, encryptedProperties };
  }

  /**
   * Verify AAD without decrypting.
   * Useful for checking authentication before full decryption.
   *
   * @param ciphertext - The encrypted data
   * @param objectId - The object identifier
   * @returns Promise resolving to true if AAD verification passes
   */
  async verifyAAD(
    ciphertext: Uint8Array,
    objectId: ObjectIdentifier
  ): Promise<boolean> {
    try {
      // Attempt decryption - will throw if AAD verification fails
      await this.decrypt(ciphertext, objectId);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * AES-CTR-HMAC encryption (encrypt-then-MAC).
   */
  private async encryptCtrHmac(
    plaintext: Uint8Array,
    nonce: Uint8Array,
    aad: Uint8Array
  ): Promise<Uint8Array> {
    if (!this.context.hmacKey) {
      throw new Error('HMAC key not available for CTR-HMAC cipher suite');
    }

    // AES-CTR encryption
    // Counter block: nonce (12 bytes) + counter (4 bytes, starts at 1)
    const counter = new Uint8Array(16);
    counter.set(nonce, 0);
    counter[15] = 1; // Start counter at 1

    // Convert to ArrayBuffer for WebCrypto API
    const counterBuffer = toArrayBuffer(counter);
    const plaintextBuffer = toArrayBuffer(plaintext);

    const encrypted = await crypto.subtle.encrypt(
      {
        name: 'AES-CTR',
        counter: counterBuffer,
        length: 32, // Counter bits
      },
      this.context.key,
      plaintextBuffer
    );

    const encryptedBytes = new Uint8Array(encrypted);

    // Compute HMAC over AAD || ciphertext
    const hmacInput = new Uint8Array(aad.length + encryptedBytes.length);
    hmacInput.set(aad, 0);
    hmacInput.set(encryptedBytes, aad.length);

    const hmacFull = await crypto.subtle.sign('HMAC', this.context.hmacKey, toArrayBuffer(hmacInput));
    const tag = new Uint8Array(hmacFull, 0, this.params.tagLength);

    // Return ciphertext || tag
    const result = new Uint8Array(encryptedBytes.length + this.params.tagLength);
    result.set(encryptedBytes, 0);
    result.set(tag, encryptedBytes.length);

    return result;
  }

  /**
   * AES-CTR-HMAC decryption (verify-then-decrypt).
   */
  private async decryptCtrHmac(
    ciphertext: Uint8Array,
    nonce: Uint8Array,
    aad: Uint8Array
  ): Promise<Uint8Array> {
    if (!this.context.hmacKey) {
      throw new Error('HMAC key not available for CTR-HMAC cipher suite');
    }

    // Split ciphertext and tag
    const encryptedLength = ciphertext.length - this.params.tagLength;
    if (encryptedLength < 0) {
      throw new Error('Ciphertext too short');
    }

    const encryptedBytes = ciphertext.slice(0, encryptedLength);
    const receivedTag = ciphertext.slice(encryptedLength);

    // Verify HMAC
    const hmacInput = new Uint8Array(aad.length + encryptedBytes.length);
    hmacInput.set(aad, 0);
    hmacInput.set(encryptedBytes, aad.length);

    const hmacFull = await crypto.subtle.sign('HMAC', this.context.hmacKey, toArrayBuffer(hmacInput));
    const expectedTag = new Uint8Array(hmacFull, 0, this.params.tagLength);

    // Constant-time comparison
    if (!this.constantTimeEqual(receivedTag, expectedTag)) {
      throw new Error('Authentication failed: HMAC verification failed');
    }

    // AES-CTR decryption
    const counter = new Uint8Array(16);
    counter.set(nonce, 0);
    counter[15] = 1;

    // Convert to ArrayBuffer for WebCrypto API
    const counterBuffer = toArrayBuffer(counter);
    const encryptedBuffer = toArrayBuffer(encryptedBytes);

    const decrypted = await crypto.subtle.decrypt(
      {
        name: 'AES-CTR',
        counter: counterBuffer,
        length: 32,
      },
      this.context.key,
      encryptedBuffer
    );

    return new Uint8Array(decrypted);
  }

  /**
   * Constant-time comparison to prevent timing attacks.
   */
  private constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    let result = 0;
    for (let i = 0; i < a.length; i++) {
      result |= a[i] ^ b[i];
    }
    return result === 0;
  }

  /**
   * Read a varint from a buffer.
   */
  private readVarInt(buffer: Uint8Array): { value: number; bytesRead: number } {
    if (buffer.length === 0) {
      throw new Error('Buffer too short for varint');
    }

    const firstByte = buffer[0];
    const prefix = firstByte >> 6;

    if (prefix === 0) {
      return { value: firstByte & 0x3f, bytesRead: 1 };
    } else if (prefix === 1) {
      if (buffer.length < 2) throw new Error('Buffer too short');
      return { value: ((firstByte & 0x3f) << 8) | buffer[1], bytesRead: 2 };
    } else if (prefix === 2) {
      if (buffer.length < 4) throw new Error('Buffer too short');
      return {
        value: ((firstByte & 0x3f) << 24) | (buffer[1] << 16) | (buffer[2] << 8) | buffer[3],
        bytesRead: 4,
      };
    } else {
      if (buffer.length < 8) throw new Error('Buffer too short');
      // For 8-byte varints, we may lose precision for very large values
      const high = ((firstByte & 0x3f) << 24) | (buffer[1] << 16) | (buffer[2] << 8) | buffer[3];
      const low = (buffer[4] << 24) | (buffer[5] << 16) | (buffer[6] << 8) | buffer[7];
      return { value: high * 0x100000000 + (low >>> 0), bytesRead: 8 };
    }
  }
}
