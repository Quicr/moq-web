// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Transport Worker Implementation
 *
 * Runs WebTransport connection in a dedicated worker thread.
 * Handles control stream, datagrams, and unidirectional streams.
 */

import type {
  TransportWorkerConfig,
  TransportWorkerRequest,
  TransportWorkerResponse,
  TransportState,
  StreamInfo,
} from './transport-worker-types.js';
import { getCurrentALPNProtocol, IS_DRAFT_16 } from '@web-moq/core';

// Worker state
let transport: WebTransport | null = null;
let controlWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
let controlReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
let currentState: TransportState = 'disconnected';
let debug = false;

// Stream management
const outgoingStreams = new Map<number, StreamInfo>();
let nextStreamId = 0;

/**
 * Log helper
 */
function log(...args: unknown[]): void {
  if (debug) {
    console.log('[TransportWorker]', ...args);
  }
}

/**
 * Send response to main thread
 */
function respond(msg: TransportWorkerResponse, transfer?: Transferable[]): void {
  if (transfer && transfer.length > 0) {
    (self as unknown as Worker).postMessage(msg, transfer);
  } else {
    self.postMessage(msg);
  }
}

/**
 * Update state and notify main thread
 */
function setState(state: TransportState): void {
  if (currentState === state) return;
  currentState = state;
  respond({ type: 'state-change', state });
}

/**
 * Connect to relay
 */
async function connect(config: TransportWorkerConfig): Promise<void> {
  if (transport) {
    respond({ type: 'error', message: 'Already connected' });
    return;
  }

  debug = config.debug ?? false;
  log('Connecting to', config.url);
  setState('connecting');

  try {
    // Build WebTransport options
    // Only set protocols (WT-Available-Protocols) for draft-16+
    // Draft-14 relays don't support WebTransport protocol negotiation
    const options: WebTransportOptions & { protocols?: string[] } = {};
    if (IS_DRAFT_16) {
      options.protocols = [getCurrentALPNProtocol()];
    }
    if (config.serverCertificateHashes?.length) {
      options.serverCertificateHashes = config.serverCertificateHashes.map((hash) => ({
        algorithm: 'sha-256',
        value: hash,
      }));
    }

    // Create WebTransport connection
    transport = new WebTransport(config.url, options);

    // Handle connection timeout
    const timeout = config.connectionTimeout ?? 10000;
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Connection timeout')), timeout);
    });

    await Promise.race([transport.ready, timeoutPromise]);
    log('WebTransport connected');

    // Set up bidirectional control stream
    const controlStream = await transport.createBidirectionalStream();
    controlWriter = controlStream.writable.getWriter();
    controlReader = controlStream.readable.getReader();
    log('Control stream established');

    // Start listeners
    listenForControlMessages();
    listenForDatagrams();
    listenForIncomingStreams();
    handleConnectionClosed();

    setState('connected');
    respond({ type: 'connected' });
  } catch (err) {
    log('Connection failed', err);
    setState('failed');
    respond({ type: 'error', message: (err as Error).message });
    cleanup();
  }
}

/**
 * Disconnect from relay
 */
async function disconnect(code?: number, reason?: string): Promise<void> {
  if (!transport) {
    respond({ type: 'disconnected' });
    return;
  }

  log('Disconnecting', { code, reason });
  setState('closing');

  try {
    // Close control stream
    await controlWriter?.close().catch(() => {});
    controlReader?.cancel().catch(() => {});

    // Close all outgoing streams
    for (const [, stream] of outgoingStreams) {
      await stream.writer.close().catch(() => {});
    }

    // Close transport
    transport.close({
      closeCode: code ?? 0,
      reason: reason ?? 'Client disconnect',
    });
  } catch (err) {
    log('Error during disconnect', err);
  }

  cleanup();
  setState('disconnected');
  respond({ type: 'disconnected', reason });
}

/**
 * Clean up resources
 */
function cleanup(): void {
  transport = null;
  controlWriter = null;
  controlReader = null;
  outgoingStreams.clear();
  nextStreamId = 0;
}

