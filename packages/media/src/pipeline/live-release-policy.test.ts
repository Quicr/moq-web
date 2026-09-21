// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Behavioral parity tests for LiveReleasePolicy.
 *
 * Ported from group-arbiter.test.ts (deleted alongside GroupArbiter). The
 * PlayoutBuffer + LiveReleasePolicy pair must exhibit the same behavior
 * the arbiter previously provided, driven exclusively through the public
 * PlayoutBuffer API.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { PlayoutBuffer } from './playout-buffer';
import type { PlayoutBufferConfig } from './playout-buffer';
import { LiveReleasePolicy } from './live-release-policy';
import type { LiveReleasePolicyConfig } from './live-release-policy';
import { MonotonicTickProvider } from './tick-provider';

function makeBuffer<T = string>(
  policyConfig: Partial<LiveReleasePolicyConfig> = {},
  ticker: MonotonicTickProvider = new MonotonicTickProvider(),
  bufferConfig: Partial<PlayoutBufferConfig> = {},
): { buffer: PlayoutBuffer<T>; policy: LiveReleasePolicy<T>; ticker: MonotonicTickProvider } {
  const policy = new LiveReleasePolicy<T>(policyConfig, ticker);
  const buffer = new PlayoutBuffer<T>(policy, bufferConfig);
  return { buffer, policy, ticker };
}

