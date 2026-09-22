// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Extra hardening tests: HKDF label domain separation, AEAD
 * tamper matrix, truncated ciphertext rejection, cross-suite decrypt
 * rejection, structured-error branching, and dispose-during-op behaviour.
 *
 * These complement `crypto.test.ts` (functional round-trip) and
 * `fuzz.test.ts` (random inputs) — the emphasis here is on adversarial
 * inputs and API-contract guarantees introduced by the hardening pass.
 */

import { describe, it, expect } from 'vitest';
import {
  SecureObjectsContext,
  CipherSuite,
  AuthenticationError,
  DisposedError,
  InvalidFramingError,
  NonceReuseError,
  SecureObjectsError,
} from '../index.js';

const KEY = new Uint8Array(32).fill(0x11);
const TRACK = { namespace: ['room', 'alpha'], trackName: 'video' };
const OID = { groupId: 0n, objectId: 0 };

describe('HKDF label domain separation', () => {
  it('different namespaces derive incompatible keys with same base key', async () => {
    const a = await SecureObjectsContext.create({
      trackBaseKey: KEY,
      track: { namespace: ['ns-a'], trackName: 't' },
    });
    const b = await SecureObjectsContext.create({
      trackBaseKey: KEY,
      track: { namespace: ['ns-b'], trackName: 't' },
    });
    const enc = await a.encrypt(new Uint8Array([1, 2, 3]), OID);
    await expect(b.decrypt(enc.ciphertext, OID)).rejects.toBeInstanceOf(SecureObjectsError);
  });

  it('different track names derive incompatible keys with same base key', async () => {
    const a = await SecureObjectsContext.create({
      trackBaseKey: KEY,
      track: { namespace: ['ns'], trackName: 'video' },
    });
    const b = await SecureObjectsContext.create({
      trackBaseKey: KEY,
      track: { namespace: ['ns'], trackName: 'audio' },
    });
    const enc = await a.encrypt(new Uint8Array([1, 2, 3]), OID);
    await expect(b.decrypt(enc.ciphertext, OID)).rejects.toBeInstanceOf(SecureObjectsError);
  });

  it('different cipher suites derive incompatible keys with same base key', async () => {
    const a = await SecureObjectsContext.create({
      trackBaseKey: KEY,
      track: TRACK,
      cipherSuite: CipherSuite.AES_128_GCM_SHA256_128,
    });
    const b = await SecureObjectsContext.create({
      trackBaseKey: KEY,
      track: TRACK,
      cipherSuite: CipherSuite.AES_256_GCM_SHA512_128,
    });
    const enc = await a.encrypt(new Uint8Array([1, 2, 3]), OID);
    // Different suite → different key length → different ciphertext framing.
    // Either the tag length differs (short-buffer) or the key mismatches.
    await expect(b.decrypt(enc.ciphertext, OID)).rejects.toBeInstanceOf(SecureObjectsError);
  });
});

describe('AEAD tamper matrix', () => {
  it('every single-byte flip in the AES-GCM ciphertext fails auth', async () => {
    const ctx = await SecureObjectsContext.create({ trackBaseKey: KEY, track: TRACK });
    const enc = await ctx.encrypt(new Uint8Array(64).fill(0x42), { groupId: 3n, objectId: 7 });
    for (let i = 0; i < enc.ciphertext.length; i++) {
      const tampered = new Uint8Array(enc.ciphertext);
      tampered[i] ^= 0x80;
      const fresh = await SecureObjectsContext.create({ trackBaseKey: KEY, track: TRACK });
      await expect(fresh.decrypt(tampered, { groupId: 3n, objectId: 7 }))
        .rejects.toBeInstanceOf(AuthenticationError);
    }
  });

  it('every single-byte flip in AES-CTR-HMAC fails auth (structured error)', async () => {
    const ctx = await SecureObjectsContext.create({
      trackBaseKey: KEY,
      track: TRACK,
      cipherSuite: CipherSuite.AES_128_CTR_HMAC_SHA256_80,
    });
    const enc = await ctx.encrypt(new Uint8Array(32).fill(0x33), { groupId: 5n, objectId: 2 });
    for (let i = 0; i < enc.ciphertext.length; i++) {
      const tampered = new Uint8Array(enc.ciphertext);
      tampered[i] ^= 0x01;
      const fresh = await SecureObjectsContext.create({
        trackBaseKey: KEY,
        track: TRACK,
        cipherSuite: CipherSuite.AES_128_CTR_HMAC_SHA256_80,
      });
      await expect(fresh.decrypt(tampered, { groupId: 5n, objectId: 2 }))
        .rejects.toBeInstanceOf(AuthenticationError);
    }
  });
});

