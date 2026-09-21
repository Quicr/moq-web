// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Behavioral tests for VodReleasePolicy on top of PlayoutBuffer.
 *
 * These cover the guarantees the deleted JitterBuffer provided for the VOD
 * path: strict sequential ordering, waiting for missing frames without
 * skipping, respecting minimum buffer thresholds before playback starts,
 * bounded buffering per group, and group-completion semantics driven by
 * END_OF_GROUP.
 */

import { describe, it, expect } from 'vitest';
import { PlayoutBuffer } from './playout-buffer';
import { VodReleasePolicy } from './vod-release-policy';
import type { VodReleasePolicyConfig } from './vod-release-policy';

function makeVodBuffer<T = string>(
  policyConfig: Partial<VodReleasePolicyConfig> = {},
  bufferConfig: Partial<{ maxGroups: number; maxFramesPerGroup: number; debug: boolean }> = {},
): { buffer: PlayoutBuffer<T>; policy: VodReleasePolicy<T> } {
  const policy = new VodReleasePolicy<T>({
    minBufferFrames: 0,
    enablePacing: false,
    ...policyConfig,
  });
  const buffer = new PlayoutBuffer<T>(policy, bufferConfig);
  return { buffer, policy };
}

describe('VodReleasePolicy — sequential output', () => {
  it('emits frames strictly in (groupId, objectId) order across arrivals', () => {
    const { buffer } = makeVodBuffer<string>();

    buffer.addFrame({ groupId: 0, objectId: 2, data: 'p2', isKeyframe: false });
    buffer.addFrame({ groupId: 0, objectId: 0, data: 'kf', isKeyframe: true });
    buffer.addFrame({ groupId: 0, objectId: 1, data: 'p1', isKeyframe: false });

    const frames = buffer.getReadyFrames(10);
    expect(frames.map(f => f.data)).toEqual(['kf', 'p1', 'p2']);
  });

  it('does not start until a keyframe arrives', () => {
    const { buffer } = makeVodBuffer<string>();

    buffer.addFrame({ groupId: 0, objectId: 1, data: 'p1', isKeyframe: false });
    buffer.addFrame({ groupId: 0, objectId: 2, data: 'p2', isKeyframe: false });

    let frames = buffer.getReadyFrames(10);
    expect(frames).toEqual([]);

    buffer.addFrame({ groupId: 0, objectId: 0, data: 'kf', isKeyframe: true });
    frames = buffer.getReadyFrames(10);
    expect(frames[0].data).toBe('kf');
    expect(frames[0].isKeyframe).toBe(true);
  });

  it('waits for a missing frame instead of skipping it', () => {
    const { buffer } = makeVodBuffer<string>();

    buffer.addFrame({ groupId: 0, objectId: 0, data: 'kf', isKeyframe: true });
    buffer.addFrame({ groupId: 0, objectId: 2, data: 'p2', isKeyframe: false });

    let frames = buffer.getReadyFrames(10);
    expect(frames.map(f => f.data)).toEqual(['kf']);

    // Gap arrives — sequential order resumes without skipping
    buffer.addFrame({ groupId: 0, objectId: 1, data: 'p1', isKeyframe: false });
    frames = buffer.getReadyFrames(10);
    expect(frames.map(f => f.data)).toEqual(['p1', 'p2']);
  });
});

