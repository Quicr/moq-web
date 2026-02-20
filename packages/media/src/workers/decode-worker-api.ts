// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Decode Worker API
 *
 * Type-safe message definitions for communication with the decode worker.
 */

/**
 * Message types from main thread to worker
 */
export type DecodeWorkerRequest =
  | { type: 'init'; config: DecodeWorkerConfig }
  | { type: 'push'; id: number; data: Uint8Array; groupId: number; objectId: number; timestamp: number }
  | { type: 'poll' }
  | { type: 'reset' }
  | { type: 'close' };

/**
 * Message types from worker to main thread
 */
export type DecodeWorkerResponse =
  | { type: 'ready' }
  | { type: 'video-frame'; data: Uint8Array; groupId: number; objectId: number; isKeyframe: boolean; timestamp: number; codecDescription?: Uint8Array }
  | { type: 'audio-frame'; data: Uint8Array; groupId: number; objectId: number; timestamp: number }
  | { type: 'poll-result'; videoFrames: number; audioFrames: number }
  | { type: 'error'; message: string }
  | { type: 'closed' };

/**
 * Worker configuration
 */
export interface DecodeWorkerConfig {
  /** Media type to decode */
  mediaType?: 'video' | 'audio';
  /** Jitter buffer target delay in ms */
  jitterBufferDelay?: number;
  /** Enable debug logging */
  debug?: boolean;
}

/**
 * Type-safe wrapper for posting messages to the decode worker
 */
export class DecodeWorkerClient {
  private worker: Worker;
  private messageId = 0;
  private handlers = new Map<string, Set<(data: DecodeWorkerResponse) => void>>();

  constructor(worker: Worker) {
    this.worker = worker;
    this.worker.onmessage = this.handleMessage.bind(this);
    this.worker.onerror = this.handleError.bind(this);
  }

  /**
   * Initialize the worker
   */
  async init(config: DecodeWorkerConfig = {}): Promise<void> {
    return new Promise((resolve, reject) => {
      const handler = (response: DecodeWorkerResponse) => {
        if (response.type === 'ready') {
          this.off('ready', handler);
          resolve();
        } else if (response.type === 'error') {
          this.off('ready', handler);
          reject(new Error(response.message));
        }
      };
      this.on('ready', handler);
      this.post({ type: 'init', config });
    });
  }

  /**
   * Push received LOC data to the worker for unpackaging and buffering
   */
  push(data: Uint8Array, groupId: number, objectId: number, timestamp: number): number {
    const id = ++this.messageId;
    const msg: DecodeWorkerRequest = {
      type: 'push',
      id,
      data,
      groupId,
      objectId,
      timestamp,
    };

    // Transfer the buffer for zero-copy
    this.worker.postMessage(msg, [data.buffer]);
    return id;
  }

  /**
   * Poll for ready frames
   */
  poll(): void {
    this.post({ type: 'poll' });
  }

  /**
   * Reset the worker state
   */
  reset(): void {
    this.post({ type: 'reset' });
  }

  /**
   * Close the worker
   */
  close(): void {
    this.post({ type: 'close' });
  }

  /**
   * Terminate the worker immediately
   */
  terminate(): void {
    this.worker.terminate();
  }

  /**
   * Register event handler
   */
  on(type: 'video-frame', handler: (data: Extract<DecodeWorkerResponse, { type: 'video-frame' }>) => void): void;
  on(type: 'audio-frame', handler: (data: Extract<DecodeWorkerResponse, { type: 'audio-frame' }>) => void): void;
  on(type: 'poll-result', handler: (data: Extract<DecodeWorkerResponse, { type: 'poll-result' }>) => void): void;
  on(type: 'error', handler: (data: Extract<DecodeWorkerResponse, { type: 'error' }>) => void): void;
  on(type: 'ready', handler: (data: Extract<DecodeWorkerResponse, { type: 'ready' }>) => void): void;
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
  off(type: string, handler: (data: DecodeWorkerResponse) => void): void {
    this.handlers.get(type)?.delete(handler);
  }

  private post(msg: DecodeWorkerRequest): void {
    this.worker.postMessage(msg);
  }

  private handleMessage(event: MessageEvent<DecodeWorkerResponse>): void {
    const response = event.data;
    const handlers = this.handlers.get(response.type);
    if (handlers) {
      for (const handler of handlers) {
        handler(response);
      }
    }
  }

  private handleError(event: ErrorEvent): void {
    const handlers = this.handlers.get('error');
    if (handlers) {
      for (const handler of handlers) {
        handler({ type: 'error', message: event.message });
      }
    }
  }
}
