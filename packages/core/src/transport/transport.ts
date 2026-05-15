// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview WebTransport Wrapper for MOQT
 *
 * Provides a high-level abstraction over the WebTransport API for MOQT
 * connections. Manages the control stream, unidirectional streams, and
 * datagram communication.
 *
 * @see https://www.w3.org/TR/webtransport/
 *
 * @example
 * ```typescript
 * import { MOQTransport } from '@web-moq/core';
 *
 * const transport = new MOQTransport();
 *
 * // Listen for events
 * transport.on('state-change', (state) => console.log('State:', state));
 * transport.on('datagram', (data) => console.log('Received datagram'));
 * transport.on('unidirectional-stream', (stream) => handleStream(stream));
 *
 * // Connect
 * await transport.connect('https://relay.example.com/moq');
 *
 * // Send control message
 * await transport.sendControl(messageBytes);
 *
 * // Send datagram
 * await transport.sendDatagram(objectBytes);
 * ```
 */

import { Logger } from '../utils/logger.js';
import { getCurrentALPNProtocol, IS_DRAFT_18 } from '../version/constants.js';
import { MOQTVarInt } from '../encoding/moqt-varint.js';
import { StreamTypeDraft18 } from '../messages/types.js';

const log = Logger.create('moqt:transport');

/**
 * Transport state
 */
export type TransportState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'closing'
  | 'closed'
  | 'failed';

/**
 * Transport event types
 */
export type TransportEventType =
  | 'state-change'
  | 'datagram'
  | 'unidirectional-stream'
  | 'control-message'
  | 'setup-message'
  | 'incoming-bidi-stream'
  | 'error';

/**
 * Transport event payloads
 */
export interface TransportEvents {
  'state-change': TransportState;
  'datagram': Uint8Array;
  'unidirectional-stream': ReadableStream<Uint8Array>;
  'control-message': Uint8Array;
  'setup-message': Uint8Array;
  'incoming-bidi-stream': { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> };
  'error': Error;
}

/**
 * Event handler function type
 */
export type TransportEventHandler<T extends TransportEventType> = (
  data: TransportEvents[T]
) => void;

/**
 * Configuration options for MOQTransport
 */
export interface TransportConfig {
  /** Maximum datagram size in bytes (default: 1200) */
  maxDatagramSize?: number;
  /** Enable congestion control (default: true) */
  congestionControl?: boolean;
  /** Server certificate hashes for self-signed certs */
  serverCertificateHashes?: ArrayBuffer[];
  /** Connection timeout in ms (default: 300000 = 5 minutes) */
  connectionTimeout?: number;
}

/**
 * MOQ Transport Layer
 *
 * @remarks
 * Wraps the WebTransport API to provide a MOQT-specific interface.
 * Manages the bidirectional control stream, incoming unidirectional
 * streams, and datagram communication.
 *
 * @example
 * ```typescript
 * const transport = new MOQTransport({
 *   maxDatagramSize: 1200,
 *   connectionTimeout: 15000,
 * });
 *
 * transport.on('state-change', (state) => {
 *   if (state === 'connected') {
 *     console.log('Transport connected!');
 *   }
 * });
 *
 * await transport.connect('https://relay.example.com/moq');
 * ```
 */
export class MOQTransport {
  /** Underlying WebTransport instance */
  private transport?: WebTransport;
  /** Control stream writer (draft-14/16) */
  private controlWriter?: WritableStreamDefaultWriter<Uint8Array>;
  /** Control stream reader (draft-14/16) */
  private controlReader?: ReadableStreamDefaultReader<Uint8Array>;
  /** Setup stream writer (draft-18 outgoing unidirectional) */
  private setupWriter?: WritableStreamDefaultWriter<Uint8Array>;
  /** Setup stream reader (draft-18 incoming unidirectional) */
  private setupReader?: ReadableStreamDefaultReader<Uint8Array>;
  /** Current transport state */
  private _state: TransportState = 'disconnected';
  /** Event handlers */
  private handlers = new Map<TransportEventType, Set<TransportEventHandler<TransportEventType>>>();
  /** Configuration */
  private config: Required<TransportConfig>;
  /** Connection URL */
  private _url?: string;
  /** Abort controller for connection timeout */
  private abortController?: AbortController;

