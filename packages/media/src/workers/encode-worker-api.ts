// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Encode Worker API
 *
 * Type-safe message definitions for communication with the encode worker.
 */

/**
 * Message types from main thread to worker
 */
export type EncodeWorkerRequest =
  | { type: 'init'; config: EncodeWorkerConfig }
  | { type: 'package-video'; id: number; data: Uint8Array; isKeyframe: boolean; timestamp: number; codecDescription?: Uint8Array }
  | { type: 'package-audio'; id: number; data: Uint8Array; timestamp: number }
  | { type: 'close' };

/**
 * Message types from worker to main thread
 */
export type EncodeWorkerResponse =
  | { type: 'ready' }
  | { type: 'video-packaged'; id: number; data: Uint8Array; groupId: number; objectId: number; isKeyframe: boolean }
  | { type: 'audio-packaged'; id: number; data: Uint8Array; groupId: number; objectId: number }
  | { type: 'error'; message: string }
  | { type: 'closed' };

/**
 * Worker configuration
 */
export interface EncodeWorkerConfig {
  /** Enable debug logging in worker */
  debug?: boolean;
}

/**
 * Type-safe wrapper for posting messages to the encode worker
 */
export class EncodeWorkerClient {
  private worker: Worker;
  private messageId = 0;
  private handlers = new Map<string, Set<(data: EncodeWorkerResponse) => void>>();

  constructor(worker: Worker) {
    this.worker = worker;
    this.worker.onmessage = this.handleMessage.bind(this);
    this.worker.onerror = this.handleError.bind(this);
  }

  /**
   * Initialize the worker
   */
  async init(config: EncodeWorkerConfig = {}): Promise<void> {
    return new Promise((resolve, reject) => {
      const handler = (response: EncodeWorkerResponse) => {
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
   * Package video data (returns immediately, result via event)
   */
  packageVideo(
    data: Uint8Array,
    isKeyframe: boolean,
    timestamp: number,
    codecDescription?: Uint8Array
  ): number {
    const id = ++this.messageId;
    const msg: EncodeWorkerRequest = {
      type: 'package-video',
      id,
      data,
      isKeyframe,
      timestamp,
      codecDescription,
    };

    // Transfer the buffer for zero-copy
    const transfer: Transferable[] = [data.buffer];
    if (codecDescription) {
      transfer.push(codecDescription.buffer);
    }

    this.worker.postMessage(msg, transfer);
    return id;
  }

  /**
   * Package audio data (returns immediately, result via event)
   */
  packageAudio(data: Uint8Array, timestamp: number): number {
    const id = ++this.messageId;
    const msg: EncodeWorkerRequest = {
      type: 'package-audio',
      id,
      data,
      timestamp,
    };

    // Transfer the buffer for zero-copy
    this.worker.postMessage(msg, [data.buffer]);
    return id;
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
  on(type: 'video-packaged', handler: (data: Extract<EncodeWorkerResponse, { type: 'video-packaged' }>) => void): void;
  on(type: 'audio-packaged', handler: (data: Extract<EncodeWorkerResponse, { type: 'audio-packaged' }>) => void): void;
  on(type: 'error', handler: (data: Extract<EncodeWorkerResponse, { type: 'error' }>) => void): void;
  on(type: 'ready', handler: (data: Extract<EncodeWorkerResponse, { type: 'ready' }>) => void): void;
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
  off(type: string, handler: (data: EncodeWorkerResponse) => void): void {
    this.handlers.get(type)?.delete(handler);
  }

  private post(msg: EncodeWorkerRequest): void {
    this.worker.postMessage(msg);
  }

  private handleMessage(event: MessageEvent<EncodeWorkerResponse>): void {
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
