// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { describe, it, expect } from 'vitest';
import { SbrFetchStrategy } from '../sbr-fetch-strategy';
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

describe('SbrFetchStrategy', () => {
  describe('getInitialFetchSize', () => {
    it('returns GOPs capped at 4 per request', () => {
      const strategy = new SbrFetchStrategy({ targetBufferSec: 30, lowBufferSec: 20, highBufferSec: 40 });
      const ctx = createContext({ gopDurationSec: 2 });
      // ceil(30/2) = 15, capped at 4
      expect(strategy.getInitialFetchSize(ctx)).toBe(4);
    });

    it('returns fewer GOPs when target fits within cap', () => {
      const strategy = new SbrFetchStrategy({ targetBufferSec: 6, lowBufferSec: 4, highBufferSec: 8 });
      const ctx = createContext({ gopDurationSec: 2 });
      // ceil(6/2) = 3, under cap
      expect(strategy.getInitialFetchSize(ctx)).toBe(3);
    });
  });

  describe('getMinFramesForPlayback', () => {
    it('returns initialBufferSec worth of frames (min 2 GOPs)', () => {
      // Default initialBufferSec is 3, with 2s GOP = ceil(3/2) = 2 GOPs (min 2)
      const strategy = new SbrFetchStrategy();
      // 2 GOPs * 60 frames/GOP = 120 frames
      expect(strategy.getMinFramesForPlayback(60, 2)).toBe(120);
      // 2 GOPs * 30 frames/GOP = 60 frames
      expect(strategy.getMinFramesForPlayback(30, 2)).toBe(60);
    });

    it('respects custom initialBufferSec', () => {
      const strategy = new SbrFetchStrategy({ initialBufferSec: 6 });
      // ceil(6/2) = 3 GOPs, 3 * 30 = 90 frames
      expect(strategy.getMinFramesForPlayback(30, 2)).toBe(90);
    });
  });

  describe('getNextFetch - sawtooth pattern', () => {
    it('does not fetch when at concurrency limit', () => {
      const strategy = new SbrFetchStrategy();
      const ctx = createContext({ activeFetchCount: 1, maxConcurrentFetches: 1 });
      const decision = strategy.getNextFetch(ctx);
      expect(decision.shouldFetch).toBe(false);
    });

    it('does not fetch when all groups fetched', () => {
      const strategy = new SbrFetchStrategy();
      const ctx = createContext({ highestInFlightGroup: 99, totalGroups: 100 });
      const decision = strategy.getNextFetch(ctx);
      expect(decision.shouldFetch).toBe(false);
    });

    it('does not fetch during initial fill phase when fetch is in flight', () => {
      const strategy = new SbrFetchStrategy({ targetBufferSec: 30, lowBufferSec: 20, highBufferSec: 40 });
      const ctx = createContext({ bufferedSeconds: 15, highestInFlightGroup: 14, activeFetchCount: 1 });
      const decision = strategy.getNextFetch(ctx);
      expect(decision.shouldFetch).toBe(false);
    });

    it('does not fetch when buffer is above low threshold', () => {
      const strategy = new SbrFetchStrategy({ targetBufferSec: 30, lowBufferSec: 20, highBufferSec: 40 });
      // Simulate initial fill complete
      let ctx = createContext({ bufferedSeconds: 28, highestInFlightGroup: 14 });
      strategy.getNextFetch(ctx); // marks initial fill done (>= 90% of 30)

      // Now buffer is at 25s, above low threshold of 20s
      ctx = createContext({ bufferedSeconds: 25, highestInFlightGroup: 14 });
      const decision = strategy.getNextFetch(ctx);
      expect(decision.shouldFetch).toBe(false);
    });

    it('fetches when buffer drops to low threshold', () => {
      const strategy = new SbrFetchStrategy({ targetBufferSec: 30, lowBufferSec: 20, highBufferSec: 40 });
      // Complete initial fill
      let ctx = createContext({ bufferedSeconds: 30, highestInFlightGroup: 14 });
      strategy.getNextFetch(ctx);

      // Buffer dropped to 20s (low threshold)
      ctx = createContext({ bufferedSeconds: 20, highestInFlightGroup: 14, gopDurationSec: 2 });
      const decision = strategy.getNextFetch(ctx);
      expect(decision.shouldFetch).toBe(true);
      // (40 - 20) / 2 = 10, capped at 4 GOPs
      expect(decision.endGroup - decision.startGroup + 1).toBe(4);
      expect(decision.startGroup).toBe(15); // highestInFlightGroup + 1
    });

    it('fetches when buffer drops below low threshold', () => {
      const strategy = new SbrFetchStrategy({ targetBufferSec: 30, lowBufferSec: 20, highBufferSec: 40 });
      // Complete initial fill
      let ctx = createContext({ bufferedSeconds: 30, highestInFlightGroup: 14 });
      strategy.getNextFetch(ctx);

      // Buffer at 10s (well below low threshold)
      ctx = createContext({ bufferedSeconds: 10, highestInFlightGroup: 14, gopDurationSec: 2 });
      const decision = strategy.getNextFetch(ctx);
      expect(decision.shouldFetch).toBe(true);
      // (40 - 10) / 2 = 15, capped at 4 GOPs
      expect(decision.endGroup - decision.startGroup + 1).toBe(4);
    });

    it('caps fetch at totalGroups boundary', () => {
      const strategy = new SbrFetchStrategy({ targetBufferSec: 30, lowBufferSec: 20, highBufferSec: 40 });
      // Complete initial fill
      let ctx = createContext({ bufferedSeconds: 30, highestInFlightGroup: 14, totalGroups: 20 });
      strategy.getNextFetch(ctx);

      // Buffer drops, but only 5 groups left (15-19), cap at 4 still means endGroup = 18
      ctx = createContext({ bufferedSeconds: 15, highestInFlightGroup: 14, totalGroups: 20, gopDurationSec: 2 });
      const decision = strategy.getNextFetch(ctx);
      expect(decision.shouldFetch).toBe(true);
      expect(decision.endGroup).toBe(18); // startGroup(15) + 4 - 1 = 18
    });

    it('works with tight sawtooth config', () => {
      const strategy = new SbrFetchStrategy({ targetBufferSec: 30, lowBufferSec: 28, highBufferSec: 32 });
      // Complete initial fill
      let ctx = createContext({ bufferedSeconds: 30, highestInFlightGroup: 14 });
      strategy.getNextFetch(ctx);

      // At 29s - above 28s threshold, no fetch
      ctx = createContext({ bufferedSeconds: 29, highestInFlightGroup: 14 });
      expect(strategy.getNextFetch(ctx).shouldFetch).toBe(false);

      // At 28s - at threshold, should fetch
      ctx = createContext({ bufferedSeconds: 28, highestInFlightGroup: 14 });
      const decision = strategy.getNextFetch(ctx);
      expect(decision.shouldFetch).toBe(true);
      // (32 - 28) / 2 = 2 GOPs
      expect(decision.endGroup - decision.startGroup + 1).toBe(2);
    });

    it('does not include trackName (single bitrate)', () => {
      const strategy = new SbrFetchStrategy({ targetBufferSec: 30, lowBufferSec: 20, highBufferSec: 40 });
      let ctx = createContext({ bufferedSeconds: 30, highestInFlightGroup: 14 });
      strategy.getNextFetch(ctx);

      ctx = createContext({ bufferedSeconds: 15, highestInFlightGroup: 14 });
      const decision = strategy.getNextFetch(ctx);
      expect(decision.trackName).toBeUndefined();
    });
  });
});
