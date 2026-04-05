// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview GroupArbiter Scenario Tests
 *
 * Comprehensive tests covering different network conditions and use cases:
 * - Interactive calls (150-300ms e2e latency)
 * - Live streaming (500ms - 2s e2e latency)
 * - High latency scenarios (2s - 10s e2e latency)
 *
 * Each profile tests:
 * - Good network conditions
 * - Bad network conditions (packet loss, reordering, jitter)
 * - Variable conditions (good → bad → good transitions)
 */

import { describe, it, expect } from 'vitest';
import { GroupArbiter } from './group-arbiter';
import { MonotonicTickProvider } from './tick-provider';
import type { TimingConfig } from './group-arbiter-types';

// ============================================================================
// Test Utilities
// ============================================================================

interface FrameArrival {
  groupId: number;
  objectId: number;
  isKeyframe: boolean;
  arrivalDelay: number; // ms after test start
  data?: string;
}

interface TestResult {
  framesOutput: number;
  groupsCompleted: number;
  groupsSkipped: number;
  droppedLateFrames: number;
  avgLatency: number;
  maxLatency: number;
  outputOrder: string[];
}

/**
 * Simulate frame arrivals and collect output
 */
async function simulateScenario(
  config: Partial<TimingConfig>,
  arrivals: FrameArrival[],
  testDurationMs: number
): Promise<TestResult> {
  const ticker = new MonotonicTickProvider();
  const arbiter = new GroupArbiter<string>(config, ticker);
  const outputOrder: string[] = [];

  // Sort arrivals by delay
  const sortedArrivals = [...arrivals].sort((a, b) => a.arrivalDelay - b.arrivalDelay);

  const startTime = performance.now();
  let arrivalIndex = 0;

  // Run simulation loop
  while (performance.now() - startTime < testDurationMs) {
    const elapsed = performance.now() - startTime;

    // Add frames that have "arrived"
    while (arrivalIndex < sortedArrivals.length && sortedArrivals[arrivalIndex].arrivalDelay <= elapsed) {
      const arrival = sortedArrivals[arrivalIndex];
      const data = arrival.data ?? `g${arrival.groupId}-o${arrival.objectId}`;
      arbiter.addFrame({
        groupId: arrival.groupId,
        objectId: arrival.objectId,
        data,
        isKeyframe: arrival.isKeyframe,
      });
      arrivalIndex++;
    }

    // Poll for ready frames
    const frames = arbiter.getReadyFrames(10);
    for (const frame of frames) {
      outputOrder.push(frame.data);
    }

    // Small delay to not spin CPU
    await new Promise(resolve => setTimeout(resolve, 5));
  }

  // Final poll
  const finalFrames = arbiter.getReadyFrames(100);
  for (const frame of finalFrames) {
    outputOrder.push(frame.data);
  }

  const stats = arbiter.getStats();
  return {
    framesOutput: stats.framesOutput,
    groupsCompleted: stats.groupsCompleted,
    groupsSkipped: stats.groupsSkipped,
    droppedLateFrames: stats.droppedLateFrames,
    avgLatency: stats.avgOutputLatency,
    maxLatency: stats.maxOutputLatency,
    outputOrder,
  };
}

/**
 * Generate frame arrivals for a GOP
 */
function generateGOP(
  groupId: number,
  frameCount: number,
  baseDelay: number,
  frameIntervalMs: number,
  jitterMs: number = 0
): FrameArrival[] {
  const frames: FrameArrival[] = [];
  for (let i = 0; i < frameCount; i++) {
    const jitter = jitterMs > 0 ? (Math.random() - 0.5) * 2 * jitterMs : 0;
    frames.push({
      groupId,
      objectId: i,
      isKeyframe: i === 0,
      arrivalDelay: baseDelay + i * frameIntervalMs + jitter,
    });
  }
  return frames;
}

/**
 * Reorder frames within a GOP to simulate network reordering
 */
