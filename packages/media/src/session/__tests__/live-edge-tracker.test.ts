// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LiveEdgeTracker } from '../live-edge-tracker';
import { TrackStatusCode } from '@moq-web/core';

// Mock session
const createMockSession = () => ({
  requestTrackStatus: vi.fn(),
});

describe('LiveEdgeTracker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('initialization', () => {
    it('creates with default config', () => {
      const session = createMockSession();
      const tracker = new LiveEdgeTracker(
        session as never,
        ['namespace'],
        'video'
      );

      expect(tracker.isActive()).toBe(false);
      expect(tracker.getLiveEdge()).toBeNull();
    });

    it('creates with custom config', () => {
      const session = createMockSession();
      const tracker = new LiveEdgeTracker(
        session as never,
        ['namespace'],
        'video',
        { pollIntervalMs: 1000, gopDurationMs: 2000 }
      );

      expect(tracker.isActive()).toBe(false);
    });
  });

  describe('polling', () => {
    it('polls immediately on start', async () => {
      const session = createMockSession();
      session.requestTrackStatus.mockResolvedValue({
        statusCode: TrackStatusCode.IN_PROGRESS,
        lastGroupId: 10,
        lastObjectId: 5,
      });

      const tracker = new LiveEdgeTracker(
        session as never,
        ['namespace'],
        'video'
      );

      tracker.start();
      expect(tracker.isActive()).toBe(true);

      // Wait for promise to resolve
      await vi.advanceTimersByTimeAsync(0);

      expect(session.requestTrackStatus).toHaveBeenCalledWith(
        ['namespace'],
        'video'
      );

      tracker.stop();
    });

    it('polls at configured interval', async () => {
      const session = createMockSession();
      session.requestTrackStatus.mockResolvedValue({
        statusCode: TrackStatusCode.IN_PROGRESS,
        lastGroupId: 10,
        lastObjectId: 5,
      });

      const tracker = new LiveEdgeTracker(
        session as never,
        ['namespace'],
        'video',
        { pollIntervalMs: 500 }
      );

      tracker.start();

      // Initial poll
      await vi.advanceTimersByTimeAsync(0);
      expect(session.requestTrackStatus).toHaveBeenCalledTimes(1);

      // Advance by poll interval
      await vi.advanceTimersByTimeAsync(500);
      expect(session.requestTrackStatus).toHaveBeenCalledTimes(2);

      // Another interval
      await vi.advanceTimersByTimeAsync(500);
      expect(session.requestTrackStatus).toHaveBeenCalledTimes(3);

      tracker.stop();
    });

    it('stops polling when stop() is called', async () => {
      const session = createMockSession();
      session.requestTrackStatus.mockResolvedValue({
        statusCode: TrackStatusCode.IN_PROGRESS,
        lastGroupId: 10,
        lastObjectId: 5,
      });

      const tracker = new LiveEdgeTracker(
        session as never,
        ['namespace'],
        'video',
        { pollIntervalMs: 500 }
      );

      tracker.start();
      await vi.advanceTimersByTimeAsync(0);

      tracker.stop();
      expect(tracker.isActive()).toBe(false);

      // Reset call count
      const callsBefore = session.requestTrackStatus.mock.calls.length;

      // Advance time - should not poll again
      await vi.advanceTimersByTimeAsync(1000);
      expect(session.requestTrackStatus.mock.calls.length).toBe(callsBefore);
    });
  });

  describe('edge tracking', () => {
    it('updates live edge on successful poll', async () => {
      const session = createMockSession();
      session.requestTrackStatus.mockResolvedValue({
        statusCode: TrackStatusCode.IN_PROGRESS,
        lastGroupId: 42,
        lastObjectId: 7,
      });

      const tracker = new LiveEdgeTracker(
        session as never,
        ['namespace'],
        'video'
      );

      tracker.start();
      await vi.advanceTimersByTimeAsync(0);

      const edge = tracker.getLiveEdge();
      expect(edge).not.toBeNull();
      expect(edge?.groupId).toBe(42);
      expect(edge?.objectId).toBe(7);
      expect(edge?.statusCode).toBe(TrackStatusCode.IN_PROGRESS);

      tracker.stop();
    });

    it('emits edge-update event', async () => {
      const session = createMockSession();
      session.requestTrackStatus.mockResolvedValue({
        statusCode: TrackStatusCode.IN_PROGRESS,
        lastGroupId: 10,
        lastObjectId: 0,
      });

      const tracker = new LiveEdgeTracker(
        session as never,
        ['namespace'],
        'video'
      );

      const edgeUpdates: Array<{ groupId: number; objectId: number }> = [];
      tracker.on('edge-update', (info) => edgeUpdates.push(info));

      tracker.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(edgeUpdates.length).toBe(1);
      expect(edgeUpdates[0].groupId).toBe(10);

      tracker.stop();
    });

    it('calculates live edge time from groupId and gopDuration', async () => {
      const session = createMockSession();
      session.requestTrackStatus.mockResolvedValue({
        statusCode: TrackStatusCode.IN_PROGRESS,
        lastGroupId: 25,
        lastObjectId: 0,
      });

      const tracker = new LiveEdgeTracker(
        session as never,
        ['namespace'],
        'video',
        { gopDurationMs: 2000 }
      );

      tracker.start();
      await vi.advanceTimersByTimeAsync(0);

      // 25 groups * 2000ms per GOP = 50000ms
      expect(tracker.getLiveEdgeTimeMs()).toBe(50000);

      tracker.stop();
    });
  });

  describe('track finished', () => {
    it('emits track-finished and stops when track finishes', async () => {
      const session = createMockSession();
      session.requestTrackStatus.mockResolvedValue({
        statusCode: TrackStatusCode.FINISHED,
        lastGroupId: 100,
        lastObjectId: 23,
      });

      const tracker = new LiveEdgeTracker(
        session as never,
        ['namespace'],
        'video'
      );

      let finished = false;
      tracker.on('track-finished', () => { finished = true; });

      tracker.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(finished).toBe(true);
      expect(tracker.isActive()).toBe(false);
    });
  });

  describe('error handling', () => {
    it('emits error event on poll failure', async () => {
      const session = createMockSession();
      session.requestTrackStatus.mockRejectedValue(new Error('Network error'));

      const tracker = new LiveEdgeTracker(
        session as never,
        ['namespace'],
        'video'
      );

      const errors: Error[] = [];
      tracker.on('error', (err) => errors.push(err));

      tracker.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(errors.length).toBe(1);
      expect(errors[0].message).toBe('Network error');

      tracker.stop();
    });
  });

  describe('event unsubscription', () => {
    it('returns unsubscribe function from on()', async () => {
      const session = createMockSession();
      session.requestTrackStatus.mockResolvedValue({
        statusCode: TrackStatusCode.IN_PROGRESS,
        lastGroupId: 10,
        lastObjectId: 0,
      });

      const tracker = new LiveEdgeTracker(
        session as never,
        ['namespace'],
        'video',
        { pollIntervalMs: 500 }
      );

      let callCount = 0;
      const unsubscribe = tracker.on('edge-update', () => { callCount++; });

      tracker.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(callCount).toBe(1);

      // Unsubscribe
      unsubscribe();

      // Next poll should not trigger handler
      await vi.advanceTimersByTimeAsync(500);
      expect(callCount).toBe(1);

      tracker.stop();
    });
  });
});
