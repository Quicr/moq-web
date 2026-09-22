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
  type TrackIdentifier,
} from './types.js';
import { getCipherSuiteParams, DEFAULT_CIPHER_SUITE } from './cipher-suites.js';
import { deriveKeys } from './key-derivation.js';
import {
  AuthenticationError,
  DisposedError,
  EncryptionLimitError,
  InvalidFramingError,
  NonceReuseError,
  SecureObjectsError,
} from './errors.js';

/**
 * Text encoder for AAD construction.
 */
const textEncoder = new TextEncoder();

/**
 * Convert Uint8Array to ArrayBuffer for WebCrypto API compatibility.
 * Avoids copying when the array owns its full underlying buffer.
 */
function toArrayBuffer(arr: Uint8Array): ArrayBuffer {
  if (arr.byteOffset === 0 && arr.byteLength === arr.buffer.byteLength) {
    return arr.buffer as ArrayBuffer;
  }
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
    throw new InvalidFramingError('Group ID exceeds maximum value (2^64 - 1)');
  }
  if (objectId.objectId > Limits.MAX_OBJECT_ID) {
    throw new InvalidFramingError('Object ID exceeds maximum value (2^32 - 1)');
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
 * Encode a value as a varint (MOQT-style QUIC variable-length integer).
 */
function encodeVarInt(value: number | bigint): Uint8Array {
  const n = BigInt(value);

  if (n < 0x40n) {
    return new Uint8Array([Number(n)]);
  } else if (n < 0x4000n) {
    return new Uint8Array([
      0x40 | Number((n >> 8n) & 0x3fn),
      Number(n & 0xffn),
    ]);
  } else if (n < 0x40000000n) {
    return new Uint8Array([
      0x80 | Number((n >> 24n) & 0x3fn),
      Number((n >> 16n) & 0xffn),
      Number((n >> 8n) & 0xffn),
      Number(n & 0xffn),
    ]);
  } else if (n < 0x4000000000000000n) {
    const bytes = new Uint8Array(8);
    bytes[0] = 0xc0 | Number((n >> 56n) & 0x3fn);
    bytes[1] = Number((n >> 48n) & 0xffn);
    bytes[2] = Number((n >> 40n) & 0xffn);
    bytes[3] = Number((n >> 32n) & 0xffn);
    bytes[4] = Number((n >> 24n) & 0xffn);
    bytes[5] = Number((n >> 16n) & 0xffn);
    bytes[6] = Number((n >> 8n) & 0xffn);
    bytes[7] = Number(n & 0xffn);
    return bytes;
  } else {
    throw new Error(`Value ${n} exceeds maximum varint range (2^62 - 1)`);
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
 *
 * Security properties enforced at runtime:
 * - Invocation cap at 2^32 (spec-mandated for AES-GCM/CTR nonce hygiene).
 * - Bounded recent-nonce tracking: catches near-duplicate (groupId, objectId)
 *   reuse within a sliding window without unbounded memory growth. The
 *   application MUST NOT reuse (groupId, objectId) pairs — this window is a
 *   safety net, not a substitute for correct sequencing.
 * - Constant-time tag comparison for CTR-HMAC decryption.
 * - Explicit {@link dispose} to drop CryptoKey references after use.
 */
export class SecureObjectsContext {
  private static readonly MAX_INVOCATIONS = 2 ** 32;
  /** Sliding window of recently-used nonce keys. Bounded to avoid leaks. */
  private static readonly RECENT_NONCE_CAPACITY = 65536;

  private context: EncryptionContext | undefined;
  private readonly params;
  /**
   * Pre-encoded AAD head (varint keyId) — invariant for the context lifetime.
   */
  private readonly aadHead: Uint8Array;
  /**
   * Pre-encoded AAD tail: namespace tuples || trackName || immutable key-id
   * property.  Also invariant for the context lifetime.
   */
  private readonly aadTail: Uint8Array;
  private readonly recentNonces = new Set<string>();
  private readonly recentNonceOrder: string[] = [];
  private encryptionCount = 0;
  private disposed = false;

  private constructor(context: EncryptionContext) {
    this.context = context;
    this.params = getCipherSuiteParams(context.cipherSuite);
    const { head, tail } = buildAADInvariantParts(context.keyId, context.track);
    this.aadHead = head;
    this.aadTail = tail;
  }

  private requireLive(): EncryptionContext {
    if (this.disposed || !this.context) {
      throw new DisposedError('SecureObjectsContext has been disposed');
    }
    return this.context;
  }

  /**
   * Record a nonce as used, evicting the oldest tracked entry once the
   * sliding-window cap is hit. Returns `true` if the nonce was already in the
   * recent-use set (i.e. detected reuse within the window).
   */
  private trackNonce(key: string): boolean {
    if (this.recentNonces.has(key)) return true;
    this.recentNonces.add(key);
    this.recentNonceOrder.push(key);
    if (this.recentNonceOrder.length > SecureObjectsContext.RECENT_NONCE_CAPACITY) {
      const evicted = this.recentNonceOrder.shift();
      if (evicted !== undefined) this.recentNonces.delete(evicted);
    }
    return false;
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

    // Defensive copy: prevent post-create caller mutation from affecting
    // derived key material.  Zeroised as soon as HKDF completes.
    const baseKeyCopy = new Uint8Array(config.trackBaseKey.length);
    baseKeyCopy.set(config.trackBaseKey);

    // Freeze the track descriptor so its `namespace`/`trackName` cannot
    // drift after we've bound them into AAD.
    const track: TrackIdentifier = Object.freeze({
      namespace: Object.freeze([...config.track.namespace]) as unknown as string[],
      trackName: config.track.trackName,
    });

    let encryptionKey: CryptoKey;
    let salt: Uint8Array;
    let hmacKey: CryptoKey | undefined;
    try {
      ({ encryptionKey, salt, hmacKey } = await deriveKeys(
        baseKeyCopy,
        track,
        cipherSuite,
        keyId
      ));
    } finally {
      baseKeyCopy.fill(0);
    }

    const context: EncryptionContext = {
      cipherSuite,
      keyId,
      key: encryptionKey,
      salt,
      track,
      hmacKey,
    };

    return new SecureObjectsContext(context);
  }

  /**
   * Get the key ID for this context.
   */
  get keyId(): bigint {
    return this.requireLive().keyId;
  }

  /**
   * Get the cipher suite for this context.
   */
  get cipherSuite(): CipherSuite {
    return this.requireLive().cipherSuite;
  }

  /**
   * Whether this context has been disposed.
   */
  get isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * Drop references to the underlying {@link CryptoKey}s and clear
   * recent-nonce state. Further encrypt/decrypt calls will throw.
   *
   * `CryptoKey` handles are non-extractable in WebCrypto, so we cannot
   * zeroise the raw key material ourselves — but releasing the reference
   * allows the platform's implementation to zero it on GC/handle-release.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.context = undefined;
    this.recentNonces.clear();
    this.recentNonceOrder.length = 0;
  }

  /**
   * Alias of {@link dispose} for the TC39 explicit-resource-management
   * proposal (`using ctx = ...`).  Purely additive — no functional change.
   */
  [Symbol.dispose](): void {
    this.dispose();
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
    const ctx = this.requireLive();
    if (this.encryptionCount >= SecureObjectsContext.MAX_INVOCATIONS) {
      throw new EncryptionLimitError(
        'Encryption limit reached: this context has exceeded 2^32 invocations and must be rotated'
      );
    }
    this.encryptionCount++;

    const nonceKey = `${objectId.groupId}:${objectId.objectId}`;
    if (this.trackNonce(nonceKey)) {
      throw new NonceReuseError(
        'Nonce reuse detected: this (groupId, objectId) pair has been used within the recent-use window'
      );
    }

    const nonce = constructNonce(ctx.salt, objectId);
    const aad = this.buildAADForObject(objectId);

    // Format: varint(payload_length) || payload || [encrypted_properties]
    // Single pre-sized allocation avoids a second Uint8Array copy.
    const lengthBytes = encodeVarInt(plaintext.length);
    const propsLength = encryptedProperties?.length ?? 0;
    const framed = new Uint8Array(lengthBytes.length + plaintext.length + propsLength);
    framed.set(lengthBytes, 0);
    framed.set(plaintext, lengthBytes.length);
    if (propsLength > 0) {
      framed.set(encryptedProperties!, lengthBytes.length + plaintext.length);
    }

    let ciphertext: Uint8Array;
    if (this.params.aeadAlgorithm === 'AES-GCM') {
      const encrypted = await crypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv: toArrayBuffer(nonce),
          additionalData: toArrayBuffer(aad),
          tagLength: this.params.tagLength * 8,
        },
        ctx.key,
        toArrayBuffer(framed)
      );
      ciphertext = new Uint8Array(encrypted);
    } else {
      ciphertext = await this.encryptCtrHmac(ctx, framed, nonce, aad);
    }

    return {
      ciphertext,
      keyId: ctx.keyId,
      cipherSuite: ctx.cipherSuite,
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
    const ctx = this.requireLive();
    const nonce = constructNonce(ctx.salt, objectId);
    const aad = this.buildAADForObject(objectId);

    let framed: Uint8Array;
    if (this.params.aeadAlgorithm === 'AES-GCM') {
      let decrypted: ArrayBuffer;
      try {
        decrypted = await crypto.subtle.decrypt(
          {
            name: 'AES-GCM',
            iv: toArrayBuffer(nonce),
            additionalData: toArrayBuffer(aad),
            tagLength: this.params.tagLength * 8,
          },
          ctx.key,
          toArrayBuffer(ciphertext)
        );
      } catch (cause) {
        // WebCrypto throws OperationError on any AEAD failure — surface as
        // structured AuthenticationError so callers can branch on type.
        throw new AuthenticationError('AEAD authentication failed');
      }
      framed = new Uint8Array(decrypted);
    } else {
      framed = await this.decryptCtrHmac(ctx, ciphertext, nonce, aad);
    }

    // Parse: varint(payload_length) || payload || [encrypted_properties]
    const { value: payloadLength, bytesRead } = this.readVarInt(framed);
    const payloadEnd = bytesRead + payloadLength;
    if (payloadEnd > framed.length) {
      throw new InvalidFramingError('Decrypted payload length exceeds available data');
    }

    // Zero-copy views into the framed buffer. The buffer is not aliased by
    // any caller — we own it — so returning subarrays is safe.
    const plaintext = framed.subarray(bytesRead, payloadEnd);
    const encryptedProperties = payloadEnd < framed.length
      ? framed.subarray(payloadEnd)
      : undefined;

    return { plaintext, encryptedProperties };
  }

  /**
   * Attempt authentication of an encrypted object.
   *
   * Note: for AEAD ciphers there is no cheap "verify only" primitive — this
   * currently runs a full decrypt and discards the plaintext. Prefer calling
   * {@link decrypt} directly and handling failures with try/catch when you
   * intend to use the plaintext anyway.
   *
   * @param ciphertext - The encrypted data
   * @param objectId - The object identifier
   * @returns Promise resolving to true if authentication passes
   */
  async verifyAAD(
    ciphertext: Uint8Array,
    objectId: ObjectIdentifier
  ): Promise<boolean> {
    try {
      await this.decrypt(ciphertext, objectId);
      return true;
    } catch {
      return false;
    }
  }

  private static readonly MAX_CTR_PLAINTEXT_LENGTH = (2 ** 32 - 1) * 16;

  /**
   * AES-CTR-HMAC encryption (encrypt-then-MAC).
   *
   * Layout: counter = nonce(12) || u32(1). HMAC is computed over
   * `aad || ciphertext`. Truncated tag length is defined per cipher suite.
   */
  private async encryptCtrHmac(
    ctx: EncryptionContext,
    plaintext: Uint8Array,
    nonce: Uint8Array,
    aad: Uint8Array
  ): Promise<Uint8Array> {
    if (!ctx.hmacKey) {
      throw new SecureObjectsError('HMAC key not available for CTR-HMAC cipher suite');
    }

    if (plaintext.length > SecureObjectsContext.MAX_CTR_PLAINTEXT_LENGTH) {
      throw new InvalidFramingError('Plaintext exceeds maximum AES-CTR length (counter would wrap)');
    }

    const counter = new Uint8Array(16);
    counter.set(nonce, 0);
    counter[15] = 1;

    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-CTR', counter: toArrayBuffer(counter), length: 32 },
      ctx.key,
      toArrayBuffer(plaintext)
    );

    const tagLen = this.params.tagLength;
    const ctLen = encrypted.byteLength;

    // Compose result as [ciphertext || tag]. Compute HMAC directly into
    // the tail of the result buffer to avoid a separate tag copy.
    const result = new Uint8Array(ctLen + tagLen);
    result.set(new Uint8Array(encrypted), 0);

    // Single pre-sized HMAC input: aad || ciphertext.
    const hmacInput = new Uint8Array(aad.length + ctLen);
    hmacInput.set(aad, 0);
    hmacInput.set(result.subarray(0, ctLen), aad.length);

    const hmacFull = await crypto.subtle.sign('HMAC', ctx.hmacKey, toArrayBuffer(hmacInput));
    result.set(new Uint8Array(hmacFull, 0, tagLen), ctLen);

    return result;
  }

  /**
   * AES-CTR-HMAC decryption (verify-then-decrypt).
   */
  private async decryptCtrHmac(
    ctx: EncryptionContext,
    ciphertext: Uint8Array,
    nonce: Uint8Array,
    aad: Uint8Array
  ): Promise<Uint8Array> {
    if (!ctx.hmacKey) {
      throw new SecureObjectsError('HMAC key not available for CTR-HMAC cipher suite');
    }

    const tagLen = this.params.tagLength;
    const encryptedLength = ciphertext.length - tagLen;
    if (encryptedLength < 0) {
      throw new InvalidFramingError('Ciphertext too short');
    }

    // Views into the caller's buffer — no copies. We only read.
    const encryptedBytes = ciphertext.subarray(0, encryptedLength);
    const receivedTag = ciphertext.subarray(encryptedLength);

    const hmacInput = new Uint8Array(aad.length + encryptedLength);
    hmacInput.set(aad, 0);
    hmacInput.set(encryptedBytes, aad.length);

    const hmacFull = await crypto.subtle.sign('HMAC', ctx.hmacKey, toArrayBuffer(hmacInput));
    const expectedTag = new Uint8Array(hmacFull, 0, tagLen);

    if (!this.constantTimeEqual(receivedTag, expectedTag)) {
      throw new AuthenticationError('Authentication failed: HMAC verification failed');
    }

    const counter = new Uint8Array(16);
    counter.set(nonce, 0);
    counter[15] = 1;

    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-CTR', counter: toArrayBuffer(counter), length: 32 },
      ctx.key,
      toArrayBuffer(encryptedBytes)
    );

    return new Uint8Array(decrypted);
  }

  /**
   * Constant-time comparison to prevent timing attacks.
   */
  private constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
    let result = a.length ^ b.length;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
      result |= a[i] ^ b[i];
    }
    return result === 0;
  }

  /**
   * Read a varint from a buffer.
   */
  private readVarInt(buffer: Uint8Array): { value: number; bytesRead: number } {
    if (buffer.length === 0) {
      throw new InvalidFramingError('Buffer too short for varint');
    }

    const firstByte = buffer[0];
    const prefix = firstByte >> 6;

    if (prefix === 0) {
      return { value: firstByte & 0x3f, bytesRead: 1 };
    } else if (prefix === 1) {
      if (buffer.length < 2) throw new InvalidFramingError('Buffer too short');
      return { value: ((firstByte & 0x3f) << 8) | buffer[1], bytesRead: 2 };
    } else if (prefix === 2) {
      if (buffer.length < 4) throw new InvalidFramingError('Buffer too short');
      return {
        value: ((firstByte & 0x3f) << 24) | (buffer[1] << 16) | (buffer[2] << 8) | buffer[3],
        bytesRead: 4,
      };
    } else {
      if (buffer.length < 8) throw new InvalidFramingError('Buffer too short');
      const n =
        (BigInt(firstByte & 0x3f) << 56n) |
        (BigInt(buffer[1]) << 48n) |
        (BigInt(buffer[2]) << 40n) |
        (BigInt(buffer[3]) << 32n) |
        (BigInt(buffer[4]) << 24n) |
        (BigInt(buffer[5]) << 16n) |
        (BigInt(buffer[6]) << 8n) |
        BigInt(buffer[7]);
      if (n > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new InvalidFramingError('Varint value exceeds safe integer range for payload length');
      }
      return { value: Number(n), bytesRead: 8 };
    }
  }

  /**
   * Compose the per-encrypt AAD by splicing `varint(groupId) || varint(objectId)`
   * between the cached head (keyId) and tail (namespace / trackName / immutable
   * properties).  Layout matches the legacy `constructAAD()` byte-for-byte.
   */
  private buildAADForObject(objectId: ObjectIdentifier): Uint8Array {
    if (objectId.groupId > Limits.MAX_GROUP_ID) {
      throw new InvalidFramingError('Group ID exceeds maximum value (2^64 - 1)');
    }
    if (objectId.objectId > Limits.MAX_OBJECT_ID) {
      throw new InvalidFramingError('Object ID exceeds maximum value (2^32 - 1)');
    }
    const groupIdVI = encodeVarInt(objectId.groupId);
    const objectIdVI = encodeVarInt(objectId.objectId);
    const out = new Uint8Array(
      this.aadHead.length + groupIdVI.length + objectIdVI.length + this.aadTail.length
    );
    let off = 0;
    out.set(this.aadHead, off); off += this.aadHead.length;
    out.set(groupIdVI, off); off += groupIdVI.length;
    out.set(objectIdVI, off); off += objectIdVI.length;
    out.set(this.aadTail, off);
    return out;
  }
}

