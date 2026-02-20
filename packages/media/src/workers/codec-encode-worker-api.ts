// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Codec Encode Worker Client API
 *
 * Type-safe client for communicating with the codec encode worker.
 * Supports multiple channels (publications) per worker, each with its
 * own encoder context. Messages include channelId for routing.
 *
 * Uses a shared message handler with O(1) dispatch via a registry map,
 * avoiding O(N) filtering overhead when multiple clients share a worker.
 */

import type {
  CodecEncodeWorkerConfig,
  CodecEncodeWorkerRequest,
  CodecEncodeWorkerResponse,
  VideoEncodedResult,
  AudioEncodedResult,
  AudioEncoderWorkerConfig,
} from './codec-encode-worker-types.js';

export type {
  CodecEncodeWorkerConfig,
  VideoEncodedResult,
  AudioEncodedResult,
  VideoEncoderWorkerConfig,
  AudioEncoderWorkerConfig,
} from './codec-encode-worker-types.js';

/**
 * Response with channelId for routing
 */
export interface ChannelVideoEncodedResponse {
  channelId: number;
  result: VideoEncodedResult;
}

export interface ChannelAudioEncodedResponse {
  channelId: number;
  result: AudioEncodedResult;
}

export interface ChannelErrorResponse {
  channelId?: number;
  message: string;
}

/**
 * Registry of clients per worker for O(1) message dispatch
 * Maps worker -> (channelId -> client)
 */
const workerRegistries = new WeakMap<Worker, Map<number, CodecEncodeWorkerClient>>();

/**
 * Get or create a registry for a worker
 */
function getRegistry(worker: Worker): Map<number, CodecEncodeWorkerClient> {
  let registry = workerRegistries.get(worker);
  if (!registry) {
    registry = new Map();
    workerRegistries.set(worker, registry);

    // Set up shared message handler for this worker
    worker.addEventListener('message', (event: MessageEvent<CodecEncodeWorkerResponse>) => {
      const response = event.data;

      // Route to specific client by channelId (O(1) lookup)
      if ('channelId' in response && response.channelId !== undefined) {
        const client = registry!.get(response.channelId);
        if (client) {
          client.dispatchMessage(response);
        }
      } else if (response.type === 'closed') {
        // Worker closed - notify all clients
        for (const client of registry!.values()) {
          client.dispatchMessage(response);
        }
      }
    });

    worker.addEventListener('error', (event: ErrorEvent) => {
      // Broadcast error to all clients on this worker
      for (const client of registry!.values()) {
        client.dispatchError(event);
      }
    });
  }
  return registry;
}

/**
 * Type-safe client for the codec encode worker (multiplexed)
 *
 * This client manages a single channel on a shared worker. Multiple
 * clients can share the same worker, each with a unique channelId.
 * Uses a shared message handler with O(1) dispatch instead of
 * per-client filtering.
 *
 * @example
 * ```typescript
 * // Application creates a shared worker
 * const worker = new Worker(
 *   new URL('@web-moq/media/codec-encode-worker', import.meta.url),
 *   { type: 'module' }
 * );
 *
 * // Create client for publication 1
 * const client1 = new CodecEncodeWorkerClient(worker, 1);
 * await client1.init({
 *   video: { codec: 'avc1.42001f', width: 1280, height: 720, bitrate: 2_000_000, framerate: 30 },
 * });
 *
 * // Create client for publication 2
 * const client2 = new CodecEncodeWorkerClient(worker, 2);
 * await client2.init({
 *   video: { codec: 'avc1.42001f', width: 1280, height: 720, bitrate: 2_000_000, framerate: 30 },
 * });
 *
 * // Each client receives only its own encoded frames
 * client1.on('video-encoded', (response) => {
 *   sendToTrack1(response.result);
 * });
 *
 * client2.on('video-encoded', (response) => {
 *   sendToTrack2(response.result);
 * });
 * ```
 */
export class CodecEncodeWorkerClient {
  private worker: Worker;
  private channelId: number;
  private registry: Map<number, CodecEncodeWorkerClient>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handlers = new Map<string, Set<(data: any) => void>>();

  /**
   * Create a client for a specific channel on the worker
   *
   * @param worker - Shared worker instance
   * @param channelId - Unique channel ID for this publication
   */
  constructor(worker: Worker, channelId: number) {
    this.worker = worker;
    this.channelId = channelId;

    // Register in shared registry for O(1) dispatch
    this.registry = getRegistry(worker);
    this.registry.set(channelId, this);
  }

  /**
   * Get the channel ID for this client
   */
  getChannelId(): number {
    return this.channelId;
  }

