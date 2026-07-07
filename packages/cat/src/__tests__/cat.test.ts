// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { describe, it, expect, beforeAll } from 'vitest';
import {
  CatTokenBuilder,
  CatTokenDecoder,
  CoseAlgorithm,
  MoqtAction,
  base64urlEncode,
  base64urlDecode,
  coseSign1Encode,
  coseSign1Decode,
  generateTestKeyPair,
  generateTestCatToken,
  generateExpiredToken,
  generateBadSignatureToken,
  generateWrongKeyToken,
} from '../index.js';
import type { MoqtScope, CoseSign1 } from '../index.js';

describe('CatTokenBuilder', () => {
  let keyPair: CryptoKeyPair;

  beforeAll(async () => {
    keyPair = await generateTestKeyPair();
  });

  it('builds and signs a minimal token', async () => {
    const tokenBytes = await new CatTokenBuilder()
      .issuer('test')
      .sign(keyPair.privateKey);

    expect(tokenBytes).toBeInstanceOf(Uint8Array);
    expect(tokenBytes.length).toBeGreaterThan(0);
  });

  it('builds a token with all standard claims', async () => {
    const now = Math.floor(Date.now() / 1000);
    const tokenBytes = await new CatTokenBuilder()
      .issuer('https://auth.example.com')
      .subject('user-123')
      .audience('moq-relay')
      .expiration(now + 3600)
      .notBefore(now)
      .issuedAt(now)
      .cwtId(new Uint8Array([1, 2, 3, 4]))
      .sign(keyPair.privateKey);

    const token = CatTokenDecoder.decode(tokenBytes);
    expect(token.claims.iss).toBe('https://auth.example.com');
    expect(token.claims.sub).toBe('user-123');
    expect(token.claims.aud).toBe('moq-relay');
    expect(token.claims.exp).toBe(now + 3600);
    expect(token.claims.nbf).toBe(now);
    expect(token.claims.iat).toBe(now);
    expect(token.claims.cti).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it('builds a token with MoQT scopes', async () => {
    const scopes: MoqtScope[] = [{
      actions: [MoqtAction.Subscribe, MoqtAction.Publish],
      namespaceMatch: ['room', 'abc'],
    }];

    const tokenBytes = await new CatTokenBuilder()
      .issuer('test')
      .moqtScopes(scopes)
      .sign(keyPair.privateKey);

    const token = CatTokenDecoder.decode(tokenBytes);
    expect(token.claims.moqt).toBeDefined();
    expect(token.claims.moqt!.length).toBe(1);
    expect(token.claims.moqt![0].actions).toContain(MoqtAction.Subscribe);
    expect(token.claims.moqt![0].namespaceMatch).toEqual(['room', 'abc']);
  });

  it('accepts Date objects for time claims', async () => {
    const exp = new Date('2030-01-01T00:00:00Z');
    const tokenBytes = await new CatTokenBuilder()
      .issuer('test')
      .expiration(exp)
      .sign(keyPair.privateKey);

    const token = CatTokenDecoder.decode(tokenBytes);
    expect(token.claims.exp).toBe(Math.floor(exp.getTime() / 1000));
  });

  it('defaults issuedAt to current time', async () => {
    const before = Math.floor(Date.now() / 1000);
    const tokenBytes = await new CatTokenBuilder()
      .issuer('test')
      .issuedAt()
      .sign(keyPair.privateKey);
    const after = Math.floor(Date.now() / 1000);

    const token = CatTokenDecoder.decode(tokenBytes);
    expect(token.claims.iat).toBeGreaterThanOrEqual(before);
    expect(token.claims.iat).toBeLessThanOrEqual(after);
  });

  it('supports audience as array', async () => {
    const tokenBytes = await new CatTokenBuilder()
      .issuer('test')
      .audience(['relay-1', 'relay-2'])
      .sign(keyPair.privateKey);

    const token = CatTokenDecoder.decode(tokenBytes);
    expect(token.claims.aud).toEqual(['relay-1', 'relay-2']);
  });

  it('supports ES384 algorithm', async () => {
    const es384KeyPair = await generateTestKeyPair(CoseAlgorithm.ES384);
    const tokenBytes = await new CatTokenBuilder()
      .issuer('test')
      .withAlgorithm(CoseAlgorithm.ES384)
      .sign(es384KeyPair.privateKey);

    const token = CatTokenDecoder.decode(tokenBytes);
    expect(token.algorithm).toBe(CoseAlgorithm.ES384);
  });

  it('signToBase64url returns base64url string', async () => {
    const b64 = await new CatTokenBuilder()
      .issuer('test')
      .signToBase64url(keyPair.privateKey);

    expect(typeof b64).toBe('string');
    expect(b64).not.toContain('+');
    expect(b64).not.toContain('/');
    expect(b64).not.toContain('=');

    // Should be decodable
    const bytes = base64urlDecode(b64);
    const token = CatTokenDecoder.decode(bytes);
    expect(token.claims.iss).toBe('test');
  });
});

describe('CatTokenDecoder', () => {
  let keyPair: CryptoKeyPair;

  beforeAll(async () => {
    keyPair = await generateTestKeyPair();
  });

  describe('decode', () => {
    it('decodes a valid token', async () => {
      const { tokenBytes } = await generateTestCatToken({ keyPair });
      const token = CatTokenDecoder.decode(tokenBytes);
      expect(token.claims.iss).toBeDefined();
      expect(token.algorithm).toBe(CoseAlgorithm.ES256);
    });

    it('decodeFromBase64url works', async () => {
      const { tokenBytes } = await generateTestCatToken({ keyPair });
      const b64 = base64urlEncode(tokenBytes);
      const token = CatTokenDecoder.decodeFromBase64url(b64);
      expect(token.claims.iss).toBeDefined();
    });
  });

  describe('validate', () => {
    it('validates a valid token', async () => {
      const now = Math.floor(Date.now() / 1000);
      const { tokenBytes } = await generateTestCatToken({
        keyPair,
        claims: { exp: now + 3600, aud: 'moq-relay' },
      });

      const result = await CatTokenDecoder.validate(tokenBytes, keyPair.publicKey, {
        requiredAudience: 'moq-relay',
      });
      expect(result.valid).toBe(true);
      expect(result.token).toBeDefined();
    });

    it('rejects expired token', async () => {
      const { tokenBytes } = await generateExpiredToken(keyPair);

      const result = await CatTokenDecoder.validate(tokenBytes, keyPair.publicKey);
      expect(result.valid).toBe(false);
      expect(result.expired).toBe(true);
      expect(result.error).toContain('expired');
    });

    it('rejects token with bad signature and does NOT return claims ', async () => {
      const { tokenBytes } = await generateBadSignatureToken(keyPair);

      const result = await CatTokenDecoder.validate(tokenBytes, keyPair.publicKey);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('signature');
      // Token must NOT be returned when signature is invalid
      expect(result.token).toBeUndefined();
    });

    it('rejects token signed with wrong key and does NOT return claims ', async () => {
      const { tokenBytes, verifyKeyPair } = await generateWrongKeyToken();

      const result = await CatTokenDecoder.validate(tokenBytes, verifyKeyPair.publicKey);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('signature');
      expect(result.token).toBeUndefined();
    });

    it('rejects token with wrong audience', async () => {
      const { tokenBytes } = await generateTestCatToken({
        keyPair,
        claims: { aud: 'wrong-relay' },
      });

      const result = await CatTokenDecoder.validate(tokenBytes, keyPair.publicKey, {
        requiredAudience: 'moq-relay',
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Audience');
    });

    it('rejects token without exp when requireExp is true', async () => {
      // Build a token with no exp claim
      const tokenBytes = await new CatTokenBuilder()
        .issuer('test')
        .subject('user')
        .audience('relay')
        .issuedAt()
        // deliberately no .expiration()
        .sign(keyPair.privateKey);

      const result = await CatTokenDecoder.validate(tokenBytes, keyPair.publicKey, {
        requireExp: true,
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('exp');
    });

    it('defaults requireExp to true', async () => {
      const tokenBytes = await new CatTokenBuilder()
        .issuer('test')
        .sign(keyPair.privateKey);

      const result = await CatTokenDecoder.validate(tokenBytes, keyPair.publicKey);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('exp');
    });

    it('allows missing exp when requireExp is false', async () => {
      const tokenBytes = await new CatTokenBuilder()
        .issuer('test')
        .sign(keyPair.privateKey);

      const result = await CatTokenDecoder.validate(tokenBytes, keyPair.publicKey, {
        requireExp: false,
      });
      expect(result.valid).toBe(true);
    });

    it('enforces requiredAlgorithm', async () => {
      const { tokenBytes } = await generateTestCatToken({ keyPair });

      // Token uses ES256, require ES384 — should fail
      const result = await CatTokenDecoder.validate(tokenBytes, keyPair.publicKey, {
        requiredAlgorithm: CoseAlgorithm.ES384,
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('signature');
    });

    it('rejects token not yet valid', async () => {
      const futureNbf = Math.floor(Date.now() / 1000) + 7200;
      const { tokenBytes } = await generateTestCatToken({
        keyPair,
        claims: { nbf: futureNbf, exp: futureNbf + 3600 },
      });

      const result = await CatTokenDecoder.validate(tokenBytes, keyPair.publicKey);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('not yet valid');
    });

    it('respects clockSkewSeconds option', async () => {
      const now = Math.floor(Date.now() / 1000);
      // Expired 30 seconds ago
      const { tokenBytes } = await generateTestCatToken({
        keyPair,
        claims: { exp: now - 30 },
      });

      // With 60-second skew, should be valid
      const result = await CatTokenDecoder.validate(tokenBytes, keyPair.publicKey, {
        clockSkewSeconds: 60,
      });
      expect(result.valid).toBe(true);

      // With 0 skew, should be expired
      const result2 = await CatTokenDecoder.validate(tokenBytes, keyPair.publicKey, {
        clockSkewSeconds: 0,
      });
      expect(result2.valid).toBe(false);
      expect(result2.expired).toBe(true);
    });

    it('supports now option for testing', async () => {
      const { tokenBytes } = await generateTestCatToken({
        keyPair,
        claims: { exp: 2000000000 }, // year 2033
      });

      // Pretend current time is year 2034
      const result = await CatTokenDecoder.validate(tokenBytes, keyPair.publicKey, {
        now: 2100000000,
        clockSkewSeconds: 0,
      });
      expect(result.valid).toBe(false);
      expect(result.expired).toBe(true);
    });

    it('validates from base64url', async () => {
      const { tokenBytes } = await generateTestCatToken({ keyPair });
      const b64 = base64urlEncode(tokenBytes);

      const result = await CatTokenDecoder.validateFromBase64url(b64, keyPair.publicKey);
      expect(result.valid).toBe(true);
    });
  });

  describe('tampered payload detection', () => {
    it('detects tampered payload bytes', async () => {
      const { tokenBytes } = await generateTestCatToken({ keyPair });

      // Decode, tamper payload, re-encode
      const sign1 = coseSign1Decode(tokenBytes);
      const tampered: CoseSign1 = {
        ...sign1,
        payload: new Uint8Array([0xff, 0xff, 0xff]),
      };
      const tamperedBytes = coseSign1Encode(tampered);

      const result = await CatTokenDecoder.validate(tamperedBytes, keyPair.publicKey);
      expect(result.valid).toBe(false);
    });
  });
});

describe('base64url utilities', () => {
  it('round-trips bytes', () => {
    const original = new Uint8Array([0, 1, 2, 253, 254, 255]);
    const encoded = base64urlEncode(original);
    const decoded = base64urlDecode(encoded);
    expect(decoded).toEqual(original);
  });

  it('produces URL-safe encoding', () => {
    const data = new Uint8Array(100);
    crypto.getRandomValues(data);
    const encoded = base64urlEncode(data);
    expect(encoded).not.toContain('+');
    expect(encoded).not.toContain('/');
    expect(encoded).not.toContain('=');
  });

  it('rejects invalid base64url characters', () => {
    expect(() => base64urlDecode('abc def')).toThrow(); // space
    expect(() => base64urlDecode('abc\ndef')).toThrow(); // newline
    expect(() => base64urlDecode('abc+def')).toThrow(); // standard base64 char
  });

  it('rejects oversized input', () => {
    const huge = 'A'.repeat(13000);
    expect(() => base64urlDecode(huge)).toThrow();
  });
});
