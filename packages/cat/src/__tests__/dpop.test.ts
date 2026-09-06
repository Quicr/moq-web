// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { describe, it, expect } from 'vitest';
import {
  CoseAlgorithm,
  CwtClaimKey,
  createDpopProof,
  decodeDpopProof,
  generateDpopKeyPair,
  jwkThumbprint,
  coseKeyThumbprint,
  moqtAuthorizationContext,
  validateCatDpopBinding,
  validateDpopProof,
} from '../index.js';
import type { CborValue, CwtClaims } from '../index.js';

describe('generic CWT DPoP', () => {
  it('creates and validates a MOQT proof with nonce and access-token binding', async () => {
    const keyPair = await generateDpopKeyPair(CoseAlgorithm.ES256);
    const accessToken = new TextEncoder().encode('cat-token');
    const context = moqtAuthorizationContext({
      action: 'subscribe',
      trackNamespace: ['room', 'blue'],
      trackName: 'video',
      parameters: new Map<number, CborValue>([[1, 'low-latency']]),
    });
    const now = 1_700_000_000;
    const proofBytes = await createDpopProof({
      privateKey: keyPair.privateKey,
      publicKey: keyPair.publicKey,
      authorizationContext: context,
      issuedAt: now,
      nonce: 'server-nonce',
      accessToken,
    });
    const proof = decodeDpopProof(proofBytes);

    expect(proof.algorithm).toBe(CoseAlgorithm.ES256);
    expect(proof.claims.cti).toBeInstanceOf(Uint8Array);
    expect(proof.claims.additionalClaims?.get(CwtClaimKey.DPOP_ACTX)).toEqual(context);

    const jkt = await jwkThumbprint(keyPair.publicKey);
    const result = await validateDpopProof(proofBytes, {
      now,
      expectedAuthorizationContext: context,
      expectedContextType: 'moqt',
      expectedNonce: 'server-nonce',
      accessToken,
      expectedJkt: jkt,
    });
    expect(result.valid, result.error).toBe(true);
    expect(await validateCatDpopBinding({ cnf: new Map([[323, jkt]]) } as CwtClaims, proof)).toBe(true);

    const wrongContext = moqtAuthorizationContext({ action: 'publish', trackNamespace: ['room', 'blue'] });
    expect((await validateDpopProof(proofBytes, { now, expectedAuthorizationContext: wrongContext })).valid).toBe(false);
    expect((await validateDpopProof(proofBytes, { now, expectedNonce: 'wrong' })).valid).toBe(false);
    expect((await validateDpopProof(proofBytes, { now, accessToken: new TextEncoder().encode('other') })).valid).toBe(false);
  });

  it('supports RSA-PSS/PS256 and COSE key confirmation', async () => {
    const keyPair = await generateDpopKeyPair(CoseAlgorithm.PS256);
    const proofBytes = await createDpopProof({
      privateKey: keyPair.privateKey,
      publicKey: keyPair.publicKey,
      authorizationContext: moqtAuthorizationContext({ action: 'fetch', trackNamespace: ['room'] }),
      issuedAt: 1_700_000_000,
      algorithm: CoseAlgorithm.PS256,
    });
    const ckt = await coseKeyThumbprint(keyPair.publicKey);
    const result = await validateDpopProof(proofBytes, { now: 1_700_000_000, expectedCkt: ckt });
    expect(result.valid, result.error).toBe(true);
    expect(ckt).toHaveLength(32);
  });

  it('rejects tampering and stale proofs', async () => {
    const keyPair = await generateDpopKeyPair();
    const proofBytes = await createDpopProof({
      privateKey: keyPair.privateKey,
      publicKey: keyPair.publicKey,
      authorizationContext: moqtAuthorizationContext({ action: 'subscribe', trackNamespace: ['room'] }),
      issuedAt: 1_700_000_000,
    });
    const tampered = proofBytes.slice();
    tampered[tampered.length - 1] ^= 1;
    expect((await validateDpopProof(tampered, { now: 1_700_000_000 })).valid).toBe(false);
    expect((await validateDpopProof(proofBytes, { now: 1_700_000_301 })).valid).toBe(false);
  });
});
