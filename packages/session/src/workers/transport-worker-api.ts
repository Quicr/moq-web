// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Transport Worker Client API
 *
 * Type-safe client for communicating with the transport worker.
 * Provides the same interface as MOQTransport but delegates to a worker.
 */

import type {
  TransportWorkerConfig,
  TransportWorkerRequest,
  TransportWorkerResponse,
  TransportState,
} from './transport-worker-types.js';

export type { TransportWorkerConfig, TransportState };

/**
 * Event types emitted by TransportWorkerClient
 */
export type TransportWorkerEventType =
  | 'state-change'
  | 'connected'
  | 'disconnected'
  | 'control-message'
  | 'datagram'
  | 'incoming-stream'
  | 'stream-data'
  | 'stream-closed'
  | 'stream-created'
  | 'error';

/**
 * Type-safe client for the transport worker
 *
 * @example
 * ```typescript
 * // Create worker (in application code)
 * const worker = new Worker(
 *   new URL('@web-moq/session/worker', import.meta.url),
 *   { type: 'module' }
 * );
 *
 * // Create client
 * const client = new TransportWorkerClient(worker);
 *
 * // Connect
 * await client.connect({ url: 'https://relay.example.com/moq' });
 *
 * // Listen for events
 * client.on('control-message', ({ data }) => handleControlMessage(data));
 * client.on('datagram', ({ data }) => handleDatagram(data));
 * ```
 */
export class TransportWorkerClient {
  private worker: Worker;
  private handlers = new Map<string, Set<(data: TransportWorkerResponse) => void>>();
  private _state: TransportState = 'disconnected';
  private streamRequestId = 0;
  private pendingStreamCreations = new Map<number, (streamId: number) => void>();

  constructor(worker: Worker) {
    this.worker = worker;
    this.worker.onmessage = this.handleMessage.bind(this);
    this.worker.onerror = this.handleError.bind(this);
  }

  /**
   * Get current transport state
   */
  get state(): TransportState {
    return this._state;
  }

  /**
   * Check if connected
   */
  get isConnected(): boolean {
    return this._state === 'connected';
  }

  /**
   * Connect to relay via worker
   */
  async connect(config: TransportWorkerConfig): Promise<void> {
    return new Promise((resolve, reject) => {
      const handleConnected = (): void => {
        this.off('connected', handleConnected);
        this.off('error', handleError);
        resolve();
      };

      const handleError = (data: { message: string; code?: number }): void => {
        this.off('connected', handleConnected);
        this.off('error', handleError);
        reject(new Error(data.message));
      };

      this.on('connected', handleConnected);
      this.on('error', handleError);
      this._state = 'connecting';
      this.post({ type: 'connect', config });
    });
  }

  /**
   * Disconnect from relay
   */
  disconnect(code?: number, reason?: string): void {
    this.post({ type: 'disconnect', code, reason });
  }

  /**
   * Send data on control stream
   */
  sendControl(data: Uint8Array): void {
    this.post({ type: 'send-control', data }, [data.buffer]);
  }

  /**
   * Send datagram
   */
  sendDatagram(data: Uint8Array): void {
    this.post({ type: 'send-datagram', data }, [data.buffer]);
  }

  /**
   * Create unidirectional stream
   * @returns Promise resolving to stream ID
   */
  async createStream(): Promise<number> {
    const id = ++this.streamRequestId;

    return new Promise((resolve) => {
      this.pendingStreamCreations.set(id, resolve);
      this.post({ type: 'create-stream', id });
    });
  }

  /**
   * Create bidirectional stream (for SUBSCRIBE_NAMESPACE in draft-16)
   * @returns Promise resolving to stream ID
   */
  async createBidiStream(): Promise<number> {
    const id = ++this.streamRequestId;

    return new Promise((resolve) => {
      this.pendingStreamCreations.set(id, resolve);
      this.post({ type: 'create-bidi-stream', id });
    });
  }

  /**
   * Write data to stream
   */
  writeStream(streamId: number, data: Uint8Array, close = false): void {
    this.post({ type: 'write-stream', streamId, data, close }, [data.buffer]);
  }

  /**
   * Close stream
   */
  closeStream(streamId: number): void {
    this.post({ type: 'close-stream', streamId });
  }

  /**
   * Register event handler
   */
  on(type: 'state-change', handler: (data: { state: TransportState }) => void): void;
  on(type: 'connected', handler: () => void): void;
  on(type: 'disconnected', handler: (data: { reason?: string }) => void): void;
  on(type: 'control-message', handler: (data: { data: Uint8Array }) => void): void;
  on(type: 'datagram', handler: (data: { data: Uint8Array }) => void): void;
  on(type: 'incoming-stream', handler: (data: { streamId: number }) => void): void;
  on(type: 'stream-data', handler: (data: { streamId: number; data: Uint8Array }) => void): void;
  on(type: 'bidi-stream-data', handler: (data: { streamId: number; data: Uint8Array }) => void): void;
  on(type: 'stream-closed', handler: (data: { streamId: number }) => void): void;
  on(type: 'error', handler: (data: { message: string; code?: number }) => void): void;
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
   * Terminate worker immediately
   */
  terminate(): void {
    this.worker.terminate();
  }

  private post(msg: TransportWorkerRequest, transfer?: Transferable[]): void {
    if (transfer && transfer.length > 0) {
      this.worker.postMessage(msg, transfer);
    } else {
      this.worker.postMessage(msg);
    }
  }

  private handleMessage(event: MessageEvent<TransportWorkerResponse>): void {
    const response = event.data;

    // Update state
    if (response.type === 'state-change') {
      this._state = response.state;
    }

    // Handle stream creation responses
    if (response.type === 'stream-created' || response.type === 'bidi-stream-created') {
      const resolver = this.pendingStreamCreations.get(response.id);
      if (resolver) {
        this.pendingStreamCreations.delete(response.id);
        resolver(response.streamId);
      }
    }

    // Emit to handlers
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
