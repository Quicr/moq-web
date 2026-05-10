// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VodFetchController, LegacyFetchStrategy } from '../vod-fetch-controller';
import { SbrFetchStrategy } from '../sbr-fetch-strategy';
import { type FetchStrategy, type FetchDecision, type FetchStrategyContext } from '../fetch-strategy';

describe('VodFetchController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('default strategy (legacy)', () => {
    it('uses LegacyFetchStrategy by default', () => {
      const controller = new VodFetchController({
        framerate: 30,
        gopDurationMs: 2000,
        totalGroups: 100,
      });
      expect(controller.getStrategy().name).toBe('legacy');
    });

    it('emits fetch-request on start', () => {
      const controller = new VodFetchController({
        framerate: 30,
        gopDurationMs: 2000,
        totalGroups: 100,
        initialBufferSec: 2,
      });

      const fetchRequests: Array<{ startGroup: number; endGroup: number }> = [];
      controller.on('fetch-request', (data) => fetchRequests.push(data));
      controller.start();

      expect(fetchRequests.length).toBe(1);
      expect(fetchRequests[0].startGroup).toBe(0);
    });

    it('transitions to playing when initial buffer is filled', () => {
      const controller = new VodFetchController({
        framerate: 30,
        gopDurationMs: 2000,
        totalGroups: 100,
        initialBufferSec: 2,
      });

      let readyToPlay = false;
      controller.on('ready-to-play', () => { readyToPlay = true; });
      controller.start();

      // 2s buffer at 30fps = 60 frames, with 2s GOPs = 1 GOP = 60 frames
      controller.onGroupReceived(0, 60);
      expect(readyToPlay).toBe(true);
      expect(controller.getState()).toBe('playing');
    });
  });

  describe('with SBR strategy', () => {
    it('uses SbrFetchStrategy when provided', () => {
      const controller = new VodFetchController({
        framerate: 30,
        gopDurationMs: 2000,
        totalGroups: 100,
        strategy: new SbrFetchStrategy({ targetBufferSec: 30, lowBufferSec: 20, highBufferSec: 40 }),
      });
      expect(controller.getStrategy().name).toBe('sbr');
    });

    it('fetches 30s initial buffer with SBR', () => {
      const controller = new VodFetchController({
        framerate: 30,
        gopDurationMs: 2000,
        totalGroups: 100,
        strategy: new SbrFetchStrategy({ targetBufferSec: 30, lowBufferSec: 20, highBufferSec: 40 }),
      });

      const fetchRequests: Array<{ startGroup: number; endGroup: number }> = [];
      controller.on('fetch-request', (data) => fetchRequests.push(data));
      controller.start();

      expect(fetchRequests.length).toBe(1);
      // 30s / 2s per GOP = 15 GOPs (groups 0-14)
      expect(fetchRequests[0].startGroup).toBe(0);
      expect(fetchRequests[0].endGroup).toBe(14);
    });

    it('starts playback after lowBufferSec worth of frames with SBR', () => {
      const controller = new VodFetchController({
        framerate: 30,
        gopDurationMs: 2000,
        totalGroups: 100,
        strategy: new SbrFetchStrategy({ targetBufferSec: 30, lowBufferSec: 20, highBufferSec: 40 }),
      });

      let readyToPlay = false;
      controller.on('ready-to-play', () => { readyToPlay = true; });
      controller.start();

      // SBR waits for lowBufferSec (20s) = 10 GOPs = 600 frames
      // With 30fps and 2s GOP = 60 frames per GOP
      // Simulate receiving 9 GOPs (540 frames) - should not be ready
      for (let i = 0; i < 9; i++) {
        controller.onGroupReceived(i, 60);
      }
      expect(readyToPlay).toBe(false);

      // Receive the 10th GOP - should now be ready (600 frames >= 600 required)
      controller.onGroupReceived(9, 60);
      expect(readyToPlay).toBe(true);
    });

    it('includes strategy name in stats', () => {
      const controller = new VodFetchController({
        framerate: 30,
        gopDurationMs: 2000,
        totalGroups: 100,
        strategy: new SbrFetchStrategy(),
      });
      expect(controller.getStats().strategy).toBe('sbr');
    });
  });

  describe('custom strategy', () => {
    it('delegates to custom strategy', () => {
      const mockStrategy: FetchStrategy = {
        name: 'mock',
        getInitialFetchSize: vi.fn().mockReturnValue(5),
        getNextFetch: vi.fn().mockReturnValue({ shouldFetch: false, startGroup: 0, endGroup: 0 }),
        getMinFramesForPlayback: vi.fn().mockReturnValue(30),
      };

      const controller = new VodFetchController({
        framerate: 30,
        gopDurationMs: 2000,
        totalGroups: 100,
        strategy: mockStrategy,
      });

      controller.start();
      expect(mockStrategy.getInitialFetchSize).toHaveBeenCalled();
    });
  });

  describe('fetch-request event', () => {
    it('includes trackName when strategy provides it', () => {
      const mockStrategy: FetchStrategy = {
        name: 'abr-mock',
        getInitialFetchSize: () => 2,
        getNextFetch: () => ({ shouldFetch: true, startGroup: 2, endGroup: 3, trackName: 'video-high' }),
        getMinFramesForPlayback: () => 30,
      };

      const controller = new VodFetchController({
        framerate: 30,
        gopDurationMs: 2000,
        totalGroups: 100,
        strategy: mockStrategy,
      });

      const fetchRequests: Array<{ startGroup: number; endGroup: number; trackName?: string }> = [];
      controller.on('fetch-request', (data) => fetchRequests.push(data));
      controller.start();

      // First request is from initial buffer, second from getNextFetch
      // Simulate first group received to trigger maybeIssueFetch
      controller.onGroupReceived(0, 30);

      // Find the request with trackName
      const abrRequest = fetchRequests.find(r => r.trackName === 'video-high');
      expect(abrRequest).toBeDefined();
    });
  });

  describe('seek', () => {
    it('resets and refetches from new position', () => {
      const controller = new VodFetchController({
        framerate: 30,
        gopDurationMs: 2000,
        totalGroups: 100,
        strategy: new SbrFetchStrategy({ targetBufferSec: 30, lowBufferSec: 20, highBufferSec: 40 }),
      });

      const fetchRequests: Array<{ startGroup: number; endGroup: number }> = [];
      controller.on('fetch-request', (data) => fetchRequests.push(data));
      controller.start();

      // Fill initial buffer
      for (let i = 0; i < 15; i++) {
        controller.onGroupReceived(i, 60);
        controller.onFetchComplete(1, i);
      }

      // Seek to group 50
      controller.seek(50);
      expect(controller.getState()).toBe('rebuffering');

      const seekFetch = fetchRequests[fetchRequests.length - 1];
      expect(seekFetch.startGroup).toBe(50);
    });

    it('emits seek-start and seek-complete events', () => {
      const controller = new VodFetchController({
        framerate: 30,
        gopDurationMs: 2000,
        totalGroups: 100,
      });

      const seekStartEvents: Array<{ targetGroup: number; targetObject: number }> = [];
      const seekCompleteEvents: Array<{ targetGroup: number; success: boolean }> = [];

      controller.on('seek-start', (data) => seekStartEvents.push(data));
      controller.on('seek-complete', (data) => seekCompleteEvents.push(data));
      controller.start();

      controller.seek(25, 5);

      expect(seekStartEvents.length).toBe(1);
      expect(seekStartEvents[0].targetGroup).toBe(25);
      expect(seekStartEvents[0].targetObject).toBe(5);

      expect(seekCompleteEvents.length).toBe(1);
      expect(seekCompleteEvents[0].targetGroup).toBe(25);
      expect(seekCompleteEvents[0].success).toBe(true);
    });

    it('emits fetch-cancel for active fetches during seek', () => {
      const controller = new VodFetchController({
        framerate: 30,
        gopDurationMs: 2000,
        totalGroups: 100,
      });

      const cancelEvents: Array<{ requestId: number }> = [];
      controller.on('fetch-cancel', (data) => cancelEvents.push(data));
      controller.start();

      // There's an active fetch after start
      expect(controller.getStats().activeFetches).toBe(1);

      // Seek should cancel it
      controller.seek(50);
      expect(cancelEvents.length).toBe(1);
    });
  });

  describe('time/group conversion helpers', () => {
    it('converts time to group correctly', () => {
      const controller = new VodFetchController({
        framerate: 30,
        gopDurationMs: 2000, // 2 seconds per GOP
        totalGroups: 100,
      });

      expect(controller.timeToGroup(0)).toBe(0);
      expect(controller.timeToGroup(1000)).toBe(0); // 1s is still in first GOP
      expect(controller.timeToGroup(2000)).toBe(1); // 2s is start of second GOP
      expect(controller.timeToGroup(5000)).toBe(2); // 5s is in third GOP
      expect(controller.timeToGroup(10000)).toBe(5); // 10s is in sixth GOP
    });

    it('converts group to time correctly', () => {
      const controller = new VodFetchController({
        framerate: 30,
        gopDurationMs: 2000,
        totalGroups: 100,
      });

      expect(controller.groupToTime(0)).toBe(0);
      expect(controller.groupToTime(1)).toBe(2000);
      expect(controller.groupToTime(5)).toBe(10000);
      expect(controller.groupToTime(50)).toBe(100000);
    });

    it('returns correct GOP duration and total groups', () => {
      const controller = new VodFetchController({
        framerate: 30,
        gopDurationMs: 1500,
        totalGroups: 200,
      });

      expect(controller.getGopDurationMs()).toBe(1500);
      expect(controller.getTotalGroups()).toBe(200);
    });
  });
});
