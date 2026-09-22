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
  encodeTrackNamespaceBytes,
  decodeTrackNamespaceBytes,
  buildTrackProperties,
  mapSubscribeFilter,
} from './session-helpers.js';

const shortNs = ['room-1', 'video'];
const longNs = [
  'conference',
  'org.example.large-tenant',
  'room-a1b2c3d4e5f6',
  'participant-42',
  'media',
  'video',
];

describe('encodeTrackNamespaceBytes', () => {
  bench('short namespace (2 tuples)', () => {
    encodeTrackNamespaceBytes(shortNs);
  });
  bench('long namespace (6 tuples)', () => {
    encodeTrackNamespaceBytes(longNs);
  });
});

describe('decodeTrackNamespaceBytes', () => {
  const shortEncoded = encodeTrackNamespaceBytes(shortNs);
  const longEncoded = encodeTrackNamespaceBytes(longNs);
  bench('short namespace roundtrip', () => {
    decodeTrackNamespaceBytes(shortEncoded);
  });
  bench('long namespace roundtrip', () => {
    decodeTrackNamespaceBytes(longEncoded);
  });
});

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
