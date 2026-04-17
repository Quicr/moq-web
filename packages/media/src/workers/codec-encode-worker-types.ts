// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Codec Encode Worker Type Definitions
 *
 * Message types for communication with the WebCodecs encode worker.
 * This worker handles video/audio encoding AND LOC packaging.
 *
 * The worker supports multiple concurrent encode channels (publications), each
 * with its own encoder instances. Messages include a channelId to route data
 * to the correct encoder context.
 */

/**
 * Video encoder configuration
 */
export interface VideoEncoderWorkerConfig {
  /** Codec string (e.g., 'avc1.42001f') */
  codec: string;
  /** Frame width */
  width: number;
  /** Frame height */
  height: number;
  /** Target bitrate in bps */
  bitrate: number;
  /** Target framerate */
  framerate: number;
  /** Keyframe interval in frames (optional) */
  keyframeInterval?: number;
}

/**
 * Audio encoder configuration
 */
export interface AudioEncoderWorkerConfig {
  /** Codec string (e.g., 'opus') */
  codec: string;
  /** Sample rate */
  sampleRate: number;
  /** Number of channels */
  numberOfChannels: number;
  /** Target bitrate in bps */
  bitrate: number;
}

/**
 * Worker initialization config for a single channel
 */
export interface CodecEncodeWorkerConfig {
  /** Video encoder configuration (optional) */
  video?: VideoEncoderWorkerConfig;
  /** Audio encoder configuration (optional) */
  audio?: AudioEncoderWorkerConfig;
  /** Enable debug logging */
  debug?: boolean;
  /** Enable QuicR-Mac interop mode (fixed-size LOC extensions) */
  quicrInteropEnabled?: boolean;
  /** Participant ID for QuicR interop (32-bit) */
  quicrParticipantId?: number;
}

/**
 * Messages from main thread to worker
 *
 * All messages (except 'close') include a channelId to identify which
 * encode context to use. Each channel has its own encoders.
 */
export type CodecEncodeWorkerRequest =
  | { type: 'init'; channelId: number; config: CodecEncodeWorkerConfig }
  | { type: 'encode-video'; channelId: number; frame: VideoFrame; forceKeyframe?: boolean }
  | { type: 'encode-audio'; channelId: number; data: AudioData }
  | { type: 'update-video-bitrate'; channelId: number; bitrate: number }
  | { type: 'update-audio-bitrate'; channelId: number; bitrate: number }
  | { type: 'reconfigure-audio'; channelId: number; config: AudioEncoderWorkerConfig }
  | { type: 'force-keyframe'; channelId: number }
  | { type: 'flush'; channelId: number }
  | { type: 'reset'; channelId: number }
  | { type: 'destroy'; channelId: number }
  | { type: 'close' };

/**
 * Encoded video result
 */
export interface VideoEncodedResult {
  /** LOC-packaged data */
  data: Uint8Array;
  /** Group ID */
  groupId: number;
  /** Object ID within group */
  objectId: number;
  /** Whether this is a keyframe */
  isKeyframe: boolean;
  /** Presentation timestamp in microseconds */
  timestamp: number;
  /** Frame duration in microseconds */
  duration: number;
  /** Codec description (for keyframes) */
  codecDescription?: Uint8Array;
}

/**
 * Encoded audio result
 */
export interface AudioEncodedResult {
  /** LOC-packaged data */
  data: Uint8Array;
  /** Group ID */
  groupId: number;
  /** Object ID within group */
  objectId: number;
  /** Presentation timestamp in microseconds */
  timestamp: number;
  /** Frame duration in microseconds */
  duration: number;
}

/**
 * Messages from worker to main thread
 *
 * Responses include channelId so the main thread can route encoded
 * packets to the correct publication handler.
 */
export type CodecEncodeWorkerResponse =
  | { type: 'ready'; channelId: number }
  | { type: 'video-ready'; channelId: number }
  | { type: 'audio-ready'; channelId: number }
  | { type: 'video-encoded'; channelId: number; result: VideoEncodedResult }
  | { type: 'audio-encoded'; channelId: number; result: AudioEncodedResult }
  | { type: 'flushed'; channelId: number }
  | { type: 'destroyed'; channelId: number }
  | { type: 'error'; channelId?: number; message: string }
  | { type: 'closed' };
