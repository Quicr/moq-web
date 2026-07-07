// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LiveTrickPlayController, type SeekMode, type SeekResult } from '../live-trick-play';
import { TrackStatusCode } from '@moq-web/core';

const createMockSession = () => ({
  requestTrackStatus: vi.fn(),
  seekSubscription: vi.fn(),
});

describe('LiveTrickPlayController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('initialization', () => {
    it('creates with required config', () => {
      const session = createMockSession();
      const controller = new LiveTrickPlayController(
        session as never,
        ['namespace'],
        'video',
        { subscriptionId: 1, gopDurationMs: 2000 }
      );

      expect(controller.isActive()).toBe(false);
      expect(controller.getLiveEdge()).toBeNull();
      expect(controller.isLive()).toBe(true);
    });

    it('creates with custom config', () => {
      const session = createMockSession();
      const controller = new LiveTrickPlayController(
        session as never,
        ['namespace'],
        'video',
        {
          subscriptionId: 1,
          gopDurationMs: 2000,
          pollIntervalMs: 1000,
          subscribeUpdateThresholdSec: 15,
          fetchCatchUpBufferSec: 10,
        }
      );

      expect(controller.getGopDurationMs()).toBe(2000);
    });
  });

  describe('start/stop', () => {
    it('starts and stops tracking', async () => {
      const session = createMockSession();
      session.requestTrackStatus.mockResolvedValue({
        statusCode: TrackStatusCode.IN_PROGRESS,
        lastGroupId: 50,
        lastObjectId: 0,
      });

      const controller = new LiveTrickPlayController(
        session as never,
        ['namespace'],
        'video',
        { subscriptionId: 1, gopDurationMs: 2000 }
      );

      controller.start();
      expect(controller.isActive()).toBe(true);

      await vi.advanceTimersByTimeAsync(0);
      expect(session.requestTrackStatus).toHaveBeenCalled();

      controller.stop();
      expect(controller.isActive()).toBe(false);
    });
  });

  describe('seek via SUBSCRIBE_UPDATE', () => {
    it('uses SUBSCRIBE_UPDATE for near-live content', async () => {
      const session = createMockSession();
      session.requestTrackStatus.mockResolvedValue({
        statusCode: TrackStatusCode.IN_PROGRESS,
        lastGroupId: 100,
        lastObjectId: 0,
      });
      session.seekSubscription.mockResolvedValue(undefined);

      const controller = new LiveTrickPlayController(
        session as never,
        ['namespace'],
        'video',
        {
          subscriptionId: 42,
          gopDurationMs: 2000,
          subscribeUpdateThresholdSec: 10,
        }
      );

      controller.start();
      await vi.advanceTimersByTimeAsync(0);

      const seekStartEvents: Array<{ targetGroup: number; mode: SeekMode }> = [];
      controller.on('seek-start', (data) => seekStartEvents.push(data));

      const result = await controller.seek(96);

      expect(result.success).toBe(true);
      expect(result.mode).toBe('subscribe-update');
      expect(session.seekSubscription).toHaveBeenCalledWith(42, 96, 0);
      expect(seekStartEvents[0].mode).toBe('subscribe-update');

      controller.stop();
    });

    it('uses SUBSCRIBE_UPDATE when seeking to live edge', async () => {
      const session = createMockSession();
      session.requestTrackStatus.mockResolvedValue({
        statusCode: TrackStatusCode.IN_PROGRESS,
        lastGroupId: 100,
        lastObjectId: 0,
      });
      session.seekSubscription.mockResolvedValue(undefined);

      const controller = new LiveTrickPlayController(
        session as never,
        ['namespace'],
        'video',
        { subscriptionId: 1, gopDurationMs: 2000 }
      );

      controller.start();
      await vi.advanceTimersByTimeAsync(0);

      const result = await controller.seek(100);

      expect(result.success).toBe(true);
      expect(result.mode).toBe('subscribe-update');
      expect(controller.isLive()).toBe(true);

      controller.stop();
    });
  });

  describe('seek via FETCH', () => {
    it('uses FETCH for historical content', async () => {
      const session = createMockSession();
      session.requestTrackStatus.mockResolvedValue({
        statusCode: TrackStatusCode.IN_PROGRESS,
        lastGroupId: 100,
        lastObjectId: 0,
      });

      const controller = new LiveTrickPlayController(
        session as never,
        ['namespace'],
        'video',
        {
          subscriptionId: 1,
          gopDurationMs: 2000,
          subscribeUpdateThresholdSec: 10,
        }
      );

      controller.start();
      await vi.advanceTimersByTimeAsync(0);

      const fetchRequests: Array<{ startGroup: number; endGroup: number }> = [];
      controller.on('fetch-request', (data) => fetchRequests.push(data));

      const result = await controller.seek(50);

      expect(result.success).toBe(true);
      expect(result.mode).toBe('fetch');
      expect(fetchRequests.length).toBe(1);
      expect(fetchRequests[0].startGroup).toBe(50);
      expect(controller.isLive()).toBe(false);

      controller.stop();
    });
  });

  describe('jumpToLive', () => {
    it('jumps to live edge position', async () => {
      const session = createMockSession();
      session.requestTrackStatus.mockResolvedValue({
        statusCode: TrackStatusCode.IN_PROGRESS,
        lastGroupId: 100,
        lastObjectId: 5,
      });
      session.seekSubscription.mockResolvedValue(undefined);

      const controller = new LiveTrickPlayController(
        session as never,
        ['namespace'],
        'video',
        { subscriptionId: 42, gopDurationMs: 2000 }
      );

      controller.start();
      await vi.advanceTimersByTimeAsync(0);

      await controller.seek(50);
      expect(controller.isLive()).toBe(false);

      const jumpEvents: Array<{ groupId: number }> = [];
      controller.on('jump-to-live', (data) => jumpEvents.push(data));

      const result = await controller.jumpToLive();

      expect(result.success).toBe(true);
      expect(session.seekSubscription).toHaveBeenLastCalledWith(42, 100, 5);
      expect(jumpEvents[0].groupId).toBe(100);
      expect(controller.isLive()).toBe(true);

      controller.stop();
    });
  });

  describe('skipForward/skipBackward', () => {
    it('skips forward by seconds', async () => {
      const session = createMockSession();
      session.requestTrackStatus.mockResolvedValue({
        statusCode: TrackStatusCode.IN_PROGRESS,
        lastGroupId: 100,
        lastObjectId: 0,
      });
      session.seekSubscription.mockResolvedValue(undefined);

      const controller = new LiveTrickPlayController(
        session as never,
        ['namespace'],
        'video',
        { subscriptionId: 1, gopDurationMs: 2000 }
      );

      controller.start();
      await vi.advanceTimersByTimeAsync(0);

      await controller.seek(50);
      const result = await controller.skipForward(10);

      expect(result.targetGroup).toBe(55);

      controller.stop();
    });

    it('skips backward by seconds', async () => {
      const session = createMockSession();
      session.requestTrackStatus.mockResolvedValue({
        statusCode: TrackStatusCode.IN_PROGRESS,
        lastGroupId: 100,
        lastObjectId: 0,
      });
      session.seekSubscription.mockResolvedValue(undefined);

      const controller = new LiveTrickPlayController(
        session as never,
        ['namespace'],
        'video',
        { subscriptionId: 1, gopDurationMs: 2000 }
      );

      controller.start();
      await vi.advanceTimersByTimeAsync(0);

      await controller.seek(50);
      const result = await controller.skipBackward(20);

      expect(result.targetGroup).toBe(40);

      controller.stop();
    });

    it('jumps to live when skipping forward past live edge', async () => {
      const session = createMockSession();
      session.requestTrackStatus.mockResolvedValue({
        statusCode: TrackStatusCode.IN_PROGRESS,
        lastGroupId: 100,
        lastObjectId: 0,
      });
      session.seekSubscription.mockResolvedValue(undefined);

      const controller = new LiveTrickPlayController(
        session as never,
        ['namespace'],
        'video',
        { subscriptionId: 1, gopDurationMs: 2000 }
      );

      controller.start();
      await vi.advanceTimersByTimeAsync(0);

      await controller.seek(90);
      const result = await controller.skipForward(30);

      expect(result.targetGroup).toBe(100);
      expect(controller.isLive()).toBe(true);

      controller.stop();
    });

    it('clamps to group 0 when skipping backward past start', async () => {
      const session = createMockSession();
      session.requestTrackStatus.mockResolvedValue({
        statusCode: TrackStatusCode.IN_PROGRESS,
        lastGroupId: 100,
        lastObjectId: 0,
      });
      session.seekSubscription.mockResolvedValue(undefined);

      const controller = new LiveTrickPlayController(
        session as never,
        ['namespace'],
        'video',
        { subscriptionId: 1, gopDurationMs: 2000 }
      );

      controller.start();
      await vi.advanceTimersByTimeAsync(0);

      await controller.seek(5);
      const result = await controller.skipBackward(30);

      expect(result.targetGroup).toBe(0);

      controller.stop();
    });
  });

  describe('time/group conversion', () => {
    it('converts time to group correctly', () => {
      const session = createMockSession();
      const controller = new LiveTrickPlayController(
        session as never,
        ['namespace'],
        'video',
        { subscriptionId: 1, gopDurationMs: 2000 }
      );

      expect(controller.timeToGroup(0)).toBe(0);
      expect(controller.timeToGroup(1000)).toBe(0);
      expect(controller.timeToGroup(2000)).toBe(1);
      expect(controller.timeToGroup(5000)).toBe(2);
    });

    it('converts group to time correctly', () => {
      const session = createMockSession();
      const controller = new LiveTrickPlayController(
        session as never,
        ['namespace'],
        'video',
        { subscriptionId: 1, gopDurationMs: 2000 }
      );

      expect(controller.groupToTime(0)).toBe(0);
      expect(controller.groupToTime(1)).toBe(2000);
      expect(controller.groupToTime(5)).toBe(10000);
    });
  });

  describe('seekToTimeMs', () => {
    it('seeks to time in milliseconds', async () => {
      const session = createMockSession();
      session.requestTrackStatus.mockResolvedValue({
        statusCode: TrackStatusCode.IN_PROGRESS,
        lastGroupId: 100,
        lastObjectId: 0,
      });
      session.seekSubscription.mockResolvedValue(undefined);

      const controller = new LiveTrickPlayController(
        session as never,
        ['namespace'],
        'video',
        { subscriptionId: 1, gopDurationMs: 2000 }
      );

      controller.start();
      await vi.advanceTimersByTimeAsync(0);

      const result = await controller.seekToTimeMs(10000);

      expect(result.targetGroup).toBe(5);

      controller.stop();
    });
  });

  describe('error handling', () => {
    it('returns error when live edge not available', async () => {
      const session = createMockSession();
      const controller = new LiveTrickPlayController(
        session as never,
        ['namespace'],
        'video',
        { subscriptionId: 1, gopDurationMs: 2000 }
      );

      const errors: Error[] = [];
      controller.on('error', (err) => errors.push(err));

      const result = await controller.seek(50);

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('live edge not available');
      expect(errors.length).toBe(1);
    });

    it('returns error on seek failure', async () => {
      const session = createMockSession();
      session.requestTrackStatus.mockResolvedValue({
        statusCode: TrackStatusCode.IN_PROGRESS,
        lastGroupId: 100,
        lastObjectId: 0,
      });
      session.seekSubscription.mockRejectedValue(new Error('Network error'));

      const controller = new LiveTrickPlayController(
        session as never,
        ['namespace'],
        'video',
        { subscriptionId: 1, gopDurationMs: 2000 }
      );

      controller.start();
      await vi.advanceTimersByTimeAsync(0);

      const result = await controller.seek(95);

      expect(result.success).toBe(false);
      expect(result.error?.message).toBe('Network error');

      controller.stop();
    });
  });

  describe('event passthrough', () => {
    it('emits edge-update from LiveEdgeTracker', async () => {
      const session = createMockSession();
      session.requestTrackStatus.mockResolvedValue({
        statusCode: TrackStatusCode.IN_PROGRESS,
        lastGroupId: 50,
        lastObjectId: 0,
      });

      const controller = new LiveTrickPlayController(
        session as never,
        ['namespace'],
        'video',
        { subscriptionId: 1, gopDurationMs: 2000 }
      );

      const edgeUpdates: Array<{ groupId: number }> = [];
      controller.on('edge-update', (info) => edgeUpdates.push(info));

      controller.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(edgeUpdates.length).toBe(1);
      expect(edgeUpdates[0].groupId).toBe(50);

      controller.stop();
    });

    it('emits track-finished from LiveEdgeTracker', async () => {
      const session = createMockSession();
      session.requestTrackStatus.mockResolvedValue({
        statusCode: TrackStatusCode.FINISHED,
        lastGroupId: 100,
        lastObjectId: 23,
      });

      const controller = new LiveTrickPlayController(
        session as never,
        ['namespace'],
        'video',
        { subscriptionId: 1, gopDurationMs: 2000 }
      );

      let finished = false;
      controller.on('track-finished', () => { finished = true; });

      controller.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(finished).toBe(true);
    });
  });

  describe('event unsubscription', () => {
    it('returns unsubscribe function from on()', async () => {
      const session = createMockSession();
      session.requestTrackStatus.mockResolvedValue({
        statusCode: TrackStatusCode.IN_PROGRESS,
        lastGroupId: 50,
        lastObjectId: 0,
      });

      const controller = new LiveTrickPlayController(
        session as never,
        ['namespace'],
        'video',
        { subscriptionId: 1, gopDurationMs: 2000, pollIntervalMs: 500 }
      );

      let callCount = 0;
      const unsubscribe = controller.on('edge-update', () => { callCount++; });

      controller.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(callCount).toBe(1);

      unsubscribe();

      await vi.advanceTimersByTimeAsync(500);
      expect(callCount).toBe(1);

      controller.stop();
    });
  });
});