  /**
   * Initialize the channel with encoder configuration
   */
  async init(config: CodecEncodeWorkerConfig): Promise<void> {
    return new Promise((resolve, reject) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handleReady = (_response: any): void => {
        this.off('ready', handleReady);
        this.off('error', handleError);
        resolve();
      };

      const handleError = (data: ChannelErrorResponse): void => {
        this.off('ready', handleReady);
        this.off('error', handleError);
        reject(new Error(data.message));
      };

      this.on('ready', handleReady);
      this.on('error', handleError);
      this.post({ type: 'init', channelId: this.channelId, config });
    });
  }

  /**
   * Encode a video frame
   * The VideoFrame is transferred to the worker (zero-copy)
   */
  encodeVideo(frame: VideoFrame, forceKeyframe = false): void {
    // Transfer VideoFrame to worker
    this.worker.postMessage(
      { type: 'encode-video', channelId: this.channelId, frame, forceKeyframe } as CodecEncodeWorkerRequest,
      [frame]
    );
  }

  /**
   * Encode audio data
   * The AudioData is transferred to the worker (zero-copy)
   */
  encodeAudio(data: AudioData): void {
    // Transfer AudioData to worker
    this.worker.postMessage(
      { type: 'encode-audio', channelId: this.channelId, data } as CodecEncodeWorkerRequest,
      [data]
    );
  }

  /**
   * Request next video frame to be a keyframe
   */
  forceKeyframe(): void {
    this.post({ type: 'force-keyframe', channelId: this.channelId });
  }

  /**
   * Update video bitrate (requires encoder reconfiguration)
   */
  updateVideoBitrate(bitrate: number): void {
    this.post({ type: 'update-video-bitrate', channelId: this.channelId, bitrate });
  }

  /**
   * Update audio bitrate (requires encoder reconfiguration)
   */
  updateAudioBitrate(bitrate: number): void {
    this.post({ type: 'update-audio-bitrate', channelId: this.channelId, bitrate });
  }

  /**
   * Reconfigure audio encoder with new settings
   * Use this when actual audio track parameters differ from initial config
   */
  reconfigureAudio(config: AudioEncoderWorkerConfig): void {
    this.post({ type: 'reconfigure-audio', channelId: this.channelId, config });
  }

  /**
   * Flush encoders
   */
  async flush(): Promise<void> {
    return new Promise((resolve, reject) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handleFlushed = (_response: any): void => {
        this.off('flushed', handleFlushed);
        this.off('error', handleError);
        resolve();
      };

      const handleError = (data: ChannelErrorResponse): void => {
        this.off('flushed', handleFlushed);
        this.off('error', handleError);
        reject(new Error(data.message));
      };

      this.on('flushed', handleFlushed);
      this.on('error', handleError);
      this.post({ type: 'flush', channelId: this.channelId });
    });
  }

  /**
   * Reset channel state
   */
  reset(): void {
    this.post({ type: 'reset', channelId: this.channelId });
  }

  /**
   * Destroy this channel and clean up resources
   * Call this when stopping publication
   */
  destroy(): void {
    this.post({ type: 'destroy', channelId: this.channelId });
  }

  /**
   * Close all resources and remove from registry
   * Call this when done with the client
   */
  close(): void {
    // Destroy the channel first
    this.destroy();

    // Remove from registry
    this.registry.delete(this.channelId);

    // Clear handlers
    this.handlers.clear();
  }

  /**
   * Register event handler
   * Handlers only receive events for this channel's channelId
   */
  on(type: 'video-encoded', handler: (data: ChannelVideoEncodedResponse) => void): void;
  on(type: 'audio-encoded', handler: (data: ChannelAudioEncodedResponse) => void): void;
  on(type: 'video-ready', handler: (data: { channelId: number }) => void): void;
  on(type: 'audio-ready', handler: (data: { channelId: number }) => void): void;
  on(type: 'ready', handler: (data: { channelId: number }) => void): void;
  on(type: 'flushed', handler: (data: { channelId: number }) => void): void;
  on(type: 'destroyed', handler: (data: { channelId: number }) => void): void;
  on(type: 'error', handler: (data: ChannelErrorResponse) => void): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(type: string, handler: (data: any) => void): void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    this.handlers.get(type)!.add(handler);
  }

  /**
   * Unregister event handler
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  off(type: string, handler: (data: any) => void): void {
    this.handlers.get(type)?.delete(handler);
  }

  /**
   * Dispatch message from shared handler (called by registry)
   * @internal
   */
  dispatchMessage(response: CodecEncodeWorkerResponse): void {
    const handlers = this.handlers.get(response.type);
    if (handlers) {
      for (const handler of handlers) {
        handler(response);
      }
    }
  }

  /**
   * Dispatch error from shared handler (called by registry)
   * @internal
   */
  dispatchError(event: ErrorEvent): void {
    const handlers = this.handlers.get('error');
    if (handlers) {
      for (const handler of handlers) {
        handler({ type: 'error', channelId: this.channelId, message: event.message });
      }
    }
  }

  private post(msg: CodecEncodeWorkerRequest): void {
    this.worker.postMessage(msg);
  }
}
