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
import { alpnProtocolFor, DEFAULT_DRAFT, MOQTVarInt, StreamTypeDraft18, type DraftVersion } from '@moq-web/core';

// Worker state
let transport: WebTransport | null = null;
let controlWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
let controlReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
let setupWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
let datagramWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
let currentState: TransportState = 'disconnected';
let debug = false;
/**
 * Draft version this worker instance is speaking. Set on `connect()` from
 * `TransportWorkerConfig.draft`; used to select ALPN and setup-stream layout.
 */
let workerDraft: DraftVersion = DEFAULT_DRAFT;
const isDraft18 = () => workerDraft === 'draft-18';
// True when the local side called disconnect() before `transport.closed` resolved;
// used to distinguish local vs peer-initiated close in the disconnected event.
let localDisconnectInitiated = false;

// Stream management
const outgoingStreams = new Map<number, StreamInfo>();
let nextStreamId = 0;

/**
 * Pending close promises for per-object streams.
 *
 * We fire-and-forget `writer.close()` after the final write so the message
 * handler doesn't block waiting on stream close roundtrips — this is
 * especially important for stream-per-object delivery where the caller may
 * open thousands of streams per second. We track the promises so `cleanup()`
 * can drain them on disconnect.
 */
const pendingCloses = new Set<Promise<void>>();

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
  workerDraft = config.draft ?? DEFAULT_DRAFT;
  localDisconnectInitiated = false;
  log('Connecting to', config.url, 'as', workerDraft);
  setState('connecting');

  try {
    const options: WebTransportOptions & { protocols?: string[] } = {};
    const alpnProtocol = alpnProtocolFor(workerDraft);
    options.protocols = [alpnProtocol];
    if (config.serverCertificateHashes?.length) {
      options.serverCertificateHashes = config.serverCertificateHashes.map((hash) => ({
        algorithm: 'sha-256',
        value: hash,
      }));
    }

    // Create WebTransport connection
    transport = new WebTransport(config.url, options);

    // Handle connection timeout
    const timeout = config.connectionTimeout ?? 300000;
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Connection timeout')), timeout);
    });

    await Promise.race([transport.ready, timeoutPromise]);
    log('WebTransport connected');

    if (isDraft18()) {
      // Draft-18: Setup uses unidirectional stream with 0x2F00 type prefix
      const setupStream = await transport.createUnidirectionalStream();
      log('Draft-18 setup stream created', { streamId: (setupStream as any).id ?? (setupStream as any).streamId ?? 'unknown' });
      setupWriter = setupStream.getWriter();
      log('Draft-18 setup stream established');
    } else {
      // Draft-14/16: Single bidirectional control stream
      const controlStream = await transport.createBidirectionalStream();
      controlWriter = controlStream.writable.getWriter();
      controlReader = controlStream.readable.getReader();
      log('Control stream established');
    }

    // Acquire datagram writer once to avoid WritableStream lock contention
    datagramWriter = transport.datagrams.writable.getWriter();

    // Start listeners
    if (!isDraft18()) {
      listenForControlMessages();
    }
    listenForDatagrams();
    listenForIncomingStreams();
    listenForIncomingBidiStreams();
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
  localDisconnectInitiated = true;
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
  setupWriter = null;
  datagramWriter = null;
  setupStreamTypeSent = false;
  outgoingStreams.clear();
  nextStreamId = 0;
  // Discard tracked close promises — the underlying transport is going away
  // so any still-inflight close() will resolve/reject on its own; we just no
  // longer need to observe them.
  pendingCloses.clear();
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

      // Zero-copy: WHATWG streams give ownership of the chunk to the reader,
      // so we can transfer its underlying buffer without copying.
      respond({ type: 'control-message', data: value }, [value.buffer]);
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

      // Zero-copy transfer of the chunk buffer to the main thread.
      respond({ type: 'datagram', data: value }, [value.buffer]);
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

  console.log('[transport-worker] Starting incoming unidirectional stream listener');
  const reader = transport.incomingUnidirectionalStreams.getReader();
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { value: stream, done } = await reader.read();
      if (done) {
        console.log('[transport-worker] Incoming streams ended');
        break;
      }

      console.log('[transport-worker] Received incoming unidirectional stream');
      if (isDraft18()) {
        handleDraft18IncomingStream(stream);
      } else {
        const streamId = nextStreamId++;
        log('Incoming stream', { streamId });
        respond({ type: 'incoming-stream', streamId });
        handleIncomingStreamData(streamId, stream);
      }
    }
  } catch (err) {
    if (transport) {
      log('Stream listener error', err);
    }
  }
}

