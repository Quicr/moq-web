// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Stream Management for MOQT
 *
 * Manages the lifecycle of MOQT streams, including creation,
 * tracking, and cleanup of unidirectional streams for data delivery.
 *
 * @example
 * ```typescript
 * import { StreamManager } from '@web-moq/core';
 *
 * const manager = new StreamManager(transport);
 *
 * // Create a stream for a track
 * const stream = await manager.createStream('track-1', Priority.HIGH);
 *
 * // Write data
 * await stream.write(headerBytes);
 * await stream.write(payloadBytes);
 *
 * // Close when done
 * await stream.close();
 * ```
 */

import { Logger } from '../utils/logger.js';
import { Priority } from '../messages/types.js';
import { MOQTransport } from '../transport/transport.js';

const log = Logger.create('moqt:transport:streams');

/**
 * Managed stream wrapper
 */
export interface ManagedStream {
  /** Unique stream identifier */
  id: string;
  /** Track key associated with this stream */
  trackKey: string;
  /** Stream priority */
  priority: Priority;
  /** Underlying writable stream */
  stream: WritableStream<Uint8Array>;
  /** Stream writer */
  writer: WritableStreamDefaultWriter<Uint8Array>;
  /** Creation timestamp */
  createdAt: number;
  /** Bytes written */
  bytesWritten: number;
  /** Whether stream is closed */
  closed: boolean;
}

/**
 * Stream creation options
 */
export interface StreamOptions {
  /** Stream priority (default: MEDIUM_HIGH) */
  priority?: Priority;
  /** Custom stream ID (default: auto-generated) */
  id?: string;
}

/**
 * Stream Manager for MOQT
 *
 * @remarks
 * Manages unidirectional streams for MOQT data delivery.
 * Tracks active streams, handles cleanup, and provides
 * statistics for monitoring.
 *
 * @example
 * ```typescript
 * const manager = new StreamManager(transport);
 *
 * // Listen for stream events
 * manager.on('stream-created', (stream) => {
 *   console.log('Stream created:', stream.id);
 * });
 *
 * // Create a stream
 * const stream = await manager.createStream('video-track');
 *
 * // Write header
 * await manager.writeToStream(stream.id, headerBytes);
 *
 * // Write objects
 * for (const object of objects) {
 *   await manager.writeToStream(stream.id, object);
 * }
 *
 * // Close stream
 * await manager.closeStream(stream.id);
 * ```
 */
export class StreamManager {
  /** Transport instance */
  private transport: MOQTransport;
  /** Active streams by ID */
  private streams = new Map<string, ManagedStream>();
  /** Streams by track key */
  private streamsByTrack = new Map<string, Set<string>>();
  /** Next stream ID counter */
  private nextStreamId = 1;
  /** Event handlers */
  private handlers = new Map<string, Set<(data: unknown) => void>>();

  /**
   * Create a new StreamManager
   *
   * @param transport - MOQTransport instance
   */
  constructor(transport: MOQTransport) {
    this.transport = transport;

    log.debug('StreamManager created');
  }

  /**
   * Create a new unidirectional stream
   *
   * @param trackKey - Track key to associate with the stream
   * @param options - Stream options
   * @returns Managed stream wrapper
   *
   * @example
   * ```typescript
   * const stream = await manager.createStream('video', {
   *   priority: Priority.HIGH,
   * });
   * ```
   */
  async createStream(
    trackKey: string,
    options: StreamOptions = {}
  ): Promise<ManagedStream> {
    if (!this.transport.isConnected) {
      throw new Error('Transport not connected');
    }

    const id = options.id ?? `stream-${this.nextStreamId++}`;
    const priority = options.priority ?? Priority.MEDIUM_HIGH;

    log.debug('Creating stream', { id, trackKey, priority });

    const stream = await this.transport.createUnidirectionalStream();
    const writer = stream.getWriter();

    const managed: ManagedStream = {
      id,
      trackKey,
      priority,
      stream,
      writer,
      createdAt: Date.now(),
      bytesWritten: 0,
      closed: false,
    };

    this.streams.set(id, managed);

    // Track by track key
    if (!this.streamsByTrack.has(trackKey)) {
      this.streamsByTrack.set(trackKey, new Set());
    }
    this.streamsByTrack.get(trackKey)!.add(id);

    this.emit('stream-created', managed);
    log.info('Stream created', { id, trackKey });

    return managed;
  }

