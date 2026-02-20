// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Test setup - WebCodecs API mocks for Node.js environment
 */

import { vi } from 'vitest';

// Mock performance.now if not available
if (typeof performance === 'undefined') {
  (globalThis as unknown as { performance: { now: () => number } }).performance = {
    now: () => Date.now(),
  };
}

/**
 * Mock VideoEncoder
 */
class MockVideoEncoder {
  state: 'unconfigured' | 'configured' | 'closed' = 'unconfigured';
  private outputCallback: (chunk: EncodedVideoChunk, metadata?: EncodedVideoChunkMetadata) => void;
  private errorCallback: (error: DOMException) => void;
  private config?: VideoEncoderConfig;
  private frameCount = 0;

  constructor(init: { output: (chunk: EncodedVideoChunk, metadata?: EncodedVideoChunkMetadata) => void; error: (error: DOMException) => void }) {
    this.outputCallback = init.output;
    this.errorCallback = init.error;
  }

  configure(config: VideoEncoderConfig): void {
    this.config = config;
    this.state = 'configured';
  }

  encode(frame: VideoFrame, options?: { keyFrame?: boolean }): void {
    if (this.state !== 'configured') {
      throw new DOMException('Encoder not configured', 'InvalidStateError');
    }

    const isKeyframe = options?.keyFrame || this.frameCount === 0;
    this.frameCount++;

    // Simulate async output
    setTimeout(() => {
      const mockData = new Uint8Array([0, 0, 0, 1, 0x67, 0x42, 0x00, 0x1f]); // Fake H.264 NAL
      const chunk = new MockEncodedVideoChunk({
        type: isKeyframe ? 'key' : 'delta',
        data: mockData,
        timestamp: frame.timestamp || 0,
        duration: frame.duration || 33333,
      });

      const metadata: EncodedVideoChunkMetadata = {};
      if (isKeyframe) {
        metadata.decoderConfig = {
          codec: this.config?.codec || 'avc1.42001f',
          codedWidth: this.config?.width || 1280,
          codedHeight: this.config?.height || 720,
          description: new Uint8Array([0x01, 0x42, 0x00, 0x1f, 0xff]),
        };
      }

      this.outputCallback(chunk as unknown as EncodedVideoChunk, metadata);
    }, 0);
  }

  async flush(): Promise<void> {
    // No-op for mock
  }

  close(): void {
    this.state = 'closed';
  }

  reset(): void {
    this.state = 'unconfigured';
    this.frameCount = 0;
  }

  static async isConfigSupported(config: VideoEncoderConfig): Promise<{ supported: boolean; config?: VideoEncoderConfig }> {
    // Support common H.264 profiles
    const supportedCodecs = ['avc1.42001f', 'avc1.42E01f', 'avc1.4D001f', 'avc1.64001f'];
    const supported = supportedCodecs.some(c => config.codec.startsWith(c.substring(0, 8)));
    return { supported, config: supported ? config : undefined };
  }
}

/**
 * Mock VideoDecoder
 */
class MockVideoDecoder {
  state: 'unconfigured' | 'configured' | 'closed' = 'unconfigured';
  private outputCallback: (frame: VideoFrame) => void;
  private errorCallback: (error: DOMException) => void;
  private config?: VideoDecoderConfig;

  constructor(init: { output: (frame: VideoFrame) => void; error: (error: DOMException) => void }) {
    this.outputCallback = init.output;
    this.errorCallback = init.error;
  }

  configure(config: VideoDecoderConfig): void {
    this.config = config;
    this.state = 'configured';
  }

  decode(chunk: EncodedVideoChunk): void {
    if (this.state !== 'configured') {
      throw new DOMException('Decoder not configured', 'InvalidStateError');
    }

    // Simulate async output
    setTimeout(() => {
      const frame = new MockVideoFrame({
        timestamp: chunk.timestamp,
        codedWidth: this.config?.codedWidth || 1280,
        codedHeight: this.config?.codedHeight || 720,
        displayWidth: this.config?.codedWidth || 1280,
        displayHeight: this.config?.codedHeight || 720,
      });
      this.outputCallback(frame as unknown as VideoFrame);
    }, 0);
  }

  async flush(): Promise<void> {
    // No-op for mock
  }

  close(): void {
    this.state = 'closed';
  }

  reset(): void {
    this.state = 'unconfigured';
  }

  static async isConfigSupported(config: VideoDecoderConfig): Promise<{ supported: boolean; config?: VideoDecoderConfig }> {
    const supported = config.codec.startsWith('avc1');
    return { supported, config: supported ? config : undefined };
  }
}

/**
 * Mock AudioEncoder
 */
class MockAudioEncoder {
  state: 'unconfigured' | 'configured' | 'closed' = 'unconfigured';
  private outputCallback: (chunk: EncodedAudioChunk, metadata?: EncodedAudioChunkMetadata) => void;
  private errorCallback: (error: DOMException) => void;
  private config?: AudioEncoderConfig;

