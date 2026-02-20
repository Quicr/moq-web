// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview CityHash64 implementation for MOQT track alias generation
 *
 * This is a TypeScript port of Google's CityHash64 algorithm, matching the
 * implementation used by LAPS (libquicr) for generating track aliases.
 *
 * The track alias is a 62-bit hash of the full track name (namespace + name),
 * used to identify tracks in MOQT protocol messages.
 *
 * @see https://github.com/google/cityhash
 */

// Constants from CityHash
const k0 = 0xc3a5c85c97cb3127n;
const k1 = 0xb492b66fbe98f273n;
const k2 = 0x9ae16a3b2f90404fn;

// Mask for 64-bit operations
const MASK64 = 0xffffffffffffffffn;

/**
 * Rotate right for 64-bit integers
 */
function rotate(val: bigint, shift: number): bigint {
  if (shift === 0) return val;
  return ((val >> BigInt(shift)) | (val << BigInt(64 - shift))) & MASK64;
}

/**
 * Shift and mix
 */
function shiftMix(val: bigint): bigint {
  return val ^ (val >> 47n);
}

/**
 * Load 64-bit little-endian value from bytes
 */
function fetch64(bytes: Uint8Array, offset: number = 0): bigint {
  let result = 0n;
  for (let i = 7; i >= 0; i--) {
    result = (result << 8n) | BigInt(bytes[offset + i]);
  }
  return result;
}

/**
 * Load 32-bit little-endian value from bytes
 */
function fetch32(bytes: Uint8Array, offset: number = 0): bigint {
  let result = 0n;
  for (let i = 3; i >= 0; i--) {
    result = (result << 8n) | BigInt(bytes[offset + i]);
  }
  return result;
}

/**
 * Swap bytes (convert endianness)
 */
function swapBytes64(val: bigint): bigint {
  return (
    ((val >> 56n) & 0xffn) |
    ((val >> 40n) & 0xff00n) |
    ((val >> 24n) & 0xff0000n) |
    ((val >> 8n) & 0xff000000n) |
    ((val << 8n) & 0xff00000000n) |
    ((val << 24n) & 0xff0000000000n) |
    ((val << 40n) & 0xff000000000000n) |
    ((val << 56n) & 0xff00000000000000n)
  );
}

/**
 * Hash 128 bits to 64 bits
 */
function hash128to64(x0: bigint, x1: bigint): bigint {
  const kMul = 0x9ddfea08eb382d69n;
  let a = ((x0 ^ x1) * kMul) & MASK64;
  a ^= a >> 47n;
  let b = ((x1 ^ a) * kMul) & MASK64;
  b ^= b >> 47n;
  b = (b * kMul) & MASK64;
  return b;
}

/**
 * Hash two 64-bit values
 */
function hashLen16(u: bigint, v: bigint, mul?: bigint): bigint {
  if (mul === undefined) {
    return hash128to64(u, v);
  }
  // Murmur-inspired hashing
  let a = ((u ^ v) * mul) & MASK64;
  a ^= a >> 47n;
  let b = ((v ^ a) * mul) & MASK64;
  b ^= b >> 47n;
  b = (b * mul) & MASK64;
  return b;
}

/**
 * Hash for 0-16 bytes
 */
function hashLen0to16(bytes: Uint8Array): bigint {
  const len = bytes.length;

  if (len >= 8) {
    const mul = k2 + BigInt(len * 2);
    const a = fetch64(bytes, 0) + k2;
    const b = fetch64(bytes, len - 8);
    const c = (rotate(b, 37) * mul + a) & MASK64;
    const d = ((rotate(a, 25) + b) * mul) & MASK64;
    return hashLen16(c, d, mul);
  }
  if (len >= 4) {
    const mul = k2 + BigInt(len * 2);
    const a = fetch32(bytes, 0);
    return hashLen16(BigInt(len) + (a << 3n), fetch32(bytes, len - 4), mul);
  }
  if (len > 0) {
    const a = bytes[0];
    const b = bytes[len >> 1];
    const c = bytes[len - 1];
    const y = BigInt(a) + (BigInt(b) << 8n);
    const z = BigInt(len) + (BigInt(c) << 2n);
    return (shiftMix((y * k2) ^ (z * k0)) * k2) & MASK64;
  }
  return k2;
}

