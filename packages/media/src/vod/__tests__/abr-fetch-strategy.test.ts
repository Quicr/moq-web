// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { describe, it, expect, vi } from 'vitest';
import { AbrFetchStrategy } from '../abr-fetch-strategy';
import { ABRController } from '../../abr/abr-controller';
import { type FetchStrategyContext } from '../fetch-strategy';

function createContext(overrides: Partial<FetchStrategyContext> = {}): FetchStrategyContext {
  return {
    playbackGroup: 0,
    fetchedUpToGroup: -1,
    bufferedSeconds: 0,
    bufferedFrames: 0,
    totalGroups: 100,
    gopDurationSec: 2,
    activeFetchCount: 0,
    maxConcurrentFetches: 1,
    highestInFlightGroup: -1,
    avgGroupDownloadMs: 0,
    downloadHistory: [],
    ...overrides,
  };
}

function createAbrController(): ABRController {
  const abr = new ABRController({
    onSwitch: vi.fn().mockResolvedValue(undefined),
    debug: false,
  });

  // Register test tracks at 3 quality levels
  abr.registerTrack({ name: 'video-low', namespace: ['vod'], altGroup: 1, bitrate: 500_000 });
  abr.registerTrack({ name: 'video-mid', namespace: ['vod'], altGroup: 1, bitrate: 2_000_000 });
  abr.registerTrack({ name: 'video-high', namespace: ['vod'], altGroup: 1, bitrate: 8_000_000 });

  // Start at lowest quality
  abr.setActiveTrack(1, 'video-low');

  return abr;
}

