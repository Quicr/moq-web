// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { describe, it, expect } from 'vitest';
import { SecureObjectsContext, CipherSuite } from '../index.js';

/**
 * Fill array with pseudo-random bytes (faster than crypto.getRandomValues for large arrays).
 * Uses a simple PRNG seeded with crypto.getRandomValues.
 */
function fillRandomBytes(arr: Uint8Array): void {
  // For small arrays, use crypto.getRandomValues directly
  if (arr.length <= 65536) {
    crypto.getRandomValues(arr);
    return;
  }

  // For larger arrays, fill in chunks
  const chunkSize = 65536;
  for (let offset = 0; offset < arr.length; offset += chunkSize) {
    const remaining = arr.length - offset;
    const size = Math.min(chunkSize, remaining);
    crypto.getRandomValues(arr.subarray(offset, offset + size));
  }
}

describe('Performance', () => {
  const testKey = new Uint8Array(32);
  crypto.getRandomValues(testKey);

  const testTrack = {
    namespace: ['perf', 'test'],
    trackName: 'video',
  };

  describe('context creation', () => {
    it('creates context in < 10ms', async () => {
      const iterations = 10;
      const start = performance.now();

      for (let i = 0; i < iterations; i++) {
        await SecureObjectsContext.create({
          trackBaseKey: testKey,
          track: testTrack,
        });
      }

      const elapsed = performance.now() - start;
      const avgTime = elapsed / iterations;

      console.log(`Context creation: ${avgTime.toFixed(2)}ms avg`);
      expect(avgTime).toBeLessThan(10);
    });
  });

  describe('AES-GCM encryption', () => {
    // Test realistic frame sizes for video encoding
    // Small frames have more overhead per-byte, so we use different thresholds
    // Note: Thresholds are set conservatively for CI runners which are much slower than local machines
    const dataSizes = [
      { name: '1KB', size: 1024, minThroughput: 1 }, // Audio frame (CI runners have high per-op overhead)
      { name: '16KB', size: 16 * 1024, minThroughput: 20 }, // Small video frame
      { name: '64KB', size: 64 * 1024, minThroughput: 50 }, // Typical video frame
    ];

    for (const { name, size, minThroughput } of dataSizes) {
      it(`encrypts ${name} at > ${minThroughput} MB/s`, async () => {
        const ctx = await SecureObjectsContext.create({
          trackBaseKey: testKey,
          track: testTrack,
          cipherSuite: CipherSuite.AES_128_GCM_SHA256_128,
        });

        const plaintext = new Uint8Array(size);
        fillRandomBytes(plaintext);

        const iterations = 100;
        const start = performance.now();

        for (let i = 0; i < iterations; i++) {
          await ctx.encrypt(plaintext, { groupId: BigInt(i), objectId: i });
        }

        const elapsed = performance.now() - start;
        const totalBytes = size * iterations;
        const throughputMBps = (totalBytes / 1024 / 1024) / (elapsed / 1000);

        console.log(`AES-GCM encrypt ${name}: ${throughputMBps.toFixed(1)} MB/s`);
        expect(throughputMBps).toBeGreaterThan(minThroughput);
      });

      it(`decrypts ${name} at > ${minThroughput} MB/s`, async () => {
        const ctx = await SecureObjectsContext.create({
          trackBaseKey: testKey,
          track: testTrack,
          cipherSuite: CipherSuite.AES_128_GCM_SHA256_128,
        });

        const plaintext = new Uint8Array(size);
        fillRandomBytes(plaintext);

        // Pre-encrypt all data
        const encrypted: { ciphertext: Uint8Array; objectId: { groupId: bigint; objectId: number } }[] = [];
        const iterations = 100;

        for (let i = 0; i < iterations; i++) {
          const objectId = { groupId: BigInt(i), objectId: i };
          const result = await ctx.encrypt(plaintext, objectId);
          encrypted.push({ ciphertext: result.ciphertext, objectId });
        }

        const start = performance.now();

        for (const { ciphertext, objectId } of encrypted) {
          await ctx.decrypt(ciphertext, objectId);
        }

        const elapsed = performance.now() - start;
        const totalBytes = size * iterations;
        const throughputMBps = (totalBytes / 1024 / 1024) / (elapsed / 1000);

        console.log(`AES-GCM decrypt ${name}: ${throughputMBps.toFixed(1)} MB/s`);
        expect(throughputMBps).toBeGreaterThan(minThroughput);
      });
    }
  });

  describe('AES-CTR-HMAC encryption', () => {
    it('encrypts 64KB frames at acceptable rate', async () => {
      const ctx = await SecureObjectsContext.create({
        trackBaseKey: testKey,
        track: testTrack,
        cipherSuite: CipherSuite.AES_128_CTR_HMAC_SHA256_80,
      });

      const size = 64 * 1024;
      const plaintext = new Uint8Array(size);
      fillRandomBytes(plaintext);

      const iterations = 50;
      const start = performance.now();

      for (let i = 0; i < iterations; i++) {
        await ctx.encrypt(plaintext, { groupId: BigInt(i), objectId: i });
      }

      const elapsed = performance.now() - start;
      const totalBytes = size * iterations;
      const throughputMBps = (totalBytes / 1024 / 1024) / (elapsed / 1000);

      console.log(`AES-CTR-HMAC encrypt 64KB: ${throughputMBps.toFixed(1)} MB/s`);
      // CTR-HMAC is slower due to separate MAC computation
      // Threshold set conservatively for CI runners
      expect(throughputMBps).toBeGreaterThan(30);
    });
  });

  describe('frame-level performance (30fps video simulation)', () => {
    it('handles 30fps 720p frames (64KB each) without blocking', async () => {
      const ctx = await SecureObjectsContext.create({
        trackBaseKey: testKey,
        track: testTrack,
        cipherSuite: CipherSuite.AES_128_GCM_SHA256_128,
      });

      // Simulate 720p H.264 frame (~64KB average)
      const frameSize = 64 * 1024;
      const plaintext = new Uint8Array(frameSize);
      fillRandomBytes(plaintext);

      // Simulate 1 second of 30fps video
      const framesPerSecond = 30;
      const start = performance.now();

      for (let i = 0; i < framesPerSecond; i++) {
        await ctx.encrypt(plaintext, { groupId: 0n, objectId: i });
      }

      const elapsed = performance.now() - start;
      const avgFrameTime = elapsed / framesPerSecond;

      console.log(`30fps 720p: ${avgFrameTime.toFixed(2)}ms per frame (budget: 33.3ms)`);

      // Must complete in less than frame budget (33.3ms per frame)
      expect(avgFrameTime).toBeLessThan(33.3);
    });

    it('handles 60fps 720p frames (50KB each) without blocking', async () => {
      const ctx = await SecureObjectsContext.create({
        trackBaseKey: testKey,
        track: testTrack,
        cipherSuite: CipherSuite.AES_128_GCM_SHA256_128,
      });

      const frameSize = 50 * 1024;
      const plaintext = new Uint8Array(frameSize);
      fillRandomBytes(plaintext);

      const framesPerSecond = 60;
      const start = performance.now();

      for (let i = 0; i < framesPerSecond; i++) {
        await ctx.encrypt(plaintext, { groupId: 0n, objectId: i });
      }

      const elapsed = performance.now() - start;
      const avgFrameTime = elapsed / framesPerSecond;

      console.log(`60fps 720p: ${avgFrameTime.toFixed(2)}ms per frame (budget: 16.7ms)`);

      // Must complete in less than frame budget (16.7ms per frame)
      expect(avgFrameTime).toBeLessThan(16.7);
    });
  });

  describe('memory efficiency', () => {
    it('does not significantly increase heap during batch operations', async () => {
      const ctx = await SecureObjectsContext.create({
        trackBaseKey: testKey,
        track: testTrack,
      });

      // Warm up
      const warmup = new Uint8Array(1024);
      await ctx.encrypt(warmup, { groupId: 0n, objectId: 0 });

      // Get baseline (if available)
      const getHeapSize = () => {
        if (typeof performance !== 'undefined' && 'memory' in performance) {
          return (performance as unknown as { memory: { usedJSHeapSize: number } }).memory.usedJSHeapSize;
        }
        return 0;
      };

      const baselineHeap = getHeapSize();

      // Process many frames
      const frameSize = 64 * 1024;
      const plaintext = new Uint8Array(frameSize);

      for (let i = 0; i < 100; i++) {
        const encrypted = await ctx.encrypt(plaintext, { groupId: BigInt(i), objectId: i });
        await ctx.decrypt(encrypted.ciphertext, { groupId: BigInt(i), objectId: i });
      }

      const finalHeap = getHeapSize();
      const heapGrowth = finalHeap - baselineHeap;

      if (baselineHeap > 0) {
        console.log(`Heap growth after 100 frames: ${(heapGrowth / 1024 / 1024).toFixed(2)} MB`);
        // Allow up to 50MB growth for test buffers
        expect(heapGrowth).toBeLessThan(50 * 1024 * 1024);
      } else {
        // Memory API not available, skip
        console.log('Memory API not available, skipping heap check');
      }
    });
  });
});
