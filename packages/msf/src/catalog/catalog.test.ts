// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { describe, it, expect } from 'vitest';
import { createCatalog, CatalogBuilder } from './builder.js';
import {
  parseCatalog,
  parseFullCatalog,
  parseDeltaCatalog,
  CatalogParseError,
  parseCatalogFromBytes,
} from './parser.js';
import { serializeCatalog, serializeCatalogToBytes } from './serializer.js';
import { generateDelta, applyDelta, createDelta, DeltaError } from './delta.js';
import { MSF_VERSION } from '../version.js';
import type { FullCatalog, Track } from '../schemas/index.js';

describe('CatalogBuilder', () => {
  it('should create an empty catalog', () => {
    const catalog = createCatalog().build();
    expect(catalog.version).toBe(MSF_VERSION);
    expect(catalog.tracks).toEqual([]);
  });

  it('should add video tracks', () => {
    const catalog = createCatalog()
      .addVideoTrack({
        name: 'video-main',
        codec: 'avc1.4D401E',
        width: 1280,
        height: 720,
        framerate: 30,
        bitrate: 2_000_000,
        isLive: true,
      })
      .build();

    expect(catalog.tracks).toHaveLength(1);
    expect(catalog.tracks[0].name).toBe('video-main');
    expect(catalog.tracks[0].codec).toBe('avc1.4D401E');
    expect(catalog.tracks[0].width).toBe(1280);
    expect(catalog.tracks[0].height).toBe(720);
    expect(catalog.tracks[0].framerate).toBe(30);
    expect(catalog.tracks[0].bitrate).toBe(2_000_000);
    expect(catalog.tracks[0].isLive).toBe(true);
    expect(catalog.tracks[0].packaging).toBe('loc');
  });

  it('should add audio tracks', () => {
    const catalog = createCatalog()
      .addAudioTrack({
        name: 'audio-main',
        codec: 'opus',
        samplerate: 48000,
        channelConfig: 'stereo',
        isLive: true,
      })
      .build();

    expect(catalog.tracks).toHaveLength(1);
    expect(catalog.tracks[0].name).toBe('audio-main');
    expect(catalog.tracks[0].codec).toBe('opus');
    expect(catalog.tracks[0].samplerate).toBe(48000);
    expect(catalog.tracks[0].channelConfig).toBe('stereo');
  });

  it('should add data tracks', () => {
    const catalog = createCatalog()
      .addDataTrack({
        name: 'metadata',
        packaging: 'eventtimeline',
        isLive: true,
        mimeType: 'application/json',
      })
      .build();

    expect(catalog.tracks).toHaveLength(1);
    expect(catalog.tracks[0].name).toBe('metadata');
    expect(catalog.tracks[0].packaging).toBe('eventtimeline');
    expect(catalog.tracks[0].mimeType).toBe('application/json');
  });

  it('should set generatedAt timestamp', () => {
    const before = Date.now();
    const catalog = createCatalog().generatedAt().build();
    const after = Date.now();

    expect(catalog.generatedAt).toBeDefined();
    expect(catalog.generatedAt).toBeGreaterThanOrEqual(before);
    expect(catalog.generatedAt).toBeLessThanOrEqual(after);
  });

  it('should set isComplete flag', () => {
    const catalog = createCatalog().isComplete().build();
    expect(catalog.isComplete).toBe(true);
  });

  it('should add multiple tracks with fluent API', () => {
    const catalog = createCatalog()
      .addVideoTrack({
        name: 'video-main',
        codec: 'avc1.4D401E',
        width: 1920,
        height: 1080,
        isLive: true,
      })
      .addVideoTrack({
        name: 'video-alt',
        codec: 'avc1.4D401E',
        width: 1280,
        height: 720,
        isLive: true,
        altGroup: 1,
      })
      .addAudioTrack({
        name: 'audio-main',
        codec: 'opus',
        isLive: true,
      })
      .build();

    expect(catalog.tracks).toHaveLength(3);
  });
});

describe('CatalogParser', () => {
  it('should parse valid full catalog', () => {
    const json = JSON.stringify({
      version: MSF_VERSION,
      tracks: [
        { name: 'test', packaging: 'loc', isLive: true },
      ],
    });

    const catalog = parseFullCatalog(json);
    expect(catalog.version).toBe(MSF_VERSION);
    expect(catalog.tracks).toHaveLength(1);
  });

  it('should parse valid delta catalog', () => {
    const json = JSON.stringify({
      version: MSF_VERSION,
      deltaUpdate: true,
      addTracks: [
        { name: 'new-track', packaging: 'loc', isLive: false },
      ],
    });

    const catalog = parseDeltaCatalog(json);
    expect(catalog.deltaUpdate).toBe(true);
    expect(catalog.addTracks).toHaveLength(1);
  });

  it('should throw on invalid JSON', () => {
    expect(() => parseCatalog('not json')).toThrow(CatalogParseError);
  });

  it('should throw on invalid catalog structure', () => {
    const json = JSON.stringify({ invalid: true });
    expect(() => parseCatalog(json)).toThrow(CatalogParseError);
  });

  it('should parse catalog from bytes', () => {
    const json = JSON.stringify({
      version: MSF_VERSION,
      tracks: [],
    });
    const bytes = new TextEncoder().encode(json);

    const catalog = parseCatalogFromBytes(bytes);
    expect(catalog.version).toBe(MSF_VERSION);
  });
});