  /**
   * Create a new MOQTransport
   *
   * @param config - Configuration options
   */
  constructor(config: TransportConfig = {}) {
    this.config = {
      maxDatagramSize: config.maxDatagramSize ?? 1200,
      congestionControl: config.congestionControl ?? true,
      serverCertificateHashes: config.serverCertificateHashes ?? [],
      connectionTimeout: config.connectionTimeout ?? 300000,
    };

    log.debug('MOQTransport created', this.config);
  }

  /**
   * Get current transport state
   */
  get state(): TransportState {
    return this._state;
  }

  /**
   * Get connection URL
   */
  get url(): string | undefined {
    return this._url;
  }

  /**
   * Check if transport is connected
   */
  get isConnected(): boolean {
    return this._state === 'connected';
  }

  /**
   * Get maximum datagram size
   */
  get maxDatagramSize(): number {
    return this.config.maxDatagramSize;
  }

  /**
   * Update transport state and emit event
   */
  private setState(state: TransportState): void {
    if (this._state === state) return;

    const previousState = this._state;
    this._state = state;

    log.info('Transport state changed', { from: previousState, to: state });
    this.emit('state-change', state);
  }

  /**
   * Connect to a MOQT relay
   *
   * @param url - WebTransport URL (must start with https://)
   * @returns Promise that resolves when connected
   * @throws Error if connection fails
   *
   * @example
   * ```typescript
   * await transport.connect('https://relay.example.com/moq');
   * ```
   */
  async connect(url: string): Promise<void> {
    if (this._state !== 'disconnected') {
      throw new Error(`Cannot connect: transport is ${this._state}`);
    }

    this._url = url;
    this.setState('connecting');
    this.abortController = new AbortController();

    log.info('Connecting to relay', { url });

    try {
      // Create WebTransport connection
      const alpnProtocol = getCurrentALPNProtocol();
      log.info('Using ALPN protocol', { protocol: alpnProtocol });
      const options: WebTransportOptions & { protocols?: string[] } = {
        congestionControl: this.config.congestionControl ? 'default' : 'throughput',
        protocols: [alpnProtocol],
      };

      // Add certificate hashes if provided (for self-signed certs)
      if (this.config.serverCertificateHashes.length > 0) {
        options.serverCertificateHashes = this.config.serverCertificateHashes.map(hash => ({
          algorithm: 'sha-256',
          value: hash,
        }));
        // Debug: log the hash being used
        const hashArray = new Uint8Array(this.config.serverCertificateHashes[0]);
        const hashHex = Array.from(hashArray).map(b => b.toString(16).padStart(2, '0')).join(':');
        log.info('Using certificate hash', { hashHex, byteLength: hashArray.byteLength });
      }

      log.debug('WebTransport options', {
        hasHashes: !!options.serverCertificateHashes,
        hashCount: options.serverCertificateHashes?.length ?? 0
      });

      this.transport = new WebTransport(url, options);

      // Set up connection timeout
      const timeoutId = setTimeout(() => {
        this.abortController?.abort();
        this.transport?.close();
        this.handleError(new Error('Connection timeout'));
      }, this.config.connectionTimeout);

      // Wait for connection to be ready
      await this.transport.ready;
      clearTimeout(timeoutId);

      log.debug('WebTransport connected');

      if (IS_DRAFT_18) {
        // Draft-18: Setup uses pair of unidirectional streams with 0x2F00 type
        // Create outgoing setup stream
        const setupStream = await this.transport.createUnidirectionalStream();
        this.setupWriter = setupStream.getWriter();

        // Write stream type (0x2F00 as MOQT varint)
        const streamType = MOQTVarInt.encode(BigInt(StreamTypeDraft18.SETUP));
        await this.setupWriter.write(streamType);

        log.debug('Draft-18 outgoing setup stream established');

        // Start listening for streams (including incoming setup stream)
        this.startStreamListener();
        this.startDatagramListener();
        this.startBidiStreamListener();
      } else {
        // Draft-14/16: Single bidirectional control stream
        const controlStream = await this.transport.createBidirectionalStream();
        this.controlWriter = controlStream.writable.getWriter();
        this.controlReader = controlStream.readable.getReader();

        log.debug('Control stream established');

        // Start listening for incoming streams and datagrams
        this.startStreamListener();
        this.startDatagramListener();
        this.startControlListener();
      }

      // Set up close handler
      this.transport.closed
        .then(() => {
          log.info('Transport closed');
          this.handleClose();
        })
        .catch((err) => {
          log.error('Transport closed with error', err);
          this.handleError(err);
        });

      this.setState('connected');
      log.info('Connected to relay', { url });
    } catch (err) {
      log.error('Connection failed', err as Error);
      this.handleError(err as Error);
      throw err;
    }
  }

