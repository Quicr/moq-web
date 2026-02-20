// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview H.264 Video Encoder Tests
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { H264Encoder, H264Profiles, type EncodedVideoFrame } from './video-encoder';
import { MockVideoFrame } from '../__tests__/setup';

describe('H264Encoder', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('constructor', () => {
    it('creates encoder with default config', () => {
      const encoder = new H264Encoder({
        width: 1280,
        height: 720,
        bitrate: 2_000_000,
        framerate: 30,
      });

      expect(encoder.state).toBe('idle');
      expect(encoder.isRunning).toBe(false);
      expect(encoder.currentConfig.width).toBe(1280);
      expect(encoder.currentConfig.height).toBe(720);
      expect(encoder.currentConfig.profile).toBe(H264Profiles.CONSTRAINED_BASELINE);
    });

    it('accepts custom profile', () => {
      const encoder = new H264Encoder({
        width: 1920,
        height: 1080,
        bitrate: 4_000_000,
        framerate: 30,
        profile: H264Profiles.HIGH,
      });

      expect(encoder.currentConfig.profile).toBe(H264Profiles.HIGH);
    });

    it('sets keyframe interval correctly', () => {
      const encoder = new H264Encoder({
        width: 1280,
        height: 720,
        bitrate: 2_000_000,
        framerate: 30,
        keyframeInterval: 5,
      });

      expect(encoder.currentConfig.keyframeInterval).toBe(5);
    });
  });

  describe('isSupported', () => {
    it('returns true for supported configs', async () => {
      const supported = await H264Encoder.isSupported({
        width: 1280,
        height: 720,
        bitrate: 2_000_000,
        framerate: 30,
        profile: H264Profiles.CONSTRAINED_BASELINE,
      });

      expect(supported).toBe(true);
    });

    it('returns false for unsupported codecs', async () => {
      const supported = await H264Encoder.isSupported({
        width: 1280,
        height: 720,
        bitrate: 2_000_000,
        framerate: 30,
        profile: 'vp9', // Not H.264
      });

      expect(supported).toBe(false);
    });
  });

  describe('start', () => {
    it('starts encoder successfully', async () => {
      const encoder = new H264Encoder({
        width: 1280,
        height: 720,
        bitrate: 2_000_000,
        framerate: 30,
      });

      await encoder.start();

      expect(encoder.state).toBe('running');
      expect(encoder.isRunning).toBe(true);
    });

    it('throws if already running', async () => {
      const encoder = new H264Encoder({
        width: 1280,
        height: 720,
        bitrate: 2_000_000,
        framerate: 30,
      });

      await encoder.start();
      await expect(encoder.start()).rejects.toThrow('Encoder already running');
    });

    it('throws if closed', async () => {
      const encoder = new H264Encoder({
        width: 1280,
        height: 720,
        bitrate: 2_000_000,
        framerate: 30,
      });

      await encoder.start();
      await encoder.close();

      await expect(encoder.start()).rejects.toThrow('Encoder is closed');
    });
  });

  describe('encode', () => {
    it('encodes a video frame', async () => {
      const encoder = new H264Encoder({
        width: 1280,
        height: 720,
        bitrate: 2_000_000,
        framerate: 30,
      });

      const frames: EncodedVideoFrame[] = [];
      encoder.on('frame', (frame) => frames.push(frame));

      await encoder.start();

      const videoFrame = new MockVideoFrame({
        timestamp: 0,
        codedWidth: 1280,
        codedHeight: 720,
        displayWidth: 1280,
        displayHeight: 720,
      });

      await encoder.encode(videoFrame as unknown as VideoFrame);

      // Process async output
      await vi.runAllTimersAsync();

      expect(frames.length).toBe(1);
      expect(frames[0].isKeyframe).toBe(true); // First frame is always keyframe
    });

    it('generates keyframes at correct intervals', async () => {
      const encoder = new H264Encoder({
        width: 1280,
        height: 720,
        bitrate: 2_000_000,
        framerate: 30,
        keyframeInterval: 1, // 1 second = 30 frames
      });

      const frames: EncodedVideoFrame[] = [];
      encoder.on('frame', (frame) => frames.push(frame));

      await encoder.start();

      // Encode 35 frames (should have keyframe at 0, 30)
      for (let i = 0; i < 35; i++) {
        const videoFrame = new MockVideoFrame({
          timestamp: i * 33333,
          codedWidth: 1280,
          codedHeight: 720,
          displayWidth: 1280,
          displayHeight: 720,
        });
        await encoder.encode(videoFrame as unknown as VideoFrame);
        await vi.runAllTimersAsync();
      }

      expect(frames.length).toBe(35);
      expect(frames[0].isKeyframe).toBe(true);
      expect(frames[30].isKeyframe).toBe(true);
    });

    it('can force keyframe', async () => {
      const encoder = new H264Encoder({
        width: 1280,
        height: 720,
        bitrate: 2_000_000,
        framerate: 30,
        keyframeInterval: 100, // Long interval
      });

      const frames: EncodedVideoFrame[] = [];
      encoder.on('frame', (frame) => frames.push(frame));

      await encoder.start();

      // First frame
      const frame1 = new MockVideoFrame({
        timestamp: 0,
        codedWidth: 1280,
        codedHeight: 720,
        displayWidth: 1280,
        displayHeight: 720,
      });
      await encoder.encode(frame1 as unknown as VideoFrame);
      await vi.runAllTimersAsync();

      // Second frame - not keyframe
      const frame2 = new MockVideoFrame({
        timestamp: 33333,
        codedWidth: 1280,
        codedHeight: 720,
        displayWidth: 1280,
        displayHeight: 720,
      });
      await encoder.encode(frame2 as unknown as VideoFrame);
      await vi.runAllTimersAsync();

      // Third frame - force keyframe
      const frame3 = new MockVideoFrame({
        timestamp: 66666,
        codedWidth: 1280,
        codedHeight: 720,
        displayWidth: 1280,
        displayHeight: 720,
      });
      await encoder.encode(frame3 as unknown as VideoFrame, true);
      await vi.runAllTimersAsync();

      expect(frames[0].isKeyframe).toBe(true);
      expect(frames[1].isKeyframe).toBe(false);
      expect(frames[2].isKeyframe).toBe(true);
    });

    it('silently skips when not running', async () => {
      const encoder = new H264Encoder({
        width: 1280,
        height: 720,
        bitrate: 2_000_000,
        framerate: 30,
      });

      const videoFrame = new MockVideoFrame({
        timestamp: 0,
        codedWidth: 1280,
        codedHeight: 720,
        displayWidth: 1280,
        displayHeight: 720,
      });

      // Should not throw
      await encoder.encode(videoFrame as unknown as VideoFrame);
    });
  });

  describe('event handlers', () => {
    it('registers and calls frame handler', async () => {
      const encoder = new H264Encoder({
        width: 1280,
        height: 720,
        bitrate: 2_000_000,
        framerate: 30,
      });

      const handler = vi.fn();
      encoder.on('frame', handler);

      await encoder.start();

      const videoFrame = new MockVideoFrame({
        timestamp: 0,
        codedWidth: 1280,
        codedHeight: 720,
        displayWidth: 1280,
        displayHeight: 720,
      });
      await encoder.encode(videoFrame as unknown as VideoFrame);
      await vi.runAllTimersAsync();

      expect(handler).toHaveBeenCalled();
    });

    it('allows unsubscribing from events', async () => {
      const encoder = new H264Encoder({
        width: 1280,
        height: 720,
        bitrate: 2_000_000,
        framerate: 30,
      });

      const handler = vi.fn();
      const unsubscribe = encoder.on('frame', handler);

      await encoder.start();

      // Encode first frame
      const frame1 = new MockVideoFrame({
        timestamp: 0,
        codedWidth: 1280,
        codedHeight: 720,
        displayWidth: 1280,
        displayHeight: 720,
      });
      await encoder.encode(frame1 as unknown as VideoFrame);
      await vi.runAllTimersAsync();

      expect(handler).toHaveBeenCalledTimes(1);

      // Unsubscribe
      unsubscribe();

      // Encode second frame
      const frame2 = new MockVideoFrame({
        timestamp: 33333,
        codedWidth: 1280,
        codedHeight: 720,
        displayWidth: 1280,
        displayHeight: 720,
      });
      await encoder.encode(frame2 as unknown as VideoFrame);
      await vi.runAllTimersAsync();

      // Handler should not be called again
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('emits closed event on close', async () => {
      const encoder = new H264Encoder({
        width: 1280,
        height: 720,
        bitrate: 2_000_000,
        framerate: 30,
      });

      const closedHandler = vi.fn();
      encoder.on('closed', closedHandler);

      await encoder.start();
      await encoder.close();

      expect(closedHandler).toHaveBeenCalled();
    });
  });

  describe('close', () => {
    it('closes encoder', async () => {
      const encoder = new H264Encoder({
        width: 1280,
        height: 720,
        bitrate: 2_000_000,
        framerate: 30,
      });

      await encoder.start();
      await encoder.close();

      expect(encoder.state).toBe('closed');
    });

    it('can close multiple times without error', async () => {
      const encoder = new H264Encoder({
        width: 1280,
        height: 720,
        bitrate: 2_000_000,
        framerate: 30,
      });

      await encoder.start();
      await encoder.close();
      await encoder.close(); // Should not throw
    });
  });

  describe('flush', () => {
    it('flushes pending frames', async () => {
      const encoder = new H264Encoder({
        width: 1280,
        height: 720,
        bitrate: 2_000_000,
        framerate: 30,
      });

      await encoder.start();
      await encoder.flush(); // Should not throw
    });

    it('does nothing when not running', async () => {
      const encoder = new H264Encoder({
        width: 1280,
        height: 720,
        bitrate: 2_000_000,
        framerate: 30,
      });

      await encoder.flush(); // Should not throw
    });
  });

  describe('updateBitrate', () => {
    it('updates bitrate', async () => {
      const encoder = new H264Encoder({
        width: 1280,
        height: 720,
        bitrate: 2_000_000,
        framerate: 30,
      });

      await encoder.start();
      await encoder.updateBitrate(4_000_000);

      expect(encoder.currentConfig.bitrate).toBe(4_000_000);
    });

    it('does nothing when not running', async () => {
      const encoder = new H264Encoder({
        width: 1280,
        height: 720,
        bitrate: 2_000_000,
        framerate: 30,
      });

      await encoder.updateBitrate(4_000_000);
      expect(encoder.currentConfig.bitrate).toBe(2_000_000);
    });
  });

  describe('statistics', () => {
    it('tracks encoder statistics', async () => {
      const encoder = new H264Encoder({
        width: 1280,
        height: 720,
        bitrate: 2_000_000,
        framerate: 30,
      });

      await encoder.start();

      for (let i = 0; i < 5; i++) {
        const videoFrame = new MockVideoFrame({
          timestamp: i * 33333,
          codedWidth: 1280,
          codedHeight: 720,
          displayWidth: 1280,
          displayHeight: 720,
        });
        await encoder.encode(videoFrame as unknown as VideoFrame);
        await vi.runAllTimersAsync();
      }

      const stats = encoder.getStats();
      expect(stats.framesEncoded).toBe(5);
      expect(stats.keyframes).toBeGreaterThanOrEqual(1);
      expect(stats.bytesEncoded).toBeGreaterThan(0);
      expect(stats.state).toBe('running');
    });

    it('resets statistics', async () => {
      const encoder = new H264Encoder({
        width: 1280,
        height: 720,
        bitrate: 2_000_000,
        framerate: 30,
      });

      await encoder.start();

      const videoFrame = new MockVideoFrame({
        timestamp: 0,
        codedWidth: 1280,
        codedHeight: 720,
        displayWidth: 1280,
        displayHeight: 720,
      });
      await encoder.encode(videoFrame as unknown as VideoFrame);
      await vi.runAllTimersAsync();

      encoder.resetStats();

      const stats = encoder.getStats();
      expect(stats.framesEncoded).toBe(0);
      expect(stats.keyframes).toBe(0);
      expect(stats.bytesEncoded).toBe(0);
    });
  });

  describe('codec description', () => {
    it('includes codec description in keyframe output', async () => {
      const encoder = new H264Encoder({
        width: 1280,
        height: 720,
        bitrate: 2_000_000,
        framerate: 30,
      });

      const frames: EncodedVideoFrame[] = [];
      encoder.on('frame', (frame) => frames.push(frame));

      await encoder.start();

      const videoFrame = new MockVideoFrame({
        timestamp: 0,
        codedWidth: 1280,
        codedHeight: 720,
        displayWidth: 1280,
        displayHeight: 720,
      });
      await encoder.encode(videoFrame as unknown as VideoFrame);
      await vi.runAllTimersAsync();

      expect(frames[0].isKeyframe).toBe(true);
      expect(frames[0].codecDescription).toBeDefined();
    });
  });
});

describe('H264Profiles', () => {
  it('has correct profile strings', () => {
    expect(H264Profiles.CONSTRAINED_BASELINE).toBe('avc1.42001f');
    expect(H264Profiles.BASELINE).toBe('avc1.42E01f');
    expect(H264Profiles.MAIN).toBe('avc1.4D001f');
    expect(H264Profiles.HIGH).toBe('avc1.64001f');
  });
});
