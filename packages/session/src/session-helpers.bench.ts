// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Micro-benchmarks for pure session helpers.  These functions
 * sit on the encode/decode hot path for setup and namespace/track prefix
 * encoding — a regression here bleeds into every publish/subscribe.
 *
 * Run: `pnpm --filter @moq-web/session exec vitest bench --run
 * src/session-helpers.bench.ts`.
 */

import { bench, describe } from 'vitest';
import {
  buildTrackProperties,
  mapSubscribeFilter,
} from './session-helpers.js';

describe('buildTrackProperties', () => {
  bench('no properties (returns undefined)', () => {
    buildTrackProperties();
  });
  bench('all properties set', () => {
    buildTrackProperties({
      subgroupDeliveryTimeout: 1000,
      objectDeliveryTimeout: 500,
      priority: 128,
      maxCacheDuration: 60_000,
    });
  });
});

describe('mapSubscribeFilter', () => {
  bench('largest-object', () => {
    mapSubscribeFilter({ filterType: 'largest-object' });
  });
  bench('absolute-range with locations', () => {
    mapSubscribeFilter({
      filterType: 'absolute-range',
      startGroup: 100,
      startObject: 50,
      endGroup: 200,
    });
  });
});