/**
 * Listen for control messages
 */
async function listenForControlMessages(): Promise<void> {
  if (!controlReader) return;

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { value, done } = await controlReader.read();
      if (done) {
        log('Control stream ended');
        break;
      }

      // Transfer buffer to main thread
      const data = new Uint8Array(value);
      respond({ type: 'control-message', data }, [data.buffer]);
    }
  } catch (err) {
    if (transport) {
      log('Control stream error', err);
      respond({ type: 'error', message: (err as Error).message });
    }
  }
}

/**
 * Listen for datagrams
 */
async function listenForDatagrams(): Promise<void> {
  if (!transport) return;

  const reader = transport.datagrams.readable.getReader();
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        log('Datagram stream ended');
        break;
      }

      // Transfer buffer to main thread
      const data = new Uint8Array(value);
      respond({ type: 'datagram', data }, [data.buffer]);
    }
  } catch (err) {
    if (transport) {
      log('Datagram listener error', err);
    }
  }
}

/**
 * Listen for incoming unidirectional streams
 */
async function listenForIncomingStreams(): Promise<void> {
  if (!transport) return;

  const reader = transport.incomingUnidirectionalStreams.getReader();
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { value: stream, done } = await reader.read();
      if (done) {
        log('Incoming streams ended');
        break;
      }

      // Assign stream ID and notify main thread
      const streamId = nextStreamId++;
      log('Incoming stream', { streamId });
      respond({ type: 'incoming-stream', streamId });

      // Read stream data in background
      handleIncomingStreamData(streamId, stream);
    }
  } catch (err) {
    if (transport) {
      log('Stream listener error', err);
    }
  }
}

/**
 * Handle data from incoming stream
 */
async function handleIncomingStreamData(
  streamId: number,
  stream: ReadableStream<Uint8Array>
): Promise<void> {
  const reader = stream.getReader();
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      // Transfer buffer to main thread
      const data = new Uint8Array(value);
      respond({ type: 'stream-data', streamId, data }, [data.buffer]);
    }
  } catch (err) {
    log('Stream read error', { streamId, error: (err as Error).message });
  } finally {
    respond({ type: 'stream-closed', streamId });
  }
}

/**
 * Handle transport close
 */
function handleConnectionClosed(): void {
  if (!transport) return;

  transport.closed
    .then(() => {
      log('Transport closed normally');
      if (currentState !== 'disconnected') {
        setState('closed');
        respond({ type: 'disconnected' });
        cleanup();
      }
    })
    .catch((err) => {
      log('Transport closed with error', err);
      if (currentState !== 'disconnected') {
        setState('failed');
        respond({ type: 'disconnected', reason: (err as Error).message });
        cleanup();
      }
    });
}

/**
 * Send data on control stream
 */
async function sendControl(data: Uint8Array): Promise<void> {
  if (!controlWriter) {
    respond({ type: 'error', message: 'Not connected' });
    return;
  }

  try {
    await controlWriter.write(data);
  } catch (err) {
    respond({ type: 'error', message: (err as Error).message });
  }
}

/**
 * Send datagram
 */
async function sendDatagram(data: Uint8Array): Promise<void> {
  if (!transport) {
    respond({ type: 'error', message: 'Not connected' });
    return;
  }

  try {
    const writer = transport.datagrams.writable.getWriter();
    await writer.write(data);
    writer.releaseLock();
  } catch (err) {
    respond({ type: 'error', message: (err as Error).message });
  }
}

/**
 * Create outgoing unidirectional stream
 */
async function createStream(requestId: number): Promise<void> {
  if (!transport) {
    respond({ type: 'error', message: 'Not connected' });
    return;
  }

  try {
    const stream = await transport.createUnidirectionalStream();
    const streamId = nextStreamId++;
    const writer = stream.getWriter();

    outgoingStreams.set(streamId, { id: requestId, writer });
    log('Created stream', { requestId, streamId });

    respond({ type: 'stream-created', id: requestId, streamId });
  } catch (err) {
    respond({ type: 'error', message: (err as Error).message });
  }
}