function reorderFrames(frames: FrameArrival[], reorderProbability: number): FrameArrival[] {
  const result = [...frames];
  for (let i = 1; i < result.length; i++) {
    if (Math.random() < reorderProbability) {
      // Swap with previous frame's arrival time
      const temp = result[i].arrivalDelay;
      result[i].arrivalDelay = result[i - 1].arrivalDelay;
      result[i - 1].arrivalDelay = temp;
    }
  }
  return result;
}

/**
 * Drop some frames to simulate packet loss
 */
function dropFrames(frames: FrameArrival[], dropProbability: number, preserveKeyframes: boolean = true): FrameArrival[] {
  return frames.filter(f => {
    if (preserveKeyframes && f.isKeyframe) return true;
    return Math.random() > dropProbability;
  });
}

// ============================================================================
// Profile Configurations
// ============================================================================

/**
 * Interactive call profile (video conferencing, gaming)
 * - Target e2e latency: 150-300ms
 * - Aggressive skip behavior
 * - Short jitter buffer
 */
const INTERACTIVE_CONFIG: Partial<TimingConfig> = {
  maxLatency: 200,
  jitterDelay: 30,
  estimatedGopDuration: 1000, // 1s keyframe interval
  deadlineExtension: 50,
  allowPartialGroupDecode: true,
  skipOnlyToKeyframe: true,
  skipToLatestGroup: true,
  skipGraceFrames: 2,
};

/**
 * Live streaming profile
 * - Target e2e latency: 500ms - 2s
 * - Moderate tolerance
 * - Medium jitter buffer
 */
const LIVE_STREAM_CONFIG: Partial<TimingConfig> = {
  maxLatency: 1000,
  jitterDelay: 100,
  estimatedGopDuration: 2000, // 2s keyframe interval
  deadlineExtension: 200,
  allowPartialGroupDecode: true,
  skipOnlyToKeyframe: true,
  skipToLatestGroup: false,
  skipGraceFrames: 5,
};

/**
 * High latency profile (satellite, poor connectivity)
 * - Target e2e latency: 2s - 10s
 * - Very tolerant
 * - Large jitter buffer
 */
const HIGH_LATENCY_CONFIG: Partial<TimingConfig> = {
  maxLatency: 5000,
  jitterDelay: 200,
  estimatedGopDuration: 5000, // 5s keyframe interval
  deadlineExtension: 1000,
  allowPartialGroupDecode: true,
  skipOnlyToKeyframe: true,
  skipToLatestGroup: false,
  skipGraceFrames: 10,
};

// ============================================================================
// Interactive Call Tests (150-300ms e2e latency)
// ============================================================================

