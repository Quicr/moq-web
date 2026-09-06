// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { describe, expect, it } from 'vitest';
import {
  C4M_TOKEN_TYPE,
  CatTokenDecoder,
  CoseAlgorithm,
  MoqtAction,
  generateTestKeyPair,
} from '@moq-web/cat';
import { CatAuthProvider, createCatAuthProvider } from './provider.js';
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
});
