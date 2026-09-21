// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Scenario tests for LiveReleasePolicy (ported from
 * group-arbiter-scenarios.test.ts).
 *
 * Covers interactive, live-streaming and high-latency profiles under good,
 * bad and variable network conditions. All wiring goes through the
 * PlayoutBuffer public surface so behavior stays covered even after the
 * legacy arbiter is deleted.
 */

import { describe, it, expect } from 'vitest';
import { PlayoutBuffer } from './playout-buffer';
import { LiveReleasePolicy } from './live-release-policy';
import type { LiveReleasePolicyConfig } from './live-release-policy';
import { MonotonicTickProvider } from './tick-provider';

// ============================================================================
// Test Utilities
// ============================================================================

interface FrameArrival {
  groupId: number;
  objectId: number;
  isKeyframe: boolean;
  arrivalDelay: number;
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

async function simulateScenario(
  config: Partial<LiveReleasePolicyConfig>,
  arrivals: FrameArrival[],
  testDurationMs: number,
): Promise<TestResult> {
  const ticker = new MonotonicTickProvider();
  const policy = new LiveReleasePolicy<string>(config, ticker);
  const buffer = new PlayoutBuffer<string>(policy);
  const outputOrder: string[] = [];

  const sortedArrivals = [...arrivals].sort((a, b) => a.arrivalDelay - b.arrivalDelay);

  const groupFrameCounts = new Map<number, { expected: number; received: number }>();
  for (const arrival of arrivals) {
    const entry = groupFrameCounts.get(arrival.groupId) ?? { expected: 0, received: 0 };
    entry.expected++;
    groupFrameCounts.set(arrival.groupId, entry);
  }

  const startTime = performance.now();
  let arrivalIndex = 0;

  while (performance.now() - startTime < testDurationMs) {
    const elapsed = performance.now() - startTime;

    while (arrivalIndex < sortedArrivals.length && sortedArrivals[arrivalIndex].arrivalDelay <= elapsed) {
      const arrival = sortedArrivals[arrivalIndex];
      const data = arrival.data ?? `g${arrival.groupId}-o${arrival.objectId}`;
      buffer.addFrame({
        groupId: arrival.groupId,
        objectId: arrival.objectId,
        data,
        isKeyframe: arrival.isKeyframe,
      });
      arrivalIndex++;

      const entry = groupFrameCounts.get(arrival.groupId)!;
      entry.received++;
      if (entry.received === entry.expected) {
        buffer.markGroupComplete(arrival.groupId);
      }
    }

    const frames = buffer.getReadyFrames(10);
    for (const frame of frames) {
      outputOrder.push(frame.data);
    }

    await new Promise(resolve => setTimeout(resolve, 5));
  }

  const finalFrames = buffer.getReadyFrames(100);
  for (const frame of finalFrames) {
    outputOrder.push(frame.data);
  }

  const bufStats = buffer.getStats();
  const polStats = policy.getStats();

  return {
    framesOutput: bufStats.framesOutput,
    groupsCompleted: bufStats.groupsCompleted,
    groupsSkipped: bufStats.groupsSkipped,
    droppedLateFrames: bufStats.framesDropped,
    avgLatency: polStats.avgOutputLatency as number,
    maxLatency: polStats.maxOutputLatency as number,
    outputOrder,
  };
}

function generateGOP(
  groupId: number,
  frameCount: number,
  baseDelay: number,
  frameIntervalMs: number,
  jitterMs: number = 0,
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

function reorderFrames(frames: FrameArrival[], reorderProbability: number): FrameArrival[] {
  const result = [...frames];
  for (let i = 1; i < result.length; i++) {
    if (Math.random() < reorderProbability) {
      const temp = result[i].arrivalDelay;
      result[i].arrivalDelay = result[i - 1].arrivalDelay;
      result[i - 1].arrivalDelay = temp;
    }
  }
  return result;
}

function dropFrames(
  frames: FrameArrival[],
  dropProbability: number,
  preserveKeyframes: boolean = true,
): FrameArrival[] {
  return frames.filter(f => {
    if (preserveKeyframes && f.isKeyframe) return true;
    return Math.random() > dropProbability;
  });
}

// ============================================================================
// Profile Configurations
// ============================================================================

const INTERACTIVE_CONFIG: Partial<LiveReleasePolicyConfig> = {
  maxLatency: 200,
  jitterDelay: 30,
  estimatedGopDuration: 1000,
  deadlineExtension: 50,
  allowPartialGroupDecode: true,
  skipOnlyToKeyframe: true,
  skipToLatestGroup: true,
  skipGraceFrames: 2,
};

const LIVE_STREAM_CONFIG: Partial<LiveReleasePolicyConfig> = {
  maxLatency: 1000,
  jitterDelay: 100,
  estimatedGopDuration: 2000,
  deadlineExtension: 200,
  allowPartialGroupDecode: true,
  skipOnlyToKeyframe: true,
  skipToLatestGroup: false,
  skipGraceFrames: 5,
};

const HIGH_LATENCY_CONFIG: Partial<LiveReleasePolicyConfig> = {
  maxLatency: 5000,
  jitterDelay: 200,
  estimatedGopDuration: 5000,
  deadlineExtension: 1000,
  allowPartialGroupDecode: true,
  skipOnlyToKeyframe: true,
  skipToLatestGroup: false,
  skipGraceFrames: 10,
};

// ============================================================================
// Interactive Call Tests
// ============================================================================

describe('Interactive Calls (150-300ms latency)', () => {
  const FRAME_INTERVAL = 33;
  const FRAMES_PER_GOP = 30;

  describe('Good Network Conditions', () => {
    it('should deliver frames with minimal latency when network is stable', async () => {
      const noSkipConfig: Partial<LiveReleasePolicyConfig> = {
        ...INTERACTIVE_CONFIG,
        skipToLatestGroup: false,
      };

      const arrivals: FrameArrival[] = [
        ...generateGOP(0, 10, 0, FRAME_INTERVAL, 0),
      ];

      const result = await simulateScenario(noSkipConfig, arrivals, 800);

      expect(result.framesOutput).toBeGreaterThan(0);
      expect(result.groupsSkipped).toBe(0);
    });

    it('should maintain frame order within GOP', async () => {
      const arrivals = generateGOP(0, 10, 0, FRAME_INTERVAL, 0);

      const result = await simulateScenario(INTERACTIVE_CONFIG, arrivals, 500);

      for (let i = 0; i < result.outputOrder.length - 1; i++) {
        const current = parseInt(result.outputOrder[i].split('-o')[1]);
        const next = parseInt(result.outputOrder[i + 1].split('-o')[1]);
        expect(next).toBeGreaterThan(current);
      }
    });
  });

  describe('Bad Network Conditions', () => {
    it('should handle high jitter (50ms+)', async () => {
      const noSkipConfig: Partial<LiveReleasePolicyConfig> = {
        ...INTERACTIVE_CONFIG,
        skipToLatestGroup: false,
      };
      const arrivals = generateGOP(0, 10, 0, FRAME_INTERVAL, 40);

      const result = await simulateScenario(noSkipConfig, arrivals, 1200);

      expect(result.framesOutput).toBeGreaterThanOrEqual(1);
    });

    it('should handle frame reordering', async () => {
      const noSkipConfig: Partial<LiveReleasePolicyConfig> = {
        ...INTERACTIVE_CONFIG,
        skipToLatestGroup: false,
      };
      let arrivals = generateGOP(0, 10, 0, FRAME_INTERVAL, 0);
      arrivals = reorderFrames(arrivals, 0.3);

      const result = await simulateScenario(noSkipConfig, arrivals, 800);

      expect(result.outputOrder[0]).toBe('g0-o0');
      expect(result.framesOutput).toBeGreaterThan(0);
    });

    it('should skip to new GOP when current GOP is too delayed', async () => {
      const skipConfig: Partial<LiveReleasePolicyConfig> = {
        ...INTERACTIVE_CONFIG,
        skipToLatestGroup: true,
        skipGraceFrames: 3,
      };

      const arrivals: FrameArrival[] = [
        { groupId: 0, objectId: 0, isKeyframe: true, arrivalDelay: 0 },
        { groupId: 1, objectId: 0, isKeyframe: true, arrivalDelay: 50 },
        { groupId: 1, objectId: 1, isKeyframe: false, arrivalDelay: 83 },
        { groupId: 1, objectId: 2, isKeyframe: false, arrivalDelay: 116 },
        { groupId: 1, objectId: 3, isKeyframe: false, arrivalDelay: 149 },
      ];

      const result = await simulateScenario(skipConfig, arrivals, 500);

      expect(result.outputOrder.some(f => f.startsWith('g1'))).toBe(true);
    });

    it('should handle packet loss (10% drop rate)', async () => {
      let arrivals = generateGOP(0, FRAMES_PER_GOP, 0, FRAME_INTERVAL, 10);
      arrivals = dropFrames(arrivals, 0.1, true);

      const result = await simulateScenario(INTERACTIVE_CONFIG, arrivals, 2000);

      expect(result.framesOutput).toBeGreaterThan(0);
      expect(result.outputOrder[0]).toBe('g0-o0');
    });
  });

  describe('Variable Network Conditions (Good → Bad → Good)', () => {
    it('should recover from temporary network degradation', async () => {
      const arrivals: FrameArrival[] = [
        ...generateGOP(0, 10, 0, FRAME_INTERVAL, 5),
        ...dropFrames(
          reorderFrames(generateGOP(1, 10, 500, FRAME_INTERVAL, 100), 0.4),
          0.2,
          true,
        ),
        ...generateGOP(2, 10, 1200, FRAME_INTERVAL, 5),
      ];

      const result = await simulateScenario(INTERACTIVE_CONFIG, arrivals, 2000);

      expect(result.groupsCompleted).toBeGreaterThanOrEqual(1);
      expect(result.framesOutput).toBeGreaterThan(5);
    });

    it('should handle burst packet loss followed by recovery', async () => {
      const arrivals: FrameArrival[] = [
        ...generateGOP(0, 5, 0, FRAME_INTERVAL, 5),
        { groupId: 1, objectId: 0, isKeyframe: true, arrivalDelay: 200 },
        { groupId: 1, objectId: 1, isKeyframe: false, arrivalDelay: 233 },
        { groupId: 1, objectId: 2, isKeyframe: false, arrivalDelay: 266 },
        ...generateGOP(1, 10, 300, FRAME_INTERVAL, 5).slice(3),
      ];

      const result = await simulateScenario(INTERACTIVE_CONFIG, arrivals, 1000);

      expect(result.framesOutput).toBeGreaterThan(1);
    });
  });
});

// ============================================================================
// Live Streaming Tests
// ============================================================================

describe('Live Streaming (500ms - 2s latency)', () => {
  const FRAME_INTERVAL = 33;
  const FRAMES_PER_GOP = 30;

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
      const arrivals = generateGOP(0, 15, 0, FRAME_INTERVAL, 50);

      const result = await simulateScenario(LIVE_STREAM_CONFIG, arrivals, 1500);

      expect(result.groupsSkipped).toBe(0);
      expect(result.framesOutput).toBeGreaterThan(0);
    });
  });

  describe('Bad Network Conditions', () => {
    it('should handle significant reordering with larger buffer', async () => {
      let arrivals = generateGOP(0, 30, 0, FRAME_INTERVAL, 0);
      arrivals = reorderFrames(arrivals, 0.5);

      const result = await simulateScenario(LIVE_STREAM_CONFIG, arrivals, 2000);

      expect(result.outputOrder[0]).toBe('g0-o0');
      expect(result.framesOutput).toBeGreaterThan(20);
    });

    it('should handle extended network outage then recovery', async () => {
      const arrivals: FrameArrival[] = [
        ...generateGOP(0, 10, 0, FRAME_INTERVAL, 10),
        ...generateGOP(1, 30, 2500, FRAME_INTERVAL, 10),
      ];

      const result = await simulateScenario(LIVE_STREAM_CONFIG, arrivals, 4000);

      expect(result.framesOutput).toBeGreaterThan(30);
    });

    it('should handle 20% packet loss', async () => {
      let arrivals = generateGOP(0, FRAMES_PER_GOP, 0, FRAME_INTERVAL, 30);
      arrivals = dropFrames(arrivals, 0.2, true);

      const result = await simulateScenario(LIVE_STREAM_CONFIG, arrivals, 3000);

      expect(result.framesOutput).toBeGreaterThan(0);
    });
  });

  describe('Variable Network Conditions', () => {
    it('should handle bandwidth fluctuation pattern', async () => {
      const arrivals: FrameArrival[] = [
        ...generateGOP(0, 20, 0, FRAME_INTERVAL, 10),
        ...generateGOP(1, 20, 800, FRAME_INTERVAL * 1.5, 50),
        ...generateGOP(2, 20, 1800, FRAME_INTERVAL, 10),
      ];

      const result = await simulateScenario(LIVE_STREAM_CONFIG, arrivals, 3500);

      expect(result.framesOutput).toBeGreaterThan(40);
      expect(result.groupsCompleted).toBeGreaterThanOrEqual(1);
    });
  });
});

