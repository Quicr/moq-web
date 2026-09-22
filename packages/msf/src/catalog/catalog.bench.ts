// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Micro-benchmarks for catalog build / parse / delta.
 *
 * Baseline for the hot paths a publisher hits when publishing MSF §5 catalogs
 * and delta updates.  Run with `pnpm --filter @moq-web/msf exec vitest bench
 * --run`.
 */

import { bench, describe } from 'vitest';
import { CatalogBuilder } from './builder.js';
import { parseCatalog, parseCatalogFromBytes } from './parser.js';
import { serializeCatalog, serializeCatalogToBytes } from './serializer.js';
import { generateDelta } from './delta.js';
import type { FullCatalog } from '../types/index.js';

function buildCatalog(trackCount: number): FullCatalog {
  const builder = new CatalogBuilder().generatedAt(1_700_000_000_000);
  for (let i = 0; i < trackCount; i++) {
    builder.addVideoTrack({
      name: `video-${i}`,
      isLive: true,
      codec: 'avc1.640028',
      width: 1920,
      height: 1080,
      framerate: 30,
      bitrate: 4_500_000,
      namespace: ['conference', 'room-1', `stream-${i}`],
    });
  }
  return builder.build() as FullCatalog;
}

describe('catalog build', () => {
  bench('build 1-track catalog', () => {
    buildCatalog(1);
  });
  bench('build 10-track catalog', () => {
    buildCatalog(10);
  });
  bench('build 50-track catalog', () => {
    buildCatalog(50);
  });
});

describe('catalog serialize', () => {
  const small = buildCatalog(1);
  const medium = buildCatalog(10);
  const large = buildCatalog(50);

  bench('serialize 1-track (JSON)', () => {
    serializeCatalog(small);
  });
  bench('serialize 10-track (JSON)', () => {
    serializeCatalog(medium);
  });
  bench('serialize 50-track (JSON)', () => {
    serializeCatalog(large);
  });
  bench('serialize 50-track (bytes)', () => {
    serializeCatalogToBytes(large);
  });
});

describe('catalog parse', () => {
  const smallJson = serializeCatalog(buildCatalog(1));
  const mediumJson = serializeCatalog(buildCatalog(10));
  const largeJson = serializeCatalog(buildCatalog(50));
  const largeBytes = serializeCatalogToBytes(buildCatalog(50));

  bench('parse 1-track', () => {
    parseCatalog(smallJson);
  });
  bench('parse 10-track', () => {
    parseCatalog(mediumJson);
  });
  bench('parse 50-track', () => {
    parseCatalog(largeJson);
  });
  bench('parseFromBytes 50-track', () => {
    parseCatalogFromBytes(largeBytes);
  });
});

describe('delta generation', () => {
  const base = buildCatalog(20);
  // Same catalog + one track added / one removed / one modified.
  const evolved: FullCatalog = {
    ...base,
    tracks: [
      ...base.tracks.slice(1),
      { ...base.tracks[0], bitrate: 5_000_000 },
      {
        name: 'video-new',
        packaging: 'loc',
        isLive: true,
        codec: 'avc1.640028',
        width: 1280,
        height: 720,
        namespace: ['conference', 'room-1', 'stream-new'],
      },
    ],
  };

  bench('generateDelta (20 tracks, 3 changes)', () => {
    generateDelta(base, evolved);
  });
});
