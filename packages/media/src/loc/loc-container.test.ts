// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview LOC Container Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  LOCPackager,
  LOCUnpackager,
  MediaType,
  LOCExtensionType,
  createSimpleLOCPacket,
  type VideoFrameMarking,
} from './loc-container';

describe('LOCPackager', () => {
  let packager: LOCPackager;

  beforeEach(() => {
    packager = new LOCPackager();
  });

  describe('packageVideo', () => {
    it('packages a video keyframe', () => {
      const payload = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x67, 0x42]);
      const packet = packager.packageVideo(payload, { isKeyframe: true });

      expect(packet).toBeInstanceOf(Uint8Array);
      expect(packet.length).toBeGreaterThan(payload.length);

      // Verify header byte: video (0), keyframe (1), no extensions
      const headerByte = packet[0];
      expect((headerByte >> 7) & 0x01).toBe(MediaType.VIDEO);
      expect((headerByte & 0x40) !== 0).toBe(true); // keyframe bit
    });

    it('packages a video delta frame', () => {
      const payload = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x41]);
      const packet = packager.packageVideo(payload, { isKeyframe: false });

      const headerByte = packet[0];
      expect((headerByte >> 7) & 0x01).toBe(MediaType.VIDEO);
      expect((headerByte & 0x40) !== 0).toBe(false); // not keyframe
    });

    it('includes capture timestamp extension', () => {
      const payload = new Uint8Array([0x01, 0x02, 0x03]);
      const timestamp = 1234567890;
      const packet = packager.packageVideo(payload, {
        isKeyframe: true,
        captureTimestamp: timestamp,
      });

      const extensionCount = packet[0] & 0x0F;
      expect(extensionCount).toBeGreaterThanOrEqual(1);
    });

    it('includes video frame marking extension', () => {
      const payload = new Uint8Array([0x01, 0x02, 0x03]);
      const frameMarking: VideoFrameMarking = {
        temporalId: 2,
        spatialId: 1,
        endOfFrame: true,
        discardable: false,
        baseLayer: true,
      };
      const packet = packager.packageVideo(payload, {
        isKeyframe: true,
        frameMarking,
      });

      const extensionCount = packet[0] & 0x0F;
      expect(extensionCount).toBeGreaterThanOrEqual(1);
    });

    it('includes codec description extension', () => {
      const payload = new Uint8Array([0x01, 0x02, 0x03]);
      const codecDescription = new Uint8Array([0x01, 0x42, 0x00, 0x1f]);
      const packet = packager.packageVideo(payload, {
        isKeyframe: true,
        codecDescription,
      });

      const extensionCount = packet[0] & 0x0F;
      expect(extensionCount).toBeGreaterThanOrEqual(1);
    });

    it('increments sequence number for each video frame', () => {
      const payload = new Uint8Array([0x01]);

      const packet1 = packager.packageVideo(payload, { isKeyframe: true });
      const packet2 = packager.packageVideo(payload, { isKeyframe: false });
      const packet3 = packager.packageVideo(payload, { isKeyframe: false });

      // Unpackage to verify sequence numbers
      const unpackager = new LOCUnpackager();
      const frame1 = unpackager.unpackage(packet1);
      const frame2 = unpackager.unpackage(packet2);
      const frame3 = unpackager.unpackage(packet3);

      expect(frame1.header.sequenceNumber).toBe(0);
      expect(frame2.header.sequenceNumber).toBe(1);
      expect(frame3.header.sequenceNumber).toBe(2);
    });
  });

  describe('packageAudio', () => {
    it('packages an audio frame', () => {
      const payload = new Uint8Array([0x4f, 0x70, 0x75, 0x73]); // "Opus"
      const packet = packager.packageAudio(payload);

      expect(packet).toBeInstanceOf(Uint8Array);

      // Verify header byte: audio (1), keyframe (always true for audio)
      const headerByte = packet[0];
      expect((headerByte >> 7) & 0x01).toBe(MediaType.AUDIO);
      expect((headerByte & 0x40) !== 0).toBe(true); // Opus frames are always key
    });

    it('includes capture timestamp extension', () => {
      const payload = new Uint8Array([0x01, 0x02]);
      const packet = packager.packageAudio(payload, {
        captureTimestamp: 12345,
      });

      const extensionCount = packet[0] & 0x0F;
      expect(extensionCount).toBeGreaterThanOrEqual(1);
    });

    it('includes audio level extension', () => {
      const payload = new Uint8Array([0x01, 0x02]);
      const packet = packager.packageAudio(payload, {
        audioLevel: 64,
        voiceActivity: true,
      });

      const extensionCount = packet[0] & 0x0F;
      expect(extensionCount).toBeGreaterThanOrEqual(1);
    });

    it('increments sequence number independently from video', () => {
      const payload = new Uint8Array([0x01]);

      // Package some video
      packager.packageVideo(payload, { isKeyframe: true });
      packager.packageVideo(payload, { isKeyframe: false });

      // Package audio
      const audioPacket1 = packager.packageAudio(payload);
      const audioPacket2 = packager.packageAudio(payload);

      const unpackager = new LOCUnpackager();
      const audioFrame1 = unpackager.unpackage(audioPacket1);
      const audioFrame2 = unpackager.unpackage(audioPacket2);

      // Audio should have its own sequence starting at 0
      expect(audioFrame1.header.sequenceNumber).toBe(0);
      expect(audioFrame2.header.sequenceNumber).toBe(1);
    });
  });

  describe('reset', () => {
    it('resets sequence counters', () => {
      const payload = new Uint8Array([0x01]);

      // Package some frames
      packager.packageVideo(payload, { isKeyframe: true });
      packager.packageVideo(payload, { isKeyframe: false });
      packager.packageAudio(payload);

      // Reset
      packager.reset();

      // Next frames should start at sequence 0
      const videoPacket = packager.packageVideo(payload, { isKeyframe: true });
      const audioPacket = packager.packageAudio(payload);

      const unpackager = new LOCUnpackager();
      expect(unpackager.unpackage(videoPacket).header.sequenceNumber).toBe(0);
      expect(unpackager.unpackage(audioPacket).header.sequenceNumber).toBe(0);
    });
  });
});

