// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { describe, it, expect, beforeAll } from 'vitest';
import {
  CatTokenBuilder,
  CatTokenDecoder,
  MoqtAction,
  cborEncode,
  cborDecode,
  generateTestKeyPair,
  base64urlEncode,
} from '../index.js';
import type { CborValue } from '../index.js';

describe('Performance', () => {
  let keyPair: CryptoKeyPair;
  let sampleToken: Uint8Array;

  beforeAll(async () => {
    keyPair = await generateTestKeyPair();
    const now = Math.floor(Date.now() / 1000);
    sampleToken = await new CatTokenBuilder()
      .issuer('https://auth.example.com')
      .subject('user-123')
      .audience('moq-relay')
      .expiration(now + 3600)
      .issuedAt(now)
      .moqtScopes([{
        actions: [MoqtAction.Subscribe, MoqtAction.Publish, MoqtAction.SubscribeNamespace],
        namespaceMatch: ['conference', 'room-1'],
      }])
      .sign(keyPair.privateKey);
  });

  it('CBOR encode: 1000 maps under 150ms', () => {
    const map = new Map<number, CborValue>([
      [1, 'https://auth.example.com'],
      [2, 'user-123'],
      [3, 'moq-relay'],
      [4, 1700000000],
      [6, 1699996400],
    ]);

    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      cborEncode(map);
    }
    const elapsed = performance.now() - start;

    // eslint-disable-next-line no-console
    console.log(`CBOR encode 1000 maps: ${elapsed.toFixed(2)}ms (${(elapsed / 1000).toFixed(3)}ms/op)`);
    expect(elapsed).toBeLessThan(150);
  });

  it('CBOR decode: 1000 maps under 50ms', () => {
    const map = new Map<number, CborValue>([
      [1, 'https://auth.example.com'],
      [2, 'user-123'],
      [3, 'moq-relay'],
      [4, 1700000000],
      [6, 1699996400],
    ]);
    const encoded = cborEncode(map);

    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      cborDecode(encoded);
    }
    const elapsed = performance.now() - start;

    // eslint-disable-next-line no-console
    console.log(`CBOR decode 1000 maps: ${elapsed.toFixed(2)}ms (${(elapsed / 1000).toFixed(3)}ms/op)`);
    expect(elapsed).toBeLessThan(50);
  });

  it('CAT token decode (no verify): 1000 tokens under 100ms', () => {
    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      CatTokenDecoder.decode(sampleToken);
    }
    const elapsed = performance.now() - start;

    // eslint-disable-next-line no-console
    console.log(`CAT decode 1000 tokens: ${elapsed.toFixed(2)}ms (${(elapsed / 1000).toFixed(3)}ms/op)`);
    expect(elapsed).toBeLessThan(100);
  });

  it('CAT token decode from base64url: 1000 tokens under 150ms', () => {
    const b64 = base64urlEncode(sampleToken);

    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      CatTokenDecoder.decodeFromBase64url(b64);
    }
    const elapsed = performance.now() - start;

    // eslint-disable-next-line no-console
    console.log(`CAT decode base64url 1000 tokens: ${elapsed.toFixed(2)}ms (${(elapsed / 1000).toFixed(3)}ms/op)`);
    expect(elapsed).toBeLessThan(150);
  });

  it('CAT token sign: 100 tokens under 5000ms', async () => {
    const now = Math.floor(Date.now() / 1000);
    const builder = new CatTokenBuilder()
      .issuer('https://auth.example.com')
      .subject('user-123')
      .audience('moq-relay')
      .expiration(now + 3600)
      .issuedAt(now)
      .moqtScopes([{
        actions: [MoqtAction.Subscribe, MoqtAction.Publish],
        namespaceMatch: ['room', 'test'],
      }]);

    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      await builder.sign(keyPair.privateKey);
    }
    const elapsed = performance.now() - start;

    // eslint-disable-next-line no-console
    console.log(`CAT sign 100 tokens: ${elapsed.toFixed(2)}ms (${(elapsed / 100).toFixed(2)}ms/op)`);
    expect(elapsed).toBeLessThan(5000);
  });

  it('CAT token validate (sign+verify): 100 tokens under 10000ms', async () => {
    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      await CatTokenDecoder.validate(sampleToken, keyPair.publicKey);
    }
    const elapsed = performance.now() - start;

    // eslint-disable-next-line no-console
    console.log(`CAT validate 100 tokens: ${elapsed.toFixed(2)}ms (${(elapsed / 100).toFixed(2)}ms/op)`);
    expect(elapsed).toBeLessThan(10000);
  });
});
