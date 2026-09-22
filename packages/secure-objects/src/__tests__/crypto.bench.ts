// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Micro-benchmarks for the Secure Objects encrypt/decrypt hot
 * paths.  Baseline for detecting regressions in AAD/nonce construction and
 * the framed-plaintext single-allocation layout.
 *
 * Each `encrypt` bench uses a fresh, monotonically-increasing `(groupId,
 * objectId)` pair so the recent-nonce sliding window never trips inside the
 * same run.  `decrypt` reuses a pre-encrypted pool — decrypt does not touch
 * the nonce tracker.
 *
 * Run: `pnpm --filter @moq-web/secure-objects exec vitest bench --run
 * src/__tests__/crypto.bench.ts`.
 */

import { bench, describe } from 'vitest';
import { SecureObjectsContext, CipherSuite } from '../index.js';
import type { EncryptedObject } from '../types.js';

const track = {
  namespace: ['conference', 'room-1'],
  trackName: 'video',
};

const key16 = new Uint8Array(16);
const key32 = new Uint8Array(32);
const key48 = new Uint8Array(48);
crypto.getRandomValues(key16);
crypto.getRandomValues(key32);
crypto.getRandomValues(key48);

const smallPayload = new Uint8Array(64);
const mediaPayload = new Uint8Array(1200); // ~1 datagram
const framePayload = new Uint8Array(8192); // ~1 encoded video frame
crypto.getRandomValues(smallPayload);
crypto.getRandomValues(mediaPayload);
crypto.getRandomValues(framePayload);

async function makeContext(cipherSuite: CipherSuite): Promise<SecureObjectsContext> {
  const key = cipherSuite === CipherSuite.AES_256_GCM_SHA512_128
    ? key32
    : cipherSuite === CipherSuite.AES_128_GCM_SHA256_128
    ? key16
    : key48;
  return SecureObjectsContext.create({
    trackBaseKey: key,
    track,
    cipherSuite,
  });
}

const gcm128 = await makeContext(CipherSuite.AES_128_GCM_SHA256_128);
const gcm256 = await makeContext(CipherSuite.AES_256_GCM_SHA512_128);
const ctrHmac128 = await makeContext(CipherSuite.AES_128_CTR_HMAC_SHA256_80);

// Monotonic object-id counters keep each encrypt call on a fresh nonce.
let idGcm128 = 0;
let idGcm256 = 0;
let idCtr = 0;

describe('encrypt (AES-128-GCM)', () => {
  bench('64 B payload', async () => {
    await gcm128.encrypt(smallPayload, { groupId: 0n, objectId: idGcm128++ });
  });
  bench('1200 B payload (datagram)', async () => {
    await gcm128.encrypt(mediaPayload, { groupId: 1n, objectId: idGcm128++ });
  });
  bench('8192 B payload (frame)', async () => {
    await gcm128.encrypt(framePayload, { groupId: 2n, objectId: idGcm128++ });
  });
});

describe('encrypt (AES-256-GCM)', () => {
  bench('1200 B payload (datagram)', async () => {
    await gcm256.encrypt(mediaPayload, { groupId: 0n, objectId: idGcm256++ });
  });
});

describe('encrypt (AES-128-CTR-HMAC)', () => {
  bench('1200 B payload (datagram)', async () => {
    await ctrHmac128.encrypt(mediaPayload, { groupId: 0n, objectId: idCtr++ });
  });
});

// Pre-encrypt a small pool per suite so decrypt benches don't depend on
// encrypt-side allocation costs.
async function pool(
  ctx: SecureObjectsContext,
  payload: Uint8Array,
  count: number,
  groupId: bigint,
): Promise<Array<{ ct: Uint8Array; groupId: bigint; objectId: number }>> {
  const out: Array<{ ct: Uint8Array; groupId: bigint; objectId: number }> = [];
  for (let i = 0; i < count; i++) {
    const enc: EncryptedObject = await ctx.encrypt(payload, {
      groupId,
      objectId: i,
    });
    out.push({ ct: enc.ciphertext, groupId, objectId: i });
  }
  return out;
}

const decryptPoolGcm = await pool(gcm128, mediaPayload, 64, 100n);
const decryptPoolCtr = await pool(ctrHmac128, mediaPayload, 64, 100n);
let decryptIdxGcm = 0;
let decryptIdxCtr = 0;

describe('decrypt (AES-128-GCM, 1200 B)', () => {
  bench('roundtrip', async () => {
    const item = decryptPoolGcm[decryptIdxGcm++ % decryptPoolGcm.length];
    await gcm128.decrypt(item.ct, { groupId: item.groupId, objectId: item.objectId });
  });
});

describe('decrypt (AES-128-CTR-HMAC, 1200 B)', () => {
  bench('roundtrip', async () => {
    const item = decryptPoolCtr[decryptIdxCtr++ % decryptPoolCtr.length];
    await ctrHmac128.decrypt(item.ct, { groupId: item.groupId, objectId: item.objectId });
  });
});