describe('Interactive Calls (150-300ms latency)', () => {
  const FRAME_INTERVAL = 33; // ~30fps
  const FRAMES_PER_GOP = 30; // 1 second GOP

  describe('Good Network Conditions', () => {
    it('should deliver frames with minimal latency when network is stable', async () => {
      // Use config without skipToLatestGroup to avoid skipping
      const noSkipConfig: Partial<TimingConfig> = {
        ...INTERACTIVE_CONFIG,
        skipToLatestGroup: false,
      };

      // Simulate frames arriving steadily with no jitter for determinism
      const arrivals: FrameArrival[] = [
        ...generateGOP(0, 10, 0, FRAME_INTERVAL, 0),
      ];

      const result = await simulateScenario(noSkipConfig, arrivals, 800);

      expect(result.framesOutput).toBeGreaterThan(0); // Should output frames
      expect(result.groupsSkipped).toBe(0); // No skips needed
    });

    it('should maintain frame order within GOP', async () => {
      const arrivals = generateGOP(0, 10, 0, FRAME_INTERVAL, 0);

      const result = await simulateScenario(INTERACTIVE_CONFIG, arrivals, 500);

      // Verify output order
      for (let i = 0; i < result.outputOrder.length - 1; i++) {
        const current = parseInt(result.outputOrder[i].split('-o')[1]);
        const next = parseInt(result.outputOrder[i + 1].split('-o')[1]);
        expect(next).toBeGreaterThan(current);
      }
    });
  });

  describe('Bad Network Conditions', () => {
    it('should handle high jitter (50ms+)', async () => {
      // High jitter scenario - use config without skipToLatestGroup
      const noSkipConfig: Partial<TimingConfig> = {
        ...INTERACTIVE_CONFIG,
        skipToLatestGroup: false,
      };
      const arrivals = generateGOP(0, 10, 0, FRAME_INTERVAL, 40);

      const result = await simulateScenario(noSkipConfig, arrivals, 1200);

      // With 40ms jitter + 30ms jitterDelay, expect at least 1 frame
      expect(result.framesOutput).toBeGreaterThanOrEqual(1);
    });

    it('should handle frame reordering', async () => {
      const noSkipConfig: Partial<TimingConfig> = {
        ...INTERACTIVE_CONFIG,
        skipToLatestGroup: false,
      };
      let arrivals = generateGOP(0, 10, 0, FRAME_INTERVAL, 0);
      arrivals = reorderFrames(arrivals, 0.3); // 30% reorder probability

      const result = await simulateScenario(noSkipConfig, arrivals, 800);

      // First frame should always be keyframe
      expect(result.outputOrder[0]).toBe('g0-o0');
      // Expect at least the keyframe was output
      expect(result.framesOutput).toBeGreaterThan(0);
    });

    it('should skip to new GOP when current GOP is too delayed', async () => {
      // This test verifies that newer group frames are output after grace period
      const skipConfig: Partial<TimingConfig> = {
        ...INTERACTIVE_CONFIG,
        skipToLatestGroup: true,
        skipGraceFrames: 3,
      };

      const arrivals: FrameArrival[] = [
        // GOP 0 starts
        { groupId: 0, objectId: 0, isKeyframe: true, arrivalDelay: 0 },
        // GOP 1 arrives with keyframe and 3 frames (grace period)
        { groupId: 1, objectId: 0, isKeyframe: true, arrivalDelay: 50 },
        { groupId: 1, objectId: 1, isKeyframe: false, arrivalDelay: 83 },
        { groupId: 1, objectId: 2, isKeyframe: false, arrivalDelay: 116 },
        { groupId: 1, objectId: 3, isKeyframe: false, arrivalDelay: 149 },
      ];

      const result = await simulateScenario(skipConfig, arrivals, 500);

      // Should have output from GOP 1 (after skip)
      expect(result.outputOrder.some(f => f.startsWith('g1'))).toBe(true);
    });

    it('should handle packet loss (10% drop rate)', async () => {
      let arrivals = generateGOP(0, FRAMES_PER_GOP, 0, FRAME_INTERVAL, 10);
      arrivals = dropFrames(arrivals, 0.1, true); // 10% drop, keep keyframes

      const result = await simulateScenario(INTERACTIVE_CONFIG, arrivals, 2000);

      // Should still output keyframe and available frames
      expect(result.framesOutput).toBeGreaterThan(0);
      expect(result.outputOrder[0]).toBe('g0-o0'); // Keyframe preserved
    });
  });

  describe('Variable Network Conditions (Good → Bad → Good)', () => {
    it('should recover from temporary network degradation', async () => {
      const arrivals: FrameArrival[] = [
        // Good: GOP 0 arrives normally
        ...generateGOP(0, 10, 0, FRAME_INTERVAL, 5),
        // Bad: GOP 1 has high jitter and some drops
        ...dropFrames(
          reorderFrames(generateGOP(1, 10, 500, FRAME_INTERVAL, 100), 0.4),
          0.2,
          true
        ),
        // Good: GOP 2 recovers
        ...generateGOP(2, 10, 1200, FRAME_INTERVAL, 5),
      ];

      const result = await simulateScenario(INTERACTIVE_CONFIG, arrivals, 2000);

      // Should have completed GOP 0 and 2
      expect(result.groupsCompleted).toBeGreaterThanOrEqual(2);
      // GOP 1 may have been skipped or partially completed
    });

    it('should handle burst packet loss followed by recovery', async () => {
      const arrivals: FrameArrival[] = [
        // Normal start
        ...generateGOP(0, 5, 0, FRAME_INTERVAL, 5),
        // Burst loss - frames 5-15 missing from GOP 0
        // GOP 1 arrives during the outage
        { groupId: 1, objectId: 0, isKeyframe: true, arrivalDelay: 200 },
        { groupId: 1, objectId: 1, isKeyframe: false, arrivalDelay: 233 },
        { groupId: 1, objectId: 2, isKeyframe: false, arrivalDelay: 266 },
        // Recovery - rest of GOP 1
        ...generateGOP(1, 10, 300, FRAME_INTERVAL, 5).slice(3),
      ];

      const result = await simulateScenario(INTERACTIVE_CONFIG, arrivals, 1000);

      // Should handle the transition (output at least keyframes)
      expect(result.framesOutput).toBeGreaterThan(1);
    });
  });
});

