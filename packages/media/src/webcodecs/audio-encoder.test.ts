// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Opus Audio Encoder Tests
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { OpusEncoder, type EncodedAudioFrame } from './audio-encoder';
import { MockAudioData } from '../__tests__/setup';

describe('OpusEncoder', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('constructor', () => {
    it('creates encoder with default config', () => {
      const encoder = new OpusEncoder();

      expect(encoder.state).toBe('idle');
      expect(encoder.isRunning).toBe(false);
      expect(encoder.currentConfig.sampleRate).toBe(48000);
      expect(encoder.currentConfig.numberOfChannels).toBe(2);
      expect(encoder.currentConfig.bitrate).toBe(128000);
    });

    it('accepts custom config', () => {
      const encoder = new OpusEncoder({
        sampleRate: 44100,
        numberOfChannels: 1,
        bitrate: 64000,
        application: 'voip',
      });

      expect(encoder.currentConfig.sampleRate).toBe(44100);
      expect(encoder.currentConfig.numberOfChannels).toBe(1);
      expect(encoder.currentConfig.bitrate).toBe(64000);
      expect(encoder.currentConfig.application).toBe('voip');
    });
  });

  describe('isSupported', () => {
    it('returns true for Opus config', async () => {
      const supported = await OpusEncoder.isSupported({
        sampleRate: 48000,
        numberOfChannels: 2,
        bitrate: 128000,
      });

      expect(supported).toBe(true);
    });

    it('returns true for default config', async () => {
      const supported = await OpusEncoder.isSupported();
      expect(supported).toBe(true);
    });
  });

  describe('start', () => {
    it('starts encoder successfully', async () => {
      const encoder = new OpusEncoder();

      await encoder.start();

      expect(encoder.state).toBe('running');
      expect(encoder.isRunning).toBe(true);
    });

    it('throws if already running', async () => {
      const encoder = new OpusEncoder();

      await encoder.start();
      await expect(encoder.start()).rejects.toThrow('Encoder already running');
    });

    it('throws if closed', async () => {
      const encoder = new OpusEncoder();

      await encoder.start();
      await encoder.close();

      await expect(encoder.start()).rejects.toThrow('Encoder is closed');
    });
  });

  describe('encode', () => {
    it('encodes audio data', async () => {
      const encoder = new OpusEncoder();
      const frames: EncodedAudioFrame[] = [];

      encoder.on('frame', (frame) => frames.push(frame));

      await encoder.start();

      const audioData = new MockAudioData({
        timestamp: 0,
        numberOfFrames: 960,
        numberOfChannels: 2,
        sampleRate: 48000,
        format: 'f32-planar',
      });

      await encoder.encode(audioData as unknown as AudioData);
      await vi.runAllTimersAsync();

      expect(frames.length).toBe(1);
      expect(frames[0].sampleRate).toBe(48000);
      expect(frames[0].numberOfChannels).toBe(2);
    });

    it('silently skips when not running', async () => {
      const encoder = new OpusEncoder();

      const audioData = new MockAudioData({
        timestamp: 0,
        numberOfFrames: 960,
        numberOfChannels: 2,
        sampleRate: 48000,
        format: 'f32-planar',
      });

      // Should not throw
      await encoder.encode(audioData as unknown as AudioData);
    });

    it('encodes multiple frames', async () => {
      const encoder = new OpusEncoder();
      const frames: EncodedAudioFrame[] = [];

      encoder.on('frame', (frame) => frames.push(frame));

      await encoder.start();

      for (let i = 0; i < 10; i++) {
        const audioData = new MockAudioData({
          timestamp: i * 20000, // 20ms frames
          numberOfFrames: 960,
          numberOfChannels: 2,
          sampleRate: 48000,
          format: 'f32-planar',
        });
        await encoder.encode(audioData as unknown as AudioData);
        await vi.runAllTimersAsync();
      }

      expect(frames.length).toBe(10);
    });
  });

  describe('event handlers', () => {
    it('registers and calls frame handler', async () => {
      const encoder = new OpusEncoder();
      const handler = vi.fn();

      encoder.on('frame', handler);

      await encoder.start();

      const audioData = new MockAudioData({
        timestamp: 0,
        numberOfFrames: 960,
        numberOfChannels: 2,
        sampleRate: 48000,
        format: 'f32-planar',
      });

      await encoder.encode(audioData as unknown as AudioData);
      await vi.runAllTimersAsync();

      expect(handler).toHaveBeenCalled();
    });

    it('allows unsubscribing from events', async () => {
      const encoder = new OpusEncoder();
      const handler = vi.fn();

      const unsubscribe = encoder.on('frame', handler);

      await encoder.start();

      const audioData1 = new MockAudioData({
        timestamp: 0,
        numberOfFrames: 960,
        numberOfChannels: 2,
        sampleRate: 48000,
        format: 'f32-planar',
      });

      await encoder.encode(audioData1 as unknown as AudioData);
      await vi.runAllTimersAsync();

      expect(handler).toHaveBeenCalledTimes(1);

      unsubscribe();

      const audioData2 = new MockAudioData({
        timestamp: 20000,
        numberOfFrames: 960,
        numberOfChannels: 2,
        sampleRate: 48000,
        format: 'f32-planar',
      });

      await encoder.encode(audioData2 as unknown as AudioData);
      await vi.runAllTimersAsync();

      // Handler should not be called again
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('emits closed event on close', async () => {
      const encoder = new OpusEncoder();
      const closedHandler = vi.fn();

      encoder.on('closed', closedHandler);

      await encoder.start();
      await encoder.close();

      expect(closedHandler).toHaveBeenCalled();
    });
  });

  describe('close', () => {
    it('closes encoder', async () => {
      const encoder = new OpusEncoder();

      await encoder.start();
      await encoder.close();

      expect(encoder.state).toBe('closed');
    });

    it('can close multiple times without error', async () => {
      const encoder = new OpusEncoder();

      await encoder.start();
      await encoder.close();
      await encoder.close(); // Should not throw
    });
  });

  describe('flush', () => {
    it('flushes pending audio', async () => {
      const encoder = new OpusEncoder();

      await encoder.start();
      await encoder.flush(); // Should not throw
    });

    it('does nothing when not running', async () => {
      const encoder = new OpusEncoder();
      await encoder.flush(); // Should not throw
    });
  });

  describe('updateBitrate', () => {
    it('updates bitrate', async () => {
      const encoder = new OpusEncoder();

      await encoder.start();
      await encoder.updateBitrate(256000);

      expect(encoder.currentConfig.bitrate).toBe(256000);
    });

    it('does nothing when not running', async () => {
      const encoder = new OpusEncoder({ bitrate: 128000 });

      await encoder.updateBitrate(256000);
      expect(encoder.currentConfig.bitrate).toBe(128000);
    });
  });

  describe('statistics', () => {
    it('tracks encoder statistics', async () => {
      const encoder = new OpusEncoder();

      await encoder.start();

      for (let i = 0; i < 5; i++) {
        const audioData = new MockAudioData({
          timestamp: i * 20000,
          numberOfFrames: 960,
          numberOfChannels: 2,
          sampleRate: 48000,
          format: 'f32-planar',
        });
        await encoder.encode(audioData as unknown as AudioData);
        await vi.runAllTimersAsync();
      }

      const stats = encoder.getStats();
      expect(stats.framesEncoded).toBe(5);
      expect(stats.bytesEncoded).toBeGreaterThan(0);
      expect(stats.state).toBe('running');
    });

    it('resets statistics', async () => {
      const encoder = new OpusEncoder();

      await encoder.start();

      const audioData = new MockAudioData({
        timestamp: 0,
        numberOfFrames: 960,
        numberOfChannels: 2,
        sampleRate: 48000,
        format: 'f32-planar',
      });

      await encoder.encode(audioData as unknown as AudioData);
      await vi.runAllTimersAsync();

      encoder.resetStats();

      const stats = encoder.getStats();
      expect(stats.framesEncoded).toBe(0);
      expect(stats.bytesEncoded).toBe(0);
    });
  });

  describe('application modes', () => {
    it('accepts voip application mode', () => {
      const encoder = new OpusEncoder({ application: 'voip' });
      expect(encoder.currentConfig.application).toBe('voip');
    });

    it('accepts audio application mode', () => {
      const encoder = new OpusEncoder({ application: 'audio' });
      expect(encoder.currentConfig.application).toBe('audio');
    });

    it('accepts lowdelay application mode', () => {
      const encoder = new OpusEncoder({ application: 'lowdelay' });
      expect(encoder.currentConfig.application).toBe('lowdelay');
    });
  });
});