  /**
   * Start listening for incoming unidirectional streams
   */
  private async startStreamListener(): Promise<void> {
    if (!this.transport) return;

    log.debug('Starting stream listener');
    const reader = this.transport.incomingUnidirectionalStreams.getReader();

    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value: stream, done } = await reader.read();
        if (done) {
          log.debug('Stream listener ended');
          break;
        }

        if (IS_DRAFT_18) {
          // Draft-18: Check stream type to route appropriately
          this.handleDraft18UnidirectionalStream(stream);
        } else {
          log.trace('Received unidirectional stream');
          this.emit('unidirectional-stream', stream);
        }
      }
    } catch (err) {
      if (this._state === 'connected') {
        log.error('Stream listener error', err as Error);
        this.handleError(err as Error);
      } else {
        log.info('Stream listener stopped', { state: this._state, error: (err as Error).message });
      }
    }
  }

  /**
   * Handle incoming unidirectional stream for draft-18
   * Routes based on stream type (0x2F00 = setup, 0x05 = fetch, etc.)
   */
  private async handleDraft18UnidirectionalStream(stream: ReadableStream<Uint8Array>): Promise<void> {
    const streamReader = stream.getReader();

    try {
      // Read stream type (MOQT varint)
      const { value: firstChunk, done } = await streamReader.read();
      if (done || !firstChunk || firstChunk.length === 0) {
        log.warn('Empty unidirectional stream received');
        streamReader.releaseLock();
        return;
      }

      // Decode stream type from first bytes
      const [streamType, bytesRead] = MOQTVarInt.decode(firstChunk);
      const streamTypeNum = Number(streamType);

      log.debug('Draft-18 unidirectional stream received', {
        streamType: streamTypeNum,
        streamTypeHex: `0x${streamTypeNum.toString(16)}`,
      });

      if (streamTypeNum === StreamTypeDraft18.SETUP) {
        // Setup stream from server - save reader for receiving SERVER_SETUP
        this.setupReader = streamReader;

        // Create a new stream that combines the remaining first chunk bytes with future reads
        const remaining = firstChunk.subarray(bytesRead);
        this.startSetupListener(remaining);
      } else {
        // Data stream - create a new ReadableStream that includes the remaining bytes
        const remaining = firstChunk.subarray(bytesRead);
        const reconstructedStream = this.reconstructStream(streamReader, remaining);
        this.emit('unidirectional-stream', reconstructedStream);
      }
    } catch (err) {
      log.error('Error handling draft-18 unidirectional stream', err as Error);
      streamReader.releaseLock();
    }
  }

  /**
   * Reconstruct a ReadableStream with pre-read bytes
   */
  private reconstructStream(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    initialBytes: Uint8Array
  ): ReadableStream<Uint8Array> {
    let initial = initialBytes.length > 0 ? initialBytes : null;

    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (initial) {
          controller.enqueue(initial);
          initial = null;
          return;
        }

        const { value, done } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(value);
      },
      cancel() {
        reader.releaseLock();
      },
    });
  }

  /**
   * Start listening for incoming bidirectional streams (draft-18)
   */
  private async startBidiStreamListener(): Promise<void> {
    if (!this.transport) return;

    log.debug('Starting bidi stream listener (draft-18)');
    const reader = this.transport.incomingBidirectionalStreams.getReader();

    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value: stream, done } = await reader.read();
        if (done) {
          log.debug('Bidi stream listener ended');
          break;
        }
        log.debug('Received incoming bidirectional stream');
        this.emit('incoming-bidi-stream', {
          readable: stream.readable,
          writable: stream.writable,
        });
      }
    } catch (err) {
      if (this._state === 'connected') {
        log.error('Bidi stream listener error', err as Error);
        this.handleError(err as Error);
      } else {
        log.info('Bidi stream listener stopped', { state: this._state, error: (err as Error).message });
      }
    }
  }

  /**
   * Start listening for setup stream messages (draft-18)
   */
  private startSetupListener(initialData: Uint8Array): void {
    if (!this.setupReader) return;

    const reader = this.setupReader;

    // Process any initial data
    if (initialData.length > 0) {
      log.trace('Processing initial setup data', { size: initialData.byteLength });
      this.emit('setup-message', initialData);
    }

    // Continue reading
    const readLoop = async () => {
      try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            log.debug('Setup stream ended');
            break;
          }

          log.trace('Received setup message', { size: value.byteLength });
          this.emit('setup-message', value);
        }
      } catch (err) {
        if (this._state === 'connected') {
          log.error('Setup listener error', err as Error);
          this.handleError(err as Error);
        }
      }
    };

    readLoop();
  }

  /**
   * Start listening for incoming datagrams
   */
  private async startDatagramListener(): Promise<void> {
    if (!this.transport) return;

    log.debug('Starting datagram listener');
    const reader = this.transport.datagrams.readable.getReader();

    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value: datagram, done } = await reader.read();
        if (done) {
          log.debug('Datagram listener ended');
          break;
        }
        log.trace('Received datagram', { size: datagram.byteLength });
        this.emit('datagram', datagram);
      }
    } catch (err) {
      if (this._state === 'connected') {
        log.error('Datagram listener error', err as Error);
        this.handleError(err as Error);
      } else {
        log.info('Datagram listener stopped', { state: this._state, error: (err as Error).message });
      }
    }
  }

  /**
   * Start listening for control stream messages
   */
  private async startControlListener(): Promise<void> {
    if (!this.controlReader) return;

    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await this.controlReader.read();
        if (done) {
          log.debug('Control stream ended');
          break;
        }

        log.trace('Received control message', { size: value.byteLength });
        this.emit('control-message', value);
      }
    } catch (err) {
      if (this._state === 'connected') {
        log.error('Control listener error', err as Error);
        this.handleError(err as Error);
      }
    }
  }

  /**
   * Send data on the control stream (draft-14/16) or setup stream (draft-18)
   *
   * @param data - Bytes to send
   * @throws Error if not connected or write fails
   *
   * @example
   * ```typescript
   * await transport.sendControl(MessageCodec.encode(setupMessage));
   * ```
   */
  async sendControl(data: Uint8Array): Promise<void> {
    if (IS_DRAFT_18) {
      if (!this.setupWriter) {
        throw new Error('Setup stream not connected');
      }
      log.trace('Sending setup message (draft-18)', { size: data.byteLength });
      await this.setupWriter.write(data);
    } else {
      if (!this.controlWriter) {
        throw new Error('Not connected');
      }
      log.trace('Sending control message', { size: data.byteLength });
      await this.controlWriter.write(data);
    }
  }

  /**
   * Create a new bidirectional stream (draft-18)
   * Used for per-request control messages (SUBSCRIBE, PUBLISH, FETCH, etc.)
   *
   * @returns Object with readable and writable streams
   */
  async createRequestStream(): Promise<{
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
  }> {
    if (!this.transport) {
      throw new Error('Not connected');
    }

    log.debug('Creating bidirectional request stream');
    const stream = await this.transport.createBidirectionalStream();
    return {
      readable: stream.readable,
      writable: stream.writable,
    };
  }

  /** Datagram writer (kept for reuse to avoid locking issues) */
  private datagramWriter?: WritableStreamDefaultWriter<Uint8Array>;
  /** Datagram write queue to serialize writes */
  private datagramWritePromise: Promise<void> = Promise.resolve();

  /**
   * Send a datagram
   *
   * @param data - Bytes to send
   * @throws Error if not connected, data too large, or write fails
   *
   * @example
   * ```typescript
   * await transport.sendDatagram(ObjectCodec.encodeDatagramObject(object));
   * ```
   */
  async sendDatagram(data: Uint8Array): Promise<void> {
    if (!this.transport) {
      throw new Error('Not connected');
    }

    if (data.byteLength > this.config.maxDatagramSize) {
      throw new Error(
        `Datagram too large: ${data.byteLength} > ${this.config.maxDatagramSize}`
      );
    }

    // Get or create datagram writer
    if (!this.datagramWriter) {
      this.datagramWriter = this.transport.datagrams.writable.getWriter();
    }

    // Queue the write to serialize concurrent calls
    this.datagramWritePromise = this.datagramWritePromise.then(async () => {
      log.trace('Sending datagram', { size: data.byteLength });
      try {
        await this.datagramWriter!.write(data);
      } catch (err) {
        log.warn('Datagram write failed', { error: (err as Error).message });
        // Reset writer on error
        this.datagramWriter = undefined;
        throw err;
      }
    });

    return this.datagramWritePromise;
  }

  /**
   * Create a new unidirectional stream for sending data
   *
   * @returns WritableStream for sending data
   * @throws Error if not connected
   *
   * @example
   * ```typescript
   * const stream = await transport.createUnidirectionalStream();
   * const writer = stream.getWriter();
   * await writer.write(headerBytes);
   * await writer.write(payloadBytes);
   * await writer.close();
   * ```
   */
  async createUnidirectionalStream(): Promise<WritableStream<Uint8Array>> {
    if (!this.transport) {
      throw new Error('Not connected');
    }

    log.trace('Creating unidirectional stream');
    const stream = await this.transport.createUnidirectionalStream();
    return stream;
  }

  /**
   * Create a new bidirectional stream
   *
   * Used for SUBSCRIBE_NAMESPACE (draft-16) which requires a new bidi stream.
   *
   * @returns Bidirectional stream with readable and writable sides
   */
  async createBidirectionalStream(): Promise<WebTransportBidirectionalStream> {
    if (!this.transport) {
      throw new Error('Not connected');
    }

    log.trace('Creating bidirectional stream');
    const stream = await this.transport.createBidirectionalStream();
    return stream;
  }

  /**
   * Close the transport connection
   *
   * @param code - Close code (default: 0)
   * @param reason - Close reason (default: 'Normal closure')
   *
   * @example
   * ```typescript
   * await transport.close(0, 'User disconnected');
   * ```
   */
  async close(code = 0, reason = 'Normal closure'): Promise<void> {
    if (!this.transport) {
      return;
    }

    log.info('Closing transport', { code, reason });
    this.setState('closing');

    try {
      // Close control stream
      if (this.controlWriter) {
        await this.controlWriter.close();
      }

      // Close WebTransport
      this.transport.close({
        closeCode: code,
        reason,
      });
    } catch (err) {
      log.warn('Error during close', err as Error);
    }

    this.cleanup();
    this.setState('closed');
  }

  /**
   * Handle connection close
   */
  private handleClose(): void {
    this.cleanup();
    if (this._state !== 'failed') {
      this.setState('closed');
    }
  }

  /**
   * Handle errors
   */
  private handleError(error: Error): void {
    log.error('Transport error', error);
    this.emit('error', error);
    this.cleanup();
    this.setState('failed');
  }

  /**
   * Clean up resources
   */
  private cleanup(): void {
    if (this.datagramWriter) {
      try {
        this.datagramWriter.releaseLock();
      } catch {
        // Ignore errors during cleanup
      }
    }
    this.datagramWriter = undefined;
    this.datagramWritePromise = Promise.resolve();
    this.controlWriter = undefined;
    this.controlReader = undefined;
    this.transport = undefined;
    this.abortController = undefined;
  }

  /**
   * Register an event handler
   *
   * @param event - Event type to listen for
   * @param handler - Handler function
   * @returns Unsubscribe function
   *
   * @example
   * ```typescript
   * const unsubscribe = transport.on('datagram', (data) => {
   *   console.log('Received:', data.byteLength, 'bytes');
   * });
   *
   * // Later...
   * unsubscribe();
   * ```
   */
  on<T extends TransportEventType>(
    event: T,
    handler: TransportEventHandler<T>
  ): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }

    const handlers = this.handlers.get(event)!;
    handlers.add(handler as TransportEventHandler<TransportEventType>);

    return () => {
      handlers.delete(handler as TransportEventHandler<TransportEventType>);
    };
  }

  /**
   * Emit an event to handlers
   */
  private emit<T extends TransportEventType>(
    event: T,
    data: TransportEvents[T]
  ): void {
    const handlers = this.handlers.get(event);
    if (!handlers) return;

    for (const handler of handlers) {
      try {
        handler(data);
      } catch (err) {
        log.error('Event handler error', err as Error);
      }
    }
  }

  /**
   * Remove all event handlers
   */
  removeAllHandlers(): void {
    this.handlers.clear();
  }

  /**
   * Get transport statistics
   */
  getStats(): {
    state: TransportState;
    url: string | undefined;
    connected: boolean;
  } {
    return {
      state: this._state,
      url: this._url,
      connected: this.isConnected,
    };
  }
}
