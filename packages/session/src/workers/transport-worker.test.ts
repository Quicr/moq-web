// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Transport worker handling of incoming draft-18/22 unidirectional streams
 * (d22 §6.4.1, §3.2.4, §3.4.1, §11.5.1).
 *
 * The worker is driven through its `self.onmessage` against a stub
 * WebTransport whose incoming streams the test controls.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MOQTVarInt, SendOrder, StreamResetErrorCodeDraft18, StreamTypeDraft18 } from '@moq-web/core';

import { streamResetReason } from '../stream-reset-reason.js';

const FETCH_REQUEST_ID = 7;
const RESET_CODE = StreamResetErrorCodeDraft18.TOO_FAR_BEHIND;
// vi64 two-byte (non-minimal) form of FETCH_HEADER, split after its first byte
const WIDE_FETCH_TYPE = [0x80, StreamTypeDraft18.FETCH_HEADER];

type Posted = Record<string, unknown>;

type StreamOptions = { sendOrder?: number } | undefined;

interface Harness {
  posted: Posted[];
  /** Options each created unidirectional / bidirectional stream was opened with */
  uniOptions: StreamOptions[];
  bidiOptions: StreamOptions[];
  /** Hands the worker an incoming unidirectional stream */
  openStream(source: UnderlyingDefaultSource<Uint8Array>): void;
  send(message: Record<string, unknown>): Promise<void>;
}

async function startWorker(): Promise<Harness> {
  const posted: Posted[] = [];
  const self = { postMessage: (message: Posted) => posted.push(message), onmessage: null as unknown };
  vi.stubGlobal('self', self);

  let incoming!: ReadableStreamDefaultController<ReadableStream<Uint8Array>>;
  const uniOptions: StreamOptions[] = [];
  const bidiOptions: StreamOptions[] = [];
  class StubWebTransport {
    ready = Promise.resolve();
    closed = new Promise<never>(() => {});
    datagrams = { writable: new WritableStream<Uint8Array>(), readable: new ReadableStream<Uint8Array>() };
    incomingUnidirectionalStreams = new ReadableStream<ReadableStream<Uint8Array>>({
      start(controller) {
        incoming = controller;
      },
    });
    incomingBidirectionalStreams = new ReadableStream({});
    createUnidirectionalStream = async (options?: StreamOptions) => {
      uniOptions.push(options);
      return new WritableStream<Uint8Array>();
    };
    createBidirectionalStream = async (options?: StreamOptions) => {
      bidiOptions.push(options);
      return { readable: new ReadableStream<Uint8Array>({}), writable: new WritableStream<Uint8Array>() };
    };
    close() {}
  }
  vi.stubGlobal('WebTransport', StubWebTransport);

  vi.resetModules();
  await import('./transport-worker.js');
  const send = async (message: Record<string, unknown>) => {
    await (self.onmessage as (event: { data: unknown }) => Promise<void>)({ data: message });
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  await send({ type: 'connect', config: { url: 'https://relay.test', draft: 'draft-22' } });

  return {
    posted,
    uniOptions,
    bidiOptions,
    send,
    openStream: (source) => incoming.enqueue(new ReadableStream<Uint8Array>(source)),
  };
}

describe('transport worker incoming unidirectional streams', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('reads a stream type split across reads before announcing the stream', async () => {
    const worker = await startWorker();
    const chunks = [[WIDE_FETCH_TYPE[0]], [WIDE_FETCH_TYPE[1], FETCH_REQUEST_ID]];
    let next = 0;

    worker.openStream({
      pull(controller) {
        if (next < chunks.length) {
          controller.enqueue(new Uint8Array(chunks[next++]));
        }
      },
    });
    await worker.send({});

    const data = worker.posted.filter((m) => m.type === 'stream-data');
    expect(worker.posted).toContainEqual({ type: 'incoming-stream', streamId: 0 });
    expect(Array.from(data[0].data as Uint8Array)).toEqual([...WIDE_FETCH_TYPE, FETCH_REQUEST_ID]);
  });

  it('reports a peer reset of a data stream with its code', async () => {
    const worker = await startWorker();
    let pulls = 0;

    worker.openStream({
      pull(controller) {
        pulls++;
        if (pulls === 1) {
          controller.enqueue(new Uint8Array([StreamTypeDraft18.FETCH_HEADER, FETCH_REQUEST_ID]));
          return;
        }
        controller.error(Object.assign(new Error('Received RESET_STREAM.'), { streamErrorCode: RESET_CODE }));
      },
    });
    await worker.send({});

    expect(worker.posted).toContainEqual(
      expect.objectContaining({ type: 'stream-reset', streamId: 0, code: RESET_CODE }),
    );
  });

  it('cancels the receive stream on abort-stream', async () => {
    const worker = await startWorker();
    const cancelled = vi.fn();

    let sent = false;
    worker.openStream({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(new Uint8Array([StreamTypeDraft18.FETCH_HEADER, FETCH_REQUEST_ID]));
        }
        // Then stay open until the worker cancels
        return new Promise<void>(() => {});
      },
      cancel: cancelled,
    });
    await worker.send({});
    await worker.send({ type: 'abort-stream', streamId: 0, code: StreamResetErrorCodeDraft18.CANCELLED });

    expect(cancelled).toHaveBeenCalledWith(streamResetReason(StreamResetErrorCodeDraft18.CANCELLED));
  });

  it('drains a padding stream without announcing it', async () => {
    const worker = await startWorker();
    const type = Array.from(MOQTVarInt.encode(BigInt(StreamTypeDraft18.PADDING)));
    let sent = false;

    worker.openStream({
      pull(controller) {
        if (sent) {
          controller.close();
          return;
        }
        sent = true;
        controller.enqueue(new Uint8Array([...type, 0, 0, 0]));
      },
    });
    await worker.send({});

    expect(worker.posted.filter((m) => m.type === 'incoming-stream' || m.type === 'stream-data')).toEqual([]);
  });

  it.each([
    ['FIN', false, (controller: ReadableStreamDefaultController<Uint8Array>) => controller.close()],
    ['reset', true, (controller: ReadableStreamDefaultController<Uint8Array>) => controller.error(new Error('reset'))],
  ])('reports the peer ending its control stream by %s', async (_name, reset, end) => {
    const worker = await startWorker();
    const setupType = Array.from(MOQTVarInt.encode(BigInt(StreamTypeDraft18.SETUP)));
    let pulls = 0;

    worker.openStream({
      pull(controller) {
        pulls++;
        if (pulls === 1) {
          controller.enqueue(new Uint8Array([...setupType, 0, 0]));
          return;
        }
        end(controller);
      },
    });
    await worker.send({});

    expect(worker.posted).toContainEqual({ type: 'setup-stream-ended', reset });
  });

  it('opens the setup stream, request streams and object streams with their priorities', async () => {
    const worker = await startWorker();
    const objectSendOrder = 123;

    await worker.send({ type: 'create-stream', id: 1, sendOrder: objectSendOrder });
    await worker.send({ type: 'create-bidi-stream', id: 2 });

    expect(worker.uniOptions).toEqual([{ sendOrder: SendOrder.CONTROL }, { sendOrder: objectSendOrder }]);
    expect(worker.bidiOptions).toEqual([{ sendOrder: SendOrder.REQUEST }]);
  });
});