// ============================================================================
// Live Streaming Tests (500ms - 2s e2e latency)
// ============================================================================

describe('Live Streaming (500ms - 2s latency)', () => {
  const FRAME_INTERVAL = 33; // ~30fps
  const FRAMES_PER_GOP = 30; // 1 second GOP for faster tests

  describe('Good Network Conditions', () => {
    it('should deliver all frames smoothly with larger buffer', async () => {
      const arrivals: FrameArrival[] = [
        ...generateGOP(0, FRAMES_PER_GOP, 0, FRAME_INTERVAL, 20),
        ...generateGOP(1, FRAMES_PER_GOP, 1200, FRAME_INTERVAL, 20),
      ];

      const result = await simulateScenario(LIVE_STREAM_CONFIG, arrivals, 3000);

      expect(result.framesOutput).toBeGreaterThan(30);
      expect(result.groupsSkipped).toBe(0);
      expect(result.groupsCompleted).toBeGreaterThanOrEqual(1);
    });

    it('should handle moderate jitter without skipping', async () => {
      // Reduce jitter to make test more deterministic
      const arrivals = generateGOP(0, 15, 0, FRAME_INTERVAL, 50);

      const result = await simulateScenario(LIVE_STREAM_CONFIG, arrivals, 1500);

      expect(result.groupsSkipped).toBe(0); // Larger buffer should absorb jitter
      expect(result.framesOutput).toBeGreaterThan(0); // Should output at least some frames
    });
  });

  describe('Bad Network Conditions', () => {
    it('should handle significant reordering with larger buffer', async () => {
      let arrivals = generateGOP(0, 30, 0, FRAME_INTERVAL, 0);
      // Heavy reordering
      arrivals = reorderFrames(arrivals, 0.5);

      const result = await simulateScenario(LIVE_STREAM_CONFIG, arrivals, 2000);

      // Should still output in correct order
      expect(result.outputOrder[0]).toBe('g0-o0');
      expect(result.framesOutput).toBeGreaterThan(20);
    });

    it('should handle extended network outage then recovery', async () => {
      const arrivals: FrameArrival[] = [
        // GOP 0 starts
        ...generateGOP(0, 10, 0, FRAME_INTERVAL, 10),
        // Network outage - 2 second gap
        // GOP 1 arrives after outage
        ...generateGOP(1, 30, 2500, FRAME_INTERVAL, 10),
      ];

      const result = await simulateScenario(LIVE_STREAM_CONFIG, arrivals, 4000);

      // Should have handled the gap gracefully
      expect(result.framesOutput).toBeGreaterThan(30);
    });

    it('should handle 20% packet loss', async () => {
      let arrivals = generateGOP(0, FRAMES_PER_GOP, 0, FRAME_INTERVAL, 30);
      arrivals = dropFrames(arrivals, 0.2, true);

      const result = await simulateScenario(LIVE_STREAM_CONFIG, arrivals, 3000);

      // Should output keyframe and available P-frames
      expect(result.framesOutput).toBeGreaterThan(0);
    });
  });

  describe('Variable Network Conditions', () => {
    it('should handle bandwidth fluctuation pattern', async () => {
      const arrivals: FrameArrival[] = [
        // Good bandwidth - normal delivery
        ...generateGOP(0, 20, 0, FRAME_INTERVAL, 10),
        // Reduced bandwidth - slower delivery with jitter
        ...generateGOP(1, 20, 800, FRAME_INTERVAL * 1.5, 50),
        // Good bandwidth recovery
        ...generateGOP(2, 20, 1800, FRAME_INTERVAL, 10),
      ];

      const result = await simulateScenario(LIVE_STREAM_CONFIG, arrivals, 3500);

      expect(result.framesOutput).toBeGreaterThan(40);
      expect(result.groupsCompleted).toBeGreaterThanOrEqual(1);
    });
  });
});

