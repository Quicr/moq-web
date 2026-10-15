// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Request stream lifecycle.
 *
 * Draft-22 §6.4.2 / draft-18 §3.3: a request stream carries more than its
 * first response. REQUEST_UPDATE consumes a new Request ID (draft-22 §6.4.2.1,
 * draft-18 §10.1) and is answered on the same stream (draft-22 §9.5, draft-18
 * §10.9). The publisher ends an Established subscription with PUBLISH_DONE
 * before its FIN (draft-22 §6.4.2.2). A client never sends a GOAWAY URI
 * (draft-22 §9.2).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  MOQTransport,
  MessageTypeDraft18,
  MessageTypeDraft22,
  SessionErrorCodeDraft18,
  SubscriptionFilterDraft18,
  type ControlMessageDraft18,
} from '@moq-web/core';

import { MOQTSession } from './session.js';

type Draft = 'draft-18' | 'draft-22';

const REQUEST_ID = 4n;
const FIRST_UPDATE_ID = 10n;
const NEXT_UPDATE_ID = 12n;
const PAST_LOCAL_CAP = 5000;
const PEER_UPDATE_ID = 7n;
const PEER_REQUEST_ID = 3n;
const UNKNOWN_MESSAGE_TYPE = 0x15;
const WORKER_STREAM_ID = 9;
const FINAL_GROUP = 3;
const FINAL_OBJECT = 9;
const GOAWAY_URI = 'https://new.example/moq';
const FIRST_BYTES = new Uint8Array([0]);

interface Internals {
  codec: {
    encodeControlMessage: (m: unknown) => Uint8Array;
    decodeControlMessage: (b: Uint8Array) => [ControlMessageDraft18, number];
  };
  activeRequestStreams: Map<bigint, unknown>;
  announcedNamespaces: Map<string, unknown>;
  nextRequestId: number;
  getNextRequestId: () => number;
  doSendControl: (b: Uint8Array) => Promise<void>;
  sendRequestAndWaitResponse: (b: Uint8Array, id: bigint, kind: string) => Promise<ControlMessageDraft18>;
  processIncomingBidiStream: (s: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }) => Promise<void>;
  abortRequestStream: (id: bigint) => Promise<void>;
  handleWorkerIncomingBidiStream: (streamId: number) => void;
  handleWorkerBidiStreamData: (streamId: number, data: Uint8Array) => void;
  handleWorkerSendStopped: (streamId: number) => void;
  publicationManager: { getByRequestId: (id: bigint) => { forward: number } | undefined; add: (p: unknown) => void };
}

function makeSession(draft: Draft): { session: MOQTSession; internals: Internals } {
  const transport = new MOQTransport({ draft });
  (transport as unknown as { close: typeof transport.close }).close = vi.fn().mockResolvedValue(undefined);
  const session = new MOQTSession(transport);
  (session as unknown as { _state: string })._state = 'ready';

  return { session, internals: session as unknown as Internals };
}

/** A request stream the test controls: `send` plays the peer, `written` is what we wrote. */
function installPeerStream(session: MOQTSession) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancelled = vi.fn();
  const readable = new ReadableStream<Uint8Array>({
    start: (c) => {
      controller = c;
    },
    cancel: cancelled,
  });
  const written: Uint8Array[] = [];
  let sendSide!: WritableStreamDefaultController;
  const writable = new WritableStream<Uint8Array>({
    start: (c) => {
      sendSide = c;
    },
    write: (chunk) => {
      written.push(chunk);
    },
  });
  const transport = (session as unknown as { transport: { createRequestStream: unknown } }).transport;
  transport.createRequestStream = vi.fn().mockResolvedValue({ readable, writable });

  const internals = session as unknown as Internals;

  return {
    written,
    send: (message: unknown) => controller.enqueue(internals.codec.encodeControlMessage(message)),
    sendRaw: (bytes: Uint8Array) => controller.enqueue(bytes),
    fin: () => controller.close(),
    cancelled,
    /** The peer's STOP_SENDING: our send side errors. */
    stopSending: () => sendSide.error(new Error('STOP_SENDING')),
  };
}

/** Open a request stream whose first response (SUBSCRIBE_OK) has already arrived. */
async function openSubscribeStream(draft: Draft) {
  const { session, internals } = makeSession(draft);
  const peer = installPeerStream(session);
  peer.send({
    type: MessageTypeDraft18.SUBSCRIBE_OK,
    requestId: REQUEST_ID,
    trackAlias: 1n,
    largestLocation: { group: 0n, object: 0n },
  });
  await internals.sendRequestAndWaitResponse(FIRST_BYTES, REQUEST_ID, 'subscribe');

  return { session, internals, peer };
}

