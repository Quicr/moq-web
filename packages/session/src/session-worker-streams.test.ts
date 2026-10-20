// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Worker-mode data streams (draft-22 §3.2.4, §3.4.1, §6.4.2.3).
 *
 * The worker forwards received stream bytes as messages. A peer reset must
 * reach the router as a read error, and a stream the router or a request
 * handler gives up on must be aborted in the worker so the peer gets
 * STOP_SENDING / RESET_STREAM.
 */

import { describe, it, expect } from 'vitest';
import {
  Draft18StreamCodec,
  DataStreamType,
  FetchSubgroupMode,
  MOQTVarInt,
  StreamResetErrorCodeDraft18,
  type DraftVersion,
  type FetchObjectDraft18,
} from '@moq-web/core';

import { MOQTSession } from './session.js';
import type { FetchStreamCompleteEvent, StreamResetEvent } from './types.js';
import { streamResetReason } from './stream-reset-reason.js';

const REQUEST_ID = 7n;
const FETCH_STREAM = 2;
const BIDI_STREAM = 5;
const TRACK_ALIAS = 9n;

interface Internals {
  setupWorkerHandlers(): void;
  handleIncomingBidiStream(stream: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }): void;
  objectRouter: { cancelFetchStream(requestId: bigint): void };
}

function makeSession(draft: DraftVersion) {
  const posted: Array<Record<string, unknown>> = [];
  const worker = {
    postMessage: (message: Record<string, unknown>) => posted.push(message),
    terminate: () => {},
    onmessage: null as null | ((event: { data: unknown }) => void),
    onerror: null,
  };
  const session = new MOQTSession({ worker: worker as unknown as Worker, url: 'https://relay.test', draft });
  const internals = session as unknown as Internals;
  internals.setupWorkerHandlers();

  const deliver = (message: Record<string, unknown>) => worker.onmessage!({ data: message });
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  return { session, internals, posted, deliver, tick };
}

function fetchStreamBytes(): Uint8Array {
  const object: FetchObjectDraft18 = {
    subgroupMode: FetchSubgroupMode.ZERO,
    groupIdDelta: 3n,
    objectIdDelta: 0n,
    publisherPriority: 128,
    payloadLength: 1n,
  };

  return new Uint8Array([
    ...MOQTVarInt.encode(BigInt(DataStreamType.FETCH_HEADER)),
    ...MOQTVarInt.encode(REQUEST_ID),
    ...Draft18StreamCodec.encodeFetchObject(object),
    0xaa,
  ]);
}

