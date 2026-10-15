// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Fill fetch (draft-22 §3.4) and its draft-18 equivalent, a Joining FETCH
 * (draft-18 §10.12.2).
 *
 * SUBSCRIBE or REQUEST_UPDATE carries FILL_PARAMETERS (§9.20.15); the
 * publisher answers on a fill fetch stream whose FETCH_HEADER carries that
 * message's Request ID. Fill objects go to the subscription's object callback.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  Draft18StreamCodec,
  Draft22MessageCodec,
  DataStreamType,
  FetchSubgroupMode,
  FetchTypeDraft18,
  GroupOrder,
  LocationFilterTypeDraft22,
  MOQTransport,
  MOQTVarInt,
  MessageTypeDraft18,
  MessageTypeDraft22,
  RequestParameterDraft18,
  type ControlMessageDraft18,
  type FetchObjectDraft18,
  type FetchMessageDraft18,
  type RequestUpdateMessageDraft22,
  type SubscribeMessageDraft22,
} from '@moq-web/core';

import { MOQTSession } from './session.js';

type Draft = 'draft-16' | 'draft-18' | 'draft-22';
type Seen = Array<[number, number]>;

const PRIORITY = 128;
const TRACK_ALIAS = 1n;
const FILL_PRIORITY = 9;
const LAST_GROUPS = 3;
const SUBSCRIBE_OK = {
  type: MessageTypeDraft18.SUBSCRIBE_OK,
  requestId: 0n,
  trackAlias: TRACK_ALIAS,
  largestLocation: { group: 0n, object: 0n },
};

interface Internals {
  codec: {
    encodeControlMessage: (m: unknown) => Uint8Array;
    decodeControlMessage: (b: Uint8Array) => [ControlMessageDraft18, number];
  };
  objectRouter: {
    fetchGroupOrders: Map<bigint, GroupOrder>;
    handleIncomingStream: (s: ReadableStream<Uint8Array>) => Promise<void>;
  };
  fillStreams: Map<bigint, number>;
  activeRequestStreams: Map<bigint, unknown>;
  sendRequestAndWaitResponse: (b: Uint8Array, id: bigint) => Promise<ControlMessageDraft18>;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function makeSession(draft: Draft): { session: MOQTSession; internals: Internals } {
  const transport = new MOQTransport({ draft });
  (transport as unknown as { close: typeof transport.close }).close = vi.fn().mockResolvedValue(undefined);
  const session = new MOQTSession(transport);
  (session as unknown as { _state: string })._state = 'ready';

  return { session, internals: session as unknown as Internals };
}

/** A request stream the test controls: `written` is what we wrote. */
function installPeerStream(session: MOQTSession, internals: Internals) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const readable = new ReadableStream<Uint8Array>({ start: (c) => { controller = c; } });
  const written: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({ write: (chunk) => { written.push(chunk); } });
  const transport = (session as unknown as { transport: { createRequestStream: unknown } }).transport;
  const createRequestStream = vi.fn().mockResolvedValue({ readable, writable });
  transport.createRequestStream = createRequestStream;

  return {
    written,
    createRequestStream,
    send: (message: unknown) => controller.enqueue(internals.codec.encodeControlMessage(message)),
  };
}

function firstObject(group: bigint, object: bigint): FetchObjectDraft18 {
  return {
    subgroupMode: FetchSubgroupMode.ZERO,
    groupIdDelta: group,
    objectIdDelta: object,
    publisherPriority: PRIORITY,
  };
}

function nextObject(fields: Partial<FetchObjectDraft18>): FetchObjectDraft18 {
  return { subgroupMode: FetchSubgroupMode.PRIOR, ...fields };
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

/** Each object with a 1-byte payload. */
function encodeObjects(objects: FetchObjectDraft18[]): Uint8Array {
  return concat(objects.flatMap((obj) => [
    Draft18StreamCodec.encodeFetchObject({ ...obj, payloadLength: 1n }),
    new Uint8Array([0xaa]),
  ]));
}

/** A fill fetch stream (FETCH_HEADER + Request ID) the test keeps open and feeds. */
function openFillStream(internals: Internals, requestId: bigint, objects: FetchObjectDraft18[]) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancelled = vi.fn();
  const stream = new ReadableStream<Uint8Array>({
    start: (c) => { controller = c; },
    cancel: cancelled,
  });
  controller.enqueue(concat([
    MOQTVarInt.encode(BigInt(DataStreamType.FETCH_HEADER)),
    MOQTVarInt.encode(requestId),
    encodeObjects(objects),
  ]));
  const done = internals.objectRouter.handleIncomingStream(stream);

  return {
    done,
    cancelled,
    push: (more: FetchObjectDraft18[]) => controller.enqueue(encodeObjects(more)),
    fin: () => controller.close(),
    reset: () => controller.error(new Error('reset')),
  };
}