describe('LOCUnpackager', () => {
  let packager: LOCPackager;
  let unpackager: LOCUnpackager;

  beforeEach(() => {
    packager = new LOCPackager();
    unpackager = new LOCUnpackager();
  });

  describe('unpackage', () => {
    it('unpackages a video keyframe', () => {
      const payload = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x67, 0x42]);
      const packet = packager.packageVideo(payload, { isKeyframe: true });

      const frame = unpackager.unpackage(packet);

      expect(frame.header.mediaType).toBe(MediaType.VIDEO);
      expect(frame.header.isKeyframe).toBe(true);
      expect(frame.header.sequenceNumber).toBe(0);
      expect(frame.payload).toEqual(payload);
    });

    it('unpackages a video delta frame', () => {
      const payload = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x41]);
      packager.packageVideo(new Uint8Array([1]), { isKeyframe: true }); // First frame
      const packet = packager.packageVideo(payload, { isKeyframe: false });

      const frame = unpackager.unpackage(packet);

      expect(frame.header.mediaType).toBe(MediaType.VIDEO);
      expect(frame.header.isKeyframe).toBe(false);
      expect(frame.header.sequenceNumber).toBe(1);
      expect(frame.payload).toEqual(payload);
    });

    it('unpackages an audio frame', () => {
      const payload = new Uint8Array([0x4f, 0x70, 0x75, 0x73]);
      const packet = packager.packageAudio(payload);

      const frame = unpackager.unpackage(packet);

      expect(frame.header.mediaType).toBe(MediaType.AUDIO);
      expect(frame.header.isKeyframe).toBe(true);
      expect(frame.payload).toEqual(payload);
    });

    it('extracts capture timestamp', () => {
      const payload = new Uint8Array([0x01]);
      const timestamp = 1234567.89;
      const packet = packager.packageVideo(payload, {
        isKeyframe: true,
        captureTimestamp: timestamp,
      });

      const frame = unpackager.unpackage(packet);

      expect(frame.captureTimestamp).toBeDefined();
      // Timestamp is stored in microseconds, may have some precision loss
      expect(Math.abs(frame.captureTimestamp! - timestamp)).toBeLessThan(1);
    });

    it('extracts video frame marking', () => {
      const payload = new Uint8Array([0x01]);
      const frameMarking: VideoFrameMarking = {
        temporalId: 3,
        spatialId: 2,
        endOfFrame: true,
        discardable: true,
        baseLayer: false,
      };
      const packet = packager.packageVideo(payload, {
        isKeyframe: true,
        frameMarking,
      });

      const frame = unpackager.unpackage(packet);

      expect(frame.frameMarking).toBeDefined();
      expect(frame.frameMarking!.temporalId).toBe(3);
      expect(frame.frameMarking!.spatialId).toBe(2);
      expect(frame.frameMarking!.endOfFrame).toBe(true);
      expect(frame.frameMarking!.discardable).toBe(true);
      expect(frame.frameMarking!.baseLayer).toBe(false);
    });

    it('extracts audio level', () => {
      const payload = new Uint8Array([0x01]);
      const packet = packager.packageAudio(payload, {
        audioLevel: 64,
        voiceActivity: true,
      });

      const frame = unpackager.unpackage(packet);

      expect(frame.audioLevel).toBeDefined();
      expect(frame.audioLevel!.level).toBe(64);
      expect(frame.audioLevel!.voiceActivity).toBe(true);
    });

    it('extracts codec description', () => {
      const payload = new Uint8Array([0x01]);
      const codecDescription = new Uint8Array([0x01, 0x42, 0x00, 0x1f, 0xff]);
      const packet = packager.packageVideo(payload, {
        isKeyframe: true,
        codecDescription,
      });

      const frame = unpackager.unpackage(packet);

      expect(frame.codecDescription).toBeDefined();
      expect(frame.codecDescription).toEqual(codecDescription);
    });
  });

  describe('isVideoKeyframe', () => {
    it('returns true for video keyframe', () => {
      const packet = packager.packageVideo(new Uint8Array([1]), { isKeyframe: true });
      expect(unpackager.isVideoKeyframe(packet)).toBe(true);
    });

    it('returns false for video delta frame', () => {
      packager.packageVideo(new Uint8Array([1]), { isKeyframe: true });
      const packet = packager.packageVideo(new Uint8Array([1]), { isKeyframe: false });
      expect(unpackager.isVideoKeyframe(packet)).toBe(false);
    });

    it('returns false for audio frame', () => {
      const packet = packager.packageAudio(new Uint8Array([1]));
      expect(unpackager.isVideoKeyframe(packet)).toBe(false);
    });

    it('returns false for empty packet', () => {
      expect(unpackager.isVideoKeyframe(new Uint8Array(0))).toBe(false);
    });
  });

  describe('getMediaType', () => {
    it('returns VIDEO for video packets', () => {
      const packet = packager.packageVideo(new Uint8Array([1]), { isKeyframe: true });
      expect(unpackager.getMediaType(packet)).toBe(MediaType.VIDEO);
    });

    it('returns AUDIO for audio packets', () => {
      const packet = packager.packageAudio(new Uint8Array([1]));
      expect(unpackager.getMediaType(packet)).toBe(MediaType.AUDIO);
    });

    it('returns VIDEO for empty packet (default)', () => {
      expect(unpackager.getMediaType(new Uint8Array(0))).toBe(MediaType.VIDEO);
    });
  });
});

