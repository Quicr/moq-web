// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Media Session Types
 *
 * Type definitions for the media-specific session layer.
 */

import type { GroupOrder } from '@web-moq/core';

/**
 * Session state
 */
export type SessionState = 'none' | 'setup' | 'ready' | 'error';

/**
 * Media session event types
 */
export type MediaSessionEventType =
  | 'state-change'
  | 'video-frame'
  | 'audio-data'
  | 'jitter-sample'
  | 'latency-stats'
  | 'error'
  | 'publish-stats'
  | 'subscribe-stats'
  | 'incoming-subscribe'
  | 'incoming-publish'
  | 'namespace-acknowledged'
  // DVR/FETCH events
  | 'fetch-object'
  | 'fetch-complete'
  | 'fetch-error';

/**
 * Worker configuration for offloading processing to web workers
 */
export interface WorkerConfig {
  /**
   * Transport worker for offloading WebTransport to a worker thread.
   * Application creates and owns this worker.
   *
   * @example
   * ```typescript
   * const transportWorker = new Worker(
   *   new URL('@web-moq/session/worker', import.meta.url),
   *   { type: 'module' }
   * );
   * ```
   */
  transportWorker?: Worker;

  /**
   * Encode worker for offloading WebCodecs encoding + LOC packaging.
   * Application creates and owns this worker.
   *
   * @example
   * ```typescript
   * const encodeWorker = new Worker(
   *   new URL('@web-moq/media/codec-encode-worker', import.meta.url),
   *   { type: 'module' }
   * );
   * ```
   */
  encodeWorker?: Worker;

  /**
   * Decode worker for offloading LOC unpackaging + WebCodecs decoding.
   * Application creates and owns this worker.
   *
   * @example
   * ```typescript
   * const decodeWorker = new Worker(
   *   new URL('@web-moq/media/codec-decode-worker', import.meta.url),
   *   { type: 'module' }
   * );
   * ```
   */
  decodeWorker?: Worker;
}

/**
 * Video/Audio configuration
 */
export interface MediaConfig {
  /** Video bitrate in bits per second */
  videoBitrate: number;
  /** Audio bitrate in bits per second */
  audioBitrate: number;
  /** Video resolution */
  videoResolution: '480p' | '720p' | '1080p';
  /** Keyframe interval in seconds */
  keyframeInterval?: number;
  /** Delivery timeout in milliseconds (0 = drop immediately) */
  deliveryTimeout?: number;
  /** Publisher priority (0 = highest, 255 = lowest) */
  priority?: number;
  /** Delivery mode: 'stream' for reliable ordered delivery, 'datagram' for low-latency unreliable */
  deliveryMode?: 'stream' | 'datagram';
  /** Audio delivery mode when main delivery mode is 'stream' (default: 'datagram' for low latency) */
  audioDeliveryMode?: 'datagram' | 'stream';
  /** Whether video is enabled for publishing */
  videoEnabled?: boolean;
  /** Whether audio is enabled for publishing */
  audioEnabled?: boolean;
  /** Enable jitter stats collection for subscriptions */
  enableStats?: boolean;
  /** Jitter buffer delay in milliseconds (default: 100) */
  jitterBufferDelay?: number;

  // Group-aware jitter buffer options (for parallel QUIC stream handling)
  /** Use GroupArbiter instead of JitterBuffer for group-aware ordering (default: false) */
  useGroupArbiter?: boolean;
  /** Maximum acceptable end-to-end latency in ms before skipping to next keyframe (default: 500) */
  maxLatency?: number;
  /** Initial estimated GOP duration in ms (default: 1000) */
  estimatedGopDuration?: number;
  /** Framerate hint from catalog (improves GOP estimation) */
  catalogFramerate?: number;
  /** Timescale hint from catalog in units per second (e.g., 90000 for video) */
  catalogTimescale?: number;
  /** Skip to latest group immediately when a new group arrives (aggressive catch-up, default: false) */
  skipToLatestGroup?: boolean;
  /** Number of frame intervals to wait before skipping to latest group (grace period, default: 3) */
  skipGraceFrames?: number;
  /** Enable catch-up mode when buffer gets too deep (default: true) */
  enableCatchUp?: boolean;
  /** Number of ready frames that triggers catch-up mode (default: 5) */
  catchUpThreshold?: number;
  /** Use latency-only deadline (true=interactive, false=streaming, default: true) */
  useLatencyDeadline?: boolean;
  /** Enable GroupArbiter debug logging (default: false) */
  arbiterDebug?: boolean;

  // Secure Objects (E2E encryption) options
  /** Enable Secure Objects encryption/decryption */
  secureObjectsEnabled?: boolean;
  /** Cipher suite for encryption (hex string, e.g., "0x0004") */
  secureObjectsCipherSuite?: string;
  /** Track base key for encryption (hex string, 32-64 hex chars = 16-32 bytes) */
  secureObjectsBaseKey?: string;

  // QuicR-Mac interop options
  /** Enable QuicR-Mac interop mode (fixed-size LOC extensions) */
  quicrInteropEnabled?: boolean;
  /** Participant ID for QuicR interop (32-bit) */
  quicrParticipantId?: number;

  // Video decoder config override (from catalog track info)
  /** Override video decoder configuration instead of using videoResolution preset */
  videoDecoderConfig?: {
    codec?: string;
    codedWidth?: number;
    codedHeight?: number;
  };
}

/**
 * Subscribe options
 */
export interface MediaSubscribeOptions {
  /** Subscriber priority (0-255, default 128) */
  priority?: number;
  /** Group ordering preference */
  groupOrder?: GroupOrder;
}

/**
 * Publish options
 */
export interface MediaPublishOptions {
  /** Publisher priority (0-255, default 128) */
  priority?: number;
  /** Group ordering */
  groupOrder?: GroupOrder;
  /** Delivery timeout in milliseconds */
  deliveryTimeout?: number;
  /** Delivery mode: 'stream' for reliable, 'datagram' for low-latency */
  deliveryMode?: 'stream' | 'datagram';
}

/**
 * Resolution configuration
 */
export interface ResolutionConfig {
  width: number;
  height: number;
  codec: string;
}

/**
 * Get resolution configuration from preset
 */
export function getResolutionConfig(resolution: '480p' | '720p' | '1080p'): ResolutionConfig {
  switch (resolution) {
    case '1080p':
      return { width: 1920, height: 1080, codec: 'avc1.42E028' }; // Baseline Level 4.0
    case '720p':
      return { width: 1280, height: 720, codec: 'avc1.42E01F' }; // Baseline Level 3.1
    case '480p':
    default:
      return { width: 854, height: 480, codec: 'avc1.42E01E' }; // Baseline Level 3.0
  }
}
