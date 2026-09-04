// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Draft-18 §13.3.1 authorization-token replay protection.
 *
 * Endpoints that accept `AUTHORIZATION_TOKEN` request parameters (§10.2.2)
 * MUST reject a token that has already been seen within the token's freshness
 * window. This module offers a bounded LRU cache keyed by
 * `${tokenType}:${b64(tokenValue)}` with a wall-clock TTL. It intentionally
 * makes no policy decisions — callers wire it into their request-accept path
 * and reject when `check()` returns `duplicate`.
 */

import type { AuthorizationToken } from '../messages/types.js';

/**
 * Result of `AuthTokenReplayCache.check()`.
 *
 * - `fresh`: the token was not present in the cache; it has been recorded.
 * - `duplicate`: the token was already seen within its freshness window.
 * - `expired`: the caller's freshness policy rejected the token before we got
 *   to check for duplicates (e.g. a nonce whose `expiresAtMs` is in the past).
 */
export type ReplayCheckResult = 'fresh' | 'duplicate' | 'expired';

export interface AuthTokenReplayCacheOptions {
  /** Max entries retained; oldest evicted on overflow. Default 1024. */
  maxEntries?: number;
  /**
   * Sliding freshness window in ms. An entry older than this counts as
   * evicted for `check()` purposes. Default 5 minutes.
   */
  ttlMs?: number;
  /**
   * Injectable clock (returns ms since epoch). Overridable for tests.
   */
  now?: () => number;
}

interface ReplayEntry {
  key: string;
  seenAtMs: number;
}

/**
 * Bounded sliding-window cache of recently-accepted authorization tokens.
 *
 * Callers invoke `check(token)` on every inbound `AUTHORIZATION_TOKEN` and
 * reject with a §13.3.1 replay error when the result is `duplicate`.
 *
 * The cache is intentionally cheap: it fingerprints the raw
 * `(tokenType, tokenValue)` pair. Signed tokens whose `tokenValue` already
 * embeds a nonce+timestamp benefit from this on top of any per-token
 * signature verification the caller performs separately.
 */
export class AuthTokenReplayCache {
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, ReplayEntry>();

  constructor(options: AuthTokenReplayCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? 1024;
    this.ttlMs = options.ttlMs ?? 5 * 60 * 1000;
    this.now = options.now ?? Date.now;
  }

  /**
   * Check a token and record it as seen when fresh.
   *
   * Tokens carrying only an alias (`aliasType === 2`) are not fingerprinted —
   * the cache has no way to compare aliases against previously-seen full
   * tokens without side-channel state, so they return `fresh` here. Callers
   * that resolve the alias to a token value should re-check the resolved
   * token.
   */
  check(token: AuthorizationToken): ReplayCheckResult {
    if (token.aliasType === 2 || !token.tokenValue) {
      return 'fresh';
    }
    const key = AuthTokenReplayCache.fingerprint(token.tokenType ?? 0, token.tokenValue);
    const nowMs = this.now();

    const existing = this.entries.get(key);
    if (existing && nowMs - existing.seenAtMs <= this.ttlMs) {
      return 'duplicate';
    }

    if (existing) {
      // Refresh position in insertion order so LRU eviction works.
      this.entries.delete(key);
    }
    this.entries.set(key, { key, seenAtMs: nowMs });

    if (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) this.entries.delete(oldestKey);
    }
    return 'fresh';
  }

  /** For diagnostics / tests. */
  size(): number {
    return this.entries.size;
  }

  /** Drop all cached entries. */
  clear(): void {
    this.entries.clear();
  }

  /**
   * Fingerprint helper — exposed so external code (e.g. relay-side auth
   * middleware) can key ancillary state on the same identity we use here.
   */
  static fingerprint(tokenType: number, tokenValue: Uint8Array): string {
    // Simple, deterministic, allocation-light. Not cryptographic — the
    // aliasing space is small enough that a stringified byte array is fine.
    let hex = '';
    for (let i = 0; i < tokenValue.length; i++) {
      hex += tokenValue[i].toString(16).padStart(2, '0');
    }
    return `${tokenType.toString(16)}:${hex}`;
  }
}
