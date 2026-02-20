// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Datagram Management for MOQT
 *
 * Manages sending and receiving of MOQT objects via WebTransport datagrams.
 * Datagrams provide low-latency, best-effort delivery suitable for real-time
 * media where timeliness is more important than reliability.
 *
 * @example
 * ```typescript
 * import { DatagramManager } from '@web-moq/core';
 *
 * const manager = new DatagramManager(transport);
 *
 * // Listen for incoming datagrams
 * manager.on('object', (object) => {
 *   console.log('Received object:', object.header.groupId, object.header.objectId);
 * });
 *
 * // Send an object via datagram
 * await manager.sendObject(object);
 * ```
 */

import { Logger } from '../utils/logger.js';
import { ObjectCodec } from '../encoding/message-codec.js';
import { MOQTObject, ObjectHeader } from '../messages/types.js';
import { MOQTransport } from '../transport/transport.js';

const log = Logger.create('moqt:transport:datagram');

/**
 * Datagram statistics
 */
export interface DatagramStats {
  /** Total datagrams sent */
  sent: number;
  /** Total datagrams received */
  received: number;
  /** Datagrams dropped due to size */
  droppedSize: number;
  /** Datagrams dropped due to decode error */
  droppedDecode: number;
  /** Total bytes sent */
  bytesSent: number;
  /** Total bytes received */
  bytesReceived: number;
}

/**
 * Datagram Manager for MOQT
 *
 * @remarks
 * Handles MOQT object delivery via WebTransport datagrams.
 * Datagrams are unreliable but low-latency, making them suitable
 * for real-time media applications where dropped frames are
 * preferable to delayed delivery.
 *
 * Features:
 * - Size validation against maximum datagram size
 * - Automatic encoding/decoding of MOQT objects
 * - Statistics tracking
 * - Event-based notification of received objects
 *
 * @example
 * ```typescript
 * const manager = new DatagramManager(transport);
 *
 * // Start listening for datagrams
 * manager.start();
 *
 * // Handle received objects
 * manager.on('object', (object) => {
 *   handleMediaObject(object);
 * });
 *
 * // Send objects
 * for (const frame of frames) {
 *   try {
 *     await manager.sendObject({
 *       header: {
 *         subscribeId: 1,
 *         trackAlias: 1,
 *         groupId: frame.groupId,
 *         objectId: frame.objectId,
 *         publisherPriority: 128,
 *         objectStatus: ObjectStatus.NORMAL,
 *       },
 *       payload: frame.data,
 *       payloadLength: frame.data.byteLength,
 *     });
 *   } catch (err) {
 *     console.warn('Datagram send failed:', err);
 *   }
 * }
 * ```
 */
export class DatagramManager {
  /** Transport instance */
  private transport: MOQTransport;
  /** Event handlers */
  private handlers = new Map<string, Set<(data: unknown) => void>>();
  /** Statistics */
  private stats: DatagramStats = {
    sent: 0,
    received: 0,
    droppedSize: 0,
    droppedDecode: 0,
    bytesSent: 0,
    bytesReceived: 0,
  };
  /** Whether listening is active */
  private listening = false;
  /** Unsubscribe function for transport events */
  private unsubscribe?: () => void;

  /**
   * Create a new DatagramManager
   *
   * @param transport - MOQTransport instance
   */
  constructor(transport: MOQTransport) {
    this.transport = transport;
    log.debug('DatagramManager created');
  }

  /**
   * Start listening for incoming datagrams
   *
   * @example
   * ```typescript
   * manager.start();
   * ```
   */
  start(): void {
    if (this.listening) return;

    this.unsubscribe = this.transport.on('datagram', this.handleDatagram.bind(this));
    this.listening = true;
    log.info('Datagram listener started');
  }

  /**
   * Stop listening for incoming datagrams
   */
  stop(): void {
    if (!this.listening) return;

    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.listening = false;
    log.info('Datagram listener stopped');
  }

  /**
   * Check if listening is active
   */
  get isListening(): boolean {
    return this.listening;
  }