/** A stream the peer opened to us: `send` plays the peer, `written` is what we wrote. */
function installIncomingStream(session: MOQTSession, announce = true) {
  const internals = session as unknown as Internals;
  if (announce) {
    internals.announcedNamespaces.set('ns', { namespace: ['ns'], options: {}, subscribers: new Map() });
  }
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const readable = new ReadableStream<Uint8Array>({
    start: (c) => {
      controller = c;
    },
  });
  const written: Uint8Array[] = [];
  const closed = vi.fn();
  let sendSide!: WritableStreamDefaultController;
  const writable = new WritableStream<Uint8Array>({
    start: (c) => {
      sendSide = c;
    },
    write: (chunk) => {
      written.push(chunk);
    },
    close: closed,
  });
  const encode = (m: unknown) => internals.codec.encodeControlMessage(m);

  return {
    written,
    closed,
    open: () => internals.processIncomingBidiStream({ readable, writable }),
    send: (...messages: unknown[]) => controller.enqueue(concat(messages.map(encode))),
    sendRaw: (bytes: Uint8Array) => controller.enqueue(bytes),
    fin: () => controller.close(),
    reset: () => controller.error(new Error('reset')),
    stopSending: () => sendSide.error(new Error('STOP_SENDING')),
  };
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }

  return out;
}

function subscribeMessage(draft: Draft) {
  return {
    type: MessageTypeDraft18.SUBSCRIBE,
    requestId: PEER_REQUEST_ID,
    trackNamespace: ['ns'],
    trackName: 't',
    forwardState: true,
    ...(draft === 'draft-18' ? { filter: SubscriptionFilterDraft18.NEXT_GROUP_START } : {}),
  };
}

const pauseUpdate = { type: MessageTypeDraft18.REQUEST_UPDATE, requestId: PEER_UPDATE_ID, forwardState: false };

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const requestOk = { type: MessageTypeDraft18.REQUEST_OK, requestId: 0n };
const publishDone = {
  type: MessageTypeDraft18.PUBLISH_DONE,
  requestId: 0n,
  finalLocation: { group: 0n, object: 0n },
  statusCode: 0n,
  streamCount: 0n,
};

describe.each(['draft-18', 'draft-22'] as const)('REQUEST_UPDATE Request ID (%s)', (draft) => {
  it('consumes a new Request ID instead of reusing the original', async () => {
    const { session, internals, peer } = await openSubscribeStream(draft);
    internals.nextRequestId = Number(FIRST_UPDATE_ID);

    await session.sendRequestUpdate(REQUEST_ID, false, { awaitAck: false });

    const update = internals.codec.decodeControlMessage(peer.written[1])[0] as { requestId: bigint };
    expect(update.requestId).toBe(FIRST_UPDATE_ID);
    expect(internals.nextRequestId).toBe(Number(NEXT_UPDATE_ID));
  });

  it('is still sent on the original request stream', async () => {
    const { session, internals, peer } = await openSubscribeStream(draft);
    internals.nextRequestId = Number(FIRST_UPDATE_ID);

    await session.sendRequestUpdate(REQUEST_ID, false, { awaitAck: false });

    expect(peer.written).toHaveLength(2);
    expect(internals.activeRequestStreams.has(FIRST_UPDATE_ID)).toBe(false);
  });
});

