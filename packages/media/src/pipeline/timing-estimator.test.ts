// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { describe, it, expect, beforeEach } from 'vitest';
import { TimingEstimator, createTimingEstimator } from './timing-estimator';
import {
  createGroupState,
  createArbiterStats,
  DEFAULT_TIMING_CONFIG,
} from './group-arbiter-types';
import { MonotonicTickProvider } from './tick-provider';

describe('TimingEstimator', () => {
  let estimator: TimingEstimator;

  beforeEach(() => {
    estimator = new TimingEstimator({
      initialGopDuration: 1000,
    });
  });

  describe('initial estimate', () => {
    it('should use initialGopDuration when no catalog hints', () => {
      expect(estimator.getEstimatedGopDuration()).toBe(1000);
    });

    it('should use 1 second default when framerate provided', () => {
      const withFramerate = new TimingEstimator({
        initialGopDuration: 500,
        catalogFramerate: 30,
      });
      expect(withFramerate.getEstimatedGopDuration()).toBe(1000);
    });
  });

  describe('onKeyframe', () => {
    it('should not update on first keyframe (no interval yet)', () => {
      estimator.onKeyframe(0, 0, 1_000_000);
      expect(estimator.getEstimatedGopDuration()).toBe(1000);
      expect(estimator.getSampleCount()).toBe(0);
    });

    it('should update estimate on subsequent keyframes', () => {
      // First keyframe at t=0
      estimator.onKeyframe(0, 0, 1_000_000);

      // Second keyframe at t=500ms
      estimator.onKeyframe(1, 500_000, 1_000_000);

      expect(estimator.getSampleCount()).toBe(1);
      // With smoothing factor 0.3: 0.7 * 1000 + 0.3 * 500 = 850
      expect(estimator.getEstimatedGopDuration()).toBeCloseTo(850, 0);
    });

    it('should handle different timescales', () => {
      // 90kHz timescale (common for video)
      estimator.onKeyframe(0, 0, 90_000);
      estimator.onKeyframe(1, 90_000, 90_000); // 1 second later

      expect(estimator.getSampleCount()).toBe(1);
      // Should detect ~1000ms GOP
      expect(estimator.getEstimatedGopDuration()).toBeCloseTo(1000, 0);
    });

    it('should ignore old/duplicate keyframes', () => {
      estimator.onKeyframe(0, 0, 1_000_000);
      estimator.onKeyframe(1, 500_000, 1_000_000);

      const estimate1 = estimator.getEstimatedGopDuration();

      // Old keyframe should be ignored
      estimator.onKeyframe(0, 100_000, 1_000_000);

      expect(estimator.getEstimatedGopDuration()).toBe(estimate1);
    });

    it('should handle gaps in groupId', () => {
      estimator.onKeyframe(0, 0, 1_000_000);
      // Skip group 1, go directly to group 5
      estimator.onKeyframe(5, 2_500_000, 1_000_000); // 2.5 seconds

      expect(estimator.getSampleCount()).toBe(1);
      // Should use the 2.5s interval
      expect(estimator.getEstimatedGopDuration()).toBeGreaterThan(1000);
    });

    it('should reject durations outside valid range', () => {
      const strictEstimator = new TimingEstimator({
        initialGopDuration: 1000,
        minGopDuration: 200,
        maxGopDuration: 5000,
      });

      strictEstimator.onKeyframe(0, 0, 1_000_000);

      // Too short (50ms)
      strictEstimator.onKeyframe(1, 50_000, 1_000_000);
      expect(strictEstimator.getSampleCount()).toBe(0);

      // Valid (500ms)
      strictEstimator.onKeyframe(2, 550_000, 1_000_000);
      expect(strictEstimator.getSampleCount()).toBe(1);
    });

    it('should maintain sliding window of samples', () => {
      const windowEstimator = new TimingEstimator({
        initialGopDuration: 1000,
        maxSamples: 3,
      });

      windowEstimator.onKeyframe(0, 0, 1_000_000);

      // Add 5 samples
      for (let i = 1; i <= 5; i++) {
        windowEstimator.onKeyframe(i, i * 500_000, 1_000_000);
      }

      expect(windowEstimator.getSampleCount()).toBe(5);
      // But internal window only keeps 3
      const stats = windowEstimator.getStats();
      expect(stats.samples.length).toBe(3);
    });
  });

  describe('calculateDeadline', () => {
    it('should calculate deadline from arrival + GOP + latency', () => {
      const ticker = new MonotonicTickProvider();
      ticker.tickBy(100); // Simulate 100ms arrival

      const group = createGroupState<unknown>(0, 100, 0);

      const deadline = estimator.calculateDeadline(group, ticker, 500);

      // arrival (100) + GOP (1000) + latency (500) = 1600
      expect(ticker.ticksToMs(deadline)).toBeCloseTo(1600, 0);
    });

    it('should use updated GOP estimate in deadline', () => {
      const ticker = new MonotonicTickProvider();

      // Update estimate to 500ms GOP
      estimator.onKeyframe(0, 0, 1_000_000);
      estimator.onKeyframe(1, 500_000, 1_000_000);

      ticker.tickBy(100);
      const group = createGroupState<unknown>(2, 100, 0);

      const deadline = estimator.calculateDeadline(group, ticker, 500);

      // GOP is now ~850ms (smoothed)
      // arrival (100) + GOP (~850) + latency (500) = ~1450
      expect(ticker.ticksToMs(deadline)).toBeGreaterThan(1400);
      expect(ticker.ticksToMs(deadline)).toBeLessThan(1500);
    });
  });

  describe('hasReliableEstimate', () => {
    it('should return false with no samples', () => {
      expect(estimator.hasReliableEstimate()).toBe(false);
    });

    it('should return false with 1 sample', () => {
      estimator.onKeyframe(0, 0, 1_000_000);
      estimator.onKeyframe(1, 500_000, 1_000_000);
      expect(estimator.hasReliableEstimate()).toBe(false);
    });

    it('should return true with 2+ samples', () => {
      estimator.onKeyframe(0, 0, 1_000_000);
      estimator.onKeyframe(1, 500_000, 1_000_000);
      estimator.onKeyframe(2, 1_000_000, 1_000_000);
      expect(estimator.hasReliableEstimate()).toBe(true);
    });
  });

  describe('reset', () => {
    it('should reset to initial state', () => {
      estimator.onKeyframe(0, 0, 1_000_000);
      estimator.onKeyframe(1, 500_000, 1_000_000);
      estimator.onKeyframe(2, 1_000_000, 1_000_000);

      estimator.reset();

      expect(estimator.getEstimatedGopDuration()).toBe(1000);
      expect(estimator.getSampleCount()).toBe(0);
      expect(estimator.hasReliableEstimate()).toBe(false);
    });
  });
});