  /**
   * Get a stream by ID
   *
   * @param id - Stream ID
   * @returns Managed stream or undefined
   */
  getStream(id: string): ManagedStream | undefined {
    return this.streams.get(id);
  }

  /**
   * Get all streams for a track
   *
   * @param trackKey - Track key
   * @returns Array of managed streams
   */
  getStreamsForTrack(trackKey: string): ManagedStream[] {
    const ids = this.streamsByTrack.get(trackKey);
    if (!ids) return [];

    return Array.from(ids)
      .map(id => this.streams.get(id))
      .filter((s): s is ManagedStream => s !== undefined);
  }

  /**
   * Write data to a stream
   *
   * @param id - Stream ID
   * @param data - Data to write
   * @throws Error if stream not found or closed
   *
   * @example
   * ```typescript
   * await manager.writeToStream(stream.id, payloadBytes);
   * ```
   */
  async writeToStream(id: string, data: Uint8Array): Promise<void> {
    const stream = this.streams.get(id);
    if (!stream) {
      throw new Error(`Stream not found: ${id}`);
    }

    if (stream.closed) {
      throw new Error(`Stream is closed: ${id}`);
    }

    log.trace('Writing to stream', { id, bytes: data.byteLength });
    await stream.writer.write(data);
    stream.bytesWritten += data.byteLength;
  }

  /**
   * Close a stream
   *
   * @param id - Stream ID
   *
   * @example
   * ```typescript
   * await manager.closeStream(stream.id);
   * ```
   */
  async closeStream(id: string): Promise<void> {
    const stream = this.streams.get(id);
    if (!stream || stream.closed) return;

    log.debug('Closing stream', { id, bytesWritten: stream.bytesWritten });

    try {
      await stream.writer.close();
    } catch (err) {
      log.warn('Error closing stream writer', err as Error);
    }

    stream.closed = true;
    this.emit('stream-closed', stream);

    log.info('Stream closed', { id, bytesWritten: stream.bytesWritten });
  }

  /**
   * Abort a stream
   *
   * @param id - Stream ID
   * @param reason - Abort reason
   */
  async abortStream(id: string, reason?: string): Promise<void> {
    const stream = this.streams.get(id);
    if (!stream || stream.closed) return;

    log.warn('Aborting stream', { id, reason });

    try {
      await stream.writer.abort(reason);
    } catch (err) {
      log.warn('Error aborting stream', err as Error);
    }

    stream.closed = true;
    this.emit('stream-aborted', stream);
  }

  /**
   * Remove a stream from tracking
   *
   * @param id - Stream ID
   */
  removeStream(id: string): void {
    const stream = this.streams.get(id);
    if (!stream) return;

    this.streams.delete(id);

    const trackStreams = this.streamsByTrack.get(stream.trackKey);
    if (trackStreams) {
      trackStreams.delete(id);
      if (trackStreams.size === 0) {
        this.streamsByTrack.delete(stream.trackKey);
      }
    }

    log.debug('Stream removed', { id });
  }

  /**
   * Close all streams for a track
   *
   * @param trackKey - Track key
   */
  async closeStreamsForTrack(trackKey: string): Promise<void> {
    const streams = this.getStreamsForTrack(trackKey);
    await Promise.all(streams.map(s => this.closeStream(s.id)));
  }

  /**
   * Close all streams
   */
  async closeAll(): Promise<void> {
    const streams = Array.from(this.streams.values());
    await Promise.all(streams.map(s => this.closeStream(s.id)));
  }

  /**
   * Get stream statistics
   *
   * @returns Stream statistics
   */
  getStats(): {
    totalStreams: number;
    activeStreams: number;
    closedStreams: number;
    totalBytesWritten: number;
    streamsByTrack: Record<string, number>;
  } {
    let activeCount = 0;
    let closedCount = 0;
    let totalBytes = 0;
    const byTrack: Record<string, number> = {};

    for (const stream of this.streams.values()) {
      if (stream.closed) {
        closedCount++;
      } else {
        activeCount++;
      }
      totalBytes += stream.bytesWritten;
      byTrack[stream.trackKey] = (byTrack[stream.trackKey] ?? 0) + 1;
    }

    return {
      totalStreams: this.streams.size,
      activeStreams: activeCount,
      closedStreams: closedCount,
      totalBytesWritten: totalBytes,
      streamsByTrack: byTrack,
    };
  }