describe.each(['draft-18', 'draft-22'] as const)('request stream reader (%s)', (draft) => {
  it('delivers PUBLISH_DONE after the first response, keyed by the stream', async () => {
    const { session, peer } = await openSubscribeStream(draft);
    const done: unknown[] = [];
    session.on('publish-done', (e) => done.push(e));

    peer.send(publishDone);
    await tick();

    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ requestId: REQUEST_ID });
  });

  it('does not let PUBLISH_DONE resolve a pending REQUEST_UPDATE', async () => {
    const { session, internals, peer } = await openSubscribeStream(draft);
    internals.nextRequestId = Number(FIRST_UPDATE_ID);
    const done: unknown[] = [];
    session.on('publish-done', (e) => done.push(e));
    const settled = vi.fn();

    const update = session.sendRequestUpdate(REQUEST_ID, true).then(settled, settled);
    await tick();
    peer.send(publishDone);
    await tick();

    expect(done).toHaveLength(1);
    expect(settled).not.toHaveBeenCalled();

    peer.send(requestOk);
    await update;

    expect(settled).toHaveBeenCalledTimes(1);
  });

  it('rejects a pending REQUEST_UPDATE on REQUEST_ERROR', async () => {
    const { session, peer } = await openSubscribeStream(draft);

    const update = session.sendRequestUpdate(REQUEST_ID, true);
    await tick();
    peer.send({ type: MessageTypeDraft18.REQUEST_ERROR, requestId: 0n, errorCode: 1, reasonPhrase: 'nope' });

    await expect(update).rejects.toThrow(/REQUEST_UPDATE failed.*nope/);
  });

  it('fails every pending REQUEST_UPDATE on one REQUEST_ERROR (coalesced updates)', async () => {
    const { session, peer } = await openSubscribeStream(draft);

    const first = session.sendRequestUpdate(REQUEST_ID, true);
    const second = session.sendRequestUpdate(REQUEST_ID, false);
    await tick();
    peer.send({ type: MessageTypeDraft18.REQUEST_ERROR, requestId: 0n, errorCode: 1, reasonPhrase: 'nope' });

    await expect(first).rejects.toThrow(/nope/);
    await expect(second).rejects.toThrow(/nope/);
  });

  it('resolves updates in the order their responses arrive', async () => {
    const { session, peer } = await openSubscribeStream(draft);
    const order: number[] = [];

    const first = session.sendRequestUpdate(REQUEST_ID, true).then(() => order.push(1));
    const second = session.sendRequestUpdate(REQUEST_ID, false).then(() => order.push(2));
    await tick();
    peer.send(requestOk);
    await first;
    expect(order).toEqual([1]);

    peer.send(requestOk);
    await second;
    expect(order).toEqual([1, 2]);
  });

  it('routes a per-request GOAWAY without moving the whole session', async () => {
    const { session, peer } = await openSubscribeStream(draft);
    const events: unknown[] = [];
    session.on('goaway' as never, (e: unknown) => events.push(e));

    peer.send({ type: MessageTypeDraft18.GOAWAY, newSessionUri: GOAWAY_URI, timeout: 0n });
    await tick();

    expect(events).toEqual([{ newSessionUri: GOAWAY_URI, timeoutMs: 0n, requestId: undefined, streamRequestId: REQUEST_ID }]);
    expect(session.state).toBe('ready');
    expect(session.pendingMigrationUri).toBeUndefined();
  });

  it('closes the request and fails pending updates when the peer ends the stream', async () => {
    const { session, internals, peer } = await openSubscribeStream(draft);

    const update = session.sendRequestUpdate(REQUEST_ID, true);
    await tick();
    peer.fin();

    await expect(update).rejects.toThrow();
    expect(internals.activeRequestStreams.has(REQUEST_ID)).toBe(false);
  });
});

describe('request stream reader (draft-22)', () => {
  it('delivers PUBLISH_STATE_NOTIFY after SUBSCRIBE_OK', async () => {
    const { session, peer } = await openSubscribeStream('draft-22');
    const events: unknown[] = [];
    session.on('publish-state-notify' as never, (e: unknown) => events.push(e));

    peer.send({
      type: MessageTypeDraft22.PUBLISH_STATE_NOTIFY,
      forwardState: false,
      largestLocation: { group: 5n, object: 6n },
    });
    await tick();

    expect(events).toEqual([
      { forwardState: false, largestLocation: { group: 5n, object: 6n }, locationFilter: undefined },
    ]);
  });

  it('delivers PUBLISH_SKIPPED on a SUBSCRIBE_TRACKS stream', async () => {
    const { session, peer } = await openSubscribeStream('draft-22');
    const events: unknown[] = [];
    session.on('publish-skipped' as never, (e: unknown) => events.push(e));

    peer.send({ type: MessageTypeDraft22.PUBLISH_SKIPPED, trackNamespaceSuffix: ['cam'], trackName: 'video' });
    await tick();

    expect(events).toEqual([{ trackNamespaceSuffix: ['cam'], trackName: 'video' }]);
  });
});

