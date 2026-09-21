// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { describe, it, expect } from 'vitest';
import { MemoryReplayStore } from '../replay.js';

describe('MemoryReplayStore eviction (B4)', () => {
  it('evicts expired entries before capacity-based eviction', async () => {
    let clock = 100;
    const store = new MemoryReplayStore({ maxEntries: 3, now: () => clock });
    await store.checkAndStore(new Uint8Array([1]), 150); // expires soonest
    await store.checkAndStore(new Uint8Array([2]), 200);
    await store.checkAndStore(new Uint8Array([3]), 250);
    // Advance clock past first entry's expiry.
    clock = 160;
    // Insert a fourth entry: expired #1 should be removed first (no capacity eviction).
    await store.checkAndStore(new Uint8Array([4]), 300);
    // Entry 1 must be gone (expired); entries 2, 3, 4 all still present.
    expect(await store.checkAndStore(new Uint8Array([2]), 200)).toBe(false);
    expect(await store.checkAndStore(new Uint8Array([3]), 250)).toBe(false);
    expect(await store.checkAndStore(new Uint8Array([4]), 300)).toBe(false);
    // Entry 1 should be treatable as new (was evicted via expiry).
    expect(await store.checkAndStore(new Uint8Array([1]), 400)).toBe(true);
  });

  it('evicts the entry closest to expiry, not FIFO oldest, when over capacity', async () => {
    const clock = 100;
    const store = new MemoryReplayStore({ maxEntries: 2, now: () => clock });
    // Insert an old-but-long-lived jti first (this is the entry an attacker would want evicted).
    const validOld = new Uint8Array([0xaa]);
    await store.checkAndStore(validOld, 10_000); // far-future expiry
    // Insert a short-lived jti.
    const shortLived = new Uint8Array([0xbb]);
    await store.checkAndStore(shortLived, 200);
    // Attacker floods the store with a fresh token forcing capacity eviction.
    const attacker = new Uint8Array([0xcc]);
    await store.checkAndStore(attacker, 10_000);
    // The short-lived entry (closest to expiry) must be evicted, NOT the long-lived old one.
    // If validOld were still stored, replaying it must return false.
    expect(await store.checkAndStore(validOld, 10_000)).toBe(false);
    // shortLived was evicted, so it can be re-stored as new.
    expect(await store.checkAndStore(shortLived, 200)).toBe(true);
  });

  it('does not allow replay of a still-valid old jti after flood of fresh tokens', async () => {
    const clock = 100;
    const store = new MemoryReplayStore({ maxEntries: 4, now: () => clock });
    const victim = new Uint8Array([1, 2, 3, 4]);
    await store.checkAndStore(victim, 10_000);
    // Flood with fresh tokens with far-future expiry.
    for (let i = 0; i < 20; i++) {
      await store.checkAndStore(new Uint8Array([0x80, i]), 9_000 + i);
    }
    // Replay of the original victim jti must still be rejected.
    expect(await store.checkAndStore(victim, 10_000)).toBe(false);
  });
});
