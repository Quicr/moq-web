// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Monotonic Tick Provider
 *
 * Provides a high-performance monotonic tick counter for timing operations
 * in the hot path. Avoids frequent performance.now() calls which can have
 * overhead from syscalls and security mitigations.
 *
 * The tick counter is incremented manually and periodically synchronized
 * with wall clock time for accurate deadline calculations.
 */

/**
 * Tick provider interface for monotonic timing
 */
export interface TickProvider {
  /** Current monotonic tick value */
  readonly currentTick: number;

  /** Calibrated ticks per millisecond */
  readonly ticksPerMs: number;

  /** Increment tick (call once per processing cycle) */
  tick(): void;

  /** Increment by multiple ticks */
  tickBy(count: number): void;

  /** Convert ticks to milliseconds (approximate) */
  ticksToMs(ticks: number): number;

  /** Convert milliseconds to ticks */
  msToTicks(ms: number): number;

  /** Sync with wall clock (call periodically) */
  sync(): void;

  /** Get current wall clock time in ms */
  now(): number;

  /** Reset the provider */
  reset(): void;
}

/**
 * Configuration for MonotonicTickProvider
 */
export interface TickProviderConfig {
  /** Initial ticks per millisecond estimate (default: 1) */
  initialTicksPerMs?: number;

  /** Minimum elapsed time (ms) before recalibration (default: 100) */
  minSyncInterval?: number;

  /** Smoothing factor for calibration (0-1, default: 0.3) */
  calibrationSmoothing?: number;
}

/**
 * High-performance monotonic tick provider
 *
 * @remarks
 * Uses a simple counter for the hot path, with periodic wall-clock
 * synchronization for accurate time conversion. This avoids the overhead
 * of calling performance.now() on every frame while maintaining reasonable
 * accuracy for deadline calculations.
 *
 * @example
 * ```typescript
 * const ticker = new MonotonicTickProvider();
 *
 * // In processing loop
 * function processFrame(frame: Frame) {
 *   ticker.tick();  // Cheap increment
 *
 *   // Check deadline using tick comparison
 *   if (ticker.currentTick > frame.deadlineTick) {
 *     handleExpired(frame);
 *   }
 * }
 *
 * // Periodically sync (e.g., every 100 frames)
 * if (frameCount % 100 === 0) {
 *   ticker.sync();
 * }
 * ```
 */
export class MonotonicTickProvider implements TickProvider {
  private _currentTick = 0;
  private _ticksPerMs: number;
  private lastSyncTime: number;
  private lastSyncTick = 0;
  private config: Required<TickProviderConfig>;

  constructor(config: TickProviderConfig = {}) {
    this.config = {
      initialTicksPerMs: config.initialTicksPerMs ?? 1,
      minSyncInterval: config.minSyncInterval ?? 100,
      calibrationSmoothing: config.calibrationSmoothing ?? 0.3,
    };

    this._ticksPerMs = this.config.initialTicksPerMs;
    this.lastSyncTime = performance.now();
  }

  get currentTick(): number {
    return this._currentTick;
  }

  get ticksPerMs(): number {
    return this._ticksPerMs;
  }

  tick(): void {
    this._currentTick++;
  }

  tickBy(count: number): void {
    this._currentTick += count;
  }

  ticksToMs(ticks: number): number {
    return ticks / this._ticksPerMs;
  }

  msToTicks(ms: number): number {
    return Math.round(ms * this._ticksPerMs);
  }

  now(): number {
    return performance.now();
  }

  sync(): void {
    const now = performance.now();
    const elapsed = now - this.lastSyncTime;
    const ticksElapsed = this._currentTick - this.lastSyncTick;

    // Only recalibrate if enough time has passed and ticks occurred
    if (elapsed >= this.config.minSyncInterval && ticksElapsed > 0) {
      const measuredTicksPerMs = ticksElapsed / elapsed;

      // Exponential moving average for smooth calibration
      this._ticksPerMs =
        (1 - this.config.calibrationSmoothing) * this._ticksPerMs +
        this.config.calibrationSmoothing * measuredTicksPerMs;

      this.lastSyncTime = now;
      this.lastSyncTick = this._currentTick;
    }
  }

  reset(): void {
    this._currentTick = 0;
    this._ticksPerMs = this.config.initialTicksPerMs;
    this.lastSyncTime = performance.now();
    this.lastSyncTick = 0;
  }
}

/**
 * Create a tick provider that uses wall clock directly (for testing/comparison)
 *
 * @remarks
 * This provider calls performance.now() on every tick, which is slower
 * but provides exact timing. Useful for testing and benchmarking.
 */
export class WallClockTickProvider implements TickProvider {
  private _currentTick = 0;
  private startTime: number;

  constructor() {
    this.startTime = performance.now();
  }

  get currentTick(): number {
    return this._currentTick;
  }

  get ticksPerMs(): number {
    return 1; // 1 tick = 1 ms
  }

  tick(): void {
    this._currentTick = Math.floor(performance.now() - this.startTime);
  }

  tickBy(_count: number): void {
    this.tick(); // Just update to current time
  }

  ticksToMs(ticks: number): number {
    return ticks;
  }

  msToTicks(ms: number): number {
    return Math.round(ms);
  }

  now(): number {
    return performance.now();
  }

  sync(): void {
    // No-op, always in sync
  }

  reset(): void {
    this._currentTick = 0;
    this.startTime = performance.now();
  }
}
