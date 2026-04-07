// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * End-to-End Example: Secure Video Publishing and Subscribing
 *
 * This example demonstrates how to use @web-moq/secure-objects for
 * encrypting video frames in a MOQT publish/subscribe scenario.
 *
 * Run with: npx tsx examples/e2e-example.ts
 */

import {
  SecureObjectsContext,
  CipherSuite,
  getRecommendedCipherSuites,
  getCipherSuiteParams,
} from '../src/index.js';

// Simulate a shared secret (in practice, this would be exchanged via a secure channel)
function generateSharedSecret(): Uint8Array {
  const secret = new Uint8Array(32);
  crypto.getRandomValues(secret);
  return secret;
}

// Simulate video frame data
function generateVideoFrame(size: number): Uint8Array {
  const frame = new Uint8Array(size);
  crypto.getRandomValues(frame);
  return frame;
}

async function main() {
  console.log('=== MOQT Secure Objects E2E Example ===\n');

  // List available cipher suites
  console.log('Recommended Cipher Suites:');
  for (const suite of getRecommendedCipherSuites()) {
    const params = getCipherSuiteParams(suite);
    console.log(`  - ${params.name} (0x${suite.toString(16).padStart(4, '0')})`);
  }
  console.log();

  // Shared configuration
  const sharedSecret = generateSharedSecret();
  const track = {
    namespace: ['conference', 'room-42', 'media'],
    trackName: 'user-123/video',
  };

  console.log(`Track: ${track.namespace.join('/')}/${track.trackName}`);
  console.log(`Secret: ${Buffer.from(sharedSecret).toString('base64').slice(0, 16)}...`);
  console.log();

  // === PUBLISHER SIDE ===
  console.log('--- Publisher Side ---\n');

  const publisherCtx = await SecureObjectsContext.create({
    trackBaseKey: sharedSecret,
    track,
    cipherSuite: CipherSuite.AES_128_GCM_SHA256_128,
    keyId: 0n,
  });

  console.log(`Publisher context created (keyId=${publisherCtx.keyId})`);

  // Simulate publishing a GOP (Group of Pictures)
  const gopId = 42n;
  const framesPerGop = 30;
  const frameSize = 64 * 1024; // 64KB typical video frame

  console.log(`Publishing GOP ${gopId} with ${framesPerGop} frames (${frameSize / 1024}KB each)...\n`);

  const encryptedFrames: { ciphertext: Uint8Array; objectId: number }[] = [];
  const startEncrypt = performance.now();

  for (let i = 0; i < framesPerGop; i++) {
    const frame = generateVideoFrame(frameSize);
    const encrypted = await publisherCtx.encrypt(frame, {
      groupId: gopId,
      objectId: i,
    });
    encryptedFrames.push({ ciphertext: encrypted.ciphertext, objectId: i });
  }

  const encryptTime = performance.now() - startEncrypt;
  const totalBytes = framesPerGop * frameSize;
  const encryptThroughput = (totalBytes / 1024 / 1024) / (encryptTime / 1000);

  console.log(`Encrypted ${framesPerGop} frames in ${encryptTime.toFixed(1)}ms`);
  console.log(`Throughput: ${encryptThroughput.toFixed(1)} MB/s`);
  console.log(`Overhead: ${((encryptedFrames[0].ciphertext.length / frameSize - 1) * 100).toFixed(1)}%`);
  console.log();

  // === SUBSCRIBER SIDE ===
  console.log('--- Subscriber Side ---\n');

  const subscriberCtx = await SecureObjectsContext.create({
    trackBaseKey: sharedSecret, // Same shared secret
    track,                      // Same track
    cipherSuite: CipherSuite.AES_128_GCM_SHA256_128,
    keyId: 0n,
  });

  console.log(`Subscriber context created (keyId=${subscriberCtx.keyId})`);
  console.log(`Receiving GOP ${gopId}...\n`);

  const startDecrypt = performance.now();
  let decryptedBytes = 0;

  for (const { ciphertext, objectId } of encryptedFrames) {
    const decrypted = await subscriberCtx.decrypt(ciphertext, {
      groupId: gopId,
      objectId,
    });
    decryptedBytes += decrypted.plaintext.length;
  }

  const decryptTime = performance.now() - startDecrypt;
  const decryptThroughput = (decryptedBytes / 1024 / 1024) / (decryptTime / 1000);

  console.log(`Decrypted ${framesPerGop} frames in ${decryptTime.toFixed(1)}ms`);
  console.log(`Throughput: ${decryptThroughput.toFixed(1)} MB/s`);
  console.log();

  // === SECURITY DEMONSTRATION ===
  console.log('--- Security Demonstration ---\n');

  // 1. Tamper detection
  console.log('1. Tamper Detection:');
  const tamperedCiphertext = new Uint8Array(encryptedFrames[0].ciphertext);
  tamperedCiphertext[10] ^= 0xff; // Flip some bits

  try {
    await subscriberCtx.decrypt(tamperedCiphertext, { groupId: gopId, objectId: 0 });
    console.log('   ERROR: Tampered data was decrypted!');
  } catch {
    console.log('   PASS: Tampered ciphertext rejected');
  }

  // 2. Wrong object ID detection
  console.log('2. Wrong Object ID Detection:');
  try {
    await subscriberCtx.decrypt(encryptedFrames[0].ciphertext, {
      groupId: gopId,
      objectId: 999, // Wrong object ID
    });
    console.log('   ERROR: Wrong object ID accepted!');
  } catch {
    console.log('   PASS: Wrong object ID rejected (AAD mismatch)');
  }

  // 3. Wrong group ID detection
  console.log('3. Wrong Group ID Detection:');
  try {
    await subscriberCtx.decrypt(encryptedFrames[0].ciphertext, {
      groupId: 999n, // Wrong group ID
      objectId: 0,
    });
    console.log('   ERROR: Wrong group ID accepted!');
  } catch {
    console.log('   PASS: Wrong group ID rejected (nonce mismatch)');
  }

  // 4. Different track rejection
  console.log('4. Different Track Rejection:');
  const otherTrackCtx = await SecureObjectsContext.create({
    trackBaseKey: sharedSecret,
    track: { namespace: ['other'], trackName: 'track' },
    cipherSuite: CipherSuite.AES_128_GCM_SHA256_128,
  });

  try {
    await otherTrackCtx.decrypt(encryptedFrames[0].ciphertext, {
      groupId: gopId,
      objectId: 0,
    });
    console.log('   ERROR: Different track decrypted data!');
  } catch {
    console.log('   PASS: Different track context rejected ciphertext');
  }

  console.log('\n=== Example Complete ===');
}

main().catch(console.error);
