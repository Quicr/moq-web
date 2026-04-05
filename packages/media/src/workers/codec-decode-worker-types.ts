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

  // Group-aware jitter buffer options (Phase 4)
  /** Use GroupArbiter instead of JitterBuffer for group-aware ordering (default: false) */
  useGroupArbiter?: boolean;
  /** Maximum acceptable end-to-end latency in ms (default: 500) */
  maxLatency?: number;
  /** Initial estimated GOP duration in ms (default: 1000) */
  estimatedGopDuration?: number;
  /** Framerate hint from catalog (optional, improves GOP estimation) */
  catalogFramerate?: number;
  /** Timescale hint from catalog in units per second (optional) */
  catalogTimescale?: number;
  /** Skip to latest group when a newer group arrives (aggressive catch-up, default: false) */
  skipToLatestGroup?: boolean;
  /** Number of frames to wait before skipping to latest group (grace period, default: 3) */
  skipGraceFrames?: number;
  /** Enable catch-up mode when buffer gets too deep (default: true) */
  enableCatchUp?: boolean;
  /** Number of ready frames that triggers catch-up mode (default: 5) */
  catchUpThreshold?: number;
  /** Use latency-only deadline (true=interactive, false=streaming, default: true) */
  useLatencyDeadline?: boolean;
  /** Enable GroupArbiter debug logging (default: false) */
  arbiterDebug?: boolean;
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
  /** Total frames dropped (late arrivals + buffer overflow) */
  framesDropped?: number;
  /** Delta frames dropped while waiting for keyframe */
  framesDroppedBeforeKeyframe?: number;
  /** Frames decoded out of sequence order */
  framesOutOfOrder?: number;
}

/**
 * Decode error diagnostic information
 */
export interface DecodeErrorDiagnostics {
  /** Type of media that failed */
  mediaType: 'video' | 'audio';
  /** Group ID of the frame that caused the error */
  groupId?: number;
  /** Object ID of the frame that caused the error */
  objectId?: number;
  /** Whether the frame was a keyframe */
  isKeyframe?: boolean;
  /** Size of the frame data in bytes */
  dataSize?: number;
  /** Sequence number of the frame */
  sequence?: number;
  /** Number of frames successfully decoded before this error */
  framesDecodedBefore: number;
  /** Number of keyframes received before this error */
  keyframesReceived: number;
  /** Whether decoder had received initial keyframe */
  hadKeyframe: boolean;
  /** Timestamp when error occurred */
  timestamp: number;
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
  | { type: 'error'; channelId?: number; message: string; diagnostics?: DecodeErrorDiagnostics }
  | { type: 'closed' };