/**
 * Handle incoming unidirectional stream for draft-18
 * Detects stream type (0x2F00 = setup, otherwise data stream)
 */
async function handleDraft18IncomingStream(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader();
  try {
    const { value: firstChunk, done } = await reader.read();
    if (done || !firstChunk || firstChunk.length === 0) {
      console.log('[transport-worker] Draft-18 incoming stream: empty or done', { done, length: firstChunk?.length });
      reader.releaseLock();
      return;
    }

    const hex = Array.from(firstChunk.subarray(0, Math.min(32, firstChunk.length)))
      .map(b => b.toString(16).padStart(2, '0')).join(' ');
    console.log('[transport-worker] Draft-18 incoming uni stream first bytes', { length: firstChunk.length, hex });

    const [streamType, bytesRead] = MOQTVarInt.decode(firstChunk);
    const streamTypeNum = Number(streamType);
    console.log('[transport-worker] Draft-18 stream type decoded', { streamType: `0x${streamTypeNum.toString(16)}`, bytesRead, isSetup: streamTypeNum === StreamTypeDraft18.SETUP });

    if (streamTypeNum === StreamTypeDraft18.SETUP) {
      // Setup stream from server — forward remaining bytes + continue reading as setup messages
      const remaining = firstChunk.subarray(bytesRead);
      if (remaining.length > 0) {
        // Zero-copy transfer: `remaining` shares firstChunk.buffer; the postMessage
        // transfers the underlying ArrayBuffer, detaching firstChunk (safe — we
        // extract streamType/bytesRead before this).
        respond({ type: 'setup-message', data: remaining }, [remaining.buffer]);
      }
      // Continue reading setup stream messages
      while (true) {
        const { value, done: d } = await reader.read();
        if (d) break;
        respond({ type: 'setup-message', data: value }, [value.buffer]);
      }
    } else {
      // Data stream (subgroup) — forward full chunk including stream type byte
      // (object router's decodeSubgroupHeader reads stream type as first field)
      const streamId = nextStreamId++;
      console.log('[transport-worker] Incoming DATA stream', { streamId, streamType: `0x${streamTypeNum.toString(16)}`, chunkSize: firstChunk.length });
      respond({ type: 'incoming-stream', streamId });

      // Zero-copy: transfer firstChunk buffer (stream type byte is part of the
      // subgroup header the main thread parses).
      const firstLen = firstChunk.length;
      respond({ type: 'stream-data', streamId, data: firstChunk }, [firstChunk.buffer]);
      // Continue forwarding data
      let totalForwarded = firstLen;
      while (true) {
        const { value, done: d } = await reader.read();
        if (d) break;
        totalForwarded += value.length;
        respond({ type: 'stream-data', streamId, data: value }, [value.buffer]);
      }
      console.log('[transport-worker] Data stream ended', { streamId, totalForwarded });
      respond({ type: 'stream-closed', streamId });
    }
  } catch (err) {
    console.log('[transport-worker] Draft-18 stream error', { error: (err as Error).message });
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

      // Zero-copy transfer to the main thread.
      respond({ type: 'stream-data', streamId, data: value }, [value.buffer]);
    }
  } catch (err) {
    log('Stream read error', { streamId, error: (err as Error).message });
  } finally {
    respond({ type: 'stream-closed', streamId });
  }
}

/**
 * Listen for incoming bidirectional streams (draft-18 relay-initiated requests)
 */
async function listenForIncomingBidiStreams(): Promise<void> {
  if (!transport) return;

  log('Starting incoming bidirectional stream listener');
  const reader = transport.incomingBidirectionalStreams.getReader();
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { value: stream, done } = await reader.read();
      if (done) {
        log('Incoming bidi streams ended');
        break;
      }

      const streamId = nextStreamId++;
      const writer = stream.writable.getWriter();
      outgoingStreams.set(streamId, { id: streamId, writer });
      log('Incoming bidi stream', { streamId });
      respond({ type: 'incoming-bidi-stream', streamId });

      // Read from the readable side
      readBidiStream(streamId, stream.readable).catch(err => {
        log('Error reading incoming bidi stream', err);
      });
    }
  } catch (err) {
    if (transport) {
      log('Bidi stream listener error', err);
    }
  }
}

/**
 * Handle transport close
 */
