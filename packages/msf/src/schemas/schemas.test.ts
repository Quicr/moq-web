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
  AccessibilitySchema,
  FullCatalogSchema,
  DeltaCatalogSchema,
  MediaTimelineTemplateSchema,
  MediaTimelineTemplateArraySchema,
  EventTimelineEntrySchema,
  LocationRefSchema,
  AuthSchemeSchema,
  assertCatalogImmutability,
  CatalogImmutabilityError,
} from './index.js';
import type { FullCatalog } from './index.js';
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
          { scheme: 'urn:scte:dash:cc:cea-708:2015', value: 'CC1=eng' },
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

  describe('§6 track fields added for spec compliance', () => {
    it('should accept initRef and authInfo', () => {
      const result = TrackSchema.safeParse({
        name: 'video',
        packaging: 'loc',
        isLive: true,
        initRef: 'video-init',
        authInfo: { scheme: 'privacy-pass', token: 'opaque' },
      });
      expect(result.success).toBe(true);
    });

    it('should accept publishTracks-oriented fields', () => {
      const result = TrackSchema.safeParse({
        name: 'client-audio',
        packaging: 'loc',
        isLive: true,
        connectionUri: 'https://relay.example/moq',
        token: 'jwt.opaque.token',
      });
      expect(result.success).toBe(true);
    });

    it('should accept max{Gop,Group}Duration and avgBitrate', () => {
      const result = TrackSchema.safeParse({
        name: 'video',
        packaging: 'loc',
        isLive: true,
        avgBitrate: 4_000_000,
        maxGopDuration: 2000,
        maxGroupDuration: 2500,
      });
      expect(result.success).toBe(true);
    });

    it('should accept buffers alone', () => {
      const result = TrackSchema.safeParse({
        name: 'video',
        packaging: 'loc',
        isLive: true,
        buffers: { target: 1500, min: 500, max: 3000 },
      });
      expect(result.success).toBe(true);
    });

    it('should reject buffers combined with targetLatency', () => {
      const result = TrackSchema.safeParse({
        name: 'video',
        packaging: 'loc',
        isLive: true,
        buffers: { target: 1500 },
        targetLatency: 800,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toContain('mutually exclusive');
      }
    });

    it('should reject authInfo without scheme', () => {
      const result = TrackSchema.safeParse({
        name: 'video',
        packaging: 'loc',
        isLive: true,
        authInfo: { token: 'x' },
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
    expect(PackagingEnum.safeParse('moqlog').success).toBe(true);
    expect(PackagingEnum.safeParse('moqmetrics').success).toBe(true);
    expect(PackagingEnum.safeParse('catalog').success).toBe(true);
  });

  it('should reject invalid packaging type', () => {
    expect(PackagingEnum.safeParse('invalid').success).toBe(false);
    expect(PackagingEnum.safeParse('LOC').success).toBe(false);
  });
});

describe('TrackRoleEnum', () => {
  it('should accept spec-reserved roles (§6 Table 4)', () => {
    const specRoles = [
      'audiodescription', 'video', 'audio', 'mediatimeline', 'eventtimeline',
      'caption', 'subtitle', 'signlanguage', 'log', 'metrics', 'data',
    ];
    for (const role of specRoles) {
      expect(TrackRoleEnum.safeParse(role).success).toBe(true);
    }
  });

  it('should accept common extension roles', () => {
    const extensionRoles = [
      'main', 'alternate', 'supplementary', 'commentary', 'dub', 'emergency',
    ];
    for (const role of extensionRoles) {
      expect(TrackRoleEnum.safeParse(role).success).toBe(true);
    }
  });

  it('should accept legacy aliases for backwards compatibility', () => {
    expect(TrackRoleEnum.safeParse('sign-language').success).toBe(true);
    expect(TrackRoleEnum.safeParse('metadata').success).toBe(true);
    expect(TrackRoleEnum.safeParse('logs').success).toBe(true);
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

  it('should accept reverse-DNS custom schemes (§3)', () => {
    expect(EncryptionSchemeEnum.safeParse('com.example.custom-scheme').success).toBe(true);
    expect(EncryptionSchemeEnum.safeParse('org.moq.experimental.foo').success).toBe(true);
  });

  it('should reject bare shortnames like DASH CENC identifiers', () => {
    for (const scheme of ['cenc', 'cbc1', 'cens', 'cbcs', 'aes']) {
      expect(EncryptionSchemeEnum.safeParse(scheme).success).toBe(false);
    }
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

describe('AccessibilitySchema (§16)', () => {
  it('should accept CEA-608/708 URNs with SCTE 214-1 values', () => {
    for (const scheme of [
      'urn:scte:dash:cc:cea-608:2015',
      'urn:scte:dash:cc:cea-708:2015',
    ]) {
      const result = AccessibilitySchema.safeParse({
        scheme,
        value: 'CC1=eng;CC3=spa',
        label: 'English + Spanish',
      });
      expect(result.success).toBe(true);
    }
  });

  it('should accept custom URN schemes', () => {
    const result = AccessibilitySchema.safeParse({
      scheme: 'urn:example:custom-cc',
    });
    expect(result.success).toBe(true);
  });

  it('should reject shortname scheme values', () => {
    const result = AccessibilitySchema.safeParse({ scheme: 'cea708' });
    expect(result.success).toBe(false);
  });

  it('should reject malformed SCTE 214-1 value', () => {
    const result = AccessibilitySchema.safeParse({
      scheme: 'urn:scte:dash:cc:cea-608:2015',
      value: 'CC1 eng; CC3=spa', // no `=` on first pair
    });
    expect(result.success).toBe(false);
  });
});

describe('AccessibilityTypeEnum (legacy shortnames)', () => {
  it('should accept the two spec-listed shortnames', () => {
    for (const type of ['cea608', 'cea708']) {
      expect(AccessibilityTypeEnum.safeParse(type).success).toBe(true);
    }
  });

  it('should reject non-spec legacy names (removed after URN migration)', () => {
    for (const removed of ['ttml', 'webvtt', 'dvb-subtitles', 'srt']) {
      expect(AccessibilityTypeEnum.safeParse(removed).success).toBe(false);
    }
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

    it('should accept catalog with publishTracks', () => {
      const result = FullCatalogSchema.safeParse({
        version: MSF_VERSION,
        tracks: [],
        publishTracks: [
          { name: 'client-audio', packaging: 'loc', isLive: true },
        ],
      });
      expect(result.success).toBe(true);
    });

    it('should accept catalog with initDataList', () => {
      const result = FullCatalogSchema.safeParse({
        version: MSF_VERSION,
        tracks: [
          { name: 'video', packaging: 'loc', isLive: true },
        ],
        initDataList: [
          { id: 'video-init', data: 'AAAA', mimeType: 'video/mp4' },
        ],
      });
      expect(result.success).toBe(true);
    });

    it('should reject initDataList entries without id', () => {
      const result = FullCatalogSchema.safeParse({
        version: MSF_VERSION,
        tracks: [],
        initDataList: [{ data: 'AAAA' }],
      });
      expect(result.success).toBe(false);
    });
  });

  describe('DeltaCatalogSchema', () => {
    it('should accept valid delta catalog with addTracks', () => {
      const result = DeltaCatalogSchema.safeParse({
        version: MSF_VERSION,
        deltaUpdate: true,
        generatedAt: Date.now(),
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
        generatedAt: Date.now(),
        removeTracks: ['old-track'],
      });
      expect(result.success).toBe(true);
    });

    it('should accept delta catalog with cloneTracks', () => {
      const result = DeltaCatalogSchema.safeParse({
        version: MSF_VERSION,
        deltaUpdate: true,
        generatedAt: Date.now(),
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
        generatedAt: Date.now(),
        addTracks: [],
      });
      expect(result.success).toBe(false);
    });

    it('should require generatedAt on delta updates (§7)', () => {
      const result = DeltaCatalogSchema.safeParse({
        version: MSF_VERSION,
        deltaUpdate: true,
        addTracks: [
          { name: 'new-track', packaging: 'loc', isLive: true },
        ],
      });
      expect(result.success).toBe(false);
    });
  });

  describe('conditional field validation (§6/§11/§12)', () => {
    it('should require codec + bitrate for A/V LOC tracks', () => {
      const missingCodec = TrackSchema.safeParse({
        name: 'video-main',
        packaging: 'loc',
        role: 'video',
        isLive: true,
        bitrate: 2_000_000,
      });
      expect(missingCodec.success).toBe(false);

      const missingBitrate = TrackSchema.safeParse({
        name: 'video-main',
        packaging: 'loc',
        role: 'video',
        isLive: true,
        codec: 'avc1.4D401E',
      });
      expect(missingBitrate.success).toBe(false);
    });

    it('should require samplerate + channelConfig for audio-role LOC', () => {
      const result = TrackSchema.safeParse({
        name: 'audio-main',
        packaging: 'loc',
        role: 'audio',
        isLive: true,
        codec: 'opus',
        bitrate: 128_000,
      });
      expect(result.success).toBe(false);
    });

    it('should accept fully specified audio LOC track', () => {
      const result = TrackSchema.safeParse({
        name: 'audio-main',
        packaging: 'loc',
        role: 'audio',
        isLive: true,
        codec: 'opus',
        bitrate: 128_000,
        samplerate: 48000,
        channelConfig: 'stereo',
      });
      expect(result.success).toBe(true);
    });

    it('should require eventType for eventtimeline packaging', () => {
      const result = TrackSchema.safeParse({
        name: 'events',
        packaging: 'eventtimeline',
        isLive: true,
      });
      expect(result.success).toBe(false);
    });

    it('should require depends for mediatimeline packaging', () => {
      const missing = TrackSchema.safeParse({
        name: 'timeline',
        packaging: 'mediatimeline',
        isLive: true,
      });
      expect(missing.success).toBe(false);

      const ok = TrackSchema.safeParse({
        name: 'timeline',
        packaging: 'mediatimeline',
        isLive: true,
        depends: ['video-main'],
      });
      expect(ok.success).toBe(true);
    });

    it('should reject trackDuration on live tracks', () => {
      const result = TrackSchema.safeParse({
        name: 'video',
        packaging: 'loc',
        isLive: true,
        trackDuration: 10_000,
      });
      expect(result.success).toBe(false);
    });

    it('should accept trackDuration on VOD tracks', () => {
      const result = TrackSchema.safeParse({
        name: 'video',
        packaging: 'loc',
        isLive: false,
        trackDuration: 10_000,
      });
      expect(result.success).toBe(true);
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

    it('should reject entry with multiple temporal indices (MSF §12)', () => {
      const result = EventTimelineEntrySchema.safeParse({
        t: 1700000000000,
        l: [1, 0],
        m: 90000,
        data: { combined: true },
      });
      expect(result.success).toBe(false);
    });

    it('should reject entry with two of t/l/m (MSF §12)', () => {
      expect(
        EventTimelineEntrySchema.safeParse({ t: 1, l: [0, 0] }).success
      ).toBe(false);
      expect(
        EventTimelineEntrySchema.safeParse({ t: 1, m: 2 }).success
      ).toBe(false);
      expect(
        EventTimelineEntrySchema.safeParse({ l: [0, 0], m: 2 }).success
      ).toBe(false);
    });

    it('should reject entry with no temporal index (MSF §12)', () => {
      const result = EventTimelineEntrySchema.safeParse({
        data: { orphan: true },
      });
      expect(result.success).toBe(false);
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

describe('AuthSchemeSchema (§17 Table 7)', () => {
  it('should accept reserved schemes privacy-pass and cat', () => {
    expect(AuthSchemeSchema.safeParse('privacy-pass').success).toBe(true);
    expect(AuthSchemeSchema.safeParse('cat').success).toBe(true);
  });

  it('should accept reverse-DNS custom identifiers', () => {
    expect(AuthSchemeSchema.safeParse('com.example.auth').success).toBe(true);
    expect(AuthSchemeSchema.safeParse('org.moq.experimental.foo').success).toBe(true);
  });

  it('should reject bare shortnames outside the reserved set', () => {
    for (const bad of ['oauth', 'bearer', 'jwt', 'basic']) {
      expect(AuthSchemeSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe('DeltaCatalogSchema strictness (§7)', () => {
  it('should reject unknown fields on delta root', () => {
    const result = DeltaCatalogSchema.safeParse({
      version: MSF_VERSION,
      deltaUpdate: true,
      generatedAt: Date.now(),
      addTracks: [],
      // §7 forbids anything other than the listed keys on a delta root:
      someUnknownField: 'nope',
    });
    expect(result.success).toBe(false);
  });
});

describe('FullCatalogSchema altGroup alignment (§2)', () => {
  it('should reject altGroup peers with mismatched timescale', () => {
    const result = FullCatalogSchema.safeParse({
      version: MSF_VERSION,
      tracks: [
        {
          name: 'v-720',
          packaging: 'loc',
          isLive: true,
          altGroup: 1,
          timescale: 90000,
        },
        {
          name: 'v-480',
          packaging: 'loc',
          isLive: true,
          altGroup: 1,
          timescale: 48000,
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('should reject VOD altGroup peers with mismatched trackDuration', () => {
    const result = FullCatalogSchema.safeParse({
      version: MSF_VERSION,
      tracks: [
        {
          name: 'v-720',
          packaging: 'loc',
          isLive: false,
          altGroup: 2,
          trackDuration: 60_000,
        },
        {
          name: 'v-480',
          packaging: 'loc',
          isLive: false,
          altGroup: 2,
          trackDuration: 61_000,
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('should accept altGroup peers that agree on timescale', () => {
    const result = FullCatalogSchema.safeParse({
      version: MSF_VERSION,
      tracks: [
        {
          name: 'v-720',
          packaging: 'loc',
          isLive: true,
          altGroup: 3,
          timescale: 90000,
        },
        {
          name: 'v-480',
          packaging: 'loc',
          isLive: true,
          altGroup: 3,
          timescale: 90000,
        },
      ],
    });
    expect(result.success).toBe(true);
  });
});

describe('assertCatalogImmutability (§5.6, §6)', () => {
  const base: FullCatalog = {
    version: MSF_VERSION,
    tracks: [{ name: 'video-main', packaging: 'loc', isLive: true }],
  };

  it('accepts a no-op republish', () => {
    expect(() => assertCatalogImmutability(base, base)).not.toThrow();
  });

  it('rejects removing `isComplete: true`', () => {
    const prev: FullCatalog = { ...base, isComplete: true };
    expect(() => assertCatalogImmutability(prev, base)).toThrow(
      CatalogImmutabilityError
    );
  });

  it('accepts adding `isComplete: true`', () => {
    const next: FullCatalog = { ...base, isComplete: true };
    expect(() => assertCatalogImmutability(base, next)).not.toThrow();
  });

  it('rejects flipping isLive from false → true', () => {
    const prev: FullCatalog = {
      ...base,
      tracks: [{ name: 'video-main', packaging: 'loc', isLive: false }],
    };
    const next: FullCatalog = {
      ...base,
      tracks: [{ name: 'video-main', packaging: 'loc', isLive: true }],
    };
    expect(() => assertCatalogImmutability(prev, next)).toThrow(
      CatalogImmutabilityError
    );
  });

  it('accepts flipping isLive from true → false (live→VOD is allowed)', () => {
    const prev: FullCatalog = {
      ...base,
      tracks: [{ name: 'video-main', packaging: 'loc', isLive: true }],
    };
    const next: FullCatalog = {
      ...base,
      tracks: [{ name: 'video-main', packaging: 'loc', isLive: false }],
    };
    expect(() => assertCatalogImmutability(prev, next)).not.toThrow();
  });

  it('ignores tracks that only appear in `next`', () => {
    const next: FullCatalog = {
      ...base,
      tracks: [
        { name: 'video-main', packaging: 'loc', isLive: true },
        { name: 'audio-main', packaging: 'loc', isLive: true },
      ],
    };
    expect(() => assertCatalogImmutability(base, next)).not.toThrow();
  });
});
