// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { describe, it, expect } from 'vitest';
import { JitteredExponentialBackoff } from './reconnect-policy.js';

describe('JitteredExponentialBackoff', () => {
  it('grows exponentially between attempts with zero jitter', () => {
    const bo = new JitteredExponentialBackoff({
      baseMs: 100,
      factor: 2,
      capMs: 10_000,
      jitter: 0,
    });
    expect(bo.nextDelayMs(1)).toBe(100);
    expect(bo.nextDelayMs(2)).toBe(200);
    expect(bo.nextDelayMs(3)).toBe(400);
    expect(bo.nextDelayMs(4)).toBe(800);
  });

  it('caps delay at capMs', () => {
    const bo = new JitteredExponentialBackoff({
      baseMs: 1000,
      factor: 2,
      capMs: 3000,
      jitter: 0,
    });
    expect(bo.nextDelayMs(1)).toBe(1000);
    expect(bo.nextDelayMs(2)).toBe(2000);
    expect(bo.nextDelayMs(3)).toBe(3000);
    // Would be 8000 without cap.
    expect(bo.nextDelayMs(4)).toBe(3000);
    expect(bo.nextDelayMs(20)).toBe(3000);
  });

  it('returns null once maxAttempts is exceeded', () => {
    const bo = new JitteredExponentialBackoff({
      baseMs: 100,
      jitter: 0,
      maxAttempts: 3,
    });
    expect(bo.nextDelayMs(1)).not.toBeNull();
    expect(bo.nextDelayMs(2)).not.toBeNull();
    expect(bo.nextDelayMs(3)).not.toBeNull();
    expect(bo.nextDelayMs(4)).toBeNull();
    expect(bo.nextDelayMs(99)).toBeNull();
  });

  it('coerces attempt < 1 to 1', () => {
    const bo = new JitteredExponentialBackoff({
      baseMs: 500,
      factor: 2,
      jitter: 0,
    });
    expect(bo.nextDelayMs(0)).toBe(500);
    expect(bo.nextDelayMs(-5)).toBe(500);
  });

  it('applies symmetric jitter within [delay*(1-j), delay*(1+j)]', () => {
    // Deterministic random => value ends up at midpoint (delay itself).
    const midpoint = new JitteredExponentialBackoff({
      baseMs: 1000,
      factor: 2,
      jitter: 0.25,
      random: () => 0.5,
    });
    expect(midpoint.nextDelayMs(1)).toBe(1000);

    // Random == 0 => min end
    const minEnd = new JitteredExponentialBackoff({
      baseMs: 1000,
      jitter: 0.25,
      random: () => 0,
    });
    expect(minEnd.nextDelayMs(1)).toBe(750);

    // Random == 1 => max end
    const maxEnd = new JitteredExponentialBackoff({
      baseMs: 1000,
      jitter: 0.25,
      random: () => 1,
    });
    expect(maxEnd.nextDelayMs(1)).toBe(1250);
  });

  it('never returns a negative delay', () => {
    // Jitter clamped to 1 even if caller passes >1.
    const bo = new JitteredExponentialBackoff({
      baseMs: 100,
      jitter: 5,
      random: () => 0, // pushes toward min bound
    });
    const value = bo.nextDelayMs(1);
    expect(value).not.toBeNull();
    expect(value!).toBeGreaterThanOrEqual(0);
  });

  it('uses spec defaults when constructed with no options', () => {
    const bo = new JitteredExponentialBackoff();
    // Default random spread: manually pin to midpoint for a deterministic check.
    const pinned = new JitteredExponentialBackoff({ random: () => 0.5 });
    expect(pinned.nextDelayMs(1)).toBe(500); // baseMs default
    expect(pinned.nextDelayMs(2)).toBe(1000);
    // Growth continues until cap (default 30_000).
    expect(pinned.nextDelayMs(10)).toBe(30_000);
    // Sanity: default policy also returns a positive number on attempt 1.
    const first = bo.nextDelayMs(1);
    expect(first).not.toBeNull();
    expect(first!).toBeGreaterThan(0);
  });

  it('rejects invalid constructor options', () => {
    expect(() => new JitteredExponentialBackoff({ baseMs: -1 })).toThrow(RangeError);
    expect(() => new JitteredExponentialBackoff({ factor: 0.5 })).toThrow(RangeError);
    expect(() =>
      new JitteredExponentialBackoff({ baseMs: 5000, capMs: 1000 }),
    ).toThrow(RangeError);
  });
});