describe.each(['draft-18', 'draft-22'] as const)('incoming SUBSCRIBE stream (%s)', (draft) => {
  async function acceptSubscribe() {
    const { session, internals } = makeSession(draft);
    const peer = installIncomingStream(session);
    peer.send(subscribeMessage(draft));
    await peer.open();

    return { session, internals, peer };
  }

  it('ends with PUBLISH_DONE on the SUBSCRIBE stream, then a FIN', async () => {
    const { session, internals, peer } = await acceptSubscribe();
    expect(peer.closed).not.toHaveBeenCalled();

    await session.sendPublishDone(PEER_REQUEST_ID, FINAL_GROUP, FINAL_OBJECT);

    expect(peer.written).toHaveLength(2);
    expect(internals.codec.decodeControlMessage(peer.written[1])[0].type).toBe(MessageTypeDraft18.PUBLISH_DONE);
    expect(peer.closed).toHaveBeenCalledTimes(1);
  });

  it('still throws when no request stream exists for the id', async () => {
    const { session } = makeSession(draft);

    await expect(session.sendPublishDone(REQUEST_ID, 0, 0)).rejects.toThrow(/no PUBLISH request stream/);
  });

  it('applies a later REQUEST_UPDATE to the publication of the stream it arrived on', async () => {
    const { session, internals, peer } = await acceptSubscribe();
    const paused: unknown[] = [];
    session.on('forward-paused', (e) => paused.push(e));

    peer.send(pauseUpdate);
    await tick();

    expect(paused).toEqual([{ subscriptionRequestId: PEER_REQUEST_ID }]);
    expect(internals.publicationManager.getByRequestId(PEER_REQUEST_ID)?.forward).toBe(0);
  });

  it('answers each REQUEST_UPDATE with one REQUEST_OK on the same stream (§9.5)', async () => {
    const { internals, peer } = await acceptSubscribe();

    peer.send(pauseUpdate, pauseUpdate);
    await tick();

    expect(peer.written).toHaveLength(3);
    for (const bytes of peer.written.slice(1)) {
      expect(internals.codec.decodeControlMessage(bytes)[0].type).toBe(MessageTypeDraft18.REQUEST_OK);
    }
  });

  it('keeps a REQUEST_UPDATE that arrives in the same read as the SUBSCRIBE', async () => {
    const { session, internals } = makeSession(draft);
    const peer = installIncomingStream(session);
    peer.send(subscribeMessage(draft), pauseUpdate);
    await peer.open();
    await tick();

    expect(internals.publicationManager.getByRequestId(PEER_REQUEST_ID)?.forward).toBe(0);
  });

  it('ends the publication when the subscriber resets the stream', async () => {
    const { internals, peer } = await acceptSubscribe();
    expect(internals.publicationManager.getByRequestId(PEER_REQUEST_ID)).toBeDefined();

    peer.reset();
    await tick();

    expect(internals.publicationManager.getByRequestId(PEER_REQUEST_ID)).toBeUndefined();
    expect(internals.activeRequestStreams.has(PEER_REQUEST_ID)).toBe(false);
  });

  it('keeps the publication when the subscriber only FINs (§6.4.2.2: no more updates)', async () => {
    const { session, internals, peer } = await acceptSubscribe();

    peer.fin();
    await tick();

    expect(internals.publicationManager.getByRequestId(PEER_REQUEST_ID)).toBeDefined();
    await session.sendPublishDone(PEER_REQUEST_ID, 0, 0);
    expect(peer.closed).toHaveBeenCalledTimes(1);
  });

  it('closes a request that was rejected instead of reading it further', async () => {
    const { session, internals } = makeSession(draft);
    const peer = installIncomingStream(session, false);
    peer.send(subscribeMessage(draft));
    await peer.open();

    expect(internals.activeRequestStreams.has(PEER_REQUEST_ID)).toBe(false);
    expect(peer.closed).toHaveBeenCalledTimes(1);
  });
});