async function subscribeWith(
  draft: Draft,
  options?: Parameters<MOQTSession['subscribe']>[2],
) {
  const { session, internals } = makeSession(draft);
  const peer = installPeerStream(session, internals);
  peer.send(SUBSCRIBE_OK);
  const seen: Seen = [];
  const onObject = (_d: Uint8Array, group: number, object: number) => { seen.push([group, object]); };

  const subscriptionId = await session.subscribe(['ns'], 't', options, onObject);
  const requestId = session.getSubscriptions()[0].requestId;

  return { session, internals, peer, seen, subscriptionId, requestId };
}

describe('draft-22 §3.4 fill: SUBSCRIBE', () => {
  it('carries FILL_PARAMETERS from SubscribeOptions.fill', async () => {
    const { peer } = await subscribeWith('draft-22', {
      fill: { lastGroups: 1, fillTimeout: 0, priority: FILL_PRIORITY, groupOrder: GroupOrder.DESCENDING },
    });

    const message = Draft22MessageCodec.decode(peer.written[0])[0] as SubscribeMessageDraft22;
    expect(message.type).toBe(MessageTypeDraft22.SUBSCRIBE);
    expect(message.fill).toEqual({
      locationFilter: {
        type: LocationFilterTypeDraft22.RELATIVE_START,
        startLocation: { group: 1n, object: 0n },
      },
      fillTimeoutMs: 0n,
      subscriberPriority: FILL_PRIORITY,
      groupOrder: GroupOrder.DESCENDING,
    });
  });

  it('carries no FILL_PARAMETERS without a fill option', async () => {
    const { peer } = await subscribeWith('draft-22');

    const message = Draft22MessageCodec.decode(peer.written[0])[0] as SubscribeMessageDraft22;
    expect(message.fill).toBeUndefined();
  });

  it('registers the SUBSCRIBE Request ID as a fill stream with the fill group order', async () => {
    const { internals, requestId, subscriptionId } = await subscribeWith('draft-22', {
      fill: { lastGroups: 1, groupOrder: GroupOrder.DESCENDING },
    });

    expect(internals.fillStreams.get(requestId)).toBe(subscriptionId);
    expect(internals.objectRouter.fetchGroupOrders.get(requestId)).toBe(GroupOrder.DESCENDING);
  });

  it('falls back to the subscription group order', async () => {
    const { internals, requestId } = await subscribeWith('draft-22', {
      groupOrder: GroupOrder.DESCENDING,
      fill: { lastGroups: 1 },
    });

    expect(internals.objectRouter.fetchGroupOrders.get(requestId)).toBe(GroupOrder.DESCENDING);
  });

  it('sends GROUP_ORDER so the fill decodes in the order the subscription uses (§3.4, §9.20.8)', async () => {
    const { peer, internals, requestId } = await subscribeWith('draft-22', { fill: { lastGroups: 1 } });

    const message = Draft22MessageCodec.decode(peer.written[0])[0] as SubscribeMessageDraft22;
    expect(message.parameters?.get(RequestParameterDraft18.GROUP_ORDER)).toEqual(new Uint8Array([1]));
    expect(internals.objectRouter.fetchGroupOrders.get(requestId)).toBe(GroupOrder.ASCENDING);
  });

  it('rejects an inexpressible fill before sending anything', async () => {
    const { session, internals } = makeSession('draft-22');
    const peer = installPeerStream(session, internals);

    await expect(
      session.subscribe(['ns'], 't', { fill: { lastGroups: 1, startGroup: 2 } }),
    ).rejects.toThrow(/lastGroups/);
    expect(peer.createRequestStream).not.toHaveBeenCalled();
    expect(session.getSubscriptions()).toHaveLength(0);
  });
});