describe('AbrFetchStrategy', () => {
  describe('getInitialFetchSize', () => {
    it('returns small probe batch for ramp-up', () => {
      const abr = createAbrController();
      const strategy = new AbrFetchStrategy({ abrController: abr, altGroup: 1 });
      const ctx = createContext();
      expect(strategy.getInitialFetchSize(ctx)).toBe(2); // default probeGroupCount
    });

    it('respects custom probeGroupCount', () => {
      const abr = createAbrController();
      const strategy = new AbrFetchStrategy({ abrController: abr, altGroup: 1, probeGroupCount: 3 });
      const ctx = createContext();
      expect(strategy.getInitialFetchSize(ctx)).toBe(3);
    });
  });

  describe('getMinFramesForPlayback', () => {
    it('returns 1 GOP for fast start', () => {
      const abr = createAbrController();
      const strategy = new AbrFetchStrategy({ abrController: abr, altGroup: 1 });
      expect(strategy.getMinFramesForPlayback(60)).toBe(60);
    });
  });

  describe('ramp-up phase', () => {
    it('starts in ramp-up phase', () => {
      const abr = createAbrController();
      const strategy = new AbrFetchStrategy({ abrController: abr, altGroup: 1 });
      expect(strategy.getPhase()).toBe('ramp-up');
    });

    it('fetches small probe batches during ramp-up', () => {
      const abr = createAbrController();
      const strategy = new AbrFetchStrategy({ abrController: abr, altGroup: 1, probeGroupCount: 2 });
      const ctx = createContext({ highestInFlightGroup: -1 });
      const decision = strategy.getNextFetch(ctx);
      expect(decision.shouldFetch).toBe(true);
      expect(decision.endGroup - decision.startGroup + 1).toBe(2);
    });

    it('waits for in-flight fetches before probing', () => {
      const abr = createAbrController();
      const strategy = new AbrFetchStrategy({ abrController: abr, altGroup: 1 });
      const ctx = createContext({ activeFetchCount: 1 });
      const decision = strategy.getNextFetch(ctx);
      expect(decision.shouldFetch).toBe(false);
    });

    it('includes current track name in fetch decision', () => {
      const abr = createAbrController();
      const strategy = new AbrFetchStrategy({ abrController: abr, altGroup: 1 });
      const ctx = createContext();
      const decision = strategy.getNextFetch(ctx);
      expect(decision.trackName).toBe('video-low');
    });

    it('transitions to steady when at highest quality', () => {
      const abr = createAbrController();
      abr.setActiveTrack(1, 'video-high');
      const strategy = new AbrFetchStrategy({ abrController: abr, altGroup: 1 });
      const ctx = createContext({ highestInFlightGroup: 1 });
      strategy.getNextFetch(ctx);
      expect(strategy.getPhase()).toBe('steady');
    });
  });

  describe('steady phase - tier-based buffer targets', () => {
    it('uses switching buffer target at lowest quality', () => {
      const abr = createAbrController();
      const strategy = new AbrFetchStrategy({
        abrController: abr,
        altGroup: 1,
        switchingBufferSec: 4,
        intermediateBufferSec: 30,
        topBufferSec: 60,
      });
      expect(strategy.getBufferTarget('lowest')).toBe(4);
      expect(strategy.getBufferTarget('intermediate')).toBe(30);
      expect(strategy.getBufferTarget('highest')).toBe(60);
    });

    it('fetches when buffer drops below threshold at highest quality', () => {
      const abr = createAbrController();
      abr.setActiveTrack(1, 'video-high');
      const strategy = new AbrFetchStrategy({
        abrController: abr,
        altGroup: 1,
        topBufferSec: 60,
      });

      // Trigger transition to steady
      let ctx = createContext({ highestInFlightGroup: 1 });
      strategy.getNextFetch(ctx);
      expect(strategy.getPhase()).toBe('steady');

      // Buffer at 30s, below 67% of 60s = 40.2s threshold
      ctx = createContext({ bufferedSeconds: 30, highestInFlightGroup: 1, gopDurationSec: 2 });
      const decision = strategy.getNextFetch(ctx);
      expect(decision.shouldFetch).toBe(true);
      // Should fetch (60 - 30) / 2 = 15 GOPs
      expect(decision.endGroup - decision.startGroup + 1).toBe(15);
    });

    it('does not fetch when buffer is above threshold', () => {
      const abr = createAbrController();
      abr.setActiveTrack(1, 'video-high');
      const strategy = new AbrFetchStrategy({
        abrController: abr,
        altGroup: 1,
        topBufferSec: 60,
      });

      // Trigger transition to steady
      let ctx = createContext({ highestInFlightGroup: 1 });
      strategy.getNextFetch(ctx);

      // Buffer at 50s, above 67% of 60s = 40.2s
      ctx = createContext({ bufferedSeconds: 50, highestInFlightGroup: 29 });
      const decision = strategy.getNextFetch(ctx);
      expect(decision.shouldFetch).toBe(false);
    });

    it('uses intermediate buffer target for mid quality', () => {
      const abr = createAbrController();
      abr.setActiveTrack(1, 'video-mid');
      const strategy = new AbrFetchStrategy({
        abrController: abr,
        altGroup: 1,
        intermediateBufferSec: 30,
      });

      // Force to steady phase by providing download history
      let ctx = createContext({
        highestInFlightGroup: 1,
        downloadHistory: [
          { durationMs: 100, groupCount: 2, bytesReceived: 1000 },
          { durationMs: 100, groupCount: 2, bytesReceived: 1000 },
        ],
      });
      strategy.getNextFetch(ctx);

      // Buffer at 15s, below 67% of 30s = 20.1s
      ctx = createContext({ bufferedSeconds: 15, highestInFlightGroup: 1, gopDurationSec: 2 });
      const decision = strategy.getNextFetch(ctx);
      expect(decision.shouldFetch).toBe(true);
      expect(decision.trackName).toBe('video-mid');
    });
  });

  describe('throughput feeding', () => {
    it('feeds bandwidth to ABR controller from download history', () => {
      const abr = createAbrController();
      const reportSpy = vi.spyOn(abr, 'reportBandwidth');
      const strategy = new AbrFetchStrategy({ abrController: abr, altGroup: 1 });

      const ctx = createContext({
        downloadHistory: [
          { durationMs: 1000, groupCount: 2, bytesReceived: 1_000_000 }, // 8 Mbps
        ],
      });
      strategy.getNextFetch(ctx);

      expect(reportSpy).toHaveBeenCalledWith(8_000_000); // 1M bytes * 8 / 1s
    });

    it('feeds buffer level to ABR controller', () => {
      const abr = createAbrController();
      const reportSpy = vi.spyOn(abr, 'reportBufferLevel');
      const strategy = new AbrFetchStrategy({ abrController: abr, altGroup: 1 });

      const ctx = createContext({ bufferedSeconds: 5.5 });
      strategy.getNextFetch(ctx);

      expect(reportSpy).toHaveBeenCalledWith(5.5);
    });
  });
});
