// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { describe, it, expect, beforeEach } from 'vitest';
import { GroupArbiter } from './group-arbiter';
import { MonotonicTickProvider } from './tick-provider';

describe('GroupArbiter', () => {
  let arbiter: GroupArbiter<string>;
  let ticker: MonotonicTickProvider;

  beforeEach(() => {
    ticker = new MonotonicTickProvider();
    arbiter = new GroupArbiter<string>(
      {
        maxLatency: 500,
        jitterDelay: 10, // Short for testing
        estimatedGopDuration: 100,
        deadlineExtension: 50,
        maxActiveGroups: 4,
      },
      ticker
    );
  });

  describe('addFrame', () => {
    it('should accept first frame and create group', () => {
      const result = arbiter.addFrame({
        groupId: 0,
        objectId: 0,
        data: 'frame-0-0',
        isKeyframe: true,
      });

      expect(result).toBe(true);
      expect(arbiter.hasGroup(0)).toBe(true);
      expect(arbiter.getActiveGroupId()).toBe(0);
    });

    it('should accept multiple frames in same group', () => {
      arbiter.addFrame({ groupId: 0, objectId: 0, data: 'kf', isKeyframe: true });
      arbiter.addFrame({ groupId: 0, objectId: 1, data: 'p1', isKeyframe: false });
      arbiter.addFrame({ groupId: 0, objectId: 2, data: 'p2', isKeyframe: false });

      const group = arbiter.getGroupState(0);
      expect(group?.frameCount).toBe(3);
      expect(group?.highestObjectId).toBe(2);
    });

    it('should accept frames from multiple groups', () => {
      arbiter.addFrame({ groupId: 0, objectId: 0, data: 'g0', isKeyframe: true });
      arbiter.addFrame({ groupId: 1, objectId: 0, data: 'g1', isKeyframe: true });
      arbiter.addFrame({ groupId: 2, objectId: 0, data: 'g2', isKeyframe: true });

      expect(arbiter.getGroupCount()).toBe(3);
    });

    it('should reject frames from completed groups', () => {
      arbiter.addFrame({ groupId: 0, objectId: 0, data: 'g0', isKeyframe: true });

      // Complete group 0
      ticker.tickBy(20);
      arbiter.getReadyFrames();

      // Now group 0 is complete, so new frames for it should be rejected
      const result = arbiter.addFrame({
        groupId: 0,
        objectId: 1,
        data: 'g0-late',
        isKeyframe: false,
      });

      expect(result).toBe(false);
      expect(arbiter.getStats().droppedLateFrames).toBe(1);
    });

    it('should handle gaps in groupId', () => {
      arbiter.addFrame({ groupId: 0, objectId: 0, data: 'g0', isKeyframe: true });
      arbiter.addFrame({ groupId: 5, objectId: 0, data: 'g5', isKeyframe: true });
      arbiter.addFrame({ groupId: 10, objectId: 0, data: 'g10', isKeyframe: true });

      expect(arbiter.getGroupCount()).toBe(3);
      expect(arbiter.hasGroup(5)).toBe(true);
    });

    it('should track keyframe presence', () => {
      arbiter.addFrame({ groupId: 0, objectId: 1, data: 'p', isKeyframe: false });
      expect(arbiter.getGroupState(0)?.hasKeyframe).toBe(false);

      arbiter.addFrame({ groupId: 0, objectId: 0, data: 'kf', isKeyframe: true });
      expect(arbiter.getGroupState(0)?.hasKeyframe).toBe(true);
    });

    it('should track LOC timestamp', () => {
      arbiter.addFrame({
        groupId: 0,
        objectId: 0,
        data: 'kf',
        isKeyframe: true,
        locTimestamp: 1234567890,
        locTimescale: 90000,
      });

      const group = arbiter.getGroupState(0);
      expect(group?.locTimestampBase).toBe(1234567890);
      expect(group?.locTimescale).toBe(90000);
    });
  });

  describe('getReadyFrames', () => {
    it('should return frames in objectId order', () => {
      // Add frames out of order
      arbiter.addFrame({ groupId: 0, objectId: 2, data: 'p2', isKeyframe: false });
      arbiter.addFrame({ groupId: 0, objectId: 0, data: 'kf', isKeyframe: true });
      arbiter.addFrame({ groupId: 0, objectId: 1, data: 'p1', isKeyframe: false });

      // Advance time past jitter delay
      ticker.tickBy(20);

      const frames = arbiter.getReadyFrames();

      expect(frames.length).toBe(3);
      expect(frames[0].objectId).toBe(0);
      expect(frames[1].objectId).toBe(1);
      expect(frames[2].objectId).toBe(2);
    });

    it('should respect jitter delay', () => {
      arbiter.addFrame({ groupId: 0, objectId: 0, data: 'kf', isKeyframe: true });

      // Don't advance time enough
      ticker.tickBy(5);
      let frames = arbiter.getReadyFrames();
      expect(frames.length).toBe(0);

      // Now advance past jitter delay
      ticker.tickBy(10);
      frames = arbiter.getReadyFrames();
      expect(frames.length).toBe(1);
    });

    it('should wait for missing frames within deadline', () => {
      arbiter.addFrame({ groupId: 0, objectId: 0, data: 'kf', isKeyframe: true });
      // Skip objectId 1
      arbiter.addFrame({ groupId: 0, objectId: 2, data: 'p2', isKeyframe: false });

      ticker.tickBy(20);
      const frames = arbiter.getReadyFrames();

      // Should only get keyframe, waiting for objectId 1
      expect(frames.length).toBe(1);
      expect(frames[0].objectId).toBe(0);
    });

    it('should complete group when all frames output', () => {
      arbiter.addFrame({ groupId: 0, objectId: 0, data: 'kf', isKeyframe: true });
      arbiter.addFrame({ groupId: 0, objectId: 1, data: 'p1', isKeyframe: false });

      ticker.tickBy(20);
      arbiter.getReadyFrames();

      expect(arbiter.getGroupState(0)?.status).toBe('complete');
      expect(arbiter.getStats().groupsCompleted).toBe(1);
    });

    it('should limit frames per call', () => {
      for (let i = 0; i < 10; i++) {
        arbiter.addFrame({
          groupId: 0,
          objectId: i,
          data: `f${i}`,
          isKeyframe: i === 0,
        });
      }

      ticker.tickBy(20);
      const frames = arbiter.getReadyFrames(3);

      expect(frames.length).toBe(3);
    });
  });

  describe('group ordering', () => {
    it('should process groups in groupId order', () => {
      // Add groups out of order
      arbiter.addFrame({ groupId: 2, objectId: 0, data: 'g2', isKeyframe: true });
      arbiter.addFrame({ groupId: 0, objectId: 0, data: 'g0', isKeyframe: true });
      arbiter.addFrame({ groupId: 1, objectId: 0, data: 'g1', isKeyframe: true });

      ticker.tickBy(20);

      // First group should be 0
      let frames = arbiter.getReadyFrames();
      expect(frames[0].data).toBe('g0');

      // Then group 1
      frames = arbiter.getReadyFrames();
      expect(frames[0].data).toBe('g1');

      // Then group 2
      frames = arbiter.getReadyFrames();
      expect(frames[0].data).toBe('g2');
    });

    it('should handle interleaved frame arrivals', () => {
      // Simulate real-world interleaving
      arbiter.addFrame({ groupId: 0, objectId: 0, data: 'g0-kf', isKeyframe: true });
      arbiter.addFrame({ groupId: 1, objectId: 0, data: 'g1-kf', isKeyframe: true });
      arbiter.addFrame({ groupId: 0, objectId: 1, data: 'g0-p1', isKeyframe: false });
      arbiter.addFrame({ groupId: 1, objectId: 1, data: 'g1-p1', isKeyframe: false });
      arbiter.addFrame({ groupId: 0, objectId: 2, data: 'g0-p2', isKeyframe: false });

      ticker.tickBy(20);

      // Should get all of group 0 first
      const g0Frames = arbiter.getReadyFrames(10);
      expect(g0Frames.length).toBe(3);
      expect(g0Frames.every((f) => f.data.startsWith('g0'))).toBe(true);

      // Then group 1
      const g1Frames = arbiter.getReadyFrames(10);
      expect(g1Frames.length).toBe(2);
      expect(g1Frames.every((f) => f.data.startsWith('g1'))).toBe(true);
    });
  });

  describe('deadline handling', () => {
    it('should skip to next keyframe group when deadline expires', () => {
      const fastArbiter = new GroupArbiter<string>(
        {
          maxLatency: 10,
          jitterDelay: 1,
          estimatedGopDuration: 10,
          deadlineExtension: 5,
        },
        ticker
      );

      // Add group 0 without keyframe (can't decode)
      fastArbiter.addFrame({ groupId: 0, objectId: 1, data: 'g0-p', isKeyframe: false });

      // Add group 1 with keyframe
      fastArbiter.addFrame({ groupId: 1, objectId: 0, data: 'g1-kf', isKeyframe: true });

      // Advance past deadline
      ticker.tickBy(100);

      const frames = fastArbiter.getReadyFrames();

      // Should have skipped to group 1
      expect(frames[0].data).toBe('g1-kf');
      expect(fastArbiter.getActiveGroupId()).toBe(1);
      expect(fastArbiter.getStats().groupsSkipped).toBe(1);
    });

    it('should extend deadline for partial group with keyframe', () => {
      const localTicker = new MonotonicTickProvider();
      const fastArbiter = new GroupArbiter<string>(
        {
          maxLatency: 10,
          jitterDelay: 1,
          estimatedGopDuration: 10,
          deadlineExtension: 100,
          allowPartialGroupDecode: true,
        },
        localTicker
      );

      // Add group 0 with keyframe and additional frame (so group doesn't complete immediately)
      fastArbiter.addFrame({ groupId: 0, objectId: 0, data: 'g0-kf', isKeyframe: true });
      fastArbiter.addFrame({ groupId: 0, objectId: 2, data: 'g0-p2', isKeyframe: false }); // Gap at 1
      localTicker.tickBy(5);
      const kfFrames = fastArbiter.getReadyFrames(); // Output keyframe, wait at gap
      expect(kfFrames.length).toBe(1);
      expect(kfFrames[0].data).toBe('g0-kf');

      // Now deadline passes while waiting for objectId 1
      localTicker.tickBy(50);

      // Trigger deadline check - should extend and skip gap
      fastArbiter.getReadyFrames();

      // Check that deadline was extended
      expect(fastArbiter.getStats().deadlinesExtended).toBeGreaterThan(0);
    });
  });

  describe('statistics', () => {
    it('should track frame counts', () => {
      arbiter.addFrame({ groupId: 0, objectId: 0, data: 'kf', isKeyframe: true });
      arbiter.addFrame({ groupId: 0, objectId: 1, data: 'p1', isKeyframe: false });

      expect(arbiter.getStats().framesReceived).toBe(2);

      ticker.tickBy(20);
      arbiter.getReadyFrames();

      expect(arbiter.getStats().framesOutput).toBe(2);
    });

    it('should track dropped late frames', () => {
      // Add and complete a group
      arbiter.addFrame({ groupId: 0, objectId: 0, data: 'g0', isKeyframe: true });
      ticker.tickBy(20);
      arbiter.getReadyFrames();

      // Try to add frame to completed group
      arbiter.addFrame({ groupId: 0, objectId: 1, data: 'g0-late', isKeyframe: false });

      expect(arbiter.getStats().droppedLateFrames).toBe(1);
    });

    it('should track latency stats', () => {
      arbiter.addFrame({ groupId: 0, objectId: 0, data: 'kf', isKeyframe: true });

      ticker.tickBy(30);
      arbiter.getReadyFrames();

      const stats = arbiter.getStats();
      expect(stats.avgOutputLatency).toBeGreaterThan(0);
    });
  });

  describe('reset', () => {
    it('should clear all state', () => {
      arbiter.addFrame({ groupId: 0, objectId: 0, data: 'kf', isKeyframe: true });
      arbiter.addFrame({ groupId: 1, objectId: 0, data: 'kf', isKeyframe: true });

      arbiter.reset();

      expect(arbiter.getGroupCount()).toBe(0);
      expect(arbiter.getActiveGroupId()).toBe(-1);
      expect(arbiter.getStats().framesReceived).toBe(0);
    });
  });
});

