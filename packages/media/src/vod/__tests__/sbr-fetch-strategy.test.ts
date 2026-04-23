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
    it('returns enough GOPs for target buffer', () => {
      const strategy = new SbrFetchStrategy({ targetBufferSec: 30, lowBufferSec: 20, highBufferSec: 40 });
      const ctx = createContext({ gopDurationSec: 2 });
      expect(strategy.getInitialFetchSize(ctx)).toBe(15); // 30 / 2 = 15 GOPs
    });

    it('rounds up for non-even divisions', () => {
      const strategy = new SbrFetchStrategy({ targetBufferSec: 30, lowBufferSec: 20, highBufferSec: 40 });
      const ctx = createContext({ gopDurationSec: 4 });
      expect(strategy.getInitialFetchSize(ctx)).toBe(8); // ceil(30/4) = 8
    });
  });

  describe('getMinFramesForPlayback', () => {
    it('returns 1 GOP worth of frames for fast start', () => {
      const strategy = new SbrFetchStrategy();
      expect(strategy.getMinFramesForPlayback(60)).toBe(60); // 1 GOP = 60 frames
      expect(strategy.getMinFramesForPlayback(30)).toBe(30);
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

    it('does not fetch during initial fill phase', () => {
      const strategy = new SbrFetchStrategy({ targetBufferSec: 30, lowBufferSec: 20, highBufferSec: 40 });
      // Buffer is partially filled but below 90% of target - still in initial fill
      const ctx = createContext({ bufferedSeconds: 15, highestInFlightGroup: 14 });
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
      // Should fetch enough to reach highBufferSec: (40 - 20) / 2 = 10 GOPs
      expect(decision.endGroup - decision.startGroup + 1).toBe(10);
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
      // (40 - 10) / 2 = 15 GOPs
      expect(decision.endGroup - decision.startGroup + 1).toBe(15);
    });

    it('caps fetch at totalGroups boundary', () => {
      const strategy = new SbrFetchStrategy({ targetBufferSec: 30, lowBufferSec: 20, highBufferSec: 40 });
      // Complete initial fill
      let ctx = createContext({ bufferedSeconds: 30, highestInFlightGroup: 14, totalGroups: 20 });
      strategy.getNextFetch(ctx);

      // Buffer drops, but only 5 groups left (15-19)
      ctx = createContext({ bufferedSeconds: 15, highestInFlightGroup: 14, totalGroups: 20, gopDurationSec: 2 });
      const decision = strategy.getNextFetch(ctx);
      expect(decision.shouldFetch).toBe(true);
      expect(decision.endGroup).toBe(19); // totalGroups - 1
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