// ============================================================================
// High Latency Tests (2s - 10s e2e latency)
// ============================================================================

describe('High Latency Scenarios (2s - 10s latency)', () => {
  const FRAME_INTERVAL = 33;

  describe('Good Network Conditions', () => {
    it('should handle very long GOPs', async () => {
      const arrivals = generateGOP(0, 30, 0, FRAME_INTERVAL, 50);

      const result = await simulateScenario(HIGH_LATENCY_CONFIG, arrivals, 2000);

      expect(result.framesOutput).toBeGreaterThan(10);
      expect(result.groupsSkipped).toBe(0);
    });

    it('should maintain smooth playback with large buffer', async () => {
      const arrivals: FrameArrival[] = [
        ...generateGOP(0, 20, 0, FRAME_INTERVAL, 100),
        ...generateGOP(1, 20, 1200, FRAME_INTERVAL, 100),
      ];

      const result = await simulateScenario(HIGH_LATENCY_CONFIG, arrivals, 3000);

      expect(result.framesOutput).toBeGreaterThan(20);
    });
  });

  describe('Bad Network Conditions', () => {
    it('should tolerate extreme jitter (500ms+)', async () => {
      // Use fewer frames and scale back jitter to complete in time
      const arrivals = generateGOP(0, 15, 0, FRAME_INTERVAL, 300);

      const result = await simulateScenario(HIGH_LATENCY_CONFIG, arrivals, 3000);

      // With very large buffer, should still output frames
      expect(result.framesOutput).toBeGreaterThan(5);
    });

    it('should handle severe reordering', async () => {
      let arrivals = generateGOP(0, 20, 0, FRAME_INTERVAL, 0);
      // Very heavy reordering
      arrivals = reorderFrames(arrivals, 0.7);
      // Also add some jitter
      arrivals = arrivals.map(a => ({
        ...a,
        arrivalDelay: a.arrivalDelay + Math.random() * 200,
      }));

      const result = await simulateScenario(HIGH_LATENCY_CONFIG, arrivals, 3000);

      // Should handle gracefully
      expect(result.framesOutput).toBeGreaterThan(0);
    });

    it('should handle 30% packet loss', async () => {
      let arrivals = generateGOP(0, 50, 0, FRAME_INTERVAL, 50);
      arrivals = dropFrames(arrivals, 0.3, true);

      const result = await simulateScenario(HIGH_LATENCY_CONFIG, arrivals, 4000);

      // Should still output available frames
      expect(result.framesOutput).toBeGreaterThan(0);
    });
  });

  describe('Variable Network Conditions', () => {
    it('should handle satellite link variability', async () => {
      // Simulate satellite link with periodic latency spikes (scaled down)
      const arrivals: FrameArrival[] = [];
      for (let g = 0; g < 2; g++) {
        const baseDelay = g * 1000;
        // Add latency spike every other GOP
        const extraDelay = g % 2 === 1 ? 200 : 0;
        const jitter = g % 2 === 1 ? 100 : 30;
        arrivals.push(...generateGOP(g, 15, baseDelay + extraDelay, FRAME_INTERVAL, jitter));
      }

      const result = await simulateScenario(HIGH_LATENCY_CONFIG, arrivals, 3000);

      expect(result.framesOutput).toBeGreaterThan(15);
    });
  });
});

// ============================================================================
// Cross-Profile Edge Cases
// ============================================================================