describe('CatalogSerializer', () => {
  it('should serialize catalog to JSON', () => {
    const catalog = createCatalog()
      .addVideoTrack({
        name: 'test',
        codec: 'avc1',
        width: 640,
        height: 480,
        isLive: true,
      })
      .build();

    const json = serializeCatalog(catalog);
    const parsed = JSON.parse(json);

    expect(parsed.version).toBe(MSF_VERSION);
    expect(parsed.tracks).toHaveLength(1);
  });

  it('should serialize with pretty printing', () => {
    const catalog = createCatalog().build();
    const json = serializeCatalog(catalog, { pretty: true });

    expect(json).toContain('\n');
  });

  it('should serialize to bytes', () => {
    const catalog = createCatalog().build();
    const bytes = serializeCatalogToBytes(catalog);

    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(0);
  });

  it('should roundtrip serialize/parse', () => {
    const original = createCatalog()
      .generatedAt(1234567890)
      .addVideoTrack({
        name: 'video',
        codec: 'avc1',
        width: 1920,
        height: 1080,
        framerate: 30,
        isLive: true,
      })
      .addAudioTrack({
        name: 'audio',
        codec: 'opus',
        samplerate: 48000,
        isLive: true,
      })
      .build();

    const json = serializeCatalog(original);
    const parsed = parseFullCatalog(json);

    expect(parsed.version).toBe(original.version);
    expect(parsed.tracks).toHaveLength(original.tracks.length);
    expect(parsed.generatedAt).toBe(original.generatedAt);
  });
});

describe('Delta operations', () => {
  const baseCatalog: FullCatalog = {
    version: MSF_VERSION,
    tracks: [
      { name: 'track-a', packaging: 'loc', isLive: true },
      { name: 'track-b', packaging: 'loc', isLive: true },
    ],
  };

  describe('generateDelta', () => {
    it('should detect added tracks', () => {
      const newCatalog: FullCatalog = {
        version: MSF_VERSION,
        tracks: [
          ...baseCatalog.tracks,
          { name: 'track-c', packaging: 'loc', isLive: true },
        ],
      };

      const delta = generateDelta(baseCatalog, newCatalog);

      expect(delta).not.toBeNull();
      expect(delta!.deltaUpdate).toBe(true);
      expect(delta!.addTracks).toHaveLength(1);
      expect(delta!.addTracks![0].name).toBe('track-c');
    });

    it('should detect removed tracks', () => {
      const newCatalog: FullCatalog = {
        version: MSF_VERSION,
        tracks: [baseCatalog.tracks[0]],
      };

      const delta = generateDelta(baseCatalog, newCatalog);

      expect(delta).not.toBeNull();
      expect(delta!.removeTracks).toHaveLength(1);
      expect(delta!.removeTracks![0]).toBe('track-b');
    });

    it('should return null when no changes', () => {
      const delta = generateDelta(baseCatalog, baseCatalog);
      expect(delta).toBeNull();
    });

    it('should detect modified tracks', () => {
      const newCatalog: FullCatalog = {
        version: MSF_VERSION,
        tracks: [
          { name: 'track-a', packaging: 'loc', isLive: false }, // Changed isLive
          baseCatalog.tracks[1],
        ],
      };

      const delta = generateDelta(baseCatalog, newCatalog);

      expect(delta).not.toBeNull();
      // Modified tracks are removed and re-added
      expect(delta!.removeTracks).toContain('track-a');
      expect(delta!.addTracks?.find((t) => t.name === 'track-a')).toBeDefined();
    });
  });

  describe('applyDelta', () => {
    it('should add tracks', () => {
      const delta = createDelta()
        .add({ name: 'track-c', packaging: 'loc', isLive: true })
        .build();

      const result = applyDelta(baseCatalog, delta);

      expect(result.tracks).toHaveLength(3);
      expect(result.tracks.find((t) => t.name === 'track-c')).toBeDefined();
    });

    it('should remove tracks', () => {
      const delta = createDelta().remove('track-b').build();

      const result = applyDelta(baseCatalog, delta);

      expect(result.tracks).toHaveLength(1);
      expect(result.tracks.find((t) => t.name === 'track-b')).toBeUndefined();
    });

    it('should clone tracks', () => {
      const delta = createDelta()
        .clone('track-a', 'track-a-copy', { isLive: false })
        .build();

      const result = applyDelta(baseCatalog, delta);

      expect(result.tracks).toHaveLength(3);
      const cloned = result.tracks.find((t) => t.name === 'track-a-copy');
      expect(cloned).toBeDefined();
      expect(cloned!.isLive).toBe(false);
      expect(cloned!.packaging).toBe('loc'); // Inherited from source
    });

    it('should throw on duplicate track name', () => {
      const delta = createDelta()
        .add({ name: 'track-a', packaging: 'loc', isLive: true })
        .build();

      expect(() => applyDelta(baseCatalog, delta)).toThrow(DeltaError);
    });

    it('should throw on clone from missing source', () => {
      const delta = createDelta()
        .clone('nonexistent', 'new-track')
        .build();

      expect(() => applyDelta(baseCatalog, delta)).toThrow(DeltaError);
    });
  });

  describe('DeltaBuilder', () => {
    it('should track changes', () => {
      const builder = createDelta()
        .add({ name: 'new', packaging: 'loc', isLive: true })
        .remove('old');

      expect(builder.hasChanges()).toBe(true);
    });

    it('should report no changes when empty', () => {
      const builder = createDelta();
      expect(builder.hasChanges()).toBe(false);
    });

    it('should set generatedAt', () => {
      const before = Date.now();
      const delta = createDelta().generatedAt().build();
      const after = Date.now();

      expect(delta.generatedAt).toBeDefined();
      expect(delta.generatedAt).toBeGreaterThanOrEqual(before);
      expect(delta.generatedAt).toBeLessThanOrEqual(after);
    });
  });
});
