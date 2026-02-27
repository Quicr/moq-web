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
  | 'namespace-acknowledged';

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
  /** Whether video is enabled for publishing */
  videoEnabled?: boolean;
  /** Whether audio is enabled for publishing */
  audioEnabled?: boolean;
  /** Enable jitter stats collection for subscriptions */
  enableStats?: boolean;
  /** Jitter buffer delay in milliseconds (default: 100) */
  jitterBufferDelay?: number;
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