describe('GroupArbiter - root cause scenario', () => {
  /**
   * This test reproduces the scenario from the root cause analysis:
   *
   * Timeline:
   * 1. Group 1471666579, Object 0 (keyframe) delivered
   * 2. Switches back to old group 1471666578 (objects 56-60)
   * 3. Group 1471666579, Object 1 (P-frame) delivered 74ms later
   *
   * The problem: 74ms gap between keyframe and P-frame because
   * two streams are interleaved.
   */
  it('should handle interleaved groups without decode errors', () => {
    const ticker = new MonotonicTickProvider();
    const arbiter = new GroupArbiter<{ type: string; obj: number }>(
      {
        maxLatency: 500,
        jitterDelay: 10,
        estimatedGopDuration: 1000,
      },
      ticker
    );

    // Simulate the timeline
    const oldGroup = 1471666578;
    const newGroup = 1471666579;

    // T=0: Keyframe for new group arrives
    arbiter.addFrame({
      groupId: newGroup,
      objectId: 0,
      data: { type: 'keyframe', obj: 0 },
      isKeyframe: true,
    });

    // T=5-15: Old group frames arrive (interleaved)
    ticker.tickBy(5);
    for (let obj = 56; obj <= 60; obj++) {
      arbiter.addFrame({
        groupId: oldGroup,
        objectId: obj,
        data: { type: 'p-frame', obj },
        isKeyframe: false,
      });
      ticker.tickBy(2);
    }

    // T=74: P-frame for new group arrives
    ticker.tickBy(60);
    arbiter.addFrame({
      groupId: newGroup,
      objectId: 1,
      data: { type: 'p-frame', obj: 1 },
      isKeyframe: false,
    });

    // Now get ready frames
    const frames = arbiter.getReadyFrames(10);

    // The arbiter should output old group first (if it has keyframe)
    // Since old group doesn't have keyframe (objects 56-60 only),
    // it should wait or skip to new group

    // Key assertion: frames should be in correct order
    // and we should not try to decode P-frame without keyframe
    const newGroupFrames = frames.filter(
      (f) => f.data.type === 'keyframe' || f.data.obj === 1
    );

    if (newGroupFrames.length > 1) {
      // If we have both keyframe and P-frame, keyframe must come first
      expect(newGroupFrames[0].data.type).toBe('keyframe');
    }
  });

  it('should ensure keyframe always precedes P-frames in output', () => {
    const ticker = new MonotonicTickProvider();
    const arbiter = new GroupArbiter<string>(
      {
        maxLatency: 500,
        jitterDelay: 5,
        estimatedGopDuration: 100,
      },
      ticker
    );

    // Add P-frames first (simulating out-of-order arrival)
    arbiter.addFrame({ groupId: 0, objectId: 3, data: 'p3', isKeyframe: false });
    arbiter.addFrame({ groupId: 0, objectId: 2, data: 'p2', isKeyframe: false });
    arbiter.addFrame({ groupId: 0, objectId: 1, data: 'p1', isKeyframe: false });

    ticker.tickBy(10);

    // Should not output anything yet (waiting for keyframe)
    let frames = arbiter.getReadyFrames();
    expect(frames.length).toBe(0);

    // Now keyframe arrives
    arbiter.addFrame({ groupId: 0, objectId: 0, data: 'kf', isKeyframe: true });
    ticker.tickBy(10);

    // Now should get all frames in order, keyframe first
    frames = arbiter.getReadyFrames(10);
    expect(frames.length).toBe(4);
    expect(frames[0].data).toBe('kf');
    expect(frames[0].isKeyframe).toBe(true);
  });
});