describe('VodReleasePolicy — group transitions', () => {
  it('completes a group on END_OF_GROUP and moves to the next sequential group', () => {
    const { buffer } = makeVodBuffer<string>();

    buffer.addFrame({ groupId: 0, objectId: 0, data: 'g0-kf', isKeyframe: true });
    buffer.addFrame({ groupId: 0, objectId: 1, data: 'g0-p1', isKeyframe: false });
    buffer.addFrame({ groupId: 1, objectId: 0, data: 'g1-kf', isKeyframe: true });

    // Drain group 0
    const g0 = buffer.getReadyFrames(10);
    expect(g0.map(f => f.data)).toEqual(['g0-kf', 'g0-p1']);

    // Explicit end-of-group unlocks the promotion to group 1
    buffer.markGroupComplete(0);
    expect(buffer.getGroup(0)?.status).toBe('complete');

    const g1 = buffer.getReadyFrames(10);
    expect(g1[0].data).toBe('g1-kf');
  });

  it('with waitForCompleteGop=false, promotes when the group drains without END_OF_GROUP', () => {
    const { buffer } = makeVodBuffer<string>({ waitForCompleteGop: false });

    buffer.addFrame({ groupId: 0, objectId: 0, data: 'g0-kf', isKeyframe: true });
    buffer.addFrame({ groupId: 1, objectId: 0, data: 'g1-kf', isKeyframe: true });

    const g0 = buffer.getReadyFrames(10);
    expect(g0.map(f => f.data)).toEqual(['g0-kf']);

    // No markGroupComplete; VOD still moves on because waitForCompleteGop is off
    const g1 = buffer.getReadyFrames(10);
    expect(g1[0].data).toBe('g1-kf');
  });

  it('never activates a non-sequential group even if it arrives first', () => {
    const { buffer } = makeVodBuffer<string>();

    // Out-of-order group arrival (parallel QUIC streams).
    buffer.addFrame({ groupId: 5, objectId: 0, data: 'g5-kf', isKeyframe: true });
    buffer.addFrame({ groupId: 5, objectId: 1, data: 'g5-p1', isKeyframe: false });

    // Group 5 initialized as the "first keyframe seen" starting point.
    const first = buffer.getReadyFrames(10);
    expect(first.map(f => f.data)).toEqual(['g5-kf', 'g5-p1']);

    // Now group 7 arrives before group 6.
    buffer.addFrame({ groupId: 7, objectId: 0, data: 'g7-kf', isKeyframe: true });
    buffer.markGroupComplete(5);

    const gap = buffer.getReadyFrames(10);
    expect(gap).toEqual([]);

    buffer.addFrame({ groupId: 6, objectId: 0, data: 'g6-kf', isKeyframe: true });
    const g6 = buffer.getReadyFrames(10);
    expect(g6[0].data).toBe('g6-kf');
  });
});

describe('VodReleasePolicy — buffering behavior', () => {
  it('holds output until minBufferFrames is reached', () => {
    const { buffer } = makeVodBuffer<string>({ minBufferFrames: 3 });

    buffer.addFrame({ groupId: 0, objectId: 0, data: 'kf', isKeyframe: true });
    buffer.addFrame({ groupId: 0, objectId: 1, data: 'p1', isKeyframe: false });

    let frames = buffer.getReadyFrames(10);
    expect(frames).toEqual([]);

    buffer.addFrame({ groupId: 0, objectId: 2, data: 'p2', isKeyframe: false });
    frames = buffer.getReadyFrames(10);
    expect(frames.map(f => f.data)).toEqual(['kf', 'p1', 'p2']);
  });

  it('rejects frames beyond maxFramesPerGroup', () => {
    const { buffer } = makeVodBuffer<string>({}, { maxFramesPerGroup: 4 });

    for (let o = 0; o < 8; o++) {
      buffer.addFrame({
        groupId: 0,
        objectId: o,
        data: `f${o}`,
        isKeyframe: o === 0,
      });
    }

    expect(buffer.getGroup(0)?.frameCount).toBe(4);
    expect(buffer.getStats().framesDropped).toBe(4);
  });

  it('rejects frames added to an already-completed group', () => {
    const { buffer } = makeVodBuffer<string>();

    buffer.addFrame({ groupId: 0, objectId: 0, data: 'g0-kf', isKeyframe: true });
    buffer.getReadyFrames(10);
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
});

describe('VodReleasePolicy — reset', () => {
  it('clears buffer state and requires a new keyframe to restart', () => {
    const { buffer } = makeVodBuffer<string>();

    buffer.addFrame({ groupId: 0, objectId: 0, data: 'kf', isKeyframe: true });
    buffer.addFrame({ groupId: 0, objectId: 1, data: 'p1', isKeyframe: false });

    buffer.reset();

    expect(buffer.getGroupCount()).toBe(0);
    expect(buffer.getActiveGroupId()).toBe(-1);

    // Only P-frames arrive first; VOD refuses to start.
    buffer.addFrame({ groupId: 3, objectId: 1, data: 'g3-p1', isKeyframe: false });
    expect(buffer.getReadyFrames(10)).toEqual([]);

    buffer.addFrame({ groupId: 3, objectId: 0, data: 'g3-kf', isKeyframe: true });
    const frames = buffer.getReadyFrames(10);
    expect(frames[0].data).toBe('g3-kf');
  });
});

describe('VodReleasePolicy — pause / resume', () => {
  it('suppresses output while paused and resumes cleanly', () => {
    const { buffer, policy } = makeVodBuffer<string>();

    buffer.addFrame({ groupId: 0, objectId: 0, data: 'kf', isKeyframe: true });
    buffer.addFrame({ groupId: 0, objectId: 1, data: 'p1', isKeyframe: false });

    policy.pause();
    expect(policy.isPaused()).toBe(true);
    expect(buffer.getReadyFrames(10)).toEqual([]);

    policy.resume();
    const frames = buffer.getReadyFrames(10);
    expect(frames.map(f => f.data)).toEqual(['kf', 'p1']);
  });
});