function handleConnectionClosed(): void {
  if (!transport) return;

  transport.closed
    .then((info: { closeCode?: number; reason?: string } | undefined) => {
      const closeCode = typeof info?.closeCode === 'number' ? info.closeCode : 0;
      const reason = typeof info?.reason === 'string' ? info.reason : undefined;
      const remote = !localDisconnectInitiated;
      log('Transport closed normally', { closeCode, reason, remote });
      if (currentState !== 'disconnected') {
        setState('closed');
        respond({ type: 'disconnected', reason, closeCode, remote });
        cleanup();
      }
    })
    .catch((err) => {
      console.error('[transport-worker] Transport closed with error:', (err as Error).message);
      log('Transport closed with error', err);
      if (currentState !== 'disconnected') {
        setState('failed');
        respond({
          type: 'disconnected',
          reason: (err as Error).message,
          closeCode: 0,
          remote: !localDisconnectInitiated,
        });
        cleanup();
      }
    });
}

/**
 * Send data on control stream
 */
let setupStreamTypeSent = false;

async function sendControl(data: Uint8Array): Promise<void> {
  if (isDraft18()) {
    if (!setupWriter) {
      respond({ type: 'error', message: 'Setup stream not connected' });
      return;
    }
    try {
      let toWrite: Uint8Array;
      if (!setupStreamTypeSent) {
        // First write: prepend stream type (0x2F00) to the message
        const streamTypeBytes = MOQTVarInt.encode(BigInt(StreamTypeDraft18.SETUP));
        toWrite = new Uint8Array(streamTypeBytes.length + data.length);
        toWrite.set(streamTypeBytes, 0);
        toWrite.set(data, streamTypeBytes.length);
        setupStreamTypeSent = true;
      } else {
        toWrite = data;
      }
      const hex = Array.from(toWrite.subarray(0, Math.min(32, toWrite.length)))
        .map(b => b.toString(16).padStart(2, '0')).join(' ');
      log('sendControl (draft-18)', { length: toWrite.length, hex, firstMessage: !setupStreamTypeSent });
      await setupWriter.write(toWrite);
      log('sendControl written successfully');
    } catch (err) {
      log('sendControl error', { error: (err as Error).message });
      respond({ type: 'error', message: (err as Error).message });
    }
  } else {
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
}

/**
 * Send datagram
 */
async function sendDatagram(data: Uint8Array): Promise<void> {
  if (!datagramWriter) {
    respond({ type: 'error', message: 'Not connected' });
    return;
  }

  try {
    await datagramWriter.write(data);
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
    // Stream was already closed (e.g., by STOP_SENDING) - this is normal, not an error
    log('Write to closed stream', { streamId });
    respond({ type: 'stream-closed', streamId });
    return;
  }

  try {
    await streamInfo.writer.write(data);

    if (close) {
      // Fire-and-forget close so the worker's onmessage handler is free to
      // service the next write-stream immediately. Stream-per-object patterns
      // otherwise pay a full close() roundtrip between writes, keeping the
      // underlying transferable buffer pinned longer than needed.
      const w = streamInfo.writer;
      outgoingStreams.delete(streamId);
      respond({ type: 'stream-closed', streamId });
      const closePromise = w.close().catch((err: unknown) => {
        const closeMsg = (err as Error)?.message ?? '';
        // STOP_SENDING/RESET_STREAM/aborted are normal races between our close
        // and a relay-initiated abort. Anything else is worth surfacing.
        if (
          !closeMsg.includes('STOP_SENDING') &&
          !closeMsg.includes('RESET_STREAM') &&
          !closeMsg.includes('aborted')
        ) {
          log('Deferred close failed', { streamId, error: closeMsg });
        }
      });
      pendingCloses.add(closePromise);
      closePromise.finally(() => pendingCloses.delete(closePromise));
    }
  } catch (err) {
    const message = (err as Error).message;
    // STOP_SENDING, RESET_STREAM, and aborted are normal for stream-per-object delivery
    // Relay closes stream after receiving object or when aborting a FETCH
    if (message.includes('STOP_SENDING') || message.includes('RESET_STREAM') || message.includes('aborted')) {
      log('Stream closed by relay', { streamId, reason: message });
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
    // Stream was already closed - this is normal, not an error
    log('Close on already-closed stream', { streamId });
    respond({ type: 'stream-closed', streamId });
    return;
  }

  try {
    await streamInfo.writer.close();
    outgoingStreams.delete(streamId);
    respond({ type: 'stream-closed', streamId });
  } catch (err) {
    const message = (err as Error).message;
    // STOP_SENDING, RESET_STREAM, and aborted are normal - relay already closed the stream
    if (message.includes('STOP_SENDING') || message.includes('RESET_STREAM') || message.includes('aborted')) {
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