describe('draft-22 §3.4 fill: requestFill', () => {
  it('sends REQUEST_UPDATE with a new Request ID and FILL_PARAMETERS on the subscription stream', async () => {
    const { session, internals, peer, requestId, subscriptionId } = await subscribeWith('draft-22');

    await session.requestFill(subscriptionId, { startGroup: 4, priority: FILL_PRIORITY });

    expect(peer.written).toHaveLength(2);
    const update = Draft22MessageCodec.decode(peer.written[1])[0] as RequestUpdateMessageDraft22;
    expect(update.type).toBe(MessageTypeDraft22.REQUEST_UPDATE);
    expect(update.requestId).not.toBe(requestId);
    expect(update.forwardState).toBeUndefined();
    expect(update.fill).toEqual({
      locationFilter: {
        type: LocationFilterTypeDraft22.ABSOLUTE_START,
        startLocation: { group: 4n, object: 0n },
      },
      subscriberPriority: FILL_PRIORITY,
    });
    expect(internals.fillStreams.get(update.requestId)).toBe(subscriptionId);
    expect(internals.objectRouter.fetchGroupOrders.get(update.requestId)).toBe(GroupOrder.ASCENDING);
  });

  it('rejects while the subscription is paused (§3.4.1)', async () => {
    const { session, peer, subscriptionId } = await subscribeWith('draft-22');
    session.getSubscriptions()[0].paused = true;

    await expect(session.requestFill(subscriptionId, { lastGroups: 1 })).rejects.toThrow(/paused/);
    expect(peer.written).toHaveLength(1);
  });

  it('rejects an unknown subscription', async () => {
    const { session } = makeSession('draft-22');

    await expect(session.requestFill(99, { lastGroups: 1 })).rejects.toThrow(/subscription/);
  });

  it('forgets the fill stream when the write fails', async () => {
    const { session, internals, requestId, subscriptionId } = await subscribeWith('draft-22');
    internals.activeRequestStreams.set(requestId, { write: () => Promise.reject(new Error('closed')) });

    await expect(session.requestFill(subscriptionId, { lastGroups: 1 })).rejects.toThrow(/closed/);
    expect(internals.fillStreams.size).toBe(0);
    expect(internals.objectRouter.fetchGroupOrders.size).toBe(0);
  });
});

describe('draft-22 §3.4 fill fetch streams', () => {
  it('delivers a SUBSCRIBE-initiated fill stream to the subscription callback', async () => {
    const { internals, seen, requestId } = await subscribeWith('draft-22', { fill: { lastGroups: 1 } });

    const fill = openFillStream(internals, requestId, [
      firstObject(7n, 0n),
      nextObject({ objectIdDelta: 0n }),
      nextObject({}),
    ]);
    fill.fin();
    await fill.done;

    expect(seen).toEqual([[7, 0], [7, 0], [7, 1]]);
  });

  it('delivers a REQUEST_UPDATE-initiated fill stream with its group order', async () => {
    const { session, internals, seen, subscriptionId } = await subscribeWith('draft-22');
    await session.requestFill(subscriptionId, { lastGroups: 2, groupOrder: GroupOrder.DESCENDING });
    const [updateId] = [...internals.fillStreams.keys()];

    const fill = openFillStream(internals, updateId, [
      firstObject(10n, 0n),
      nextObject({ groupIdDelta: 0n, objectIdDelta: 0n }),
    ]);
    fill.fin();
    await fill.done;

    expect(seen).toEqual([[10, 0], [9, 0]]);
  });

  it('delivers through a callback set after subscribing, and not as fetch-object', async () => {
    const { session, internals, requestId, subscriptionId } = await subscribeWith('draft-22', {
      fill: { lastGroups: 1 },
    });
    const later: Seen = [];
    session.setSubscriptionCallback(subscriptionId, (_d, g, o) => { later.push([g, o]); });
    const events: unknown[] = [];
    session.on('fetch-object', (e) => events.push(e));

    const fill = openFillStream(internals, requestId, [firstObject(2n, 3n)]);
    fill.fin();
    await fill.done;

    expect(later).toEqual([[2, 3]]);
    expect(events).toHaveLength(0);
  });

  it('keeps two fill streams open at once, each routed by its Request ID', async () => {
    const { session, internals, seen, requestId, subscriptionId } = await subscribeWith('draft-22', {
      fill: { lastGroups: 1 },
    });
    await session.requestFill(subscriptionId, { lastGroups: 3 });
    const updateId = [...internals.fillStreams.keys()].find((id) => id !== requestId)!;

    const first = openFillStream(internals, requestId, [firstObject(8n, 0n)]);
    const second = openFillStream(internals, updateId, [firstObject(5n, 0n)]);
    await tick();
    first.push([nextObject({})]);
    second.push([nextObject({})]);
    await tick();

    expect(internals.fillStreams.size).toBe(2);
    expect([...seen].sort()).toEqual([[5, 0], [5, 1], [8, 0], [8, 1]]);

    first.fin();
    second.fin();
    await Promise.all([first.done, second.done]);

    expect(internals.fillStreams.size).toBe(0);
    expect(internals.objectRouter.fetchGroupOrders.size).toBe(0);
  });

  it('survives a fill stream reset (§3.4.1)', async () => {
    const { session, internals, requestId, subscriptionId } = await subscribeWith('draft-22', {
      fill: { lastGroups: 1 },
    });

    const fill = openFillStream(internals, requestId, [firstObject(1n, 0n)]);
    await tick();
    fill.reset();
    await fill.done;

    expect(session.getSubscriptions().map((s) => s.subscriptionId)).toEqual([subscriptionId]);
    expect(internals.activeRequestStreams.has(requestId)).toBe(true);
    expect(internals.fillStreams.size).toBe(0);
  });

  it('stops open fill streams on unsubscribe (§3.4.1)', async () => {
    const { session, internals, seen, requestId, subscriptionId } = await subscribeWith('draft-22', {
      fill: { lastGroups: 1 },
    });
    const fill = openFillStream(internals, requestId, [firstObject(1n, 0n)]);
    await tick();

    await session.unsubscribe(subscriptionId);
    await fill.done;

    expect(fill.cancelled).toHaveBeenCalled();
    expect(internals.fillStreams.size).toBe(0);
    expect(seen).toEqual([[1, 0]]);
  });

  it('cancels a fill stream that has not arrived yet when unsubscribing', async () => {
    const { session, internals, seen, requestId, subscriptionId } = await subscribeWith('draft-22', {
      fill: { lastGroups: 1 },
    });

    await session.unsubscribe(subscriptionId);
    const fill = openFillStream(internals, requestId, [firstObject(1n, 0n)]);
    await fill.done;

    expect(fill.cancelled).toHaveBeenCalled();
    expect(seen).toEqual([]);
  });
});