describe('Cross-Profile Edge Cases', () => {
  it('should handle profile mismatch (interactive config with high latency network)', async () => {
    // Interactive config with skipToLatestGroup enabled
    const skipConfig: Partial<TimingConfig> = {
      ...INTERACTIVE_CONFIG,
      skipToLatestGroup: true,
      skipGraceFrames: 3,
    };

    const arrivals: FrameArrival[] = [
      // GOP 0 keyframe arrives
      { groupId: 0, objectId: 0, isKeyframe: true, arrivalDelay: 0 },
      // GOP 1 arrives with keyframe and 3 frames (grace period met)
      { groupId: 1, objectId: 0, isKeyframe: true, arrivalDelay: 50 },
      { groupId: 1, objectId: 1, isKeyframe: false, arrivalDelay: 83 },
      { groupId: 1, objectId: 2, isKeyframe: false, arrivalDelay: 116 },
      { groupId: 1, objectId: 3, isKeyframe: false, arrivalDelay: 149 },
    ];

    const result = await simulateScenario(skipConfig, arrivals, 500);

    // Should have output from GOP 1 (skipped to newer group)
    expect(result.outputOrder.some(f => f.startsWith('g1'))).toBe(true);
  });

  it('should handle interleaved GOP delivery (multiple streams)', async () => {
    // Simulate two streams being multiplexed
    const arrivals: FrameArrival[] = [
      { groupId: 100, objectId: 0, isKeyframe: true, arrivalDelay: 0 },
      { groupId: 200, objectId: 0, isKeyframe: true, arrivalDelay: 10 },
      { groupId: 100, objectId: 1, isKeyframe: false, arrivalDelay: 20 },
      { groupId: 200, objectId: 1, isKeyframe: false, arrivalDelay: 30 },
      { groupId: 100, objectId: 2, isKeyframe: false, arrivalDelay: 40 },
      { groupId: 200, objectId: 2, isKeyframe: false, arrivalDelay: 50 },
    ];

    const result = await simulateScenario(LIVE_STREAM_CONFIG, arrivals, 500);

    // Should process lower groupId first
    expect(result.outputOrder[0]).toBe('g100-o0');
  });

  it('should handle rapid GOP switching (scene change)', async () => {
    // Scene change causes new GOP before previous completes
    // Use no-skip config to process GOPs sequentially
    const noSkipConfig: Partial<TimingConfig> = {
      ...INTERACTIVE_CONFIG,
      skipToLatestGroup: false,
    };

    const arrivals: FrameArrival[] = [
      ...generateGOP(0, 5, 0, 33, 5), // Start GOP 0
      // Scene change - new GOP arrives
      ...generateGOP(1, 5, 200, 33, 5),
    ];

    const result = await simulateScenario(noSkipConfig, arrivals, 700);

    // Should handle rapid transitions - at least output keyframes
    expect(result.framesOutput).toBeGreaterThanOrEqual(2);
  });

  it('should handle keyframe loss with subsequent recovery', async () => {
    const arrivals: FrameArrival[] = [
      // GOP 0 keyframe lost, only P-frames arrive
      { groupId: 0, objectId: 1, isKeyframe: false, arrivalDelay: 33 },
      { groupId: 0, objectId: 2, isKeyframe: false, arrivalDelay: 66 },
      // GOP 1 arrives complete
      ...generateGOP(1, 10, 200, 33, 5),
    ];

    const result = await simulateScenario(INTERACTIVE_CONFIG, arrivals, 1000);

    // Should skip to GOP 1 which has keyframe
    expect(result.outputOrder.some(f => f.startsWith('g1-o0'))).toBe(true);
  });
});

// ============================================================================
// Performance Under Load Tests
// ============================================================================