/**
 * Hash for 17-32 bytes
 */
function hashLen17to32(bytes: Uint8Array): bigint {
  const len = bytes.length;
  const mul = k2 + BigInt(len * 2);
  const a = (fetch64(bytes, 0) * k1) & MASK64;
  const b = fetch64(bytes, 8);
  const c = (fetch64(bytes, len - 8) * mul) & MASK64;
  const d = (fetch64(bytes, len - 16) * k2) & MASK64;
  return hashLen16(
    (rotate(a + b, 43) + rotate(c, 30) + d) & MASK64,
    (a + rotate(b + k2, 18) + c) & MASK64,
    mul
  );
}

/**
 * Weak hash for 32 bytes with seeds
 */
function weakHashLen32WithSeeds(
  bytes: Uint8Array,
  offset: number,
  a: bigint,
  b: bigint
): [bigint, bigint] {
  const w = fetch64(bytes, offset);
  const x = fetch64(bytes, offset + 8);
  const y = fetch64(bytes, offset + 16);
  const z = fetch64(bytes, offset + 24);

  a = (a + w) & MASK64;
  b = rotate((b + a + z) & MASK64, 21);
  const c = a;
  a = (a + x + y) & MASK64;
  b = (b + rotate(a, 44)) & MASK64;
  return [(a + z) & MASK64, (b + c) & MASK64];
}

/**
 * Hash for 33-64 bytes
 */
function hashLen33to64(bytes: Uint8Array): bigint {
  const len = bytes.length;
  const mul = k2 + BigInt(len * 2);
  let a = (fetch64(bytes, 0) * k2) & MASK64;
  const b = fetch64(bytes, 8);
  const c = fetch64(bytes, len - 24);
  const d = fetch64(bytes, len - 32);
  const e = (fetch64(bytes, 16) * k2) & MASK64;
  const f = (fetch64(bytes, 24) * 9n) & MASK64;
  const g = fetch64(bytes, len - 8);
  const h = (fetch64(bytes, len - 16) * mul) & MASK64;
  const u = (rotate(a + g, 43) + ((rotate(b, 30) + c) * 9n & MASK64)) & MASK64;
  const vv = (((a + g) ^ d) + f + 1n) & MASK64;
  const w = (swapBytes64((u + vv) * mul & MASK64) + h) & MASK64;
  const x = (rotate(e + f, 42) + c) & MASK64;
  const y = ((swapBytes64((vv + w) * mul & MASK64) + g) * mul) & MASK64;
  const z = (e + f + c) & MASK64;

  a = (swapBytes64((x + z) * mul + y & MASK64) + b) & MASK64;
  const bb = (shiftMix((z + a) * mul + d + h & MASK64) * mul) & MASK64;

  return (bb + x) & MASK64;
}

/**
 * CityHash64 - main hash function
 *
 * @param bytes - Input bytes to hash
 * @returns 64-bit hash value as bigint
 */
export function cityHash64(bytes: Uint8Array): bigint {
  const len = bytes.length;

  if (len <= 16) {
    return hashLen0to16(bytes);
  } else if (len <= 32) {
    return hashLen17to32(bytes);
  } else if (len <= 64) {
    return hashLen33to64(bytes);
  }

  // For strings over 64 bytes
  let x = fetch64(bytes, len - 40);
  let y = (fetch64(bytes, len - 16) + fetch64(bytes, len - 56)) & MASK64;
  let z = hashLen16(
    (fetch64(bytes, len - 48) + BigInt(len)) & MASK64,
    fetch64(bytes, len - 24)
  );
  let v = weakHashLen32WithSeeds(bytes, len - 64, BigInt(len), z);
  let w = weakHashLen32WithSeeds(bytes, len - 32, (y + k1) & MASK64, x);
  x = (x * k1 + fetch64(bytes, 0)) & MASK64;

  // Decrease len to the nearest multiple of 64
  let offset = 0;
  let remaining = (len - 1) & ~63;

  do {
    x = (rotate((x + y + v[0] + fetch64(bytes, offset + 8)) & MASK64, 37) * k1) & MASK64;
    y = (rotate((y + v[1] + fetch64(bytes, offset + 48)) & MASK64, 42) * k1) & MASK64;
    x ^= w[1];
    y = (y + v[0] + fetch64(bytes, offset + 40)) & MASK64;
    z = (rotate((z + w[0]) & MASK64, 33) * k1) & MASK64;
    v = weakHashLen32WithSeeds(bytes, offset, (v[1] * k1) & MASK64, (x + w[0]) & MASK64);
    w = weakHashLen32WithSeeds(bytes, offset + 32, (z + w[1]) & MASK64, (y + fetch64(bytes, offset + 16)) & MASK64);
    [z, x] = [x, z];
    offset += 64;
    remaining -= 64;
  } while (remaining !== 0);

  return hashLen16(
    (hashLen16(v[0], w[0]) + shiftMix(y) * k1 + z) & MASK64,
    (hashLen16(v[1], w[1]) + x) & MASK64
  );
}