  constructor(init: { output: (chunk: EncodedAudioChunk, metadata?: EncodedAudioChunkMetadata) => void; error: (error: DOMException) => void }) {
    this.outputCallback = init.output;
    this.errorCallback = init.error;
  }

  configure(config: AudioEncoderConfig): void {
    this.config = config;
    this.state = 'configured';
  }

  encode(audioData: AudioData): void {
    if (this.state !== 'configured') {
      throw new DOMException('Encoder not configured', 'InvalidStateError');
    }

    // Simulate async output
    setTimeout(() => {
      const mockData = new Uint8Array([0x4f, 0x70, 0x75, 0x73]); // "Opus" header bytes
      const chunk = new MockEncodedAudioChunk({
        type: 'key',
        data: mockData,
        timestamp: audioData.timestamp || 0,
        duration: audioData.duration || 20000,
      });
      this.outputCallback(chunk as unknown as EncodedAudioChunk, {});
    }, 0);
  }

  async flush(): Promise<void> {
    // No-op for mock
  }

  close(): void {
    this.state = 'closed';
  }

  reset(): void {
    this.state = 'unconfigured';
  }

  static async isConfigSupported(config: AudioEncoderConfig): Promise<{ supported: boolean; config?: AudioEncoderConfig }> {
    const supported = config.codec === 'opus';
    return { supported, config: supported ? config : undefined };
  }
}

/**
 * Mock AudioDecoder
 */
class MockAudioDecoder {
  state: 'unconfigured' | 'configured' | 'closed' = 'unconfigured';
  private outputCallback: (audioData: AudioData) => void;
  private errorCallback: (error: DOMException) => void;
  private config?: AudioDecoderConfig;

  constructor(init: { output: (audioData: AudioData) => void; error: (error: DOMException) => void }) {
    this.outputCallback = init.output;
    this.errorCallback = init.error;
  }

  configure(config: AudioDecoderConfig): void {
    this.config = config;
    this.state = 'configured';
  }

  decode(chunk: EncodedAudioChunk): void {
    if (this.state !== 'configured') {
      throw new DOMException('Decoder not configured', 'InvalidStateError');
    }

    // Simulate async output
    setTimeout(() => {
      const audioData = new MockAudioData({
        timestamp: chunk.timestamp,
        numberOfFrames: 960,
        numberOfChannels: this.config?.numberOfChannels || 2,
        sampleRate: this.config?.sampleRate || 48000,
        format: 'f32-planar',
      });
      this.outputCallback(audioData as unknown as AudioData);
    }, 0);
  }

  async flush(): Promise<void> {
    // No-op for mock
  }

  close(): void {
    this.state = 'closed';
  }

  reset(): void {
    this.state = 'unconfigured';
  }

  static async isConfigSupported(config: AudioDecoderConfig): Promise<{ supported: boolean; config?: AudioDecoderConfig }> {
    const supported = config.codec === 'opus';
    return { supported, config: supported ? config : undefined };
  }
}

/**
 * Mock EncodedVideoChunk
 */
class MockEncodedVideoChunk {
  readonly type: 'key' | 'delta';
  readonly timestamp: number;
  readonly duration: number | null;
  readonly byteLength: number;
  private data: Uint8Array;

  constructor(init: { type: 'key' | 'delta'; data: BufferSource; timestamp: number; duration?: number }) {
    this.type = init.type;
    this.timestamp = init.timestamp;
    this.duration = init.duration ?? null;
    if (init.data instanceof ArrayBuffer) {
      this.data = new Uint8Array(init.data);
    } else if (ArrayBuffer.isView(init.data)) {
      this.data = new Uint8Array(init.data.buffer, init.data.byteOffset, init.data.byteLength);
    } else {
      this.data = new Uint8Array(init.data as ArrayBuffer);
    }
    this.byteLength = this.data.byteLength;
  }

  copyTo(destination: BufferSource): void {
    const dest = destination instanceof ArrayBuffer
      ? new Uint8Array(destination)
      : new Uint8Array((destination as ArrayBufferView).buffer, (destination as ArrayBufferView).byteOffset, (destination as ArrayBufferView).byteLength);
    dest.set(this.data);
  }
}

/**
 * Mock EncodedAudioChunk
 */
class MockEncodedAudioChunk {
  readonly type: 'key' | 'delta';
  readonly timestamp: number;
  readonly duration: number | null;
  readonly byteLength: number;
  private data: Uint8Array;

  constructor(init: { type: 'key' | 'delta'; data: BufferSource; timestamp: number; duration?: number }) {
    this.type = init.type;
    this.timestamp = init.timestamp;
    this.duration = init.duration ?? null;
    if (init.data instanceof ArrayBuffer) {
      this.data = new Uint8Array(init.data);
    } else if (ArrayBuffer.isView(init.data)) {
      this.data = new Uint8Array(init.data.buffer, init.data.byteOffset, init.data.byteLength);
    } else {
      this.data = new Uint8Array(init.data as ArrayBuffer);
    }
    this.byteLength = this.data.byteLength;
  }