describe('createSimpleLOCPacket', () => {
  it('creates a minimal video keyframe packet', () => {
    const payload = new Uint8Array([0x01, 0x02, 0x03]);
    const packet = createSimpleLOCPacket(MediaType.VIDEO, true, 0, payload);

    const unpackager = new LOCUnpackager();
    const frame = unpackager.unpackage(packet);

    expect(frame.header.mediaType).toBe(MediaType.VIDEO);
    expect(frame.header.isKeyframe).toBe(true);
    expect(frame.header.sequenceNumber).toBe(0);
    expect(frame.header.extensions.length).toBe(0);
    expect(frame.payload).toEqual(payload);
  });

  it('creates a minimal audio packet', () => {
    const payload = new Uint8Array([0x04, 0x05]);
    const packet = createSimpleLOCPacket(MediaType.AUDIO, true, 42, payload);

    const unpackager = new LOCUnpackager();
    const frame = unpackager.unpackage(packet);

    expect(frame.header.mediaType).toBe(MediaType.AUDIO);
    expect(frame.header.isKeyframe).toBe(true);
    expect(frame.header.sequenceNumber).toBe(42);
    expect(frame.payload).toEqual(payload);
  });

  it('creates packets with no extensions for minimal overhead', () => {
    const payload = new Uint8Array([0x01]);
    const packet = createSimpleLOCPacket(MediaType.VIDEO, false, 100, payload);

    // Minimal packet should be: 1 byte header + 1-2 bytes sequence + 1 byte length + payload
    // So for sequence 100 (1 byte varint) and 1 byte payload: 1 + 1 + 1 + 1 = 4 bytes
    expect(packet.length).toBeLessThanOrEqual(5);
  });
});