describe.each(['draft-18', 'draft-22'] as const)('STOP_SENDING from the peer (%s)', (draft) => {
  const publication = {
    trackAlias: 1n, namespace: ['ns'], trackName: 't', requestId: REQUEST_ID, cleanupHandlers: [], forward: 1,
  };

  it('ends our PUBLISH and cancels the receive side too', async () => {
    const { internals, peer } = await openSubscribeStream(draft);
    internals.publicationManager.add(publication);

    peer.stopSending();
    await tick();

    expect(internals.publicationManager.getByRequestId(REQUEST_ID)).toBeUndefined();
    expect(internals.activeRequestStreams.has(REQUEST_ID)).toBe(false);
    expect(peer.cancelled).toHaveBeenCalledTimes(1);
  });

  it('ends the publication of an accepted SUBSCRIBE', async () => {
    const { session, internals } = makeSession(draft);
    const peer = installIncomingStream(session);
    peer.send(subscribeMessage(draft));
    await peer.open();
    expect(internals.publicationManager.getByRequestId(PEER_REQUEST_ID)).toBeDefined();

    peer.stopSending();
    await tick();

    expect(internals.publicationManager.getByRequestId(PEER_REQUEST_ID)).toBeUndefined();
    expect(internals.activeRequestStreams.has(PEER_REQUEST_ID)).toBe(false);
  });

  it('is not mistaken for a peer cancel when we abort the request ourselves', async () => {
    const { internals } = await openSubscribeStream(draft);
    internals.publicationManager.add(publication);

    await internals.abortRequestStream(REQUEST_ID);
    await tick();

    expect(internals.publicationManager.getByRequestId(REQUEST_ID)).toBeDefined();
  });

  it('ends an accepted SUBSCRIBE on a worker stream when the worker reports it', async () => {
    const worker = { postMessage: vi.fn(), addEventListener: vi.fn(), terminate: vi.fn() } as unknown as Worker;
    const session = new MOQTSession({ worker, draft });
    const internals = session as unknown as Internals;
    internals.announcedNamespaces.set('ns', { namespace: ['ns'], options: {}, subscribers: new Map() });
    internals.handleWorkerIncomingBidiStream(WORKER_STREAM_ID);
    internals.handleWorkerBidiStreamData(WORKER_STREAM_ID, internals.codec.encodeControlMessage(subscribeMessage(draft)));
    await tick();
    expect(internals.publicationManager.getByRequestId(PEER_REQUEST_ID)).toBeDefined();

    internals.handleWorkerSendStopped(WORKER_STREAM_ID);
    await tick();

    expect(internals.publicationManager.getByRequestId(PEER_REQUEST_ID)).toBeUndefined();
  });
});

describe.each(['draft-18', 'draft-22'] as const)('our PUBLISH stream (%s)', (draft) => {
  it('stays open when the subscriber FINs, since PUBLISH_DONE is still owed', async () => {
    const { internals, peer } = await openSubscribeStream(draft);
    internals.publicationManager.add({
      trackAlias: 1n, namespace: ['ns'], trackName: 't', requestId: REQUEST_ID, cleanupHandlers: [], forward: 1,
    });

    peer.fin();
    await tick();

    expect(internals.activeRequestStreams.has(REQUEST_ID)).toBe(true);
  });
});

describe.each(['draft-18', 'draft-22'] as const)('unknown message type (%s)', (draft) => {
  const unknown = new Uint8Array([UNKNOWN_MESSAGE_TYPE, 0, 0]);

  it('closes the session when it arrives on a request stream', async () => {
    const { session, internals } = makeSession(draft);
    const close = vi.spyOn(session, 'close').mockResolvedValue(undefined);
    const peer = installPeerStream(session);
    peer.send({
      type: MessageTypeDraft18.SUBSCRIBE_OK,
      requestId: REQUEST_ID,
      trackAlias: 1n,
      largestLocation: { group: 0n, object: 0n },
    });
    await internals.sendRequestAndWaitResponse(FIRST_BYTES, REQUEST_ID, 'subscribe');

    peer.sendRaw(unknown);
    await tick();

    expect(close).toHaveBeenCalledWith(expect.objectContaining({ code: SessionErrorCodeDraft18.PROTOCOL_VIOLATION }));
  });

  it('closes the session when it opens a peer stream', async () => {
    const { session } = makeSession(draft);
    const close = vi.spyOn(session, 'close').mockResolvedValue(undefined);
    const peer = installIncomingStream(session);
    peer.sendRaw(unknown);

    await peer.open();

    expect(close).toHaveBeenCalledWith(expect.objectContaining({ code: SessionErrorCodeDraft18.PROTOCOL_VIOLATION }));
  });
});

describe.each(['draft-18', 'draft-22'] as const)('client GOAWAY (%s)', (draft) => {
  it('refuses a New Session URI (draft-22 §9.2)', async () => {
    const { session, internals } = makeSession(draft);
    internals.doSendControl = vi.fn().mockResolvedValue(undefined);

    await expect(session.goAway(GOAWAY_URI)).rejects.toThrow(/client/);
    expect(internals.doSendControl).not.toHaveBeenCalled();
  });

  it('still sends a GOAWAY with no URI', async () => {
    const { session, internals } = makeSession(draft);
    internals.doSendControl = vi.fn().mockResolvedValue(undefined);

    await session.goAway();

    expect(internals.doSendControl).toHaveBeenCalledTimes(1);
  });
});

describe.each(['draft-18', 'draft-22'] as const)('request ID cap (%s)', (draft) => {
  it('does not apply: MAX_REQUEST_ID was removed in draft-17', () => {
    const { internals } = makeSession(draft);
    internals.nextRequestId = PAST_LOCAL_CAP;

    expect(internals.getNextRequestId()).toBe(PAST_LOCAL_CAP);
  });
});
