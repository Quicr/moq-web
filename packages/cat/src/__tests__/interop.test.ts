// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { describe, it, expect } from 'vitest';
import {
  CatTokenDecoder,
  CoseAlgorithm,
  coseMac0Decode,
  coseMac0Verify,
} from '../index.js';

function hexToBytes(hex: string): Uint8Array {
  const result = new Uint8Array(hex.length / 2);
  for (let i = 0; i < result.length; i++) result[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return result;
}

describe('CAT-4-MOQT PR #47 interop vectors', () => {
  it('decodes and verifies the tagged COSE_Mac0 HMAC-256/256 vector', async () => {
    const token = hexToBytes(
      'd18448a201051063434154a0583fa301781868747470733a2f2f617574682e6578616d706c652e636f6d' +
      '0381781968747470733a2f2f72656c61792e6578616d706c652e636f6d041a65554280582016ca16a2d4e2476528ae858d91b00f257a507fe57284bfb13d7d6ca1f065e230',
    );
    const key = await crypto.subtle.importKey(
      'raw',
      new Uint8Array(Array.from({ length: 32 }, (_, index) => index)),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    const decoded = CatTokenDecoder.decode(token);
    expect(decoded.messageType).toBe('Mac0');
    expect(decoded.algorithm).toBe(CoseAlgorithm.HMAC_256_256);
    expect(await coseMac0Verify(coseMac0Decode(token), key, CoseAlgorithm.HMAC_256_256)).toBe(true);
    expect((await CatTokenDecoder.validate(token, key, { requiredAlgorithm: CoseAlgorithm.HMAC_256_256, now: 1_700_000_000 })).valid).toBe(true);
  });
});
