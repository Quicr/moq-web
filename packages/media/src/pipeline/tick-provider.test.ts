// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { describe, it, expect, beforeEach } from 'vitest';
import {
  MonotonicTickProvider,
  WallClockTickProvider,
  type TickProvider,
} from './tick-provider';

describe('MonotonicTickProvider', () => {
  let provider: MonotonicTickProvider;

  beforeEach(() => {
    provider = new MonotonicTickProvider();
  });

  describe('tick counting', () => {
    it('should start at 0', () => {
      expect(provider.currentTick).toBe(0);
    });

    it('should increment on tick()', () => {
      provider.tick();
      expect(provider.currentTick).toBe(1);

      provider.tick();
      provider.tick();
      expect(provider.currentTick).toBe(3);
    });

    it('should increment by count on tickBy()', () => {
      provider.tickBy(10);
      expect(provider.currentTick).toBe(10);

      provider.tickBy(5);
      expect(provider.currentTick).toBe(15);
    });

    it('should reset to 0', () => {
      provider.tickBy(100);
      provider.reset();
      expect(provider.currentTick).toBe(0);
    });
  });

  describe('time conversion', () => {
    it('should convert ticks to ms with default ratio', () => {
      // Default is 1 tick per ms
      expect(provider.ticksToMs(100)).toBe(100);
      expect(provider.ticksToMs(50)).toBe(50);
    });

    it('should convert ms to ticks with default ratio', () => {
      expect(provider.msToTicks(100)).toBe(100);
      expect(provider.msToTicks(50)).toBe(50);
    });

    it('should handle custom initial ticksPerMs', () => {
      const custom = new MonotonicTickProvider({ initialTicksPerMs: 2 });
      expect(custom.ticksToMs(100)).toBe(50); // 100 ticks / 2 ticks per ms
      expect(custom.msToTicks(50)).toBe(100); // 50 ms * 2 ticks per ms
    });

    it('should round msToTicks', () => {
      expect(provider.msToTicks(10.4)).toBe(10);
      expect(provider.msToTicks(10.6)).toBe(11);
    });
  });

  describe('calibration', () => {
    it('should update ticksPerMs on sync after enough time', async () => {
      const provider = new MonotonicTickProvider({
        initialTicksPerMs: 1,
        minSyncInterval: 50,
        calibrationSmoothing: 1.0, // Full update for testing
      });

      // Wait for time to pass
      await new Promise((r) => setTimeout(r, 60));

      // Tick a known number of times
      const tickCount = 120; // ~2 ticks per ms for 60ms
      provider.tickBy(tickCount);
      provider.sync();

      // ticksPerMs should be approximately 2 (with some variance due to timing)
      expect(provider.ticksPerMs).toBeGreaterThan(1);
      expect(provider.ticksPerMs).toBeLessThan(4);
    });

    it('should not recalibrate before minSyncInterval', () => {
      const provider = new MonotonicTickProvider({
        initialTicksPerMs: 1,
        minSyncInterval: 1000, // Very long interval
      });

      provider.tickBy(1000);
      provider.sync();

      // Should still be at initial value
      expect(provider.ticksPerMs).toBe(1);
    });

    it('should smooth calibration updates', async () => {
      const provider = new MonotonicTickProvider({
        initialTicksPerMs: 1,
        minSyncInterval: 10,
        calibrationSmoothing: 0.5,
      });

      // Wait and tick
      await new Promise((r) => setTimeout(r, 20));
      provider.tickBy(100);
      provider.sync();

      const firstCalibration = provider.ticksPerMs;

      // Reset and do different rate
      await new Promise((r) => setTimeout(r, 20));
      provider.tickBy(50);
      provider.sync();

      // Should be smoothed between first and second measurement
      expect(provider.ticksPerMs).not.toBe(firstCalibration);
    });
  });

  describe('now()', () => {
    it('should return current wall clock time', () => {
      const before = performance.now();
      const now = provider.now();
      const after = performance.now();

      expect(now).toBeGreaterThanOrEqual(before);
      expect(now).toBeLessThanOrEqual(after);
    });
  });
});

describe('WallClockTickProvider', () => {
  let provider: WallClockTickProvider;

  beforeEach(() => {
    provider = new WallClockTickProvider();
  });

  it('should track elapsed time as ticks', async () => {
    await new Promise((r) => setTimeout(r, 50));
    provider.tick();

    expect(provider.currentTick).toBeGreaterThanOrEqual(45);
    expect(provider.currentTick).toBeLessThanOrEqual(100);
  });

  it('should have 1:1 tick to ms ratio', () => {
    expect(provider.ticksPerMs).toBe(1);
    expect(provider.ticksToMs(100)).toBe(100);
    expect(provider.msToTicks(100)).toBe(100);
  });

  it('should reset to 0', async () => {
    await new Promise((r) => setTimeout(r, 20));
    provider.tick();
    expect(provider.currentTick).toBeGreaterThan(0);

    provider.reset();
    provider.tick();
    expect(provider.currentTick).toBeLessThan(10);
  });
});

describe('TickProvider benchmark', () => {
  const ITERATIONS = 100000;

  it('MonotonicTickProvider.tick() should be fast', () => {
    const provider = new MonotonicTickProvider();
    const start = performance.now();

    for (let i = 0; i < ITERATIONS; i++) {
      provider.tick();
    }

    const elapsed = performance.now() - start;
    const opsPerMs = ITERATIONS / elapsed;

    console.log(
      `MonotonicTickProvider: ${ITERATIONS} ticks in ${elapsed.toFixed(2)}ms ` +
        `(${opsPerMs.toFixed(0)} ops/ms)`
    );

    // Should be very fast - at least 10000 ops/ms
    expect(opsPerMs).toBeGreaterThan(10000);
  });

  it('WallClockTickProvider.tick() overhead comparison', () => {
    const provider = new WallClockTickProvider();
    const start = performance.now();

    for (let i = 0; i < ITERATIONS; i++) {
      provider.tick();
    }

    const elapsed = performance.now() - start;
    const opsPerMs = ITERATIONS / elapsed;

    console.log(
      `WallClockTickProvider: ${ITERATIONS} ticks in ${elapsed.toFixed(2)}ms ` +
        `(${opsPerMs.toFixed(0)} ops/ms)`
    );

    // Wall clock is slower but should still be reasonable
    expect(opsPerMs).toBeGreaterThan(100);
  });

  it('demonstrates monotonic vs wall clock performance difference', () => {
    const monotonic = new MonotonicTickProvider();
    const wallClock = new WallClockTickProvider();

    // Warm up
    for (let i = 0; i < 1000; i++) {
      monotonic.tick();
      wallClock.tick();
    }
    monotonic.reset();
    wallClock.reset();

    // Benchmark monotonic
    const monoStart = performance.now();
    for (let i = 0; i < ITERATIONS; i++) {
      monotonic.tick();
    }
    const monoElapsed = performance.now() - monoStart;

    // Benchmark wall clock
    const wallStart = performance.now();
    for (let i = 0; i < ITERATIONS; i++) {
      wallClock.tick();
    }
    const wallElapsed = performance.now() - wallStart;

    const speedup = wallElapsed / monoElapsed;

    console.log(
      `Monotonic: ${monoElapsed.toFixed(2)}ms, ` +
        `WallClock: ${wallElapsed.toFixed(2)}ms, ` +
        `Speedup: ${speedup.toFixed(1)}x`
    );

    // Monotonic should be significantly faster
    expect(speedup).toBeGreaterThan(1);
  });
});