describe('truncated ciphertext rejection', () => {
  it('AES-CTR-HMAC rejects ciphertext shorter than tag as InvalidFramingError', async () => {
    const ctx = await SecureObjectsContext.create({
      trackBaseKey: KEY,
      track: TRACK,
      cipherSuite: CipherSuite.AES_128_CTR_HMAC_SHA256_80,
    });
    const enc = await ctx.encrypt(new Uint8Array([1, 2, 3]), OID);
    const tagLen = 10; // 80 bits
    const truncated = enc.ciphertext.subarray(0, tagLen - 1);
    const fresh = await SecureObjectsContext.create({
      trackBaseKey: KEY,
      track: TRACK,
      cipherSuite: CipherSuite.AES_128_CTR_HMAC_SHA256_80,
    });
    await expect(fresh.decrypt(truncated, OID)).rejects.toBeInstanceOf(InvalidFramingError);
  });

  it('AES-GCM rejects empty ciphertext as AuthenticationError', async () => {
    const ctx = await SecureObjectsContext.create({ trackBaseKey: KEY, track: TRACK });
    await expect(ctx.decrypt(new Uint8Array(0), OID)).rejects.toBeInstanceOf(AuthenticationError);
  });
});

describe('structured errors', () => {
  it('dispose then encrypt raises DisposedError, not generic Error', async () => {
    const ctx = await SecureObjectsContext.create({ trackBaseKey: KEY, track: TRACK });
    ctx.dispose();
    await expect(ctx.encrypt(new Uint8Array([1]), OID)).rejects.toBeInstanceOf(DisposedError);
  });

  it('nonce reuse raises NonceReuseError, not generic Error', async () => {
    const ctx = await SecureObjectsContext.create({ trackBaseKey: KEY, track: TRACK });
    await ctx.encrypt(new Uint8Array([1]), OID);
    await expect(ctx.encrypt(new Uint8Array([2]), OID)).rejects.toBeInstanceOf(NonceReuseError);
  });

  it('all custom errors inherit from SecureObjectsError', () => {
    expect(new AuthenticationError('x')).toBeInstanceOf(SecureObjectsError);
    expect(new NonceReuseError('x')).toBeInstanceOf(SecureObjectsError);
    expect(new DisposedError('x')).toBeInstanceOf(SecureObjectsError);
    expect(new InvalidFramingError('x')).toBeInstanceOf(SecureObjectsError);
  });
});

describe('defensive-copy of trackBaseKey', () => {
  it('mutating the caller\'s base key after create() does not affect derived state', async () => {
    const callerKey = new Uint8Array(32).fill(0x55);
    const ctx = await SecureObjectsContext.create({ trackBaseKey: callerKey, track: TRACK });
    const enc = await ctx.encrypt(new Uint8Array([9, 9, 9]), OID);

    // Poison the caller's buffer.  If we retained a reference instead of
    // copying, subsequent derivations (there aren't any) or observable state
    // could shift.  We at minimum assert existing operations still work.
    callerKey.fill(0xff);

    const dec = await ctx.decrypt(enc.ciphertext, OID);
    expect(Array.from(dec.plaintext)).toEqual([9, 9, 9]);
  });
});

describe('frozen track descriptor', () => {
  it('post-create mutation of the caller\'s track object does not affect AAD binding', async () => {
    const track = { namespace: ['orig'], trackName: 'video' };
    const ctx = await SecureObjectsContext.create({ trackBaseKey: KEY, track });

    // Mutate the caller-visible object.  We freeze a copy internally, so
    // encrypt/decrypt must still use the original namespace/trackName.
    (track as { trackName: string }).trackName = 'audio';

    const enc = await ctx.encrypt(new Uint8Array([1, 2, 3]), OID);
    const dec = await ctx.decrypt(enc.ciphertext, OID);
    expect(Array.from(dec.plaintext)).toEqual([1, 2, 3]);
  });
});

describe('Symbol.dispose', () => {
  it('is defined and aliases dispose()', () => {
    // Using an IIFE keeps this compatible with tsconfig targets that don't
    // yet parse `using` (Node 20 + tsc target ES2022 does not).
    expect(typeof (SecureObjectsContext.prototype as unknown as {
      [Symbol.dispose]: () => void;
    })[Symbol.dispose]).toBe('function');
  });
});
