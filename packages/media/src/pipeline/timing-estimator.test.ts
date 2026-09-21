// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { describe, it, expect, beforeEach } from 'vitest';
import { TimingEstimator } from './timing-estimator';

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
      estimator.onKeyframe(0, 0, 1_000_000);
      estimator.onKeyframe(1, 500_000, 1_000_000);

      expect(estimator.getSampleCount()).toBe(1);
      // With smoothing factor 0.3: 0.7 * 1000 + 0.3 * 500 = 850
      expect(estimator.getEstimatedGopDuration()).toBeCloseTo(850, 0);
    });

    it('should handle different timescales', () => {
      estimator.onKeyframe(0, 0, 90_000);
      estimator.onKeyframe(1, 90_000, 90_000); // 1 second later

      expect(estimator.getSampleCount()).toBe(1);
      expect(estimator.getEstimatedGopDuration()).toBeCloseTo(1000, 0);
    });

    it('should ignore old/duplicate keyframes', () => {
      estimator.onKeyframe(0, 0, 1_000_000);
      estimator.onKeyframe(1, 500_000, 1_000_000);

      const estimate1 = estimator.getEstimatedGopDuration();
      estimator.onKeyframe(0, 100_000, 1_000_000);

      expect(estimator.getEstimatedGopDuration()).toBe(estimate1);
    });

    it('should handle gaps in groupId', () => {
      estimator.onKeyframe(0, 0, 1_000_000);
      estimator.onKeyframe(5, 2_500_000, 1_000_000);

      expect(estimator.getSampleCount()).toBe(1);
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

      for (let i = 1; i <= 5; i++) {
        windowEstimator.onKeyframe(i, i * 500_000, 1_000_000);
      }

      expect(windowEstimator.getSampleCount()).toBe(5);
      const stats = windowEstimator.getStats();
      expect(stats.samples.length).toBe(3);
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

describe('TimingEstimator benchmark', () => {
  it('onKeyframe should be fast', () => {
    const estimator = new TimingEstimator({ initialGopDuration: 1000 });
    const ITERATIONS = 10000;

    estimator.onKeyframe(0, 0, 1_000_000);

    const start = performance.now();
    for (let i = 1; i <= ITERATIONS; i++) {
      estimator.onKeyframe(i, i * 33333, 1_000_000);
    }
    const elapsed = performance.now() - start;
    const opsPerMs = ITERATIONS / elapsed;

    console.log(
      `TimingEstimator.onKeyframe: ${ITERATIONS} calls in ${elapsed.toFixed(2)}ms ` +
        `(${opsPerMs.toFixed(0)} ops/ms)`
    );

    expect(opsPerMs).toBeGreaterThan(1000);
  });
});
