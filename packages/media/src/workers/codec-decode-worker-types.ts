// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Codec Decode Worker Type Definitions
 *
 * Message types for communication with the WebCodecs decode worker.
 * This worker handles LOC unpackaging, jitter buffering, AND video/audio decoding.
 *
 * The worker supports multiple concurrent decode channels (subscriptions), each
 * with its own decoder instances and jitter buffers. Messages include a channelId
 * to route data to the correct decoder context.
 */

/**
 * Video decoder configuration
 */
export interface VideoDecoderWorkerConfig {
  /** Codec string (e.g., 'avc1.42001f') */
  codec: string;
  /** Coded frame width */
  codedWidth: number;
  /** Coded frame height */
  codedHeight: number;
  /** Optional initial codec description (SPS/PPS for H.264) */
  description?: Uint8Array;
}

/**
 * Audio decoder configuration
 */
export interface AudioDecoderWorkerConfig {
  /** Codec string (e.g., 'opus') */
  codec: string;
  /** Sample rate */
  sampleRate: number;
  /** Number of channels */
  numberOfChannels: number;
}

/**
 * Worker initialization config for a single channel
 */
export interface CodecDecodeWorkerConfig {
  /** Video decoder configuration (optional) */
  video?: VideoDecoderWorkerConfig;
  /** Audio decoder configuration (optional) */
  audio?: AudioDecoderWorkerConfig;
  /** Jitter buffer target delay in ms (default: 50) */
  jitterBufferDelay?: number;
  /** Enable debug logging */
  debug?: boolean;
  /** Enable latency stats emission */
  enableStats?: boolean;
}

/**
 * Messages from main thread to worker
 *
 * All messages (except 'close') include a channelId to identify which
 * decode context to use. Each channel has its own decoders and buffers.
 *
 * The 'init' message includes a MessagePort for direct point-to-point
 * communication, avoiding broadcast overhead when multiple channels exist.
 */
export type CodecDecodeWorkerRequest =
  | { type: 'init'; channelId: number; config: CodecDecodeWorkerConfig }
  | { type: 'push'; channelId: number; data: Uint8Array; groupId: number; objectId: number; timestamp: number }
  | { type: 'poll'; channelId: number }
  | { type: 'poll-all' }
  | { type: 'reconfigure-video'; channelId: number; config: VideoDecoderWorkerConfig }
  | { type: 'reconfigure-audio'; channelId: number; config: AudioDecoderWorkerConfig }
  | { type: 'reset'; channelId: number }
  | { type: 'destroy'; channelId: number }
  | { type: 'close' };

/**
 * Decoded video frame result
 */
export interface VideoDecodedResult {
  /** Decoded VideoFrame (transferred) */
  frame: VideoFrame;
  /** Group ID */
  groupId: number;
  /** Object ID */
  objectId: number;
  /** Presentation timestamp in microseconds */
  timestamp: number;
}

/**
 * Decoded audio data result
 */
export interface AudioDecodedResult {
  /** Decoded AudioData (transferred) */
  data: AudioData;
  /** Group ID */
  groupId: number;
  /** Object ID */
  objectId: number;
  /** Presentation timestamp in microseconds */
  timestamp: number;
}

/**
 * Latency stats sample
 */
export interface LatencyStatsSample {
  /** Time from object arrival to frame decode complete (ms) */
  processingDelay: number;
  /** Current jitter buffer depth (frames) */
  bufferDepth: number;
  /** Time spent in jitter buffer (ms) */
  bufferDelay: number;
}

/**
 * Messages from worker to main thread
 *
 * Responses include channelId so the main thread can route decoded
 * frames to the correct subscription handler.
 */
export type CodecDecodeWorkerResponse =
  | { type: 'ready'; channelId: number }
  | { type: 'video-ready'; channelId: number }
  | { type: 'audio-ready'; channelId: number }
  | { type: 'video-frame'; channelId: number; result: VideoDecodedResult }
  | { type: 'audio-data'; channelId: number; result: AudioDecodedResult }
  | { type: 'latency-stats'; channelId: number; stats: LatencyStatsSample }
  | { type: 'poll-result'; channelId: number; videoFrames: number; audioFrames: number }
  | { type: 'destroyed'; channelId: number }
  | { type: 'error'; channelId?: number; message: string }
  | { type: 'closed' };