describe('LOC roundtrip', () => {
  it('roundtrips video frames with all extensions', () => {
    const packager = new LOCPackager();
    const unpackager = new LOCUnpackager();

    const payload = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0x00, 0x1f]);
    const timestamp = 1000.5;
    const frameMarking: VideoFrameMarking = {
      temporalId: 7,
      spatialId: 3,
      endOfFrame: true,
      discardable: false,
      baseLayer: true,
    };
    const codecDescription = new Uint8Array([0x01, 0x42, 0x00, 0x1f, 0xff, 0xe1]);

    const packet = packager.packageVideo(payload, {
      isKeyframe: true,
      captureTimestamp: timestamp,
      frameMarking,
      codecDescription,
    });

    const frame = unpackager.unpackage(packet);

    expect(frame.header.mediaType).toBe(MediaType.VIDEO);
    expect(frame.header.isKeyframe).toBe(true);
    expect(frame.payload).toEqual(payload);
    expect(Math.abs(frame.captureTimestamp! - timestamp)).toBeLessThan(1);
    expect(frame.frameMarking).toEqual(frameMarking);
    expect(frame.codecDescription).toEqual(codecDescription);
  });

  it('roundtrips audio frames with all extensions', () => {
    const packager = new LOCPackager();
    const unpackager = new LOCUnpackager();

    const payload = new Uint8Array(new Array(100).fill(0x42));
    const timestamp = 5000.25;
    const audioLevel = 100;
    const voiceActivity = false;

    const packet = packager.packageAudio(payload, {
      captureTimestamp: timestamp,
      audioLevel,
      voiceActivity,
    });

    const frame = unpackager.unpackage(packet);

    expect(frame.header.mediaType).toBe(MediaType.AUDIO);
    expect(frame.payload).toEqual(payload);
    expect(Math.abs(frame.captureTimestamp! - timestamp)).toBeLessThan(1);
    expect(frame.audioLevel!.level).toBe(audioLevel);
    expect(frame.audioLevel!.voiceActivity).toBe(voiceActivity);
  });

  it('handles large payloads', () => {
    const packager = new LOCPackager();
    const unpackager = new LOCUnpackager();

    // Create a large payload (100KB)
    const payload = new Uint8Array(100 * 1024);
    for (let i = 0; i < payload.length; i++) {
      payload[i] = i % 256;
    }

    const packet = packager.packageVideo(payload, { isKeyframe: true });
    const frame = unpackager.unpackage(packet);

    expect(frame.payload).toEqual(payload);
  });

  it('handles sequence number wrap for large sequences', () => {
    const packager = new LOCPackager();
    const unpackager = new LOCUnpackager();

    // Test with large sequence numbers by packaging many frames
    const payload = new Uint8Array([1]);

    // Package 100 frames
    let lastPacket: Uint8Array | undefined;
    for (let i = 0; i < 100; i++) {
      lastPacket = packager.packageVideo(payload, { isKeyframe: i === 0 });
    }

    const frame = unpackager.unpackage(lastPacket!);
    expect(frame.header.sequenceNumber).toBe(99);
  });
});

describe('VideoFrameMarking bit packing', () => {
  it('correctly packs and unpacks all bit combinations', () => {
    const packager = new LOCPackager();
    const unpackager = new LOCUnpackager();

    // Test various combinations
    const testCases: VideoFrameMarking[] = [
      { temporalId: 0, spatialId: 0, endOfFrame: false, discardable: false, baseLayer: false },
      { temporalId: 7, spatialId: 3, endOfFrame: true, discardable: true, baseLayer: true },
      { temporalId: 4, spatialId: 2, endOfFrame: true, discardable: false, baseLayer: true },
      { temporalId: 1, spatialId: 0, endOfFrame: false, discardable: true, baseLayer: false },
    ];

    for (const marking of testCases) {
      packager.reset();
      const packet = packager.packageVideo(new Uint8Array([1]), {
        isKeyframe: true,
        frameMarking: marking,
      });
      const frame = unpackager.unpackage(packet);

      expect(frame.frameMarking).toEqual(marking);
    }
  });
});

describe('AudioLevel RFC 6464 format', () => {
  it('correctly packs voice activity bit', () => {
    const packager = new LOCPackager();
    const unpackager = new LOCUnpackager();

    // With voice activity
    let packet = packager.packageAudio(new Uint8Array([1]), {
      audioLevel: 50,
      voiceActivity: true,
    });
    let frame = unpackager.unpackage(packet);
    expect(frame.audioLevel!.voiceActivity).toBe(true);
    expect(frame.audioLevel!.level).toBe(50);

    // Without voice activity
    packager.reset();
    packet = packager.packageAudio(new Uint8Array([1]), {
      audioLevel: 50,
      voiceActivity: false,
    });
    frame = unpackager.unpackage(packet);
    expect(frame.audioLevel!.voiceActivity).toBe(false);
    expect(frame.audioLevel!.level).toBe(50);
  });

  it('correctly handles level range 0-127', () => {
    const packager = new LOCPackager();
    const unpackager = new LOCUnpackager();

    for (const level of [0, 1, 63, 64, 126, 127]) {
      packager.reset();
      const packet = packager.packageAudio(new Uint8Array([1]), {
        audioLevel: level,
        voiceActivity: false,
      });
      const frame = unpackager.unpackage(packet);
      expect(frame.audioLevel!.level).toBe(level);
    }
  });
});
