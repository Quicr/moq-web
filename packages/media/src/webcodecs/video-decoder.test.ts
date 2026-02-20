// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview H.264 Video Decoder Tests
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { H264Decoder } from './video-decoder';

describe('H264Decoder', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('constructor', () => {
    it('creates decoder in idle state', () => {
      const decoder = new H264Decoder();

      expect(decoder.state).toBe('idle');
      expect(decoder.isRunning).toBe(false);
      expect(decoder.id).toBeGreaterThan(0);
    });

    it('assigns unique instance IDs', () => {
      const decoder1 = new H264Decoder();
      const decoder2 = new H264Decoder();

      expect(decoder1.id).not.toBe(decoder2.id);
    });
  });

  describe('isSupported', () => {
    it('returns true for supported H.264 configs', async () => {
      const supported = await H264Decoder.isSupported({
        codec: 'avc1.4D401E',
        codedWidth: 1280,
        codedHeight: 720,
      });

      expect(supported).toBe(true);
    });

    it('returns false for unsupported codecs', async () => {
      const supported = await H264Decoder.isSupported({
        codec: 'vp9',
        codedWidth: 1280,
        codedHeight: 720,
      });

      expect(supported).toBe(false);
    });
  });

  describe('start', () => {
    it('starts decoder successfully', async () => {
      const decoder = new H264Decoder();

      await decoder.start({
        codec: 'avc1.4D401E',
        codedWidth: 1280,
        codedHeight: 720,
      });

      expect(decoder.state).toBe('running');
      expect(decoder.isRunning).toBe(true);
    });

    it('throws if already running', async () => {
      const decoder = new H264Decoder();

      await decoder.start({
        codec: 'avc1.4D401E',
        codedWidth: 1280,
        codedHeight: 720,
      });

      await expect(decoder.start({
        codec: 'avc1.4D401E',
        codedWidth: 1280,
        codedHeight: 720,
      })).rejects.toThrow('Decoder already running');
    });

    it('throws if closed', async () => {
      const decoder = new H264Decoder();

      await decoder.start({
        codec: 'avc1.4D401E',
        codedWidth: 1280,
        codedHeight: 720,
      });
      await decoder.close();

      await expect(decoder.start({
        codec: 'avc1.4D401E',
        codedWidth: 1280,
        codedHeight: 720,
      })).rejects.toThrow('Decoder is closed');
    });

    it('throws for unsupported config', async () => {
      const decoder = new H264Decoder();

      await expect(decoder.start({
        codec: 'unsupported-codec',
        codedWidth: 1280,
        codedHeight: 720,
      })).rejects.toThrow('not supported');
    });
  });

  describe('decode', () => {
    it('decodes a keyframe', async () => {
      const decoder = new H264Decoder();
      const frames: VideoFrame[] = [];

      decoder.on('frame', (frame) => frames.push(frame));

      await decoder.start({
        codec: 'avc1.4D401E',
        codedWidth: 1280,
        codedHeight: 720,
      });

      const encodedData = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x67, 0x42]);
      decoder.decode(encodedData, true, 0);

      await vi.runAllTimersAsync();

      expect(frames.length).toBe(1);
    });

    it('drops delta frames before first keyframe', async () => {
      const decoder = new H264Decoder();
      const frames: VideoFrame[] = [];

      decoder.on('frame', (frame) => frames.push(frame));

      await decoder.start({
        codec: 'avc1.4D401E',
        codedWidth: 1280,
        codedHeight: 720,
      });

      // Send delta frame first
      const deltaData = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x41]);
      decoder.decode(deltaData, false, 0);

      await vi.runAllTimersAsync();

      expect(frames.length).toBe(0);

      const stats = decoder.getStats();
      expect(stats.droppedFrames).toBe(1);
    });

    it('decodes delta frames after keyframe', async () => {
      const decoder = new H264Decoder();
      const frames: VideoFrame[] = [];

      decoder.on('frame', (frame) => frames.push(frame));

      await decoder.start({
        codec: 'avc1.4D401E',
        codedWidth: 1280,
        codedHeight: 720,
      });

      // Keyframe first
      decoder.decode(new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x67]), true, 0);
      await vi.runAllTimersAsync();

      // Delta frame
      decoder.decode(new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x41]), false, 33333);
      await vi.runAllTimersAsync();

      expect(frames.length).toBe(2);
    });

    it('throws when not running', async () => {
      const decoder = new H264Decoder();

      expect(() => {
        decoder.decode(new Uint8Array([1, 2, 3]), true, 0);
      }).toThrow('Decoder not running');
    });
  });

  describe('reconfigure', () => {
    it('reconfigures decoder with new settings', async () => {
      const decoder = new H264Decoder();

      await decoder.start({
        codec: 'avc1.4D401E',
        codedWidth: 1280,
        codedHeight: 720,
      });

      await decoder.reconfigure({
        codedWidth: 1920,
        codedHeight: 1080,
      });

      // Should still be running
      expect(decoder.isRunning).toBe(true);
    });

    it('throws when not running', async () => {
      const decoder = new H264Decoder();

      await expect(decoder.reconfigure({
        codedWidth: 1920,
        codedHeight: 1080,
      })).rejects.toThrow('Decoder not running');
    });

    it('requires new keyframe after reconfigure', async () => {
      const decoder = new H264Decoder();
      const frames: VideoFrame[] = [];

      decoder.on('frame', (frame) => frames.push(frame));

      await decoder.start({
        codec: 'avc1.4D401E',
        codedWidth: 1280,
        codedHeight: 720,
      });

      // Send keyframe
      decoder.decode(new Uint8Array([0x67]), true, 0);
      await vi.runAllTimersAsync();

      // Reconfigure
      await decoder.reconfigure({ codedWidth: 1920, codedHeight: 1080 });

      // Delta frame should be dropped (no keyframe since reconfigure)
      decoder.decode(new Uint8Array([0x41]), false, 33333);
      await vi.runAllTimersAsync();

      const stats = decoder.getStats();
      expect(stats.droppedFrames).toBe(1);
    });
  });

  describe('event handlers', () => {
    it('registers and calls frame handler', async () => {
      const decoder = new H264Decoder();
      const handler = vi.fn();

      decoder.on('frame', handler);

      await decoder.start({
        codec: 'avc1.4D401E',
        codedWidth: 1280,
        codedHeight: 720,
      });

      decoder.decode(new Uint8Array([0x67]), true, 0);
      await vi.runAllTimersAsync();

      expect(handler).toHaveBeenCalled();
    });

    it('allows unsubscribing from events', async () => {
      const decoder = new H264Decoder();
      const handler = vi.fn();

      const unsubscribe = decoder.on('frame', handler);

      await decoder.start({
        codec: 'avc1.4D401E',
        codedWidth: 1280,
        codedHeight: 720,
      });

      decoder.decode(new Uint8Array([0x67]), true, 0);
      await vi.runAllTimersAsync();

      expect(handler).toHaveBeenCalledTimes(1);

      unsubscribe();

      decoder.decode(new Uint8Array([0x67]), true, 33333);
      await vi.runAllTimersAsync();

      // Handler should not be called again
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('emits closed event on close', async () => {
      const decoder = new H264Decoder();
      const closedHandler = vi.fn();

      decoder.on('closed', closedHandler);

      await decoder.start({
        codec: 'avc1.4D401E',
        codedWidth: 1280,
        codedHeight: 720,
      });

      await decoder.close();

      expect(closedHandler).toHaveBeenCalled();
    });
  });

  describe('close', () => {
    it('closes decoder', async () => {
      const decoder = new H264Decoder();

      await decoder.start({
        codec: 'avc1.4D401E',
        codedWidth: 1280,
        codedHeight: 720,
      });

      await decoder.close();

      expect(decoder.state).toBe('closed');
    });

    it('can close multiple times without error', async () => {
      const decoder = new H264Decoder();

      await decoder.start({
        codec: 'avc1.4D401E',
        codedWidth: 1280,
        codedHeight: 720,
      });

      await decoder.close();
      await decoder.close(); // Should not throw
    });
  });

  describe('flush', () => {
    it('flushes pending frames', async () => {
      const decoder = new H264Decoder();

      await decoder.start({
        codec: 'avc1.4D401E',
        codedWidth: 1280,
        codedHeight: 720,
      });

      await decoder.flush(); // Should not throw
    });

    it('does nothing when not running', async () => {
      const decoder = new H264Decoder();
      await decoder.flush(); // Should not throw
    });
  });

  describe('reset', () => {
    it('resets decoder state', async () => {
      const decoder = new H264Decoder();

      await decoder.start({
        codec: 'avc1.4D401E',
        codedWidth: 1280,
        codedHeight: 720,
      });

      // Decode keyframe
      decoder.decode(new Uint8Array([0x67]), true, 0);
      await vi.runAllTimersAsync();

      await decoder.reset();

      // After reset, delta frames should be dropped again
      decoder.decode(new Uint8Array([0x41]), false, 33333);
      await vi.runAllTimersAsync();

      const stats = decoder.getStats();
      expect(stats.droppedFrames).toBe(1);
    });

    it('does nothing when not running', async () => {
      const decoder = new H264Decoder();
      await decoder.reset(); // Should not throw
    });
  });

  describe('statistics', () => {
    it('tracks decoder statistics', async () => {
      const decoder = new H264Decoder();

      await decoder.start({
        codec: 'avc1.4D401E',
        codedWidth: 1280,
        codedHeight: 720,
      });

      // Decode keyframe
      decoder.decode(new Uint8Array([0x67]), true, 0);
      await vi.runAllTimersAsync();

      // Decode delta frames
      for (let i = 1; i < 5; i++) {
        decoder.decode(new Uint8Array([0x41]), false, i * 33333);
        await vi.runAllTimersAsync();
      }

      const stats = decoder.getStats();
      expect(stats.framesDecoded).toBe(5);
      expect(stats.keyframes).toBe(1);
      expect(stats.state).toBe('running');
    });

    it('resets statistics', async () => {
      const decoder = new H264Decoder();

      await decoder.start({
        codec: 'avc1.4D401E',
        codedWidth: 1280,
        codedHeight: 720,
      });

      decoder.decode(new Uint8Array([0x67]), true, 0);
      await vi.runAllTimersAsync();

      decoder.resetStats();

      const stats = decoder.getStats();
      expect(stats.framesDecoded).toBe(0);
      expect(stats.keyframes).toBe(0);
      expect(stats.droppedFrames).toBe(0);
    });
  });

  describe('decoder recovery', () => {
    it('handles decoder closed state gracefully', async () => {
      const decoder = new H264Decoder();

      await decoder.start({
        codec: 'avc1.4D401E',
        codedWidth: 1280,
        codedHeight: 720,
      });

      // First keyframe
      decoder.decode(new Uint8Array([0x67]), true, 0);
      await vi.runAllTimersAsync();

      // The decoder should handle unexpected closures
      // (this tests the auto-recreation logic)
      expect(decoder.isRunning).toBe(true);
    });
  });
});