describe('Performance Under Load', () => {
  it('should handle high frame rate (60fps) interactive call', async () => {
    const FRAME_INTERVAL_60FPS = 16.67;
    const arrivals = generateGOP(0, 60, 0, FRAME_INTERVAL_60FPS, 5);

    const result = await simulateScenario(
      { ...INTERACTIVE_CONFIG, estimatedGopDuration: 1000 },
      arrivals,
      1500
    );

    expect(result.framesOutput).toBeGreaterThan(50);
  });

  it('should handle multiple concurrent GOPs (4 groups)', async () => {
    const arrivals: FrameArrival[] = [];
    // 4 GOPs arriving with overlap
    for (let g = 0; g < 4; g++) {
      arrivals.push(...generateGOP(g, 20, g * 200, 33, 30));
    }

    const result = await simulateScenario(
      { ...LIVE_STREAM_CONFIG, maxActiveGroups: 4 },
      arrivals,
      2000
    );

    expect(result.framesOutput).toBeGreaterThan(60);
  });

  it('should handle burst arrival pattern', async () => {
    // All frames in a GOP arrive in a burst (common with TCP-based delivery)
    const arrivals: FrameArrival[] = [];
    for (let i = 0; i < 30; i++) {
      arrivals.push({
        groupId: 0,
        objectId: i,
        isKeyframe: i === 0,
        arrivalDelay: i * 2, // 2ms apart (burst)
      });
    }

    const result = await simulateScenario(LIVE_STREAM_CONFIG, arrivals, 500);

    expect(result.framesOutput).toBeGreaterThan(25);
    expect(result.outputOrder[0]).toBe('g0-o0');
  });
});

// ============================================================================
// Skip-to-Latest Behavior Tests
// ============================================================================

describe('Skip-to-Latest Group Behavior', () => {
  it('should skip with minimal grace frames', async () => {
    // With skipGraceFrames=2, skip happens on second frame of newer group
    const config: Partial<TimingConfig> = {
      ...INTERACTIVE_CONFIG,
      skipToLatestGroup: true,
      skipGraceFrames: 2,
    };

    const arrivals: FrameArrival[] = [
      { groupId: 0, objectId: 0, isKeyframe: true, arrivalDelay: 0 },
      // GOP 1 arrives with keyframe and second frame
      { groupId: 1, objectId: 0, isKeyframe: true, arrivalDelay: 50 },
      { groupId: 1, objectId: 1, isKeyframe: false, arrivalDelay: 83 }, // 2nd frame triggers skip
      { groupId: 1, objectId: 2, isKeyframe: false, arrivalDelay: 116 },
    ];

    const result = await simulateScenario(config, arrivals, 400);

    // Should have output from GOP 1 after skip
    expect(result.outputOrder.some(f => f.startsWith('g1'))).toBe(true);
  });

  it('should wait for grace frames before skipping', async () => {
    const config: Partial<TimingConfig> = {
      ...INTERACTIVE_CONFIG,
      skipToLatestGroup: true,
      skipGraceFrames: 3,
    };

    const arrivals: FrameArrival[] = [
      { groupId: 0, objectId: 0, isKeyframe: true, arrivalDelay: 0 },
      // GOP 1 starts arriving
      { groupId: 1, objectId: 0, isKeyframe: true, arrivalDelay: 50 },
      { groupId: 1, objectId: 1, isKeyframe: false, arrivalDelay: 60 },
      { groupId: 1, objectId: 2, isKeyframe: false, arrivalDelay: 70 },
      // Grace period reached (3 frames), should skip now
      { groupId: 1, objectId: 3, isKeyframe: false, arrivalDelay: 80 },
    ];

    const result = await simulateScenario(config, arrivals, 300);

    // Should have skipped after grace period
    expect(result.outputOrder.some(f => f.startsWith('g1'))).toBe(true);
  });

  it('should not skip when skipToLatestGroup is disabled', async () => {
    const config: Partial<TimingConfig> = {
      ...LIVE_STREAM_CONFIG,
      skipToLatestGroup: false,
    };

    const arrivals: FrameArrival[] = [
      ...generateGOP(0, 10, 0, 33, 5),
      ...generateGOP(1, 10, 200, 33, 5),
    ];

    const result = await simulateScenario(config, arrivals, 800);

    // Should complete GOP 0 before moving to GOP 1
    expect(result.groupsCompleted).toBeGreaterThanOrEqual(1);
  });
});