/** Answers SUBSCRIBE with SUBSCRIBE_OK and FETCH with FETCH_OK, recording each request. */
function installDraft18Peer(internals: Internals, onFetch?: (fetch: FetchMessageDraft18) => Promise<void>) {
  const requests: ControlMessageDraft18[] = [];
  internals.sendRequestAndWaitResponse = async (bytes) => {
    const message = internals.codec.decodeControlMessage(bytes)[0];
    requests.push(message);
    if (message.type === MessageTypeDraft18.FETCH) {
      await onFetch?.(message as FetchMessageDraft18);
      return {
        type: MessageTypeDraft18.FETCH_OK,
        endOfTrack: false,
        endLocation: { group: 0n, object: 0n },
      } as unknown as ControlMessageDraft18;
    }

    return SUBSCRIBE_OK as unknown as ControlMessageDraft18;
  };

  return requests;
}

describe('draft-18 §10.12.2 fill as a Joining FETCH', () => {
  it('maps lastGroups N to a relative Joining FETCH of the subscription', async () => {
    const { session, internals } = makeSession('draft-18');
    const requests = installDraft18Peer(internals);
    const subscriptionId = await session.subscribe(['ns'], 't');
    const subscribeId = session.getSubscriptions()[0].requestId;

    await session.requestFill(subscriptionId, { lastGroups: LAST_GROUPS, priority: FILL_PRIORITY });

    const fetch = requests[1] as FetchMessageDraft18;
    expect(fetch.fetchType).toBe(FetchTypeDraft18.JOINING_RELATIVE);
    expect(fetch.subscribeRequestId).toBe(subscribeId);
    expect(fetch.joiningStart).toBe(BigInt(LAST_GROUPS - 1));
    expect(fetch.subscriberPriority).toBe(FILL_PRIORITY);
  });

  it('maps startGroup to an absolute Joining FETCH', async () => {
    const { session, internals } = makeSession('draft-18');
    const requests = installDraft18Peer(internals);
    const subscriptionId = await session.subscribe(['ns'], 't');

    await session.requestFill(subscriptionId, { startGroup: 7 });

    const fetch = requests[1] as FetchMessageDraft18;
    expect(fetch.fetchType).toBe(FetchTypeDraft18.JOINING_ABSOLUTE);
    expect(fetch.joiningStart).toBe(7n);
  });

  it('sends the Joining FETCH after SUBSCRIBE when SubscribeOptions.fill is set', async () => {
    const { session, internals } = makeSession('draft-18');
    const requests = installDraft18Peer(internals);

    await session.subscribe(['ns'], 't', { fill: { lastGroups: 1 } });

    expect(requests.map((r) => r.type)).toEqual([MessageTypeDraft18.SUBSCRIBE, MessageTypeDraft18.FETCH]);
  });

  it('rejects what a Joining FETCH cannot express, sending nothing', async () => {
    const { session, internals } = makeSession('draft-18');
    const requests = installDraft18Peer(internals);
    const subscriptionId = await session.subscribe(['ns'], 't');

    await expect(session.requestFill(subscriptionId, { startGroup: 1, endGroup: 3 })).rejects.toThrow(/endGroup/);
    await expect(session.requestFill(subscriptionId, {})).rejects.toThrow(/lastGroups or startGroup/);
    expect(requests).toHaveLength(1);
  });

  it('rejects an inexpressible fill in SubscribeOptions before subscribing', async () => {
    const { session, internals } = makeSession('draft-18');
    const requests = installDraft18Peer(internals);

    await expect(session.subscribe(['ns'], 't', { fill: { startGroup: 1, endGroup: 3 } })).rejects.toThrow(/endGroup/);
    expect(requests).toHaveLength(0);
  });

  it('delivers the fill stream to the subscription callback, even before FETCH_OK', async () => {
    const { session, internals } = makeSession('draft-18');
    const seen: Seen = [];
    installDraft18Peer(internals, async (fetch) => {
      const fill = openFillStream(internals, fetch.requestId, [firstObject(4n, 0n), nextObject({ groupIdDelta: 6n, objectIdDelta: 0n })]);
      fill.fin();
      await fill.done;
    });
    const subscriptionId = await session.subscribe(['ns'], 't', undefined, (_d, g, o) => { seen.push([g, o]); });

    await session.requestFill(subscriptionId, { lastGroups: 1 });

    expect(seen).toEqual([[4, 0], [6, 0]]);
    expect(internals.fillStreams.size).toBe(0);
  });

  it('stops an open fill stream on unsubscribe', async () => {
    const { session, internals } = makeSession('draft-18');
    let fill: ReturnType<typeof openFillStream> | undefined;
    installDraft18Peer(internals, async (fetch) => {
      fill = openFillStream(internals, fetch.requestId, [firstObject(4n, 0n)]);
      await tick();
    });
    const subscriptionId = await session.subscribe(['ns'], 't');
    await session.requestFill(subscriptionId, { lastGroups: 1 });

    await session.unsubscribe(subscriptionId);
    await fill!.done;

    expect(fill!.cancelled).toHaveBeenCalled();
    expect(internals.fillStreams.size).toBe(0);
  });
});