describe('LiveReleasePolicy', () => {
  let buffer: PlayoutBuffer<string>;
  let policy: LiveReleasePolicy<string>;
  let ticker: MonotonicTickProvider;

  beforeEach(() => {
    ticker = new MonotonicTickProvider();
    ({ buffer, policy } = makeBuffer<string>(
      {
        maxLatency: 500,
        jitterDelay: 0,
        estimatedGopDuration: 100,
        deadlineExtension: 50,
        maxActiveGroups: 4,
        enableCatchUp: false,
      },
      ticker,
    ));
  });

  describe('addFrame', () => {
    it('should accept first frame and create group', () => {
      const accepted = buffer.addFrame({
        groupId: 0,
        objectId: 0,
        data: 'frame-0-0',
        isKeyframe: true,
      });

      expect(accepted).toBe(true);
      expect(buffer.getGroup(0)).toBeDefined();
      expect(buffer.getActiveGroupId()).toBe(0);
    });

    it('should accept multiple frames in same group', () => {
      buffer.addFrame({ groupId: 0, objectId: 0, data: 'kf', isKeyframe: true });
      buffer.addFrame({ groupId: 0, objectId: 1, data: 'p1', isKeyframe: false });
      buffer.addFrame({ groupId: 0, objectId: 2, data: 'p2', isKeyframe: false });

      const group = buffer.getGroup(0);
      expect(group?.frameCount).toBe(3);
      expect(group?.highestObjectId).toBe(2);
    });

    it('should accept frames from multiple groups', () => {
      buffer.addFrame({ groupId: 0, objectId: 0, data: 'g0', isKeyframe: true });
      buffer.addFrame({ groupId: 1, objectId: 0, data: 'g1', isKeyframe: true });
      buffer.addFrame({ groupId: 2, objectId: 0, data: 'g2', isKeyframe: true });

      expect(buffer.getGroupCount()).toBe(3);
    });

    it('should reject frames from completed groups', () => {
      buffer.addFrame({ groupId: 0, objectId: 0, data: 'g0', isKeyframe: true });

      ticker.tickBy(20);
      buffer.getReadyFrames();
      buffer.markGroupComplete(0);

      const accepted = buffer.addFrame({
        groupId: 0,
        objectId: 1,
        data: 'g0-late',
        isKeyframe: false,
      });

      expect(accepted).toBe(false);
      expect(buffer.getStats().framesDropped).toBe(1);
    });

    it('should handle gaps in groupId', () => {
      buffer.addFrame({ groupId: 0, objectId: 0, data: 'g0', isKeyframe: true });
      buffer.addFrame({ groupId: 5, objectId: 0, data: 'g5', isKeyframe: true });
      buffer.addFrame({ groupId: 10, objectId: 0, data: 'g10', isKeyframe: true });

      expect(buffer.getGroupCount()).toBe(3);
      expect(buffer.getGroup(5)).toBeDefined();
    });

    it('should track keyframe presence', () => {
      buffer.addFrame({ groupId: 0, objectId: 1, data: 'p', isKeyframe: false });
      expect(buffer.getGroup(0)?.hasKeyframe).toBe(false);

      buffer.addFrame({ groupId: 0, objectId: 0, data: 'kf', isKeyframe: true });
      expect(buffer.getGroup(0)?.hasKeyframe).toBe(true);
    });

    it('should carry LOC timestamp on stored frames', () => {
      buffer.addFrame({
        groupId: 0,
        objectId: 0,
        data: 'kf',
        isKeyframe: true,
        locTimestamp: 1234567890,
        locTimescale: 90000,
      });

      const frame = buffer.getGroup(0)?.frames.get(0);
      expect(frame?.locTimestamp).toBe(1234567890);
      expect(frame?.locTimescale).toBe(90000);
    });
  });

  describe('getReadyFrames', () => {
    it('should return frames in objectId order', () => {
      buffer.addFrame({ groupId: 0, objectId: 2, data: 'p2', isKeyframe: false });
      buffer.addFrame({ groupId: 0, objectId: 0, data: 'kf', isKeyframe: true });
      buffer.addFrame({ groupId: 0, objectId: 1, data: 'p1', isKeyframe: false });

      ticker.tickBy(20);

      const frames = buffer.getReadyFrames();

      expect(frames.length).toBe(3);
      expect(frames[0].objectId).toBe(0);
      expect(frames[1].objectId).toBe(1);
      expect(frames[2].objectId).toBe(2);
    });

    it('should respect jitter delay', async () => {
      const jitter = makeBuffer<string>({
        maxLatency: 500,
        jitterDelay: 30,
        estimatedGopDuration: 100,
      });

      jitter.buffer.addFrame({ groupId: 0, objectId: 0, data: 'kf', isKeyframe: true });

      let frames = jitter.buffer.getReadyFrames();
      expect(frames.length).toBe(0);

      await new Promise(resolve => setTimeout(resolve, 40));

      frames = jitter.buffer.getReadyFrames();
      expect(frames.length).toBe(1);
    });

    it('should wait for missing frames within deadline', () => {
      buffer.addFrame({ groupId: 0, objectId: 0, data: 'kf', isKeyframe: true });
      // Skip objectId 1
      buffer.addFrame({ groupId: 0, objectId: 2, data: 'p2', isKeyframe: false });

      ticker.tickBy(20);
      const frames = buffer.getReadyFrames();

      expect(frames.length).toBe(1);
      expect(frames[0].objectId).toBe(0);
    });

    it('should complete group when END_OF_GROUP received', () => {
      buffer.addFrame({ groupId: 0, objectId: 0, data: 'kf', isKeyframe: true });
      buffer.addFrame({ groupId: 0, objectId: 1, data: 'p1', isKeyframe: false });

      ticker.tickBy(20);
      buffer.getReadyFrames();
      buffer.markGroupComplete(0);

      expect(buffer.getGroup(0)?.status).toBe('complete');
      expect(buffer.getStats().groupsCompleted).toBe(1);
    });

    it('should limit frames per call', () => {
      for (let i = 0; i < 10; i++) {
        buffer.addFrame({
          groupId: 0,
          objectId: i,
          data: `f${i}`,
          isKeyframe: i === 0,
        });
      }

      ticker.tickBy(20);
      const frames = buffer.getReadyFrames(3);

      expect(frames.length).toBe(3);
    });
  });

  describe('group ordering', () => {
    it('should process groups in groupId order', () => {
      buffer.addFrame({ groupId: 2, objectId: 0, data: 'g2', isKeyframe: true });
      buffer.addFrame({ groupId: 0, objectId: 0, data: 'g0', isKeyframe: true });
      buffer.addFrame({ groupId: 1, objectId: 0, data: 'g1', isKeyframe: true });

      ticker.tickBy(20);

      let frames = buffer.getReadyFrames();
      expect(frames[0].data).toBe('g0');

      frames = buffer.getReadyFrames();
      expect(frames[0].data).toBe('g1');

      frames = buffer.getReadyFrames();
      expect(frames[0].data).toBe('g2');
    });

    it('should handle interleaved frame arrivals', () => {
      buffer.addFrame({ groupId: 0, objectId: 0, data: 'g0-kf', isKeyframe: true });
      buffer.addFrame({ groupId: 1, objectId: 0, data: 'g1-kf', isKeyframe: true });
      buffer.addFrame({ groupId: 0, objectId: 1, data: 'g0-p1', isKeyframe: false });
      buffer.addFrame({ groupId: 1, objectId: 1, data: 'g1-p1', isKeyframe: false });
      buffer.addFrame({ groupId: 0, objectId: 2, data: 'g0-p2', isKeyframe: false });

      ticker.tickBy(20);

      const g0Frames = buffer.getReadyFrames(10);
      expect(g0Frames.length).toBe(3);
      expect(g0Frames.every((f) => f.data.startsWith('g0'))).toBe(true);

      const g1Frames = buffer.getReadyFrames(10);
      expect(g1Frames.length).toBe(2);
      expect(g1Frames.every((f) => f.data.startsWith('g1'))).toBe(true);
    });
  });

  describe('deadline handling', () => {
    const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

    it('should skip to next keyframe group when deadline expires', async () => {
      const { buffer: b, policy: p } = makeBuffer<string>({
        maxLatency: 20,
        jitterDelay: 0,
        estimatedGopDuration: 20,
        deadlineExtension: 5,
      });

      b.addFrame({ groupId: 0, objectId: 1, data: 'g0-p', isKeyframe: false });
      b.addFrame({ groupId: 1, objectId: 0, data: 'g1-kf', isKeyframe: true });

      await sleep(50);

      const frames = b.getReadyFrames();

      expect(frames[0].data).toBe('g1-kf');
      expect(b.getActiveGroupId()).toBe(1);
      expect(p.getStats().groupsSkipped).toBeGreaterThanOrEqual(1);
    });

    it('should extend deadline for partial group with keyframe', async () => {
      const { buffer: b, policy: p } = makeBuffer<string>({
        maxLatency: 20,
        jitterDelay: 0,
        estimatedGopDuration: 20,
        deadlineExtension: 100,
        allowPartialGroupDecode: true,
      });

      b.addFrame({ groupId: 0, objectId: 0, data: 'g0-kf', isKeyframe: true });
      b.addFrame({ groupId: 0, objectId: 2, data: 'g0-p2', isKeyframe: false });

      const kfFrames = b.getReadyFrames();
      expect(kfFrames.length).toBe(1);
      expect(kfFrames[0].data).toBe('g0-kf');

      await sleep(50);

      b.getReadyFrames();

      const stats = p.getStats();
      expect(stats.deadlinesExtended as number).toBeGreaterThan(0);
    });
  });

  describe('statistics', () => {
    it('should track frame counts', () => {
      buffer.addFrame({ groupId: 0, objectId: 0, data: 'kf', isKeyframe: true });
      buffer.addFrame({ groupId: 0, objectId: 1, data: 'p1', isKeyframe: false });

      expect(buffer.getStats().framesReceived).toBe(2);

      ticker.tickBy(20);
      buffer.getReadyFrames();

      expect(buffer.getStats().framesOutput).toBe(2);
    });

    it('should track dropped late frames', () => {
      buffer.addFrame({ groupId: 0, objectId: 0, data: 'g0', isKeyframe: true });
      ticker.tickBy(20);
      buffer.getReadyFrames();
      buffer.markGroupComplete(0);

      buffer.addFrame({ groupId: 0, objectId: 1, data: 'g0-late', isKeyframe: false });

      expect(buffer.getStats().framesDropped).toBe(1);
    });

    it('should track latency stats', () => {
      buffer.addFrame({ groupId: 0, objectId: 0, data: 'kf', isKeyframe: true });

      ticker.tickBy(30);
      buffer.getReadyFrames();

      const stats = policy.getStats();
      expect(stats.avgOutputLatency as number).toBeGreaterThan(0);
    });
  });

  describe('reset', () => {
    it('should clear all state', () => {
      buffer.addFrame({ groupId: 0, objectId: 0, data: 'kf', isKeyframe: true });
      buffer.addFrame({ groupId: 1, objectId: 0, data: 'kf', isKeyframe: true });

      buffer.reset();

      expect(buffer.getGroupCount()).toBe(0);
      expect(buffer.getActiveGroupId()).toBe(-1);
      expect(buffer.getStats().framesReceived).toBe(0);
    });
  });
});

