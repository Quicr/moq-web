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
  QuicRExtensionType,
  createSimpleLOCPacket,
  type VideoFrameMarking,
  type VADData,
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

describe('QuicR Interop Mode', () => {
  let packager: LOCPackager;
  let unpackager: LOCUnpackager;

  beforeEach(() => {
    packager = new LOCPackager(262144, 12345); // with participant ID
    unpackager = new LOCUnpackager();
  });

  describe('Video packaging', () => {
    it('packages and unpackages a video keyframe in QuicR interop mode', () => {
      const payload = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x67, 0x42]);
      const packet = packager.packageVideo(payload, {
        isKeyframe: true,
        quicrInterop: true,
        captureTimestamp: 1000.5,
      });

      // Unpackage in QuicR mode
      const frame = unpackager.unpackage(packet, true);

      expect(frame.header.mediaType).toBe(MediaType.VIDEO);
      expect(frame.header.isKeyframe).toBe(true);
      expect(frame.header.sequenceNumber).toBe(0);
      expect(frame.payload).toEqual(payload);
      // Timestamp should be within ~1ms of original
      expect(Math.abs(frame.captureTimestamp! - 1000.5)).toBeLessThan(1);
    });

    it('packages video delta frame in QuicR interop mode', () => {
      const payload = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x41]);
      // First frame (keyframe)
      packager.packageVideo(new Uint8Array([1]), { isKeyframe: true, quicrInterop: true });
      // Second frame (delta)
      const packet = packager.packageVideo(payload, { isKeyframe: false, quicrInterop: true });

      const frame = unpackager.unpackage(packet, true);

      expect(frame.header.mediaType).toBe(MediaType.VIDEO);
      expect(frame.header.isKeyframe).toBe(false);
      expect(frame.header.sequenceNumber).toBe(1);
      expect(frame.payload).toEqual(payload);
    });

    it('includes VAD data in QuicR video packet', () => {
      const payload = new Uint8Array([0x01]);
      const vadData = {
        voiceActivity: true,
        speechProbability: 200,
        energyLevel: -50,
      };
      const packet = packager.packageVideo(payload, {
        isKeyframe: true,
        quicrInterop: true,
        vadData,
      });

      const frame = unpackager.unpackage(packet, true);

      expect(frame.vadData).toBeDefined();
      expect(frame.vadData!.voiceActivity).toBe(true);
      expect(frame.vadData!.speechProbability).toBe(200);
      expect(frame.vadData!.energyLevel).toBe(-50);
    });

    it('includes codec description in QuicR video keyframe', () => {
      const payload = new Uint8Array([0x01]);
      const codecDescription = new Uint8Array([0x01, 0x42, 0x00, 0x1f]);
      const packet = packager.packageVideo(payload, {
        isKeyframe: true,
        quicrInterop: true,
        codecDescription,
      });

      const frame = unpackager.unpackage(packet, true);

      expect(frame.codecDescription).toBeDefined();
      expect(frame.codecDescription).toEqual(codecDescription);
    });

    it('uses fixed-size extensions in QuicR mode', () => {
      const payload = new Uint8Array([0x01]);
      const packet = packager.packageVideo(payload, {
        isKeyframe: true,
        quicrInterop: true,
        captureTimestamp: 12345.678,
      });

      // Check fixed sizes in packet:
      // Header(1) + CaptureTimestamp(type:1 + len:1 + data:6) + SequenceNumber(type:1 + len:1 + data:4) + payloadLen + payload
      // Extension count in header should be 2
      const extensionCount = packet[0] & 0x0f;
      expect(extensionCount).toBe(2);

      // Verify capture timestamp extension (type 0x02, length 6)
      expect(packet[1]).toBe(0x02); // QuicR CAPTURE_TIMESTAMP type
      expect(packet[2]).toBe(6);    // Fixed 6-byte length

      // Verify sequence number extension (type 0x04, length 4)
      expect(packet[9]).toBe(0x04); // QuicR SEQUENCE_NUMBER type
      expect(packet[10]).toBe(4);   // Fixed 4-byte length
    });
  });

  describe('Audio packaging', () => {
    it('packages and unpackages an audio frame in QuicR interop mode', () => {
      const payload = new Uint8Array([0x4f, 0x70, 0x75, 0x73]); // "Opus"
      const packet = packager.packageAudio(payload, {
        quicrInterop: true,
        captureTimestamp: 2000.25,
      });

      const frame = unpackager.unpackage(packet, true);

      expect(frame.header.mediaType).toBe(MediaType.AUDIO);
      expect(frame.header.isKeyframe).toBe(true); // Opus always keyframe
      expect(frame.header.sequenceNumber).toBe(0);
      expect(frame.payload).toEqual(payload);
      expect(Math.abs(frame.captureTimestamp! - 2000.25)).toBeLessThan(1);
    });

    it('includes participant ID in QuicR audio packet', () => {
      const payload = new Uint8Array([0x01]);
      const packet = packager.packageAudio(payload, {
        quicrInterop: true,
        participantId: 98765,
      });

      const frame = unpackager.unpackage(packet, true);

      expect(frame.participantId).toBe(98765);
    });

    it('uses packager default participant ID when not specified', () => {
      const payload = new Uint8Array([0x01]);
      const packet = packager.packageAudio(payload, {
        quicrInterop: true,
      });

      const frame = unpackager.unpackage(packet, true);

      expect(frame.participantId).toBe(12345); // Default from packager constructor
    });

    it('includes energy level in QuicR audio packet', () => {
      const payload = new Uint8Array([0x01]);
      const packet = packager.packageAudio(payload, {
        quicrInterop: true,
        audioLevel: 75,
        voiceActivity: true,
      });

      const frame = unpackager.unpackage(packet, true);

      expect(frame.audioLevel).toBeDefined();
      expect(frame.audioLevel!.level).toBe(75);
      expect(frame.audioLevel!.voiceActivity).toBe(true);
    });

    it('includes VAD data in QuicR audio packet', () => {
      const payload = new Uint8Array([0x01]);
      const vadData = {
        voiceActivity: false,
        speechProbability: 50,
        energyLevel: 100,
      };
      const packet = packager.packageAudio(payload, {
        quicrInterop: true,
        vadData,
      });

      const frame = unpackager.unpackage(packet, true);

      expect(frame.vadData).toBeDefined();
      expect(frame.vadData!.voiceActivity).toBe(false);
      expect(frame.vadData!.speechProbability).toBe(50);
      expect(frame.vadData!.energyLevel).toBe(100);
    });

    it('uses fixed-size extensions in QuicR audio mode', () => {
      const payload = new Uint8Array([0x01]);
      const packet = packager.packageAudio(payload, {
        quicrInterop: true,
        captureTimestamp: 5000.0,
        audioLevel: 60,
      });

      // Extension count should be 5 (timestamp, sequence, energy, participant)
      const extensionCount = packet[0] & 0x0f;
      expect(extensionCount).toBe(4);

      // Verify extensions are present with fixed sizes
      let offset = 1;

      // CaptureTimestamp (0x02, 6 bytes)
      expect(packet[offset]).toBe(0x02);
      expect(packet[offset + 1]).toBe(6);
      offset += 8;

      // SequenceNumber (0x04, 4 bytes)
      expect(packet[offset]).toBe(0x04);
      expect(packet[offset + 1]).toBe(4);
      offset += 6;

      // EnergyLevel (0x06, 6 bytes)
      expect(packet[offset]).toBe(0x06);
      expect(packet[offset + 1]).toBe(6);
      offset += 8;

      // ParticipantID (0x08, 8 bytes)
      expect(packet[offset]).toBe(0x08);
      expect(packet[offset + 1]).toBe(8);
    });
  });

  describe('Roundtrip tests', () => {
    it('roundtrips video with all QuicR extensions', () => {
      const payload = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0x00, 0x1f]);
      const codecDescription = new Uint8Array([0x01, 0x42, 0x00, 0x1f, 0xff, 0xe1]);
      const vadData = {
        voiceActivity: true,
        speechProbability: 180,
        energyLevel: -10,
      };

      const packet = packager.packageVideo(payload, {
        isKeyframe: true,
        quicrInterop: true,
        captureTimestamp: 3000.123,
        codecDescription,
        vadData,
      });

      const frame = unpackager.unpackage(packet, true);

      expect(frame.header.mediaType).toBe(MediaType.VIDEO);
      expect(frame.header.isKeyframe).toBe(true);
      expect(frame.header.sequenceNumber).toBe(0);
      expect(frame.payload).toEqual(payload);
      expect(Math.abs(frame.captureTimestamp! - 3000.123)).toBeLessThan(1);
      expect(frame.codecDescription).toEqual(codecDescription);
      expect(frame.vadData).toEqual(vadData);
    });

    it('roundtrips audio with all QuicR extensions', () => {
      const payload = new Uint8Array(100).fill(0x42);
      const vadData = {
        voiceActivity: false,
        speechProbability: 25,
        energyLevel: -80,
      };

      const packet = packager.packageAudio(payload, {
        quicrInterop: true,
        captureTimestamp: 4000.5,
        audioLevel: 100,
        voiceActivity: false,
        vadData,
        participantId: 55555,
      });

      const frame = unpackager.unpackage(packet, true);

      expect(frame.header.mediaType).toBe(MediaType.AUDIO);
      expect(frame.payload).toEqual(payload);
      expect(Math.abs(frame.captureTimestamp! - 4000.5)).toBeLessThan(1);
      expect(frame.audioLevel!.level).toBe(100);
      expect(frame.audioLevel!.voiceActivity).toBe(false);
      expect(frame.vadData).toEqual(vadData);
      expect(frame.participantId).toBe(55555);
    });

    it('maintains sequence numbers across multiple frames', () => {
      const payload = new Uint8Array([0x01]);

      // Package multiple video frames
      const videoPacket1 = packager.packageVideo(payload, { isKeyframe: true, quicrInterop: true });
      const videoPacket2 = packager.packageVideo(payload, { isKeyframe: false, quicrInterop: true });
      const videoPacket3 = packager.packageVideo(payload, { isKeyframe: false, quicrInterop: true });

      // Package multiple audio frames
      const audioPacket1 = packager.packageAudio(payload, { quicrInterop: true });
      const audioPacket2 = packager.packageAudio(payload, { quicrInterop: true });

      // Verify video sequences
      expect(unpackager.unpackage(videoPacket1, true).header.sequenceNumber).toBe(0);
      expect(unpackager.unpackage(videoPacket2, true).header.sequenceNumber).toBe(1);
      expect(unpackager.unpackage(videoPacket3, true).header.sequenceNumber).toBe(2);

      // Verify audio sequences (independent from video)
      expect(unpackager.unpackage(audioPacket1, true).header.sequenceNumber).toBe(0);
      expect(unpackager.unpackage(audioPacket2, true).header.sequenceNumber).toBe(1);
    });

    it('handles large payloads in QuicR mode', () => {
      // 100KB payload
      const payload = new Uint8Array(100 * 1024);
      for (let i = 0; i < payload.length; i++) {
        payload[i] = i % 256;
      }

      const packet = packager.packageVideo(payload, {
        isKeyframe: true,
        quicrInterop: true,
        captureTimestamp: 12345.678,
      });

      const frame = unpackager.unpackage(packet, true);

      expect(frame.payload).toEqual(payload);
    });
  });

  describe('calculatePacketSize', () => {
    it('calculates correct QuicR video packet size', () => {
      const payload = new Uint8Array(100);
      const options = {
        isKeyframe: true,
        quicrInterop: true,
        captureTimestamp: 1000.0,
      };

      const calculatedSize = packager.calculateVideoPacketSize(payload, options);
      const packet = packager.packageVideo(payload, options);

      // Reset to get same sequence number
      packager.reset();
      const packet2 = packager.packageVideo(payload, options);

      expect(packet2.length).toBe(calculatedSize);
    });

    it('calculates correct QuicR audio packet size', () => {
      const payload = new Uint8Array(50);
      const options = {
        quicrInterop: true,
        captureTimestamp: 2000.0,
        audioLevel: 64,
      };

      const calculatedSize = packager.calculateAudioPacketSize(payload, options);
      const packet = packager.packageAudio(payload, options);

      // Reset to get same sequence number
      packager.reset();
      const packet2 = packager.packageAudio(payload, options);

      expect(packet2.length).toBe(calculatedSize);
    });
  });
});