describe('createTimingEstimator', () => {
  it('should create from TimingConfig', () => {
    const estimator = createTimingEstimator(DEFAULT_TIMING_CONFIG);
    expect(estimator.getEstimatedGopDuration()).toBe(1000);
  });

  it('should use catalog hints when available', () => {
    const config = {
      ...DEFAULT_TIMING_CONFIG,
      catalogFramerate: 30,
      catalogTimescale: 90000,
    };
    const estimator = createTimingEstimator(config);
    expect(estimator.getEstimatedGopDuration()).toBe(1000);
  });
});

describe('group-arbiter-types', () => {
  describe('createGroupState', () => {
    it('should create empty group state', () => {
      const now = performance.now();
      const group = createGroupState<string>(42, 100, now, 2000, now + 1500);

      expect(group.groupId).toBe(42);
      expect(group.firstFrameReceivedTick).toBe(100);
      expect(group.firstFrameReceivedAt).toBe(now);
      expect(group.deadlineTick).toBe(2000);
      expect(group.deadlineTime).toBe(now + 1500);
      expect(group.frames.size).toBe(0);
      expect(group.hasKeyframe).toBe(false);
      expect(group.highestObjectId).toBe(-1);
      expect(group.outputObjectId).toBe(-1);
      expect(group.frameCount).toBe(0);
      expect(group.status).toBe('receiving');
      expect(group.locTimestampBase).toBe(-1);
      expect(group.locTimescale).toBe(1_000_000);
    });
  });

  describe('createArbiterStats', () => {
    it('should create zeroed stats', () => {
      const stats = createArbiterStats();

      expect(stats.groupsReceived).toBe(0);
      expect(stats.groupsCompleted).toBe(0);
      expect(stats.groupsExpired).toBe(0);
      expect(stats.groupsSkipped).toBe(0);
      expect(stats.deadlinesExtended).toBe(0);
      expect(stats.framesReceived).toBe(0);
      expect(stats.framesOutput).toBe(0);
      expect(stats.droppedLateFrames).toBe(0);
      expect(stats.skippedMissingFrames).toBe(0);
      expect(stats.estimatedGopDuration).toBe(0);
      expect(stats.avgOutputLatency).toBe(0);
      expect(stats.maxOutputLatency).toBe(0);
      expect(stats.catchUpEvents).toBe(0);
      expect(stats.framesFlushed).toBe(0);
    });
  });

  describe('DEFAULT_TIMING_CONFIG', () => {
    it('should have sensible defaults', () => {
      expect(DEFAULT_TIMING_CONFIG.estimatedGopDuration).toBe(1000);
      expect(DEFAULT_TIMING_CONFIG.maxLatency).toBe(500);
      expect(DEFAULT_TIMING_CONFIG.jitterDelay).toBe(50);
      expect(DEFAULT_TIMING_CONFIG.deadlineExtension).toBe(200);
      expect(DEFAULT_TIMING_CONFIG.maxActiveGroups).toBe(4);
      expect(DEFAULT_TIMING_CONFIG.maxFramesPerGroup).toBe(120);
      expect(DEFAULT_TIMING_CONFIG.allowPartialGroupDecode).toBe(true);
      expect(DEFAULT_TIMING_CONFIG.skipOnlyToKeyframe).toBe(true);
      expect(DEFAULT_TIMING_CONFIG.enableCatchUp).toBe(true);
      expect(DEFAULT_TIMING_CONFIG.catchUpThreshold).toBe(5);
      expect(DEFAULT_TIMING_CONFIG.maxCatchUpFrames).toBe(30);
    });
  });
});

describe('TimingEstimator benchmark', () => {
  it('onKeyframe should be fast', () => {
    const estimator = new TimingEstimator({ initialGopDuration: 1000 });
    const ITERATIONS = 10000;

    // Initialize
    estimator.onKeyframe(0, 0, 1_000_000);

    const start = performance.now();
    for (let i = 1; i <= ITERATIONS; i++) {
      estimator.onKeyframe(i, i * 33333, 1_000_000); // ~30fps
    }
    const elapsed = performance.now() - start;
    const opsPerMs = ITERATIONS / elapsed;

    console.log(
      `TimingEstimator.onKeyframe: ${ITERATIONS} calls in ${elapsed.toFixed(2)}ms ` +
        `(${opsPerMs.toFixed(0)} ops/ms)`
    );

    // Should be very fast - at least 1000 ops/ms
    expect(opsPerMs).toBeGreaterThan(1000);
  });
});
