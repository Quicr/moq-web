// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Opus Audio Decoder Tests
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { OpusDecoder } from './audio-decoder';

describe('OpusDecoder', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('constructor', () => {
    it('creates decoder in idle state', () => {
      const decoder = new OpusDecoder();

      expect(decoder.state).toBe('idle');
      expect(decoder.isRunning).toBe(false);
    });
  });

  describe('isSupported', () => {
    it('returns true for Opus config', async () => {
      const supported = await OpusDecoder.isSupported({
        sampleRate: 48000,
        numberOfChannels: 2,
      });

      expect(supported).toBe(true);
    });

    it('returns true for mono Opus', async () => {
      const supported = await OpusDecoder.isSupported({
        sampleRate: 48000,
        numberOfChannels: 1,
      });

      expect(supported).toBe(true);
    });
  });

  describe('start', () => {
    it('starts decoder successfully', async () => {
      const decoder = new OpusDecoder();

      await decoder.start({
        sampleRate: 48000,
        numberOfChannels: 2,
      });

      expect(decoder.state).toBe('running');
      expect(decoder.isRunning).toBe(true);
    });

    it('throws if already running', async () => {
      const decoder = new OpusDecoder();

      await decoder.start({
        sampleRate: 48000,
        numberOfChannels: 2,
      });

      await expect(decoder.start({
        sampleRate: 48000,
        numberOfChannels: 2,
      })).rejects.toThrow('Decoder already running');
    });

    it('throws if closed', async () => {
      const decoder = new OpusDecoder();

      await decoder.start({
        sampleRate: 48000,
        numberOfChannels: 2,
      });
      await decoder.close();

      await expect(decoder.start({
        sampleRate: 48000,
        numberOfChannels: 2,
      })).rejects.toThrow('Decoder is closed');
    });
  });

  describe('decode', () => {
    it('decodes Opus frame', async () => {
      const decoder = new OpusDecoder();
      const frames: AudioData[] = [];

      decoder.on('frame', (frame) => frames.push(frame));

      await decoder.start({
        sampleRate: 48000,
        numberOfChannels: 2,
      });

      const encodedData = new Uint8Array([0x4f, 0x70, 0x75, 0x73]); // "Opus"
      decoder.decode(encodedData, 0);

      await vi.runAllTimersAsync();

      expect(frames.length).toBe(1);
    });

    it('decodes multiple frames', async () => {
      const decoder = new OpusDecoder();
      const frames: AudioData[] = [];

      decoder.on('frame', (frame) => frames.push(frame));

      await decoder.start({
        sampleRate: 48000,
        numberOfChannels: 2,
      });

      for (let i = 0; i < 10; i++) {
        const encodedData = new Uint8Array([0x4f, 0x70, 0x75, 0x73]);
        decoder.decode(encodedData, i * 20000);
        await vi.runAllTimersAsync();
      }

      expect(frames.length).toBe(10);
    });

    it('throws when not running', () => {
      const decoder = new OpusDecoder();

      expect(() => {
        decoder.decode(new Uint8Array([1, 2, 3]), 0);
      }).toThrow('Decoder not running');
    });

    it('accepts duration parameter', async () => {
      const decoder = new OpusDecoder();
      const frames: AudioData[] = [];

      decoder.on('frame', (frame) => frames.push(frame));

      await decoder.start({
        sampleRate: 48000,
        numberOfChannels: 2,
      });

      const encodedData = new Uint8Array([0x4f, 0x70, 0x75, 0x73]);
      decoder.decode(encodedData, 0, 20000);

      await vi.runAllTimersAsync();

      expect(frames.length).toBe(1);
    });
  });

  describe('event handlers', () => {
    it('registers and calls frame handler', async () => {
      const decoder = new OpusDecoder();
      const handler = vi.fn();

      decoder.on('frame', handler);

      await decoder.start({
        sampleRate: 48000,
        numberOfChannels: 2,
      });

      decoder.decode(new Uint8Array([0x4f, 0x70, 0x75, 0x73]), 0);
      await vi.runAllTimersAsync();

      expect(handler).toHaveBeenCalled();
    });

    it('allows unsubscribing from events', async () => {
      const decoder = new OpusDecoder();
      const handler = vi.fn();

      const unsubscribe = decoder.on('frame', handler);

      await decoder.start({
        sampleRate: 48000,
        numberOfChannels: 2,
      });

      decoder.decode(new Uint8Array([0x4f, 0x70]), 0);
      await vi.runAllTimersAsync();

      expect(handler).toHaveBeenCalledTimes(1);

      unsubscribe();

      decoder.decode(new Uint8Array([0x75, 0x73]), 20000);
      await vi.runAllTimersAsync();

      // Handler should not be called again
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('emits closed event on close', async () => {
      const decoder = new OpusDecoder();
      const closedHandler = vi.fn();

      decoder.on('closed', closedHandler);

      await decoder.start({
        sampleRate: 48000,
        numberOfChannels: 2,
      });

      await decoder.close();

      expect(closedHandler).toHaveBeenCalled();
    });
  });

  describe('close', () => {
    it('closes decoder', async () => {
      const decoder = new OpusDecoder();

      await decoder.start({
        sampleRate: 48000,
        numberOfChannels: 2,
      });

      await decoder.close();

      expect(decoder.state).toBe('closed');
    });

    it('can close multiple times without error', async () => {
      const decoder = new OpusDecoder();

      await decoder.start({
        sampleRate: 48000,
        numberOfChannels: 2,
      });

      await decoder.close();
      await decoder.close(); // Should not throw
    });
  });

  describe('flush', () => {
    it('flushes pending audio', async () => {
      const decoder = new OpusDecoder();

      await decoder.start({
        sampleRate: 48000,
        numberOfChannels: 2,
      });

      await decoder.flush(); // Should not throw
    });

    it('does nothing when not running', async () => {
      const decoder = new OpusDecoder();
      await decoder.flush(); // Should not throw
    });
  });

  describe('reset', () => {
    it('resets decoder state', async () => {
      const decoder = new OpusDecoder();

      await decoder.start({
        sampleRate: 48000,
        numberOfChannels: 2,
      });

      await decoder.reset();

      // Should still be running
      expect(decoder.isRunning).toBe(true);
    });

    it('does nothing when not running', async () => {
      const decoder = new OpusDecoder();
      await decoder.reset(); // Should not throw
    });
  });

  describe('statistics', () => {
    it('tracks decoder statistics', async () => {
      const decoder = new OpusDecoder();

      await decoder.start({
        sampleRate: 48000,
        numberOfChannels: 2,
      });

      for (let i = 0; i < 5; i++) {
        decoder.decode(new Uint8Array([0x4f, 0x70, 0x75, 0x73]), i * 20000);
        await vi.runAllTimersAsync();
      }

      const stats = decoder.getStats();
      expect(stats.framesDecoded).toBe(5);
      expect(stats.state).toBe('running');
    });

    it('resets statistics', async () => {
      const decoder = new OpusDecoder();

      await decoder.start({
        sampleRate: 48000,
        numberOfChannels: 2,
      });

      decoder.decode(new Uint8Array([0x4f, 0x70, 0x75, 0x73]), 0);
      await vi.runAllTimersAsync();

      decoder.resetStats();

      const stats = decoder.getStats();
      expect(stats.framesDecoded).toBe(0);
      expect(stats.errors).toBe(0);
    });
  });

  describe('decoder recovery', () => {
    it('handles decoder closed state gracefully', async () => {
      const decoder = new OpusDecoder();

      await decoder.start({
        sampleRate: 48000,
        numberOfChannels: 2,
      });

      // Decode some frames
      decoder.decode(new Uint8Array([0x4f, 0x70, 0x75, 0x73]), 0);
      await vi.runAllTimersAsync();

      // The decoder should handle unexpected closures
      expect(decoder.isRunning).toBe(true);
    });
  });

  describe('different sample rates', () => {
    it('works with 44100 Hz', async () => {
      const decoder = new OpusDecoder();
      const frames: AudioData[] = [];

      decoder.on('frame', (frame) => frames.push(frame));

      await decoder.start({
        sampleRate: 44100,
        numberOfChannels: 2,
      });

      decoder.decode(new Uint8Array([0x4f, 0x70, 0x75, 0x73]), 0);
      await vi.runAllTimersAsync();

      expect(frames.length).toBe(1);
    });

    it('works with mono audio', async () => {
      const decoder = new OpusDecoder();
      const frames: AudioData[] = [];

      decoder.on('frame', (frame) => frames.push(frame));

      await decoder.start({
        sampleRate: 48000,
        numberOfChannels: 1,
      });

      decoder.decode(new Uint8Array([0x4f, 0x70, 0x75, 0x73]), 0);
      await vi.runAllTimersAsync();

      expect(frames.length).toBe(1);
    });
  });
});