describe.each(['draft-18', 'draft-22'] as const)('worker data streams (%s)', (draft) => {
  it('surfaces a peer reset of a fetch stream as its end', async () => {
    const { session, deliver, tick } = makeSession(draft);
    const events: FetchStreamCompleteEvent[] = [];
    session.on('fetch-stream-complete', (event) => events.push(event));

    deliver({ type: 'incoming-stream', streamId: FETCH_STREAM });
    deliver({ type: 'stream-data', streamId: FETCH_STREAM, data: fetchStreamBytes() });
    await tick();
    deliver({ type: 'stream-reset', streamId: FETCH_STREAM, code: StreamResetErrorCodeDraft18.CANCELLED });
    await tick();

    expect(events).toEqual([{ requestId: REQUEST_ID, lastGroupId: 3n }]);
  });

  it('reports the code of a peer reset of a subgroup stream', async () => {
    const { session, deliver, tick } = makeSession(draft);
    const events: StreamResetEvent[] = [];
    session.on('stream-reset', (event) => events.push(event));
    const header = Draft18StreamCodec.encodeSubgroupHeader({
      trackAlias: TRACK_ALIAS,
      groupId: 1n,
      subgroupId: 0n,
      publisherPriority: 128,
    });

    deliver({ type: 'incoming-stream', streamId: FETCH_STREAM });
    deliver({ type: 'stream-data', streamId: FETCH_STREAM, data: header });
    await tick();
    deliver({ type: 'stream-reset', streamId: FETCH_STREAM, code: StreamResetErrorCodeDraft18.TOO_FAR_BEHIND });
    await tick();

    expect(events).toHaveLength(1);
    expect(events[0].code).toBe(StreamResetErrorCodeDraft18.TOO_FAR_BEHIND);
  });

  it('aborts the worker stream when the router cancels a fetch stream', async () => {
    const { internals, posted, deliver, tick } = makeSession(draft);

    deliver({ type: 'incoming-stream', streamId: FETCH_STREAM });
    deliver({ type: 'stream-data', streamId: FETCH_STREAM, data: fetchStreamBytes() });
    await tick();
    internals.objectRouter.cancelFetchStream(REQUEST_ID);
    await tick();

    expect(posted).toContainEqual({
      type: 'abort-stream',
      streamId: FETCH_STREAM,
      code: StreamResetErrorCodeDraft18.CANCELLED,
    });
  });

  it('aborts a peer-initiated request stream when its receive side is cancelled', async () => {
    const { internals, posted, deliver } = makeSession(draft);
    let captured!: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> };
    internals.handleIncomingBidiStream = (stream) => {
      captured = stream;
    };

    deliver({ type: 'incoming-bidi-stream', streamId: BIDI_STREAM });
    await captured.readable.cancel(streamResetReason(StreamResetErrorCodeDraft18.CANCELLED));

    expect(posted).toContainEqual({
      type: 'abort-stream',
      streamId: BIDI_STREAM,
      code: StreamResetErrorCodeDraft18.CANCELLED,
    });
  });

  it('aborts a peer-initiated request stream when its send side is aborted', async () => {
    const { internals, posted, deliver } = makeSession(draft);
    let captured!: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> };
    internals.handleIncomingBidiStream = (stream) => {
      captured = stream;
    };

    deliver({ type: 'incoming-bidi-stream', streamId: BIDI_STREAM });
    await captured.writable.abort(streamResetReason(StreamResetErrorCodeDraft18.CANCELLED));

    expect(posted).toContainEqual({
      type: 'abort-stream',
      streamId: BIDI_STREAM,
      code: StreamResetErrorCodeDraft18.CANCELLED,
    });
  });

  it('resets a publication stream with its code, not a FIN', async () => {
    const { session, posted } = makeSession(draft);
    (session as unknown as { activeVideoStreams: Map<string, unknown> }).activeVideoStreams.set('9', {
      streamId: BIDI_STREAM,
      groupId: 1,
      objectCount: 1,
      previousObjectId: 0,
      hasExtensions: false,
    });

    await session.resetPublicationStream('9', StreamResetErrorCodeDraft18.DELIVERY_TIMEOUT);

    expect(posted).toContainEqual({
      type: 'abort-stream',
      streamId: BIDI_STREAM,
      code: StreamResetErrorCodeDraft18.DELIVERY_TIMEOUT,
    });
    expect(posted.some((message) => message.type === 'close-stream')).toBe(false);
  });

  it('opens object streams with a sendOrder in worker mode', async () => {
    const { session, posted, deliver, tick } = makeSession(draft);
    (session as unknown as { _state: string })._state = 'ready';
    (session as unknown as { publicationManager: { add(p: unknown): void } }).publicationManager.add({
      trackAlias: TRACK_ALIAS,
      namespace: ['ns'],
      trackName: 'track',
      priority: 128,
      deliveryMode: 'stream',
      requestId: REQUEST_ID,
      cleanupHandlers: [],
      forward: 1,
    });

    const sending = session.sendObject(TRACK_ALIAS, new Uint8Array([1]), { groupId: 1, objectId: 0, type: 'data' });
    await tick();
    const create = posted.find((message) => message.type === 'create-stream')!;
    deliver({ type: 'stream-created', id: create.id, streamId: FETCH_STREAM });
    await sending;

    expect(typeof create.sendOrder).toBe('number');
  });
});