describe('LiveReleasePolicy - root cause scenario', () => {
  it('should handle interleaved groups without decode errors', () => {
    const ticker = new MonotonicTickProvider();
    const { buffer } = makeBuffer<{ type: string; obj: number }>(
      {
        maxLatency: 500,
        jitterDelay: 0,
        estimatedGopDuration: 1000,
      },
      ticker,
    );

    const oldGroup = 1471666578;
    const newGroup = 1471666579;

    buffer.addFrame({
      groupId: newGroup,
      objectId: 0,
      data: { type: 'keyframe', obj: 0 },
      isKeyframe: true,
    });

    ticker.tickBy(5);
    for (let obj = 56; obj <= 60; obj++) {
      buffer.addFrame({
        groupId: oldGroup,
        objectId: obj,
        data: { type: 'p-frame', obj },
        isKeyframe: false,
      });
      ticker.tickBy(2);
    }

    ticker.tickBy(60);
    buffer.addFrame({
      groupId: newGroup,
      objectId: 1,
      data: { type: 'p-frame', obj: 1 },
      isKeyframe: false,
    });

    const frames = buffer.getReadyFrames(10);

    const newGroupFrames = frames.filter(
      (f) => f.data.type === 'keyframe' || f.data.obj === 1,
    );

    if (newGroupFrames.length > 1) {
      expect(newGroupFrames[0].data.type).toBe('keyframe');
    }
  });

  it('should ensure keyframe always precedes P-frames in output', () => {
    const ticker = new MonotonicTickProvider();
    const { buffer } = makeBuffer<string>(
      {
        maxLatency: 500,
        jitterDelay: 0,
        estimatedGopDuration: 100,
      },
      ticker,
    );

    buffer.addFrame({ groupId: 0, objectId: 3, data: 'p3', isKeyframe: false });
    buffer.addFrame({ groupId: 0, objectId: 2, data: 'p2', isKeyframe: false });
    buffer.addFrame({ groupId: 0, objectId: 1, data: 'p1', isKeyframe: false });

    ticker.tickBy(10);

    let frames = buffer.getReadyFrames();
    expect(frames.length).toBe(0);

    buffer.addFrame({ groupId: 0, objectId: 0, data: 'kf', isKeyframe: true });
    ticker.tickBy(10);

    frames = buffer.getReadyFrames(10);
    expect(frames.length).toBe(4);
    expect(frames[0].data).toBe('kf');
    expect(frames[0].isKeyframe).toBe(true);
  });
});