describe('draft-22 fill on a relay-pushed PUBLISH', () => {
  it('lets an incoming-publish listener call requestFill synchronously', async () => {
    const { session, internals } = makeSession('draft-22');
    const namespaceSubscriptions = (session as unknown as { namespaceSubscriptions: Map<number, unknown> })
      .namespaceSubscriptions;
    namespaceSubscriptions.set(1, { subscriptionId: 1, requestId: 1n, namespacePrefix: ['ns'], tracks: new Map() });

    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const readable = new ReadableStream<Uint8Array>({ start: (c) => { controller = c; } });
    const written: Uint8Array[] = [];
    const writable = new WritableStream<Uint8Array>({ write: (chunk) => { written.push(chunk); } });
    let fill: Promise<void> | undefined;
    session.on('incoming-publish', (evt) => {
      fill = session.requestFill(evt.subscriptionId, { lastGroups: 1 });
    });

    controller.enqueue(internals.codec.encodeControlMessage({
      type: MessageTypeDraft22.PUBLISH,
      requestId: 3n,
      trackAlias: 9n,
      trackNamespace: ['ns', 'peer'],
      trackName: 'catalog',
      forwardState: true,
    }));
    await (session as unknown as {
      processIncomingBidiStream: (s: unknown) => Promise<void>;
    }).processIncomingBidiStream({ readable, writable });
    await fill;

    const types = written.map((bytes) => internals.codec.decodeControlMessage(bytes)[0].type);
    expect(types).toEqual([MessageTypeDraft18.REQUEST_OK, MessageTypeDraft22.REQUEST_UPDATE]);
    expect(internals.activeRequestStreams.has(3n)).toBe(true);
  });
});

describe('draft-16 has no fill', () => {
  it('ignores SubscribeOptions.fill and rejects requestFill', async () => {
    const { session } = makeSession('draft-16');
    (session as unknown as { doSendControl: () => Promise<void> }).doSendControl = async () => {};

    const subscriptionId = await session.subscribe(['ns'], 't', { fill: { lastGroups: 1 } });

    await expect(session.requestFill(subscriptionId, { lastGroups: 1 })).rejects.toThrow(/draft-18/);
  });
});
