// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { describe, expect, it } from 'vitest';
import {
  C4M_TOKEN_TYPE,
  CatTokenDecoder,
  CoseAlgorithm,
  MemoryReplayStore,
  MoqtAction,
  generateDpopKeyPair,
  generateTestKeyPair,
  staticCatKeyResolver,
} from '@moq-web/cat';
import { CatAuthProvider, createCatAuthProvider, type CatDpopProof } from './provider.js';
import type { AuthContext } from '../auth/provider.js';

function ctx(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    namespace: ['conference', 'room-1'],
    trackName: 'video-main',
    action: 'subscribe',
    ...overrides,
  };
}

describe('CatAuthProvider', () => {
  it('mints C4M tokens with scheme=cat and C4M token type', async () => {
    const { privateKey } = await generateTestKeyPair();
    const provider = new CatAuthProvider({
      signingKey: privateKey,
      issuer: 'https://auth.example.com',
      audience: 'moq-relay',
      subject: 'user-42',
    });

    expect(provider.scheme).toBe('cat');
    const token = await provider.obtainToken(ctx());
    expect(token.tokenType).toBe(C4M_TOKEN_TYPE);
    expect(token.tokenBytes.byteLength).toBeGreaterThan(0);
    expect(token.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('encodes the requested track scope + action into the CWT claims', async () => {
    const { privateKey, publicKey } = await generateTestKeyPair();
    const provider = new CatAuthProvider({
      signingKey: privateKey,
      verificationKey: publicKey,
      issuer: 'https://auth.example.com',
      audience: 'moq-relay',
      subject: 'user-42',
    });

    const token = await provider.obtainToken(
      ctx({ action: 'publish', trackName: 'logs' })
    );

    const result = await CatTokenDecoder.validate(token.tokenBytes, publicKey, {
      requiredAudience: 'moq-relay',
      requiredAlgorithm: CoseAlgorithm.ES256,
    });
    expect(result.valid).toBe(true);
    expect(result.token?.claims.iss).toBe('https://auth.example.com');
    expect(result.token?.claims.sub).toBe('user-42');
    expect(result.token?.claims.moqt).toEqual([
      {
        actions: [MoqtAction.Publish],
        namespaceMatch: ['conference', 'room-1'],
        trackMatch: 'logs',
      },
    ]);
  });

  it('resolves subject from a function of AuthContext', async () => {
    const { privateKey, publicKey } = await generateTestKeyPair();
    const provider = createCatAuthProvider({
      signingKey: privateKey,
      verificationKey: publicKey,
      issuer: 'https://auth.example.com',
      audience: 'moq-relay',
      subject: (c) => (c.sessionContext?.userId as string) ?? 'anon',
    });

    const token = await provider.obtainToken(
      ctx({ sessionContext: { userId: 'alice' } })
    );
    const decoded = CatTokenDecoder.decode(token.tokenBytes);
    expect(decoded.claims.sub).toBe('alice');
  });

  it('validateToken returns valid=true for freshly minted tokens', async () => {
    const { privateKey, publicKey } = await generateTestKeyPair();
    const provider = new CatAuthProvider({
      signingKey: privateKey,
      verificationKey: publicKey,
      issuer: 'https://auth.example.com',
      audience: 'moq-relay',
      subject: 'user-42',
      validationOptions: { requiredAudience: 'moq-relay' },
    });
    const token = await provider.obtainToken(ctx());
    const result = await provider.validateToken(token.tokenBytes, ctx());
    expect(result.valid).toBe(true);
    expect(result.subject).toBe('user-42');
    expect(result.expiresAt).toBe(token.expiresAt);
  });

  it('validateToken rejects tokens signed with a different key', async () => {
    const { privateKey } = await generateTestKeyPair();
    const { publicKey: wrongPublic } = await generateTestKeyPair();
    const provider = new CatAuthProvider({
      signingKey: privateKey,
      verificationKey: wrongPublic,
      issuer: 'https://auth.example.com',
      audience: 'moq-relay',
      subject: 'user-42',
    });
    const token = await provider.obtainToken(ctx());
    const result = await provider.validateToken(token.tokenBytes, ctx());
    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it('validateToken reports missing verification key rather than throwing', async () => {
    const { privateKey } = await generateTestKeyPair();
    const provider = new CatAuthProvider({
      signingKey: privateKey,
      issuer: 'https://auth.example.com',
      audience: 'moq-relay',
      subject: 'user-42',
    });
    const token = await provider.obtainToken(ctx());
    const result = await provider.validateToken(token.tokenBytes, ctx());
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('verificationKey');
  });

  it('honours a custom scopeBuilder', async () => {
    const { privateKey, publicKey } = await generateTestKeyPair();
    const provider = new CatAuthProvider({
      signingKey: privateKey,
      verificationKey: publicKey,
      issuer: 'https://auth.example.com',
      audience: 'moq-relay',
      subject: 'user-42',
      scopeBuilder: () => [
        {
          actions: [MoqtAction.Subscribe, MoqtAction.Fetch],
          namespaceMatch: ['tenant-a'],
        },
      ],
    });
    const token = await provider.obtainToken(ctx({ action: 'fetch' }));
    const decoded = CatTokenDecoder.decode(token.tokenBytes);
    expect(decoded.claims.moqt).toEqual([
      {
        actions: [MoqtAction.Subscribe, MoqtAction.Fetch],
        namespaceMatch: ['tenant-a'],
      },
    ]);
  });

  it('supports a scope-less token when scopeBuilder returns []', async () => {
    const { privateKey } = await generateTestKeyPair();
    const provider = new CatAuthProvider({
      signingKey: privateKey,
      issuer: 'https://auth.example.com',
      audience: 'moq-relay',
      subject: 'user-42',
      scopeBuilder: () => [],
    });
    const token = await provider.obtainToken(ctx());
    const decoded = CatTokenDecoder.decode(token.tokenBytes);
    expect(decoded.claims.moqt).toBeUndefined();
  });

  describe('DPoP-bound tokens', () => {
    it('emits a DPoP proof and validates the bound CAT + proof', async () => {
      const { privateKey, publicKey } = await generateTestKeyPair();
      const dpop = await generateDpopKeyPair();
      const provider = new CatAuthProvider({
        signingKey: privateKey,
        verificationKey: publicKey,
        issuer: 'https://auth.example.com',
        audience: 'moq-relay',
        subject: 'user-42',
        dpop: { keyPair: dpop },
      });

      const token = await provider.obtainToken(ctx({ action: 'publish' }));
      const proof = token.details?.dpopProof as CatDpopProof | undefined;
      expect(proof?.proofBytes).toBeInstanceOf(Uint8Array);
      expect(proof?.algorithm).toBe(CoseAlgorithm.ES256);

      // CAT should carry the cnf.jkt confirmation binding
      const decoded = CatTokenDecoder.decode(token.tokenBytes);
      expect(decoded.claims.cnf).toBeInstanceOf(Map);

      // Round-trip validate CAT + proof through the provider
      const result = await provider.validateToken(
        token.tokenBytes,
        ctx({ action: 'publish', dpopProof: proof!.proofBytes })
      );
      expect(result.valid).toBe(true);
      const details = result.details as { dpop?: { valid: boolean } } | undefined;
      expect(details?.dpop?.valid).toBe(true);
    });

    it('rejects a bound CAT presented without a DPoP proof', async () => {
      const { privateKey, publicKey } = await generateTestKeyPair();
      const dpop = await generateDpopKeyPair();
      const provider = new CatAuthProvider({
        signingKey: privateKey,
        verificationKey: publicKey,
        issuer: 'https://auth.example.com',
        audience: 'moq-relay',
        subject: 'user-42',
        dpop: { keyPair: dpop },
      });

      const token = await provider.obtainToken(ctx());
      const result = await provider.validateToken(token.tokenBytes, ctx());
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/DPoP/i);
    });
  });

  describe('key resolver', () => {
    it('resolves the verification key from the token kid', async () => {
      const { privateKey, publicKey } = await generateTestKeyPair();
      const resolver = staticCatKeyResolver({}, publicKey);
      const provider = new CatAuthProvider({
        signingKey: privateKey,
        keyResolver: resolver,
        issuer: 'https://auth.example.com',
        audience: 'moq-relay',
        subject: 'user-42',
      });

      const token = await provider.obtainToken(ctx());
      const result = await provider.validateToken(token.tokenBytes, ctx());
      expect(result.valid).toBe(true);
      expect(result.subject).toBe('user-42');
    });

    it('reports a friendly reason when the resolver has no key', async () => {
      const { privateKey } = await generateTestKeyPair();
      const resolver = staticCatKeyResolver({});
      const provider = new CatAuthProvider({
        signingKey: privateKey,
        keyResolver: resolver,
        issuer: 'https://auth.example.com',
        audience: 'moq-relay',
        subject: 'user-42',
      });
      const token = await provider.obtainToken(ctx());
      const result = await provider.validateToken(token.tokenBytes, ctx());
      expect(result.valid).toBe(false);
      expect(result.reason).toBeDefined();
    });
  });

  describe('policy evaluation', () => {
    it('rejects a token whose scope does not cover the requested action', async () => {
      const { privateKey, publicKey } = await generateTestKeyPair();
      const provider = new CatAuthProvider({
        signingKey: privateKey,
        verificationKey: publicKey,
        issuer: 'https://auth.example.com',
        audience: 'moq-relay',
        subject: 'user-42',
        // Only allow Subscribe scope regardless of request action
        scopeBuilder: () => [
          {
            actions: [MoqtAction.Subscribe],
            namespaceMatch: ['conference', 'room-1'],
          },
        ],
      });

      const token = await provider.obtainToken(ctx());
      // Validate against a publish request — the token only permits subscribe
      const result = await provider.validateToken(
        token.tokenBytes,
        ctx({ action: 'publish' })
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/not authorized/i);
    });

    it('accepts a token when scope matches the requested action + track', async () => {
      const { privateKey, publicKey } = await generateTestKeyPair();
      const provider = new CatAuthProvider({
        signingKey: privateKey,
        verificationKey: publicKey,
        issuer: 'https://auth.example.com',
        audience: 'moq-relay',
        subject: 'user-42',
      });
      const token = await provider.obtainToken(ctx({ action: 'fetch' }));
      const result = await provider.validateToken(
        token.tokenBytes,
        ctx({ action: 'fetch' })
      );
      expect(result.valid).toBe(true);
      const details = result.details as { policy?: { allowed: boolean } } | undefined;
      expect(details?.policy?.allowed).toBe(true);
    });
  });

  describe('replay store integration', () => {
    it('accepts distinct tokens and continues to accept them', async () => {
      const { privateKey, publicKey } = await generateTestKeyPair();
      const store = new MemoryReplayStore();
      const provider = new CatAuthProvider({
        signingKey: privateKey,
        verificationKey: publicKey,
        issuer: 'https://auth.example.com',
        audience: 'moq-relay',
        subject: 'user-42',
        replayStore: store,
      });

      // Non-replay-protected tokens don't consume the store; both should pass.
      const t1 = await provider.obtainToken(ctx());
      const t2 = await provider.obtainToken(ctx());
      const r1 = await provider.validateToken(t1.tokenBytes, ctx());
      const r2 = await provider.validateToken(t2.tokenBytes, ctx());
      expect(r1.valid).toBe(true);
      expect(r2.valid).toBe(true);
    });
  });

  describe('roundTrip convenience', () => {
    it('mints + validates in one call for DPoP-bound tokens', async () => {
      const { privateKey, publicKey } = await generateTestKeyPair();
      const dpop = await generateDpopKeyPair();
      const provider = new CatAuthProvider({
        signingKey: privateKey,
        verificationKey: publicKey,
        issuer: 'https://auth.example.com',
        audience: 'moq-relay',
        subject: 'user-42',
        dpop: { keyPair: dpop },
      });
      const result = await provider.roundTrip(ctx({ action: 'subscribe' }));
      expect(result.valid).toBe(true);
    });
  });
});