describe('LiveReleasePolicy edge cases', () => {
  it('should handle very short GOP (< 100ms)', () => {
    const ticker = new MonotonicTickProvider();
    const { buffer } = makeBuffer<string>(
      {
        maxLatency: 200,
        jitterDelay: 0,
        estimatedGopDuration: 50,
      },
      ticker,
    );

    for (let g = 0; g < 5; g++) {
      buffer.addFrame({ groupId: g, objectId: 0, data: `g${g}-kf`, isKeyframe: true });
      buffer.addFrame({ groupId: g, objectId: 1, data: `g${g}-p1`, isKeyframe: false });
      ticker.tickBy(10);
    }

    ticker.tickBy(20);
    const frames = buffer.getReadyFrames(20);

    expect(frames.length).toBeGreaterThan(0);
    expect(frames[0].data).toBe('g0-kf');
  });

  it('should handle very long GOP (10+ seconds)', () => {
    const ticker = new MonotonicTickProvider();
    const { buffer } = makeBuffer<string>(
      {
        maxLatency: 2000,
        jitterDelay: 0,
        estimatedGopDuration: 10000,
        maxFramesPerGroup: 300,
      },
      ticker,
      { maxFramesPerGroup: 300 },
    );

    for (let o = 0; o < 100; o++) {
      buffer.addFrame({
        groupId: 0,
        objectId: o,
        data: `f${o}`,
        isKeyframe: o === 0,
      });
    }

    const frames = buffer.getReadyFrames(50);

    expect(frames.length).toBeGreaterThan(0);
    expect(frames[0].isKeyframe).toBe(true);
  });

  it('should handle rapid group ID jumps', () => {
    const ticker = new MonotonicTickProvider();
    const { buffer } = makeBuffer<string>(
      {
        maxLatency: 500,
        jitterDelay: 0,
        estimatedGopDuration: 1000,
      },
      ticker,
    );

    buffer.addFrame({ groupId: 100, objectId: 0, data: 'g100', isKeyframe: true });
    buffer.addFrame({ groupId: 200, objectId: 0, data: 'g200', isKeyframe: true });
    buffer.addFrame({ groupId: 500, objectId: 0, data: 'g500', isKeyframe: true });

    let frames = buffer.getReadyFrames();
    expect(frames[0].data).toBe('g100');

    buffer.getGroup(100)!.status = 'complete';

    frames = buffer.getReadyFrames();
    expect(frames[0].data).toBe('g200');

    buffer.getGroup(200)!.status = 'complete';

    frames = buffer.getReadyFrames();
    expect(frames[0].data).toBe('g500');
  });

  it('should handle large groupId values (real-world scenario)', () => {
    const ticker = new MonotonicTickProvider();
    const { buffer } = makeBuffer<string>(
      {
        maxLatency: 500,
        jitterDelay: 0,
        estimatedGopDuration: 1000,
      },
      ticker,
    );

    const baseGroupId = 1471666578;
    buffer.addFrame({ groupId: baseGroupId, objectId: 0, data: 'g0-kf', isKeyframe: true });
    buffer.addFrame({ groupId: baseGroupId, objectId: 1, data: 'g0-p1', isKeyframe: false });
    buffer.addFrame({ groupId: baseGroupId + 1, objectId: 0, data: 'g1-kf', isKeyframe: true });

    const frames = buffer.getReadyFrames(10);

    expect(frames.length).toBeGreaterThan(0);
    expect(frames[0].data).toBe('g0-kf');
    expect(buffer.getGroup(baseGroupId)).toBeDefined();
    expect(buffer.getGroup(baseGroupId + 1)).toBeDefined();
  });

  it('should handle NewGroupRequest mid-stream (new keyframe in new group)', () => {
    const ticker = new MonotonicTickProvider();
    const { buffer } = makeBuffer<string>(
      {
        maxLatency: 500,
        jitterDelay: 0,
        estimatedGopDuration: 1000,
      },
      ticker,
    );

    buffer.addFrame({ groupId: 0, objectId: 0, data: 'g0-kf', isKeyframe: true });
    buffer.addFrame({ groupId: 0, objectId: 1, data: 'g0-p1', isKeyframe: false });
    buffer.addFrame({ groupId: 0, objectId: 2, data: 'g0-p2', isKeyframe: false });

    buffer.addFrame({ groupId: 1, objectId: 0, data: 'g1-kf', isKeyframe: true });

    buffer.addFrame({ groupId: 0, objectId: 3, data: 'g0-p3', isKeyframe: false });
    buffer.addFrame({ groupId: 0, objectId: 4, data: 'g0-p4', isKeyframe: false });

    const frames = buffer.getReadyFrames(10);
    expect(frames.every(f => f.data.startsWith('g0'))).toBe(true);
  });

  it('should honor maxFramesPerGroup on the buffer', () => {
    const ticker = new MonotonicTickProvider();
    const { buffer } = makeBuffer<string>(
      {
        maxLatency: 500,
        jitterDelay: 0,
      },
      ticker,
      { maxFramesPerGroup: 5 },
    );

    for (let o = 0; o < 10; o++) {
      buffer.addFrame({
        groupId: 0,
        objectId: o,
        data: `f${o}`,
        isKeyframe: o === 0,
      });
    }

    expect(buffer.getGroup(0)?.frameCount).toBe(5);
    expect(buffer.getStats().framesDropped).toBe(5);
  });
});

