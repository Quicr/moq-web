// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Reconnect / backoff policy for MOQTSession
 *
 * A `ReconnectPolicy` decides how long the caller should wait before making
 * another reconnect attempt (autoMigrate, transport re-open, etc.). The
 * library intentionally does not schedule the wait itself — call sites drive
 * the loop so cancellation, jitter cancellation on GOAWAY, and timers under
 * fake test clocks all remain in the caller's hands.
 *
 * The default policy is jittered exponential backoff (a.k.a. "decorrelated"
 * jitter in the AWS Architecture Blog sense, simplified to full-jitter
 * uniform in [delay*(1-j), delay*(1+j)]).
 */

/**
 * Backoff strategy interface. Implementations MUST be pure (no side effects)
 * so callers can share a single instance across sessions.
 */
export interface ReconnectPolicy {
  /**
   * Compute the next delay to wait before the given (1-based) attempt.
   *
   * @param attempt The 1-based attempt counter (`1` = first retry after a
   *                failure, `2` = second retry, ...). Attempts less than 1
   *                are coerced to 1.
   * @returns Delay in ms to wait before starting the attempt, or `null`
   *          when the policy has given up (attempt exceeds `maxAttempts`).
   */
  nextDelayMs(attempt: number): number | null;
}

/**
 * Options for `JitteredExponentialBackoff`.
 */
export interface JitteredExponentialBackoffOptions {
  /** Initial delay (attempt 1). Default: 500ms. */
  baseMs?: number;
  /** Growth factor per attempt. Default: 2. */
  factor?: number;
  /** Maximum delay before jitter is applied. Default: 30_000ms. */
  capMs?: number;
  /**
   * Symmetric jitter fraction in `[0, 1]`. `0.25` means the returned delay
   * is uniform in `[base*0.75, base*1.25]`. Default: 0.25.
   */
  jitter?: number;
  /**
   * Maximum number of attempts before `nextDelayMs()` returns `null`.
   * Default: `Infinity` (retry forever — the caller is responsible for
   * external cancellation, e.g. by not calling `nextDelayMs` any more).
   */
  maxAttempts?: number;
  /**
   * Random source used for jitter. Defaults to `Math.random`. Overridable
   * for deterministic tests.
   */
  random?: () => number;
}

/**
 * Full-jitter exponential backoff.
 *
 * `nextDelayMs(1)` returns roughly `baseMs`, `nextDelayMs(2)` returns roughly
 * `baseMs * factor`, ... capped at `capMs`. Every returned value is scaled
 * by a uniformly-random factor in `[1 - jitter, 1 + jitter]` so many clients
 * failing simultaneously don't dogpile a recovering relay.
 */
export class JitteredExponentialBackoff implements ReconnectPolicy {
  private readonly baseMs: number;
  private readonly factor: number;
  private readonly capMs: number;
  private readonly jitter: number;
  private readonly maxAttempts: number;
  private readonly random: () => number;

  constructor(opts?: JitteredExponentialBackoffOptions) {
    this.baseMs = opts?.baseMs ?? 500;
    this.factor = opts?.factor ?? 2;
    this.capMs = opts?.capMs ?? 30_000;
    // Clamp jitter into [0, 1] so nextDelayMs can never return negative values.
    const rawJitter = opts?.jitter ?? 0.25;
    this.jitter = Math.max(0, Math.min(1, rawJitter));
    this.maxAttempts = opts?.maxAttempts ?? Number.POSITIVE_INFINITY;
    this.random = opts?.random ?? Math.random;

    if (this.baseMs < 0) {
      throw new RangeError('baseMs must be non-negative');
    }
    if (this.factor < 1) {
      throw new RangeError('factor must be >= 1');
    }
    if (this.capMs < this.baseMs) {
      throw new RangeError('capMs must be >= baseMs');
    }
  }

  nextDelayMs(attempt: number): number | null {
    const n = attempt < 1 ? 1 : Math.floor(attempt);
    if (n > this.maxAttempts) return null;

    // Grow exponentially, cap before applying jitter.
    const raw = this.baseMs * Math.pow(this.factor, n - 1);
    const capped = raw > this.capMs ? this.capMs : raw;

    if (this.jitter === 0) return capped;

    // Uniform in [capped * (1 - jitter), capped * (1 + jitter)].
    const spread = capped * this.jitter;
    const min = capped - spread;
    const width = 2 * spread;
    const value = min + this.random() * width;
    // Guard against subtle floating-point rounding pushing us negative when
    // baseMs is tiny and jitter approaches 1.
    return value < 0 ? 0 : value;
  }
}