  copyTo(destination: BufferSource): void {
    const dest = destination instanceof ArrayBuffer
      ? new Uint8Array(destination)
      : new Uint8Array((destination as ArrayBufferView).buffer, (destination as ArrayBufferView).byteOffset, (destination as ArrayBufferView).byteLength);
    dest.set(this.data);
  }
}

/**
 * Mock VideoFrame
 */
class MockVideoFrame {
  readonly timestamp: number;
  readonly duration: number | null;
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly displayWidth: number;
  readonly displayHeight: number;
  readonly format: string | null = 'I420';
  private _closed = false;

  constructor(init: {
    timestamp: number;
    duration?: number;
    codedWidth: number;
    codedHeight: number;
    displayWidth: number;
    displayHeight: number;
  }) {
    this.timestamp = init.timestamp;
    this.duration = init.duration ?? null;
    this.codedWidth = init.codedWidth;
    this.codedHeight = init.codedHeight;
    this.displayWidth = init.displayWidth;
    this.displayHeight = init.displayHeight;
  }

  close(): void {
    this._closed = true;
  }

  clone(): MockVideoFrame {
    return new MockVideoFrame({
      timestamp: this.timestamp,
      duration: this.duration ?? undefined,
      codedWidth: this.codedWidth,
      codedHeight: this.codedHeight,
      displayWidth: this.displayWidth,
      displayHeight: this.displayHeight,
    });
  }
}

/**
 * Mock AudioData
 */
class MockAudioData {
  readonly timestamp: number;
  readonly duration: number;
  readonly numberOfFrames: number;
  readonly numberOfChannels: number;
  readonly sampleRate: number;
  readonly format: string;
  private _closed = false;

  constructor(init: {
    timestamp: number;
    numberOfFrames: number;
    numberOfChannels: number;
    sampleRate: number;
    format: string;
  }) {
    this.timestamp = init.timestamp;
    this.numberOfFrames = init.numberOfFrames;
    this.numberOfChannels = init.numberOfChannels;
    this.sampleRate = init.sampleRate;
    this.format = init.format;
    this.duration = Math.round((init.numberOfFrames / init.sampleRate) * 1_000_000);
  }

  close(): void {
    this._closed = true;
  }

  clone(): MockAudioData {
    return new MockAudioData({
      timestamp: this.timestamp,
      numberOfFrames: this.numberOfFrames,
      numberOfChannels: this.numberOfChannels,
      sampleRate: this.sampleRate,
      format: this.format,
    });
  }

  copyTo(destination: BufferSource, options?: { planeIndex?: number }): void {
    // No-op for mock
  }
}

// Type declarations for config interfaces
interface VideoEncoderConfig {
  codec: string;
  width: number;
  height: number;
  bitrate?: number;
  framerate?: number;
  hardwareAcceleration?: string;
  latencyMode?: string;
  avc?: { format: string };
}

interface VideoDecoderConfig {
  codec: string;
  codedWidth: number;
  codedHeight: number;
  description?: BufferSource;
  hardwareAcceleration?: string;
  optimizeForLatency?: boolean;
}

interface AudioEncoderConfig {
  codec: string;
  sampleRate: number;
  numberOfChannels: number;
  bitrate?: number;
}

interface AudioDecoderConfig {
  codec: string;
  sampleRate: number;
  numberOfChannels: number;
  description?: BufferSource;
}

interface EncodedVideoChunkMetadata {
  decoderConfig?: {
    codec: string;
    codedWidth: number;
    codedHeight: number;
    description?: BufferSource;
  };
}

interface EncodedAudioChunkMetadata {
  decoderConfig?: {
    codec: string;
    sampleRate: number;
    numberOfChannels: number;
  };
}

// Install mocks on globalThis
(globalThis as Record<string, unknown>).VideoEncoder = MockVideoEncoder;
(globalThis as Record<string, unknown>).VideoDecoder = MockVideoDecoder;
(globalThis as Record<string, unknown>).AudioEncoder = MockAudioEncoder;
(globalThis as Record<string, unknown>).AudioDecoder = MockAudioDecoder;
(globalThis as Record<string, unknown>).EncodedVideoChunk = MockEncodedVideoChunk;
(globalThis as Record<string, unknown>).EncodedAudioChunk = MockEncodedAudioChunk;
(globalThis as Record<string, unknown>).VideoFrame = MockVideoFrame;
(globalThis as Record<string, unknown>).AudioData = MockAudioData;

// Export mocks for direct use in tests
export {
  MockVideoEncoder,
  MockVideoDecoder,
  MockAudioEncoder,
  MockAudioDecoder,
  MockEncodedVideoChunk,
  MockEncodedAudioChunk,
  MockVideoFrame,
  MockAudioData,
};