  /**
   * Register an event handler
   *
   * @param event - Event type
   * @param handler - Handler function
   * @returns Unsubscribe function
   */
  on(event: string, handler: (data: unknown) => void): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler);

    return () => {
      this.handlers.get(event)?.delete(handler);
    };
  }

  /**
   * Emit an event
   */
  private emit(event: string, data: unknown): void {
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
}

/**
 * Incoming stream reader helper
 *
 * @remarks
 * Utility class for reading data from incoming unidirectional streams.
 *
 * @example
 * ```typescript
 * const reader = new StreamReader(incomingStream);
 *
 * // Read header
 * const header = await reader.read(headerSize);
 *
 * // Read remaining data
 * const payload = await reader.readAll();
 * ```
 */
export class StreamReader {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private buffer: Uint8Array = new Uint8Array(0);
  private _closed = false;

  /**
   * Create a StreamReader
   *
   * @param stream - Readable stream to read from
   */
  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader();
  }

  /**
   * Check if stream is closed
   */
  get closed(): boolean {
    return this._closed;
  }

  /**
   * Append data to buffer
   * Always copies incoming data since WebTransport may reuse its internal buffer
   */
  private appendToBuffer(data: Uint8Array): void {
    if (this.buffer.length === 0) {
      // Copy the data - WebTransport streams may reuse their internal buffer
      this.buffer = data.slice();
    } else {
      // Need to combine buffers
      const newBuffer = new Uint8Array(this.buffer.length + data.length);
      newBuffer.set(this.buffer);
      newBuffer.set(data, this.buffer.length);
      this.buffer = newBuffer;
    }
  }

  /**
   * Read exactly n bytes
   *
   * @param n - Number of bytes to read
   * @returns Uint8Array of exactly n bytes (zero-copy view when possible)
   * @throws Error if stream ends before n bytes are read
   */
  async read(n: number): Promise<Uint8Array> {
    // Fill buffer until we have enough bytes
    while (this.buffer.length < n) {
      const { value, done } = await this.reader.read();
      if (done) {
        this._closed = true;
        throw new Error(`Stream ended early: wanted ${n} bytes, got ${this.buffer.length}`);
      }
      this.appendToBuffer(value);
    }

    // Extract requested bytes using subarray (view into our owned buffer)
    const result = this.buffer.subarray(0, n);
    // Create new buffer for remaining data
    this.buffer = this.buffer.length > n ? this.buffer.slice(n) : new Uint8Array(0);
    return result;
  }

  /**
   * Read all remaining data
   *
   * @returns Uint8Array containing all remaining bytes
   */
  async readAll(): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [this.buffer];
    let totalLength = this.buffer.length;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { value, done } = await this.reader.read();
      if (done) {
        this._closed = true;
        break;
      }
      chunks.push(value);
      totalLength += value.length;
    }

    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }

    this.buffer = new Uint8Array(0);
    return result;
  }

  /**
   * Try to read n bytes without blocking
   *
   * @param n - Maximum bytes to read
   * @returns Bytes read (may be less than n, zero-copy view when possible)
   */
  async tryRead(n: number): Promise<Uint8Array> {
    if (this.buffer.length >= n) {
      const result = this.buffer.subarray(0, n);
      this.buffer = this.buffer.length > n ? this.buffer.slice(n) : new Uint8Array(0);
      return result;
    }

    // Try one read
    const { value, done } = await this.reader.read();
    if (done) {
      this._closed = true;
      const result = this.buffer;
      this.buffer = new Uint8Array(0);
      return result;
    }

    this.appendToBuffer(value);

    const readSize = Math.min(n, this.buffer.length);
    const result = this.buffer.subarray(0, readSize);
    this.buffer = this.buffer.length > readSize ? this.buffer.slice(readSize) : new Uint8Array(0);
    return result;
  }

  /**
   * Cancel reading and release the stream
   */
  async cancel(): Promise<void> {
    await this.reader.cancel();
    this._closed = true;
  }
}