// ============================================================================
// High Latency Tests
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
      const arrivals = generateGOP(0, 15, 0, FRAME_INTERVAL, 300);

      const result = await simulateScenario(HIGH_LATENCY_CONFIG, arrivals, 3000);

      expect(result.framesOutput).toBeGreaterThan(5);
    });

    it('should handle severe reordering', async () => {
      let arrivals = generateGOP(0, 20, 0, FRAME_INTERVAL, 0);
      arrivals = reorderFrames(arrivals, 0.7);
      arrivals = arrivals.map(a => ({
        ...a,
        arrivalDelay: a.arrivalDelay + Math.random() * 200,
      }));

      const result = await simulateScenario(HIGH_LATENCY_CONFIG, arrivals, 3000);

      expect(result.framesOutput).toBeGreaterThan(0);
    });

    it('should handle 30% packet loss', async () => {
      let arrivals = generateGOP(0, 50, 0, FRAME_INTERVAL, 50);
      arrivals = dropFrames(arrivals, 0.3, true);

      const result = await simulateScenario(HIGH_LATENCY_CONFIG, arrivals, 4000);

      expect(result.framesOutput).toBeGreaterThan(0);
    });
  });

  describe('Variable Network Conditions', () => {
    it('should handle satellite link variability', async () => {
      const arrivals: FrameArrival[] = [];
      for (let g = 0; g < 2; g++) {
        const baseDelay = g * 1000;
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
    const skipConfig: Partial<LiveReleasePolicyConfig> = {
      ...INTERACTIVE_CONFIG,
      skipToLatestGroup: true,
      skipGraceFrames: 3,
    };

    const arrivals: FrameArrival[] = [
      { groupId: 0, objectId: 0, isKeyframe: true, arrivalDelay: 0 },
      { groupId: 1, objectId: 0, isKeyframe: true, arrivalDelay: 50 },
      { groupId: 1, objectId: 1, isKeyframe: false, arrivalDelay: 83 },
      { groupId: 1, objectId: 2, isKeyframe: false, arrivalDelay: 116 },
      { groupId: 1, objectId: 3, isKeyframe: false, arrivalDelay: 149 },
    ];

    const result = await simulateScenario(skipConfig, arrivals, 500);

    expect(result.outputOrder.some(f => f.startsWith('g1'))).toBe(true);
  });

  it('should handle interleaved GOP delivery (multiple streams)', async () => {
    const arrivals: FrameArrival[] = [
      { groupId: 100, objectId: 0, isKeyframe: true, arrivalDelay: 0 },
      { groupId: 200, objectId: 0, isKeyframe: true, arrivalDelay: 10 },
      { groupId: 100, objectId: 1, isKeyframe: false, arrivalDelay: 20 },
      { groupId: 200, objectId: 1, isKeyframe: false, arrivalDelay: 30 },
      { groupId: 100, objectId: 2, isKeyframe: false, arrivalDelay: 40 },
      { groupId: 200, objectId: 2, isKeyframe: false, arrivalDelay: 50 },
    ];

    const result = await simulateScenario(LIVE_STREAM_CONFIG, arrivals, 500);

    expect(result.outputOrder[0]).toBe('g100-o0');
  });

  it('should handle rapid GOP switching (scene change)', async () => {
    const noSkipConfig: Partial<LiveReleasePolicyConfig> = {
      ...INTERACTIVE_CONFIG,
      skipToLatestGroup: false,
    };

    const arrivals: FrameArrival[] = [
      ...generateGOP(0, 5, 0, 33, 5),
      ...generateGOP(1, 5, 200, 33, 5),
    ];

    const result = await simulateScenario(noSkipConfig, arrivals, 700);

    expect(result.framesOutput).toBeGreaterThanOrEqual(2);
  });

  it('should handle keyframe loss with subsequent recovery', async () => {
    const arrivals: FrameArrival[] = [
      { groupId: 0, objectId: 1, isKeyframe: false, arrivalDelay: 33 },
      { groupId: 0, objectId: 2, isKeyframe: false, arrivalDelay: 66 },
      ...generateGOP(1, 10, 200, 33, 5),
    ];

    const result = await simulateScenario(INTERACTIVE_CONFIG, arrivals, 1000);

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
      1500,
    );

    expect(result.framesOutput).toBeGreaterThan(50);
  });

  it('should handle multiple concurrent GOPs (4 groups)', async () => {
    const arrivals: FrameArrival[] = [];
    for (let g = 0; g < 4; g++) {
      arrivals.push(...generateGOP(g, 20, g * 200, 33, 30));
    }

    const result = await simulateScenario(
      { ...LIVE_STREAM_CONFIG, maxActiveGroups: 4 },
      arrivals,
      2000,
    );

    expect(result.framesOutput).toBeGreaterThan(60);
  });

  it('should handle burst arrival pattern', async () => {
    const arrivals: FrameArrival[] = [];
    for (let i = 0; i < 30; i++) {
      arrivals.push({
        groupId: 0,
        objectId: i,
        isKeyframe: i === 0,
        arrivalDelay: i * 2,
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
    const config: Partial<LiveReleasePolicyConfig> = {
      ...INTERACTIVE_CONFIG,
      skipToLatestGroup: true,
      skipGraceFrames: 2,
    };

    const arrivals: FrameArrival[] = [
      { groupId: 0, objectId: 0, isKeyframe: true, arrivalDelay: 0 },
      { groupId: 1, objectId: 0, isKeyframe: true, arrivalDelay: 50 },
      { groupId: 1, objectId: 1, isKeyframe: false, arrivalDelay: 83 },
      { groupId: 1, objectId: 2, isKeyframe: false, arrivalDelay: 116 },
    ];

    const result = await simulateScenario(config, arrivals, 400);

    expect(result.outputOrder.some(f => f.startsWith('g1'))).toBe(true);
  });

  it('should wait for grace frames before skipping', async () => {
    const config: Partial<LiveReleasePolicyConfig> = {
      ...INTERACTIVE_CONFIG,
      skipToLatestGroup: true,
      skipGraceFrames: 3,
    };

    const arrivals: FrameArrival[] = [
      { groupId: 0, objectId: 0, isKeyframe: true, arrivalDelay: 0 },
      { groupId: 1, objectId: 0, isKeyframe: true, arrivalDelay: 50 },
      { groupId: 1, objectId: 1, isKeyframe: false, arrivalDelay: 60 },
      { groupId: 1, objectId: 2, isKeyframe: false, arrivalDelay: 70 },
      { groupId: 1, objectId: 3, isKeyframe: false, arrivalDelay: 80 },
    ];

    const result = await simulateScenario(config, arrivals, 300);

    expect(result.outputOrder.some(f => f.startsWith('g1'))).toBe(true);
  });

  it('should not skip when skipToLatestGroup is disabled', async () => {
    const config: Partial<LiveReleasePolicyConfig> = {
      ...LIVE_STREAM_CONFIG,
      skipToLatestGroup: false,
    };

    const arrivals: FrameArrival[] = [
      ...generateGOP(0, 10, 0, 33, 5),
      ...generateGOP(1, 10, 200, 33, 5),
    ];

    const result = await simulateScenario(config, arrivals, 800);

    expect(result.groupsCompleted).toBeGreaterThanOrEqual(1);
  });
});