describe('LiveReleasePolicy benchmark', () => {
  it('addFrame should be fast', () => {
    const ticker = new MonotonicTickProvider();
    const { buffer } = makeBuffer<number>({}, ticker);
    const ITERATIONS = 10000;

    const start = performance.now();
    for (let i = 0; i < ITERATIONS; i++) {
      buffer.addFrame({
        groupId: Math.floor(i / 30),
        objectId: i % 30,
        data: i,
        isKeyframe: i % 30 === 0,
      });
    }
    const elapsed = performance.now() - start;
    const opsPerMs = ITERATIONS / elapsed;

    console.log(
      `PlayoutBuffer.addFrame (live): ${ITERATIONS} calls in ${elapsed.toFixed(2)}ms ` +
        `(${opsPerMs.toFixed(0)} ops/ms)`,
    );

    expect(opsPerMs).toBeGreaterThan(100);
  });

  it('getReadyFrames should be fast', () => {
    const ticker = new MonotonicTickProvider();
    const { buffer } = makeBuffer<number>({ jitterDelay: 0 }, ticker);

    for (let g = 0; g < 10; g++) {
      for (let o = 0; o < 30; o++) {
        buffer.addFrame({
          groupId: g,
          objectId: o,
          data: g * 30 + o,
          isKeyframe: o === 0,
        });
      }
    }

    ticker.tickBy(100);

    const ITERATIONS = 1000;
    const start = performance.now();
    for (let i = 0; i < ITERATIONS; i++) {
      buffer.getReadyFrames(5);
    }
    const elapsed = performance.now() - start;
    const opsPerMs = ITERATIONS / elapsed;

    console.log(
      `PlayoutBuffer.getReadyFrames (live): ${ITERATIONS} calls in ${elapsed.toFixed(2)}ms ` +
        `(${opsPerMs.toFixed(0)} ops/ms)`,
    );

    expect(opsPerMs).toBeGreaterThan(30);
  });
});