/**
 * Combine two hash values (matching LAPS hash_combine)
 *
 * @param seed - Existing hash to update
 * @param value - New hash to combine
 * @returns Combined hash
 */
export function hashCombine(seed: bigint, value: bigint): bigint {
  return (seed ^ (value + 0x9e3779b9n + (seed << 6n) + (value >> 2n))) & MASK64;
}

/**
 * Compute track alias from full track name (namespace + track name)
 *
 * This matches the algorithm used by LAPS (libquicr):
 * 1. Hash namespace bytes with CityHash64
 * 2. Hash track name bytes with CityHash64
 * 3. Combine hashes using hash_combine
 * 4. Truncate to 62 bits
 *
 * @param namespace - Track namespace as array of strings
 * @param trackName - Track name as string
 * @returns 62-bit track alias as number (truncated to fit in JS safe integer)
 */
export function computeTrackAlias(namespace: string[], trackName: string): bigint {
  // Encode namespace: each element is length-prefixed
  const namespaceBytes: number[] = [];
  for (const ns of namespace) {
    const encoded = new TextEncoder().encode(ns);
    // Write length as varint (simplified - just use 1-2 bytes for common lengths)
    if (encoded.length < 64) {
      namespaceBytes.push(encoded.length);
    } else if (encoded.length < 16384) {
      namespaceBytes.push(0x40 | (encoded.length >> 8));
      namespaceBytes.push(encoded.length & 0xff);
    } else {
      // For very long strings, use 4-byte encoding
      namespaceBytes.push(0x80 | (encoded.length >> 24));
      namespaceBytes.push((encoded.length >> 16) & 0xff);
      namespaceBytes.push((encoded.length >> 8) & 0xff);
      namespaceBytes.push(encoded.length & 0xff);
    }
    namespaceBytes.push(...encoded);
  }

  // Encode track name
  const trackNameBytes = new TextEncoder().encode(trackName);

  // Hash namespace
  const namespaceHash = cityHash64(new Uint8Array(namespaceBytes));

  // Hash track name
  const trackNameHash = cityHash64(trackNameBytes);

  // Combine hashes
  let fullHash = 0n;
  fullHash = hashCombine(fullHash, namespaceHash);
  fullHash = hashCombine(fullHash, trackNameHash);

  // Truncate to 62 bits (matches LAPS: (h << 2) >> 2)
  // In C++, uint64_t << 2 loses top 2 bits due to fixed width
  // In JS BigInt, we must mask directly to 62 bits
  const MASK62 = 0x3fffffffffffffffn; // 62 bits of 1s
  const trackAlias = fullHash & MASK62;

  return trackAlias;
}

/**
 * Convert track alias bigint to number (for use with existing APIs)
 *
 * Note: This truncates to Number.MAX_SAFE_INTEGER if the value is too large.
 * The BigInt version should be used for encoding in MOQT messages.
 *
 * @param alias - Track alias as bigint
 * @returns Track alias as number
 */
export function trackAliasToNumber(alias: bigint): number {
  // JavaScript numbers can safely represent integers up to 2^53 - 1
  // Our 62-bit hash will exceed this, so we need to handle it carefully
  if (alias <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number(alias);
  }
  // For values exceeding safe integer range, we return the truncated value
  // This should be handled carefully in calling code
  return Number(alias & BigInt(Number.MAX_SAFE_INTEGER));
}
