// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { describe, it, expect } from 'vitest';
import {
  TrackSchema,
  PackagingEnum,
  TrackRoleEnum,
  ChannelConfigEnum,
  EncryptionSchemeEnum,
  CipherSuiteEnum,
  AccessibilityTypeEnum,
  FullCatalogSchema,
  DeltaCatalogSchema,
  MediaTimelineTemplateSchema,
  MediaTimelineTemplateArraySchema,
  EventTimelineEntrySchema,
  LocationRefSchema,
} from './index.js';
import { MSF_VERSION } from '../version.js';

describe('TrackSchema', () => {
  describe('required fields', () => {
    it('should accept valid track with required fields', () => {
      const result = TrackSchema.safeParse({
        name: 'video-main',
        packaging: 'loc',
        isLive: true,
      });
      expect(result.success).toBe(true);
    });

    it('should reject track without name', () => {
      const result = TrackSchema.safeParse({
        packaging: 'loc',
        isLive: true,
      });
      expect(result.success).toBe(false);
    });

    it('should reject track with empty name', () => {
      const result = TrackSchema.safeParse({
        name: '',
        packaging: 'loc',
        isLive: true,
      });
      expect(result.success).toBe(false);
    });

    it('should reject track without packaging', () => {
      const result = TrackSchema.safeParse({
        name: 'test',
        isLive: true,
      });
      expect(result.success).toBe(false);
    });

    it('should reject track without isLive', () => {
      const result = TrackSchema.safeParse({
        name: 'test',
        packaging: 'loc',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('optional fields', () => {
    it('should accept track with all optional video fields', () => {
      const result = TrackSchema.safeParse({
        name: 'video',
        packaging: 'loc',
        isLive: true,
        codec: 'avc1.4D401E',
        width: 1920,
        height: 1080,
        displayWidth: 1920,
        displayHeight: 1080,
        framerate: 30,
        bitrate: 5000000,
      });
      expect(result.success).toBe(true);
    });

    it('should accept track with all optional audio fields', () => {
      const result = TrackSchema.safeParse({
        name: 'audio',
        packaging: 'loc',
        isLive: true,
        codec: 'opus',
        samplerate: 48000,
        channelConfig: 'stereo',
        bitrate: 128000,
      });
      expect(result.success).toBe(true);
    });

    it('should accept track with eventType for eventtimeline', () => {
      const result = TrackSchema.safeParse({
        name: 'events',
        packaging: 'eventtimeline',
        isLive: true,
        eventType: 'ad-markers',
      });
      expect(result.success).toBe(true);
    });

    it('should accept track with encryption fields', () => {
      const result = TrackSchema.safeParse({
        name: 'video',
        packaging: 'loc',
        isLive: true,
        encryptionScheme: 'moq-secure-objects',
        cipherSuite: 'aes-128-gcm-sha256',
        keyId: 'base64keyid==',
      });
      expect(result.success).toBe(true);
    });

    it('should accept track with accessibility features', () => {
      const result = TrackSchema.safeParse({
        name: 'captions',
        packaging: 'loc',
        isLive: true,
        role: 'caption',
        accessibility: [
          { type: 'cea708', lang: 'en', channel: 1 },
        ],
      });
      expect(result.success).toBe(true);
    });

    it('should accept track with SVC layer IDs', () => {
      const result = TrackSchema.safeParse({
        name: 'video-svc',
        packaging: 'loc',
        isLive: true,
        temporalId: 0,
        spatialId: 2,
      });
      expect(result.success).toBe(true);
    });

    it('should accept track with namespace', () => {
      const result = TrackSchema.safeParse({
        name: 'video',
        packaging: 'loc',
        isLive: true,
        namespace: ['conference', 'room-123'],
      });
      expect(result.success).toBe(true);
    });
  });

  describe('field validation', () => {
    it('should reject negative width', () => {
      const result = TrackSchema.safeParse({
        name: 'video',
        packaging: 'loc',
        isLive: true,
        width: -100,
      });
      expect(result.success).toBe(false);
    });

    it('should reject negative framerate', () => {
      const result = TrackSchema.safeParse({
        name: 'video',
        packaging: 'loc',
        isLive: true,
        framerate: -30,
      });
      expect(result.success).toBe(false);
    });

    it('should reject negative renderGroup', () => {
      const result = TrackSchema.safeParse({
        name: 'video',
        packaging: 'loc',
        isLive: true,
        renderGroup: -1,
      });
      expect(result.success).toBe(false);
    });

    it('should reject non-integer timescale', () => {
      const result = TrackSchema.safeParse({
        name: 'video',
        packaging: 'loc',
        isLive: true,
        timescale: 90000.5,
      });
      expect(result.success).toBe(false);
    });
  });
});

describe('PackagingEnum', () => {
  it('should accept valid packaging types', () => {
    expect(PackagingEnum.safeParse('loc').success).toBe(true);
    expect(PackagingEnum.safeParse('mediatimeline').success).toBe(true);
    expect(PackagingEnum.safeParse('eventtimeline').success).toBe(true);
  });

  it('should reject invalid packaging type', () => {
    expect(PackagingEnum.safeParse('invalid').success).toBe(false);
    expect(PackagingEnum.safeParse('LOC').success).toBe(false);
  });
});

describe('TrackRoleEnum', () => {
  it('should accept all valid roles', () => {
    const validRoles = [
      'main', 'alternate', 'supplementary', 'commentary', 'dub',
      'emergency', 'caption', 'subtitle', 'sign-language', 'metadata',
      'logs', 'metrics',
    ];

    for (const role of validRoles) {
      expect(TrackRoleEnum.safeParse(role).success).toBe(true);
    }
  });

  it('should reject invalid role', () => {
    expect(TrackRoleEnum.safeParse('primary').success).toBe(false);
    expect(TrackRoleEnum.safeParse('MAIN').success).toBe(false);
  });
});

describe('ChannelConfigEnum', () => {
  it('should accept valid channel configs', () => {
    const validConfigs = ['mono', 'stereo', 'surround-5.1', 'surround-7.1', 'atmos'];

    for (const config of validConfigs) {
      expect(ChannelConfigEnum.safeParse(config).success).toBe(true);
    }
  });

  it('should reject invalid channel config', () => {
    expect(ChannelConfigEnum.safeParse('5.1').success).toBe(false);
    expect(ChannelConfigEnum.safeParse('quadraphonic').success).toBe(false);
  });
});

describe('EncryptionSchemeEnum', () => {
  it('should accept moq-secure-objects (recommended)', () => {
    expect(EncryptionSchemeEnum.safeParse('moq-secure-objects').success).toBe(true);
  });

  it('should accept legacy schemes', () => {
    const legacySchemes = ['cenc', 'cbc1', 'cens', 'cbcs'];

    for (const scheme of legacySchemes) {
      expect(EncryptionSchemeEnum.safeParse(scheme).success).toBe(true);
    }
  });

  it('should reject invalid scheme', () => {
    expect(EncryptionSchemeEnum.safeParse('aes').success).toBe(false);
  });
});

describe('CipherSuiteEnum', () => {
  it('should accept mandatory cipher suite', () => {
    expect(CipherSuiteEnum.safeParse('aes-128-gcm-sha256').success).toBe(true);
  });

  it('should accept optional cipher suites', () => {
    expect(CipherSuiteEnum.safeParse('aes-256-gcm-sha512').success).toBe(true);
    expect(CipherSuiteEnum.safeParse('aes-128-ctr-hmac-sha256-80').success).toBe(true);
  });

  it('should reject invalid cipher suite', () => {
    expect(CipherSuiteEnum.safeParse('aes-256-cbc').success).toBe(false);
  });
});

describe('AccessibilityTypeEnum', () => {
  it('should accept all accessibility types', () => {
    const validTypes = ['cea608', 'cea708', 'dvb-subtitles', 'ttml', 'webvtt'];

    for (const type of validTypes) {
      expect(AccessibilityTypeEnum.safeParse(type).success).toBe(true);
    }
  });

  it('should reject invalid type', () => {
    expect(AccessibilityTypeEnum.safeParse('srt').success).toBe(false);
  });
});

describe('CatalogSchema', () => {
  describe('FullCatalogSchema', () => {
    it('should accept valid full catalog', () => {
      const result = FullCatalogSchema.safeParse({
        version: MSF_VERSION,
        tracks: [
          { name: 'video', packaging: 'loc', isLive: true },
        ],
      });
      expect(result.success).toBe(true);
    });

    it('should accept catalog with optional fields', () => {
      const result = FullCatalogSchema.safeParse({
        version: MSF_VERSION,
        tracks: [],
        generatedAt: Date.now(),
        isComplete: true,
      });
      expect(result.success).toBe(true);
    });

    it('should reject wrong version', () => {
      const result = FullCatalogSchema.safeParse({
        version: 999,
        tracks: [],
      });
      expect(result.success).toBe(false);
    });

    it('should reject catalog without tracks', () => {
      const result = FullCatalogSchema.safeParse({
        version: MSF_VERSION,
      });
      expect(result.success).toBe(false);
    });
  });

  describe('DeltaCatalogSchema', () => {
    it('should accept valid delta catalog with addTracks', () => {
      const result = DeltaCatalogSchema.safeParse({
        version: MSF_VERSION,
        deltaUpdate: true,
        addTracks: [
          { name: 'new-track', packaging: 'loc', isLive: true },
        ],
      });
      expect(result.success).toBe(true);
    });

    it('should accept delta catalog with removeTracks', () => {
      const result = DeltaCatalogSchema.safeParse({
        version: MSF_VERSION,
        deltaUpdate: true,
        removeTracks: ['old-track'],
      });
      expect(result.success).toBe(true);
    });

    it('should accept delta catalog with cloneTracks', () => {
      const result = DeltaCatalogSchema.safeParse({
        version: MSF_VERSION,
        deltaUpdate: true,
        cloneTracks: [
          { sourceName: 'video', name: 'video-copy' },
        ],
      });
      expect(result.success).toBe(true);
    });

    it('should require deltaUpdate to be true', () => {
      const result = DeltaCatalogSchema.safeParse({
        version: MSF_VERSION,
        deltaUpdate: false,
        addTracks: [],
      });
      expect(result.success).toBe(false);
    });
  });
});

describe('TimelineSchemas', () => {
  describe('LocationRefSchema', () => {
    it('should accept valid location', () => {
      expect(LocationRefSchema.safeParse([0, 0]).success).toBe(true);
      expect(LocationRefSchema.safeParse([100, 50]).success).toBe(true);
    });

    it('should reject negative values', () => {
      expect(LocationRefSchema.safeParse([-1, 0]).success).toBe(false);
      expect(LocationRefSchema.safeParse([0, -1]).success).toBe(false);
    });

    it('should reject non-integer values', () => {
      expect(LocationRefSchema.safeParse([1.5, 0]).success).toBe(false);
    });

    it('should reject wrong length', () => {
      expect(LocationRefSchema.safeParse([0]).success).toBe(false);
      expect(LocationRefSchema.safeParse([0, 0, 0]).success).toBe(false);
    });
  });

  describe('EventTimelineEntrySchema', () => {
    it('should accept entry with wallclock time (t)', () => {
      const result = EventTimelineEntrySchema.safeParse({
        t: 1700000000000,
        data: { type: 'marker' },
      });
      expect(result.success).toBe(true);
    });

    it('should accept entry with location (l)', () => {
      const result = EventTimelineEntrySchema.safeParse({
        l: [5, 10],
        data: { action: 'seek' },
      });
      expect(result.success).toBe(true);
    });

    it('should accept entry with media time (m)', () => {
      const result = EventTimelineEntrySchema.safeParse({
        m: 90000,
      });
      expect(result.success).toBe(true);
    });

    it('should accept entry with multiple references', () => {
      const result = EventTimelineEntrySchema.safeParse({
        t: 1700000000000,
        l: [1, 0],
        m: 90000,
        data: { combined: true },
      });
      expect(result.success).toBe(true);
    });

    it('should reject invalid location format', () => {
      const result = EventTimelineEntrySchema.safeParse({
        l: 'invalid',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('MediaTimelineTemplateArraySchema', () => {
    it('should accept valid spec format template', () => {
      const result = MediaTimelineTemplateArraySchema.safeParse([
        0,           // startMediaTime
        3000,        // deltaMediaTime
        [0, 0],      // [startGroupId, startObjectId]
        [0, 1],      // [deltaGroupId, deltaObjectId]
        1700000000000, // startWallclock
        33,          // deltaWallclock
      ]);
      expect(result.success).toBe(true);
    });

    it('should reject template with wrong length', () => {
      const result = MediaTimelineTemplateArraySchema.safeParse([
        0, 3000, [0, 0], [0, 1], 1700000000000, // missing deltaWallclock
      ]);
      expect(result.success).toBe(false);
    });

    it('should reject template with invalid location', () => {
      const result = MediaTimelineTemplateArraySchema.safeParse([
        0, 3000, [0], [0, 1], 1700000000000, 33, // invalid startLocation
      ]);
      expect(result.success).toBe(false);
    });
  });

  describe('MediaTimelineTemplateSchema', () => {
    it('should accept valid object format template', () => {
      const result = MediaTimelineTemplateSchema.safeParse({
        startMediaTime: 0,
        deltaMediaTime: 3000,
        startGroupId: 0,
        startObjectId: 0,
        deltaGroupId: 0,
        deltaObjectId: 1,
        startWallclock: 1700000000000,
        deltaWallclock: 33,
      });
      expect(result.success).toBe(true);
    });

    it('should require deltaMediaTime', () => {
      const result = MediaTimelineTemplateSchema.safeParse({
        startGroupId: 0,
      });
      expect(result.success).toBe(false);
    });

    it('should reject non-positive deltaMediaTime', () => {
      const result = MediaTimelineTemplateSchema.safeParse({
        deltaMediaTime: 0,
        startGroupId: 0,
      });
      expect(result.success).toBe(false);
    });

    it('should use default values', () => {
      const result = MediaTimelineTemplateSchema.safeParse({
        deltaMediaTime: 3000,
        startGroupId: 0,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.startMediaTime).toBe(0);
        expect(result.data.startObjectId).toBe(0);
      }
    });
  });
});