describe('LiveReleasePolicy catch-up mode', () => {
  it('should trigger catch-up when buffer exceeds threshold', () => {
    const ticker = new MonotonicTickProvider();
    const { buffer, policy } = makeBuffer<string>(
      {
        jitterDelay: 0,
        enableCatchUp: true,
        catchUpThreshold: 5,
        maxCatchUpFrames: 30,
      },
      ticker,
    );

    for (let i = 0; i < 10; i++) {
      buffer.addFrame({
        groupId: 0,
        objectId: i,
        data: `f${i}`,
        isKeyframe: i === 0,
      });
    }

    const frames = buffer.getReadyFrames(3);

    expect(frames.length).toBe(10);

    for (let i = 0; i < frames.length - 1; i++) {
      expect(frames[i].shouldRender).toBe(false);
    }
    expect(frames[frames.length - 1].shouldRender).toBe(true);

    const stats = policy.getStats();
    expect(stats.catchUpEvents as number).toBe(1);
    expect(stats.framesFlushed as number).toBe(9);
  });

  it('should not trigger catch-up when disabled', () => {
    const ticker = new MonotonicTickProvider();
    const { buffer, policy } = makeBuffer<string>(
      {
        jitterDelay: 0,
        enableCatchUp: false,
        catchUpThreshold: 5,
      },
      ticker,
    );

    for (let i = 0; i < 10; i++) {
      buffer.addFrame({
        groupId: 0,
        objectId: i,
        data: `f${i}`,
        isKeyframe: i === 0,
      });
    }

    const frames = buffer.getReadyFrames(3);

    expect(frames.length).toBe(3);

    for (const frame of frames) {
      expect(frame.shouldRender).toBe(true);
    }

    const stats = policy.getStats();
    expect(stats.catchUpEvents as number).toBe(0);
    expect(stats.framesFlushed as number).toBe(0);
  });

  it('should not trigger catch-up when below threshold', () => {
    const ticker = new MonotonicTickProvider();
    const { buffer, policy } = makeBuffer<string>(
      {
        jitterDelay: 0,
        enableCatchUp: true,
        catchUpThreshold: 5,
      },
      ticker,
    );

    for (let i = 0; i < 3; i++) {
      buffer.addFrame({
        groupId: 0,
        objectId: i,
        data: `f${i}`,
        isKeyframe: i === 0,
      });
    }

    const frames = buffer.getReadyFrames(10);

    expect(frames.length).toBe(3);

    for (const frame of frames) {
      expect(frame.shouldRender).toBe(true);
    }

    const stats = policy.getStats();
    expect(stats.catchUpEvents as number).toBe(0);
  });

  it('should respect maxCatchUpFrames limit', () => {
    const ticker = new MonotonicTickProvider();
    const { buffer } = makeBuffer<string>(
      {
        jitterDelay: 0,
        enableCatchUp: true,
        catchUpThreshold: 5,
        maxCatchUpFrames: 8,
      },
      ticker,
    );

    for (let i = 0; i < 15; i++) {
      buffer.addFrame({
        groupId: 0,
        objectId: i,
        data: `f${i}`,
        isKeyframe: i === 0,
      });
    }

    const frames = buffer.getReadyFrames(3);

    expect(frames.length).toBe(8);

    expect(frames[7].shouldRender).toBe(true);
    for (let i = 0; i < 7; i++) {
      expect(frames[i].shouldRender).toBe(false);
    }
  });

  it('should mark only last frame for rendering in catch-up', () => {
    const ticker = new MonotonicTickProvider();
    const { buffer } = makeBuffer<string>(
      {
        jitterDelay: 0,
        enableCatchUp: true,
        catchUpThreshold: 3,
      },
      ticker,
    );

    for (let i = 0; i < 6; i++) {
      buffer.addFrame({
        groupId: 0,
        objectId: i,
        data: `f${i}`,
        isKeyframe: i === 0,
      });
    }

    const frames = buffer.getReadyFrames();

    expect(frames[0].data).toBe('f0');
    expect(frames[5].data).toBe('f5');

    expect(frames[0].shouldRender).toBe(false);
    expect(frames[1].shouldRender).toBe(false);
    expect(frames[2].shouldRender).toBe(false);
    expect(frames[3].shouldRender).toBe(false);
    expect(frames[4].shouldRender).toBe(false);
    expect(frames[5].shouldRender).toBe(true);
  });
});
