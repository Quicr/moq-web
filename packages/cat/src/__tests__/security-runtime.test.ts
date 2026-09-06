// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { describe, it, expect } from 'vitest';
import {
  CatTokenBuilder,
  CoseAlgorithm,
  MemoryReplayStore,
  MoqtAction,
  MoqtMatchType,
  createDpopProof,
  evaluateCatPolicy,
  generateAesGcmKey,
  generateDpopKeyPair,
  decryptCwtClaims,
  encryptCwtClaims,
  importCatJwk,
  jwkThumbprint,
  moqtAuthorizationContext,
  staticCatKeyResolver,
  validateCatRequest,
  validateCatRequestWithResolver,
} from '../index.js';
import type { CwtClaims, MoqtScope } from '../index.js';

describe('runtime CAT security modules', () => {
  it('evaluates MOQT exact, prefix, suffix, and bounded namespace scopes', async () => {
    const scopes: MoqtScope[] = [{
      actions: [MoqtAction.Subscribe],
      namespaceMatch: ['room', { type: MoqtMatchType.Prefix, value: 'user-' }, null],
      trackMatch: { type: MoqtMatchType.Suffix, value: '.m4s' },
    }];
    const allowed = await evaluateCatPolicy({ moqt: scopes }, { action: MoqtAction.Subscribe, namespace: ['room', 'user-alice'], trackName: 'video.m4s' });
    const wrongNamespace = await evaluateCatPolicy({ moqt: scopes }, { action: MoqtAction.Subscribe, namespace: ['room', 'user-alice', 'extra'], trackName: 'video.m4s' });
    const wrongTrack = await evaluateCatPolicy({ moqt: scopes }, { action: MoqtAction.Subscribe, namespace: ['room', 'user-alice'], trackName: 'video.webm' });
    expect(allowed.allowed).toBe(true);
    expect(wrongNamespace.allowed).toBe(false);
    expect(wrongTrack.allowed).toBe(false);
  });

  it('enforces method, ALPN, URI, and header claims', async () => {
    const claims: CwtClaims = {
      catm: ['GET'],
      catalpn: [new TextEncoder().encode('h3')],
      catu: new Map([[3, new Map([[1, '/media']])]]),
      cath: new Map([['X-Tenant', new Map([[0, 'alpha']])]]),
    };
    const result = await evaluateCatPolicy(claims, {
      method: 'GET',
      alpn: new TextEncoder().encode('h3'),
      uri: 'https://example.test/media/file',
      headers: { 'x-tenant': 'alpha' },
    });
    expect(result.allowed).toBe(true);
    expect((await evaluateCatPolicy(claims, { method: 'POST', alpn: new TextEncoder().encode('h3'), uri: 'https://example.test/media/file', headers: { 'x-tenant': 'alpha' } })).allowed).toBe(false);
  });

  it('provides atomic in-memory replay decisions', async () => {
    const store = new MemoryReplayStore({ now: () => 100 });
    const id = new Uint8Array([1, 2, 3]);
    expect(await store.checkAndStore(id, 200)).toBe(true);
    expect(await store.checkAndStore(id, 200)).toBe(false);
    expect(store.size).toBe(1);
  });

  it('composes CAT, DPoP, policy, and replay validation', async () => {
    const signer = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    const dpopKeys = await generateDpopKeyPair();
    const jkt = await jwkThumbprint(dpopKeys.publicKey);
    const cat = await new CatTokenBuilder()
      .issuer('issuer')
      .audience('relay')
      .expiration(1_700_000_600)
      .issuedAt(1_700_000_000)
      .replayPolicy(1)
      .cwtId(new Uint8Array([1, 2, 3, 4]))
      .confirmation(new Map([[323, jkt]]))
      .dpopSettings(new Map([[0, 300], [1, 1]]))
      .moqtScopes([{ actions: [MoqtAction.Subscribe], namespaceMatch: ['room'], trackMatch: 'video' }])
      .sign(signer.privateKey);
    const proof = await createDpopProof({
      privateKey: dpopKeys.privateKey,
      publicKey: dpopKeys.publicKey,
      authorizationContext: moqtAuthorizationContext({ action: 'subscribe', trackNamespace: ['room'], trackName: 'video' }),
      issuedAt: 1_700_000_000,
    });
    const replayStore = new MemoryReplayStore({ now: () => 1_700_000_000 });
    const validationOptions = {
      now: 1_700_000_000,
      requiredAudience: 'relay',
      dpopProof: proof,
      replayStore,
      request: { action: MoqtAction.Subscribe, namespace: ['room'], trackName: 'video' },
      dpop: { expectedContextType: 'moqt', now: 1_700_000_000 },
    } as const;
    const result = await validateCatRequest(cat, signer.publicKey, validationOptions);
    expect(result.valid).toBe(true);
    expect((await validateCatRequest(cat, signer.publicKey, validationOptions)).valid).toBe(false);
  });

  it('encrypts and authenticates CWT claims with COSE_Encrypt0', async () => {
    const key = await generateAesGcmKey(3);
    const claims: CwtClaims = { iss: 'issuer', cti: new Uint8Array([7, 8, 9]) };
    const encrypted = await encryptCwtClaims(claims, key);
    expect(await decryptCwtClaims(encrypted, key)).toEqual(claims);
    const tampered = encrypted.slice();
    tampered[tampered.length - 1] ^= 1;
    await expect(decryptCwtClaims(tampered, key)).rejects.toThrow();
  });

  it('resolves algorithm-compatible JWK keys by kid', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
    const key = await importCatJwk(jwk, CoseAlgorithm.ES256);
    const resolved = await staticCatKeyResolver(new Map([['a2lk', key]])).resolve(new Uint8Array([0x6b, 0x69, 0x64]), CoseAlgorithm.ES256);
    expect(resolved).toBe(key);
    const token = await new CatTokenBuilder().protectedHeader(4, new Uint8Array([0x6b, 0x69, 0x64])).sign(pair.privateKey);
    expect((await validateCatRequestWithResolver(token, staticCatKeyResolver(new Map([['a2lk', key]])))).valid).toBe(true);
  });

  it('rejects AES-GCM algorithm/key-length mismatches', async () => {
    const key = await generateAesGcmKey(1);
    await expect(encryptCwtClaims({}, key, { algorithm: 3 })).rejects.toThrow();
  });
});
