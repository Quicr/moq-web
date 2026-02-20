// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Codec Decode Worker Client API
 *
 * Type-safe client for communicating with the codec decode worker.
 * Supports multiple channels (subscriptions) per worker, each with its
 * own decoder context. Messages include channelId for routing.
 *
 * Uses a shared message handler with O(1) dispatch via a registry map,
 * avoiding O(N) filtering overhead when multiple clients share a worker.
 */

import type {
  CodecDecodeWorkerConfig,
  CodecDecodeWorkerRequest,
  CodecDecodeWorkerResponse,
  VideoDecodedResult,
  AudioDecodedResult,
  VideoDecoderWorkerConfig,
  AudioDecoderWorkerConfig,
  LatencyStatsSample,
} from './codec-decode-worker-types.js';

export type {
  CodecDecodeWorkerConfig,
  VideoDecodedResult,
  AudioDecodedResult,
  VideoDecoderWorkerConfig,
  AudioDecoderWorkerConfig,
  LatencyStatsSample,
} from './codec-decode-worker-types.js';

/**
 * Response with channelId for routing
 */
export interface ChannelVideoFrameResponse {
  channelId: number;
  result: VideoDecodedResult;
}

export interface ChannelAudioDataResponse {
  channelId: number;
  result: AudioDecodedResult;
}

export interface ChannelPollResult {
  channelId: number;
  videoFrames: number;
  audioFrames: number;
}

export interface ChannelErrorResponse {
  channelId?: number;
  message: string;
}

export interface ChannelLatencyStatsResponse {
  channelId: number;
  stats: LatencyStatsSample;
}

/**
 * Registry of clients per worker for O(1) message dispatch
 * Maps worker -> (channelId -> client)
 */
const workerRegistries = new WeakMap<Worker, Map<number, CodecDecodeWorkerClient>>();

/**
 * Get or create a registry for a worker
 */
function getRegistry(worker: Worker): Map<number, CodecDecodeWorkerClient> {
  let registry = workerRegistries.get(worker);
  if (!registry) {
    registry = new Map();
    workerRegistries.set(worker, registry);

    // Set up shared message handler for this worker
    worker.addEventListener('message', (event: MessageEvent<CodecDecodeWorkerResponse>) => {
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
 * Type-safe client for the codec decode worker (multiplexed)
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
 *   new URL('@web-moq/media/codec-decode-worker', import.meta.url),
 *   { type: 'module' }
 * );
 *
 * // Create client for subscription 1
 * const client1 = new CodecDecodeWorkerClient(worker, 1);
 * await client1.init({ video: { codec: 'avc1.42001f', codedWidth: 1280, codedHeight: 720 } });
 *
 * // Create client for subscription 2
 * const client2 = new CodecDecodeWorkerClient(worker, 2);
 * await client2.init({ video: { codec: 'avc1.42001f', codedWidth: 1280, codedHeight: 720 } });
 *
 * // Each client receives only its own frames (O(1) dispatch)
 * client1.on('video-frame', (response) => {
 *   ctx1.drawImage(response.result.frame, 0, 0);
 *   response.result.frame.close();
 * });
 * ```
 */
export class CodecDecodeWorkerClient {
  private worker: Worker;
  private channelId: number;
  private registry: Map<number, CodecDecodeWorkerClient>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handlers = new Map<string, Set<(data: any) => void>>();

  /**
   * Create a client for a specific channel on the worker
   *
   * @param worker - Shared worker instance
   * @param channelId - Unique channel ID for this subscription
   */
  constructor(worker: Worker, channelId: number) {
    this.worker = worker;
    this.channelId = channelId;

    // Register this client in the shared registry for O(1) dispatch
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
   * Initialize the channel with decoder configuration
   */
  async init(config: CodecDecodeWorkerConfig): Promise<void> {
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
   * Push LOC-packaged data to the worker for decoding
   * The data buffer is transferred to the worker (zero-copy)
   */
  push(data: Uint8Array, groupId: number, objectId: number, timestamp: number): void {
    this.worker.postMessage(
      { type: 'push', channelId: this.channelId, data, groupId, objectId, timestamp } as CodecDecodeWorkerRequest,
      [data.buffer]
    );
  }

  /**
   * Poll for decoded frames on this channel
   * Call this periodically (e.g., at 60fps) to receive decoded frames
   */
  poll(): void {
    this.post({ type: 'poll', channelId: this.channelId });
  }

  /**
   * Reconfigure the video decoder (e.g., when codec description changes)
   */
  reconfigureVideo(config: VideoDecoderWorkerConfig): void {
    const msg: CodecDecodeWorkerRequest = { type: 'reconfigure-video', channelId: this.channelId, config };
    if (config.description) {
      // Transfer description buffer
      this.worker.postMessage(msg, [config.description.buffer]);
    } else {
      this.post(msg);
    }
  }

  /**
   * Reconfigure the audio decoder
   */
  reconfigureAudio(config: AudioDecoderWorkerConfig): void {
    this.post({ type: 'reconfigure-audio', channelId: this.channelId, config });
  }

  /**
   * Reset channel state (e.g., when seeking)
   */
  reset(): void {
    this.post({ type: 'reset', channelId: this.channelId });
  }

  /**
   * Destroy this channel and clean up resources
   * Call this when unsubscribing
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
  on(type: 'video-frame', handler: (data: ChannelVideoFrameResponse) => void): void;
  on(type: 'audio-data', handler: (data: ChannelAudioDataResponse) => void): void;
  on(type: 'video-ready', handler: (data: { channelId: number }) => void): void;
  on(type: 'audio-ready', handler: (data: { channelId: number }) => void): void;
  on(type: 'ready', handler: (data: { channelId: number }) => void): void;
  on(type: 'poll-result', handler: (data: ChannelPollResult) => void): void;
  on(type: 'latency-stats', handler: (data: ChannelLatencyStatsResponse) => void): void;
  on(type: 'error', handler: (data: ChannelErrorResponse) => void): void;
  on(type: 'destroyed', handler: (data: { channelId: number }) => void): void;
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
   * Dispatch a message to this client's handlers (called by shared handler)
   * @internal
   */
  dispatchMessage(response: CodecDecodeWorkerResponse): void {
    const handlers = this.handlers.get(response.type);
    if (handlers) {
      for (const handler of handlers) {
        handler(response);
      }
    }
  }

  /**
   * Dispatch an error to this client's handlers (called by shared handler)
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

  private post(msg: CodecDecodeWorkerRequest): void {
    this.worker.postMessage(msg);
  }
}