  /**
   * Get maximum payload size for datagrams
   *
   * @remarks
   * Returns the maximum payload size after accounting for MOQT header overhead.
   * The actual datagram size limit depends on the network path MTU.
   */
  get maxPayloadSize(): number {
    // Reserve bytes for header (conservative estimate)
    // Message type (1) + subscribeId (8) + trackAlias (8) + groupId (8) +
    // objectId (8) + priority (1) + status (1) = ~35 bytes max
    return this.transport.maxDatagramSize - 40;
  }

  /**
   * Send an object via datagram
   *
   * @param object - MOQT object to send
   * @throws Error if object is too large for datagram
   *
   * @example
   * ```typescript
   * await manager.sendObject({
   *   header: {
   *     subscribeId: 1,
   *     trackAlias: 1,
   *     groupId: 5,
   *     objectId: 3,
   *     publisherPriority: 128,
   *     objectStatus: ObjectStatus.NORMAL,
   *   },
   *   payload: frameData,
   *   payloadLength: frameData.byteLength,
   * });
   * ```
   */
  async sendObject(object: MOQTObject): Promise<void> {
    const encoded = ObjectCodec.encodeDatagramObject(object);

    if (encoded.byteLength > this.transport.maxDatagramSize) {
      this.stats.droppedSize++;
      throw new Error(
        `Object too large for datagram: ${encoded.byteLength} > ${this.transport.maxDatagramSize}`
      );
    }

    log.trace('Sending datagram object', {
      groupId: object.header.groupId,
      objectId: object.header.objectId,
      size: encoded.byteLength,
    });

    await this.transport.sendDatagram(encoded);
    this.stats.sent++;
    this.stats.bytesSent += encoded.byteLength;
  }

  /**
   * Send raw header with payload via datagram
   *
   * @param header - Object header
   * @param payload - Object payload
   */
  async sendRaw(header: ObjectHeader, payload: Uint8Array): Promise<void> {
    await this.sendObject({
      header,
      payload,
      payloadLength: payload.byteLength,
    });
  }

  /**
   * Check if a payload will fit in a datagram
   *
   * @param payloadSize - Payload size in bytes
   * @returns True if the payload fits
   */
  canFit(payloadSize: number): boolean {
    return payloadSize <= this.maxPayloadSize;
  }

  /**
   * Handle incoming datagram
   */
  private handleDatagram(data: Uint8Array): void {
    this.stats.received++;
    this.stats.bytesReceived += data.byteLength;

    try {
      const object = ObjectCodec.decodeDatagramObject(data);

      log.trace('Received datagram object', {
        groupId: object.header.groupId,
        objectId: object.header.objectId,
        size: data.byteLength,
      });

      this.emit('object', object);
    } catch (err) {
      log.warn('Failed to decode datagram', err as Error);
      this.stats.droppedDecode++;
      this.emit('error', err);
    }
  }

  /**
   * Get datagram statistics
   *
   * @returns Statistics object
   */
  getStats(): DatagramStats {
    return { ...this.stats };
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    this.stats = {
      sent: 0,
      received: 0,
      droppedSize: 0,
      droppedDecode: 0,
      bytesSent: 0,
      bytesReceived: 0,
    };
  }

  /**
   * Register an event handler
   *
   * @param event - Event type ('object' or 'error')
   * @param handler - Handler function
   * @returns Unsubscribe function
   *
   * @example
   * ```typescript
   * manager.on('object', (object: MOQTObject) => {
   *   console.log('Received:', object.header.groupId);
   * });
   *
   * manager.on('error', (error: Error) => {
   *   console.error('Datagram error:', error);
   * });
   * ```
   */
  on(event: 'object', handler: (object: MOQTObject) => void): () => void;
  on(event: 'error', handler: (error: Error) => void): () => void;
  on(event: 'object' | 'error', handler: ((object: MOQTObject) => void) | ((error: Error) => void)): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    // Cast to the internal handler type
    this.handlers.get(event)!.add(handler as (data: unknown) => void);

    return () => {
      this.handlers.get(event)?.delete(handler as (data: unknown) => void);
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

  /**
   * Remove all event handlers
   */
  removeAllHandlers(): void {
    this.handlers.clear();
  }
}
