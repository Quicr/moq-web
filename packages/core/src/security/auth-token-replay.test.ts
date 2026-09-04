// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { describe, it, expect } from 'vitest';
import { AuthTokenReplayCache } from './auth-token-replay.js';
import type { AuthorizationToken } from '../messages/types.js';

function token(bytes: number[], tokenType = 0x63346d): AuthorizationToken {
  return { aliasType: 3, tokenType, tokenValue: new Uint8Array(bytes) };
}

describe('AuthTokenReplayCache', () => {
  it('marks first sight as fresh and second as duplicate', () => {
    const cache = new AuthTokenReplayCache();
    const t = token([1, 2, 3, 4]);
    expect(cache.check(t)).toBe('fresh');
    expect(cache.check(t)).toBe('duplicate');
  });

  it('treats different tokenTypes as distinct fingerprints', () => {
    const cache = new AuthTokenReplayCache();
    expect(cache.check(token([1, 2, 3], 0x01))).toBe('fresh');
    expect(cache.check(token([1, 2, 3], 0x02))).toBe('fresh');
  });

  it('expires entries after ttlMs and re-accepts', () => {
    let currentMs = 1000;
    const cache = new AuthTokenReplayCache({ ttlMs: 100, now: () => currentMs });
    const t = token([9, 9]);
    expect(cache.check(t)).toBe('fresh');
    currentMs += 50;
    expect(cache.check(t)).toBe('duplicate');
    currentMs += 100; // now 51ms past ttl
    expect(cache.check(t)).toBe('fresh');
  });

  it('evicts oldest entries once maxEntries is exceeded', () => {
    const cache = new AuthTokenReplayCache({ maxEntries: 2 });
    expect(cache.check(token([1]))).toBe('fresh');
    expect(cache.check(token([2]))).toBe('fresh');
    expect(cache.check(token([3]))).toBe('fresh');
    // token [1] should have been evicted, so a re-check is fresh.
    expect(cache.check(token([1]))).toBe('fresh');
    // token [3] is still cached.
    expect(cache.check(token([3]))).toBe('duplicate');
  });

  it('does not fingerprint alias-only (aliasType=2) tokens', () => {
    const cache = new AuthTokenReplayCache();
    const alias: AuthorizationToken = { aliasType: 2, tokenAlias: 7 };
    expect(cache.check(alias)).toBe('fresh');
    expect(cache.check(alias)).toBe('fresh');
  });

  it('clear() empties the cache', () => {
    const cache = new AuthTokenReplayCache();
    cache.check(token([1]));
    cache.check(token([2]));
    expect(cache.size()).toBe(2);
    cache.clear();
    expect(cache.size()).toBe(0);
    expect(cache.check(token([1]))).toBe('fresh');
  });

  it('exposes a stable fingerprint helper', () => {
    const a = AuthTokenReplayCache.fingerprint(0x63346d, new Uint8Array([0xaa, 0xbb]));
    const b = AuthTokenReplayCache.fingerprint(0x63346d, new Uint8Array([0xaa, 0xbb]));
    expect(a).toBe(b);
    const c = AuthTokenReplayCache.fingerprint(0x00, new Uint8Array([0xaa, 0xbb]));
    expect(a).not.toBe(c);
  });
});
