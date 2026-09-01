// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import type { ChatPayload } from './profile.js';

export interface ChatMessage {
  groupId: number;
  objectId: number;
  bytes: Uint8Array;
  /** Deterministic ASCII payload string, useful for assertion output. */
  text: string;
}

/**
 * Deterministic chat message generator.
 *
 * Each message body encodes `msg-<groupId>-<objectId>` and is padded with
 * a repeating counter so that the receiver can recompute the expected
 * bytes from (groupId, objectId) alone. This gives byte-exact verifiability
 * without a decoder in the loop.
 */
export function* generateChat(payload: ChatPayload): Generator<ChatMessage> {
  const encoder = new TextEncoder();
  const perGroup = payload.objectsPerGroup ?? 10;
  const total = payload.messages;
  const size = Math.max(payload.sizeBytes, 16);

  for (let i = 0; i < total; i++) {
    const groupId = Math.floor(i / perGroup);
    const objectId = i % perGroup;

    const header = `msg-${groupId}-${objectId}-`;
    const headerBytes = encoder.encode(header);
    const bytes = new Uint8Array(size);
    bytes.set(headerBytes.subarray(0, Math.min(headerBytes.length, size)));

    // Fill remainder with a repeating deterministic pattern seeded by (g, o).
    const seed = (groupId * 1_000_003 + objectId * 97 + 1) >>> 0;
    let x = seed;
    for (let j = headerBytes.length; j < size; j++) {
      // xorshift32 for cheap deterministic bytes
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      bytes[j] = x & 0xff;
    }

    const text = new TextDecoder().decode(bytes);
    yield { groupId, objectId, bytes, text };
  }
}

/**
 * Rebuild the expected message for a given (groupId, objectId) so the
 * subscriber can compare byte-for-byte with what it received.
 */
export function expectedMessage(
  payload: ChatPayload,
  groupId: number,
  objectId: number,
): Uint8Array {
  const encoder = new TextEncoder();
  const size = Math.max(payload.sizeBytes, 16);
  const header = `msg-${groupId}-${objectId}-`;
  const headerBytes = encoder.encode(header);
  const bytes = new Uint8Array(size);
  bytes.set(headerBytes.subarray(0, Math.min(headerBytes.length, size)));

  const seed = (groupId * 1_000_003 + objectId * 97 + 1) >>> 0;
  let x = seed;
  for (let j = headerBytes.length; j < size; j++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    bytes[j] = x & 0xff;
  }
  return bytes;
}