/**
 * Create bidirectional stream for SUBSCRIBE_NAMESPACE (draft-16)
 */
async function createBidiStream(requestId: number): Promise<void> {
  if (!transport) {
    respond({ type: 'error', message: 'Not connected' });
    return;
  }

  try {
    const stream = await transport.createBidirectionalStream();
    const streamId = nextStreamId++;
    const writer = stream.writable.getWriter();

    outgoingStreams.set(streamId, { id: requestId, writer });
    log('Created bidi stream', { requestId, streamId });

    respond({ type: 'bidi-stream-created', id: requestId, streamId });

    // Start reading from the readable side
    readBidiStream(streamId, stream.readable).catch(err => {
      log('Error reading bidi stream', err);
    });
  } catch (err) {
    respond({ type: 'error', message: (err as Error).message });
  }
}

/**
 * Read from bidirectional stream and forward to main thread
 */
async function readBidiStream(streamId: number, readable: ReadableStream<Uint8Array>): Promise<void> {
  const reader = readable.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value && value.length > 0) {
        respond({ type: 'bidi-stream-data', streamId, data: value }, [value.buffer]);
      }
    }
  } catch (err) {
    log('Bidi stream read error', err);
  } finally {
    reader.releaseLock();
    respond({ type: 'stream-closed', streamId });
  }
}

/**
 * Write data to stream
 */
async function writeStream(
  streamId: number,
  data: Uint8Array,
  close?: boolean
): Promise<void> {
  const streamInfo = outgoingStreams.get(streamId);
  if (!streamInfo) {
    respond({ type: 'error', message: `Stream ${streamId} not found` });
    return;
  }

  try {
    await streamInfo.writer.write(data);

    if (close) {
      await streamInfo.writer.close();
      outgoingStreams.delete(streamId);
      respond({ type: 'stream-closed', streamId });
    }
  } catch (err) {
    const message = (err as Error).message;
    // STOP_SENDING is normal for stream-per-object delivery - relay closes stream after receiving object
    if (message.includes('STOP_SENDING')) {
      log('Stream closed by relay (STOP_SENDING)', { streamId });
      outgoingStreams.delete(streamId);
      respond({ type: 'stream-closed', streamId });
    } else {
      respond({ type: 'error', message });
    }
  }
}

/**
 * Close stream
 */
async function closeStream(streamId: number): Promise<void> {
  const streamInfo = outgoingStreams.get(streamId);
  if (!streamInfo) {
    respond({ type: 'error', message: `Stream ${streamId} not found` });
    return;
  }

  try {
    await streamInfo.writer.close();
    outgoingStreams.delete(streamId);
    respond({ type: 'stream-closed', streamId });
  } catch (err) {
    const message = (err as Error).message;
    // STOP_SENDING is normal - relay already closed the stream
    if (message.includes('STOP_SENDING')) {
      outgoingStreams.delete(streamId);
      respond({ type: 'stream-closed', streamId });
    } else {
      respond({ type: 'error', message });
    }
  }
}

/**
 * Message handler
 */
self.onmessage = async (event: MessageEvent<TransportWorkerRequest>): Promise<void> => {
  const msg = event.data;
  log('Received message', msg.type);

  switch (msg.type) {
    case 'connect':
      await connect(msg.config);
      break;
    case 'disconnect':
      await disconnect(msg.code, msg.reason);
      break;
    case 'send-control':
      await sendControl(msg.data);
      break;
    case 'send-datagram':
      await sendDatagram(msg.data);
      break;
    case 'create-stream':
      await createStream(msg.id);
      break;
    case 'create-bidi-stream':
      await createBidiStream(msg.id);
      break;
    case 'write-stream':
      await writeStream(msg.streamId, msg.data, msg.close);
      break;
    case 'close-stream':
      await closeStream(msg.streamId);
      break;
  }
};

// Signal ready
respond({ type: 'ready' });
log('Transport worker initialized');