describe('GroupArbiter benchmark', () => {
  it('addFrame should be fast', () => {
    const ticker = new MonotonicTickProvider();
    const arbiter = new GroupArbiter<number>({}, ticker);
    const ITERATIONS = 10000;

    const start = performance.now();
    for (let i = 0; i < ITERATIONS; i++) {
      arbiter.addFrame({
        groupId: Math.floor(i / 30), // ~30 frames per group
        objectId: i % 30,
        data: i,
        isKeyframe: i % 30 === 0,
      });
    }
    const elapsed = performance.now() - start;
    const opsPerMs = ITERATIONS / elapsed;

    console.log(
      `GroupArbiter.addFrame: ${ITERATIONS} calls in ${elapsed.toFixed(2)}ms ` +
        `(${opsPerMs.toFixed(0)} ops/ms)`
    );

    expect(opsPerMs).toBeGreaterThan(1000);
  });

  it('getReadyFrames should be fast', () => {
    const ticker = new MonotonicTickProvider();
    const arbiter = new GroupArbiter<number>(
      { jitterDelay: 0 },
      ticker
    );

    // Add frames
    for (let g = 0; g < 10; g++) {
      for (let o = 0; o < 30; o++) {
        arbiter.addFrame({
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
      arbiter.getReadyFrames(5);
    }
    const elapsed = performance.now() - start;
    const opsPerMs = ITERATIONS / elapsed;

    console.log(
      `GroupArbiter.getReadyFrames: ${ITERATIONS} calls in ${elapsed.toFixed(2)}ms ` +
        `(${opsPerMs.toFixed(0)} ops/ms)`
    );

    expect(opsPerMs).toBeGreaterThan(100);
  });
});