/**
 * Precompute the invariant head + tail of the AAD so `encrypt`/`decrypt`
 * only pay the varint cost of `groupId` and `objectId` on each call.
 */
function buildAADInvariantParts(
  keyId: bigint,
  track: TrackIdentifier
): { head: Uint8Array; tail: Uint8Array } {
  const head = encodeVarInt(keyId);

  const tailParts: Uint8Array[] = [];
  tailParts.push(encodeVarInt(track.namespace.length));
  for (const tuple of track.namespace) {
    const tupleBytes = textEncoder.encode(tuple);
    tailParts.push(encodeVarInt(tupleBytes.length));
    tailParts.push(tupleBytes);
  }
  const trackNameBytes = textEncoder.encode(track.trackName);
  tailParts.push(encodeVarInt(trackNameBytes.length));
  tailParts.push(trackNameBytes);

  // Immutable KEY_ID property (type 0x02, length-prefixed value).
  const keyIdBytes = encodeVarInt(keyId);
  tailParts.push(encodeVarInt(0x02));
  tailParts.push(encodeVarInt(keyIdBytes.length));
  tailParts.push(keyIdBytes);

  const tailLen = tailParts.reduce((s, p) => s + p.length, 0);
  const tail = new Uint8Array(tailLen);
  let off = 0;
  for (const p of tailParts) {
    tail.set(p, off);
    off += p.length;
  }
  return { head, tail };
}
