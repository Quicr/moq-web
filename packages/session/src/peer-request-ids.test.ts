// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { describe, it, expect } from 'vitest';

import { PeerRequestIds } from './peer-request-ids.js';

describe('PeerRequestIds', () => {
  it('refuses a repeat, in order or not', () => {
    const ids = new PeerRequestIds(1n);
    expect(ids.add(1n)).toBe(true);
    expect(ids.add(5n)).toBe(true);
    expect(ids.add(1n)).toBe(false);
    expect(ids.add(5n)).toBe(false);
    expect(ids.add(3n)).toBe(true);
    expect(ids.add(3n)).toBe(false);
  });

  it('holds nothing above the floor once the IDs are contiguous', () => {
    const ids = new PeerRequestIds(1n);
    for (let i = 0n; i < 10_000n; i++) {
      ids.add(1n + 2n * i);
    }
    expect(ids.sparseSize).toBe(0);
    expect(ids.highest).toBe(19_999n);
  });

  it('closes a gap when the late ID arrives', () => {
    const ids = new PeerRequestIds(1n);
    ids.add(3n);
    ids.add(5n);
    expect(ids.sparseSize).toBe(2);
    ids.add(1n);
    expect(ids.sparseSize).toBe(0);
  });

  it('stays bounded when a gap never closes, and never refuses an unused ID', () => {
    const cap = 64;
    const ids = new PeerRequestIds(1n, 2n, cap);
    // 1 never arrives, so every later ID stays above the floor
    for (let i = 1n; i < 10_000n; i++) {
      expect(ids.add(1n + 2n * i)).toBe(true);
      expect(ids.sparseSize).toBeLessThanOrEqual(cap);
    }
    expect(ids.add(1n)).toBe(true);
    // The most recent IDs are still remembered
    expect(ids.add(1n + 2n * 9_999n)).toBe(false);
  });

  it('reports the highest ID, and forgets everything on clear', () => {
    const ids = new PeerRequestIds(1n);
    expect(ids.highest).toBeUndefined();
    ids.add(9n);
    ids.add(3n);
    expect(ids.highest).toBe(9n);
    ids.clear();
    expect(ids.highest).toBeUndefined();
    expect(ids.add(9n)).toBe(true);
  });
});
