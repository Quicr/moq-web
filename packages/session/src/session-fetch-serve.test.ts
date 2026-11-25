// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Serving a Standalone FETCH from a live publication's `fetchHandler`
 * (draft-18 §10.12.3, §10.13, §11.4.4). The reply is FETCH_OK with the End
 * Location clamped to the Largest Object, then the objects on a
 * unidirectional stream that starts with FETCH_HEADER and ends with a FIN.
 * The stream is decoded with the receive path's own parser and ID resolver.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  Draft18StreamCodec,
  FetchIdResolver,
  FetchTypeDraft18,
  GroupOrder,
  LocationFilterTypeDraft22,
  MessageTypeDraft18,
  RequestErrorCodeDraft18,
  SubscriptionFilterDraft18,
  type FetchIdRules,
  type FetchOkMessageDraft18,
  type RequestErrorMessageDraft18,
  type RequestOkMessageDraft18,
} from '@moq-web/core';
import { announce, makeSession, openIncoming, tick, type Draft, type SessionInternals } from './__tests__/incoming-peer.js';
import { encodeFetchedObject, fetchEndLocation, orderFetchedObjects } from './fetch-responder.js';
import type { FetchedObject, PublicationFetchHandler, PublicationFetchRequest } from './types.js';

const SUBSCRIBE_ID = 1n;
const FETCH_ID = 3n;
const NAMESPACE = ['ns'];
const TRACK = 't';
const LARGEST = { group: 5n, object: 2n };

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array) => new TextDecoder().decode(data);

/** A publication of NAMESPACE/TRACK, made by a peer's SUBSCRIBE, whose Largest Object is LARGEST. */
async function publication(internals: SessionInternals, draft: Draft, fetchHandler?: PublicationFetchHandler) {
  announce(internals, NAMESPACE);
  const peer = openIncoming(internals, {
    type: MessageTypeDraft18.SUBSCRIBE,
    requestId: SUBSCRIBE_ID,
    trackNamespace: NAMESPACE,
    trackName: TRACK,
    forwardState: true,
    ...(draft === 'draft-18' ? { filter: SubscriptionFilterDraft18.NEXT_GROUP_START } : {}),
  });
  await peer.opened;
  const pub = internals.publicationManager.getByRequestId(SUBSCRIBE_ID)!;
  internals.publicationManager.updateLatest(pub.trackAlias as bigint, LARGEST.group, LARGEST.object);
  pub.fetchHandler = fetchHandler;
}

/** Record what the session writes on the unidirectional streams it opens. */
function captureStreams(internals: SessionInternals) {
  const streams: { chunks: Uint8Array[]; closed: boolean }[] = [];
  (internals as unknown as { doCreateStream: () => Promise<unknown> }).doCreateStream = async () => {
    const stream = { chunks: [] as Uint8Array[], closed: false };
    streams.push(stream);
    const writable = new WritableStream<Uint8Array>({
      write: (chunk) => { stream.chunks.push(chunk); },
      close: () => { stream.closed = true; },
    });
    return { writer: writable.getWriter() };
  };
  return streams;
}

/** Decode a fetch stream: its Request ID and the objects with resolved IDs. */
function decodeFetchStream(chunks: Uint8Array[], order = GroupOrder.ASCENDING, rules: FetchIdRules = 'draft-18') {
  const buffer = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const [header, headerLength] = Draft18StreamCodec.decodeFetchHeader(buffer, 0);
  const resolver = new FetchIdResolver(rules, order);
  const objects: { group: number; object: number; priority: number; payload: string }[] = [];
  for (offset = headerLength; offset < buffer.byteLength; ) {
    const [decoded, length] = Draft18StreamCodec.decodeFetchObject(buffer, offset);
    offset += length;
    const payloadLength = Number(decoded.payloadLength ?? 0n);
    const ids = resolver.object(decoded);
    objects.push({
      group: Number(ids.groupId),
      object: Number(ids.objectId),
      priority: ids.priority,
      payload: text(buffer.subarray(offset, offset + payloadLength)),
    });
    offset += payloadLength;
  }
  return { requestId: header.requestId, objects };
}

function standaloneFetch(start: { group: bigint; object: bigint }, end: { group: bigint; object: bigint }, groupOrder = GroupOrder.ASCENDING) {
  return {
    type: MessageTypeDraft18.FETCH,
    requestId: FETCH_ID,
    fetchType: FetchTypeDraft18.STANDALONE,
    joiningFlag: false,
    trackNamespace: NAMESPACE,
    trackName: TRACK,
    subscriberPriority: 128,
    groupOrder,
    startLocation: start,
    endLocation: end,
  };
}

const stored: FetchedObject[] = [
  { groupId: 0, objectId: 0, data: bytes('before the range') },
  { groupId: 1, objectId: 0, data: bytes('g1o0') },
  { groupId: 1, objectId: 1, data: bytes('g1o1') },
  { groupId: 3, objectId: 0, data: bytes('g3o0') },
  { groupId: 3, objectId: 4, data: bytes('g3o4') },
  { groupId: 5, objectId: 2, data: bytes('g5o2') },
];

describe('FETCH served by a fetchHandler (draft-18)', () => {
  const draft = 'draft-18';

  it('answers FETCH_OK with the End Location clamped to the Largest Object, then streams the objects', async () => {
    const { internals } = makeSession(draft);
    const requests: PublicationFetchRequest[] = [];
    await publication(internals, draft, (request) => {
      requests.push(request);
      return stored;
    });
    const streams = captureStreams(internals);

    // End {9, 0} (all of group 9) is beyond the Largest Object {5, 2}
    const peer = openIncoming(internals, standaloneFetch({ group: 1n, object: 0n }, { group: 9n, object: 0n }));
    await peer.opened;
    await tick();

    expect(requests).toEqual([
      { requestId: FETCH_ID, namespace: NAMESPACE, trackName: TRACK, start: { group: 1, object: 0 }, end: { group: 5, object: 2 } },
    ]);

    const [reply] = peer.written();
    expect(reply.type).toBe(MessageTypeDraft18.FETCH_OK);
    expect((reply as FetchOkMessageDraft18).endLocation).toEqual({ group: 5n, object: 3n });
    // The request is finished once FETCH_OK and every object are sent, so the stream ends with a FIN
    expect(peer.closed()).toBe(true);

    expect(streams).toHaveLength(1);
    expect(streams[0].closed).toBe(true);
    const { requestId, objects } = decodeFetchStream(streams[0].chunks);
    expect(requestId).toBe(FETCH_ID);
    expect(objects.map((o) => `${o.group}/${o.object} ${o.payload}`)).toEqual([
      '1/0 g1o0',
      '1/1 g1o1',
      '3/0 g3o0',
      '3/4 g3o4',
      '5/2 g5o2',
    ]);
  });

  it('keeps the requested End Location when it is within the published range', async () => {
    const { internals } = makeSession(draft);
    const requests: PublicationFetchRequest[] = [];
    await publication(internals, draft, (request) => {
      requests.push(request);
      return stored;
    });
    const streams = captureStreams(internals);

    // End {3, 1} is exclusive: only Object 0 of group 3
    const peer = openIncoming(internals, standaloneFetch({ group: 1n, object: 1n }, { group: 3n, object: 1n }));
    await peer.opened;
    await tick();

    expect(requests[0].end).toEqual({ group: 3, object: 0 });
    expect((peer.written()[0] as FetchOkMessageDraft18).endLocation).toEqual({ group: 3n, object: 1n });
    expect(decodeFetchStream(streams[0].chunks).objects.map((o) => `${o.group}/${o.object}`)).toEqual(['1/1', '3/0']);
  });

  it('sends groups in descending order when asked', async () => {
    const { internals } = makeSession(draft);
    await publication(internals, draft, () => stored);
    const streams = captureStreams(internals);

    const peer = openIncoming(internals, standaloneFetch({ group: 1n, object: 0n }, { group: 9n, object: 0n }, GroupOrder.DESCENDING));
    await peer.opened;
    await tick();

    const { objects } = decodeFetchStream(streams[0].chunks, GroupOrder.DESCENDING);
    expect(objects.map((o) => `${o.group}/${o.object}`)).toEqual(['5/2', '3/0', '3/4', '1/0', '1/1']);
  });

  it('opens the stream and ends it with a FIN when no objects exist in the range', async () => {
    const { internals } = makeSession(draft);
    await publication(internals, draft, () => []);
    const streams = captureStreams(internals);

    const peer = openIncoming(internals, standaloneFetch({ group: 2n, object: 0n }, { group: 2n, object: 0n }));
    await peer.opened;
    await tick();

    expect(peer.written()[0].type).toBe(MessageTypeDraft18.FETCH_OK);
    expect(streams[0].closed).toBe(true);
    expect(decodeFetchStream(streams[0].chunks)).toEqual({ requestId: FETCH_ID, objects: [] });
  });

  it('says INTERNAL_ERROR when the handler fails', async () => {
    const { internals } = makeSession(draft);
    await publication(internals, draft, () => {
      throw new Error('store unavailable');
    });
    const streams = captureStreams(internals);

    const peer = openIncoming(internals, standaloneFetch({ group: 1n, object: 0n }, { group: 5n, object: 0n }));
    await peer.opened;
    await tick();

    const [reply] = peer.written();
    expect(reply.type).toBe(MessageTypeDraft18.REQUEST_ERROR);
    expect((reply as RequestErrorMessageDraft18).errorCode).toBe(RequestErrorCodeDraft18.INTERNAL_ERROR);
    expect(streams).toHaveLength(0);
  });

  it('still says INVALID_RANGE past the Largest Object, without calling the handler', async () => {
    const { internals } = makeSession(draft);
    const handler = vi.fn(() => stored);
    await publication(internals, draft, handler);

    const peer = openIncoming(internals, standaloneFetch({ group: 5n, object: 3n }, { group: 9n, object: 0n }));
    await peer.opened;

    expect((peer.written()[0] as RequestErrorMessageDraft18).errorCode).toBe(RequestErrorCodeDraft18.INVALID_RANGE);
    expect(handler).not.toHaveBeenCalled();
  });

  it('does not serve a Joining FETCH', async () => {
    const { internals } = makeSession(draft);
    const handler = vi.fn(() => stored);
    await publication(internals, draft, handler);

    const peer = openIncoming(internals, {
      ...standaloneFetch({ group: 0n, object: 0n }, { group: 0n, object: 0n }),
      fetchType: FetchTypeDraft18.JOINING_RELATIVE,
      joiningFlag: true,
      subscribeRequestId: SUBSCRIBE_ID,
      joiningStart: 1n,
    });
    await peer.opened;

    expect((peer.written()[0] as RequestErrorMessageDraft18).errorCode).toBe(RequestErrorCodeDraft18.NOT_SUPPORTED);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe.each(['draft-22', 'draft-23'] as const)('FETCH served by a fetchHandler (%s)', (draft) => {
  const rules: FetchIdRules = draft === 'draft-23' ? 'draft-23' : 'draft-18';
  // Draft-22+ FETCH has no Fetch Type; its range is the LOCATION_FILTER parameter (d22 §3.2)
  const locationFetch = (locationFilter?: object, groupOrder = GroupOrder.ASCENDING) => ({
    type: MessageTypeDraft18.FETCH,
    requestId: FETCH_ID,
    trackNamespace: NAMESPACE,
    trackName: TRACK,
    subscriberPriority: 128,
    groupOrder,
    ...(locationFilter ? { locationFilter } : {}),
  });

  async function serve(message: object, handler: PublicationFetchHandler = () => stored) {
    const { internals } = makeSession(draft);
    const requests: PublicationFetchRequest[] = [];
    await publication(internals, draft, (request) => {
      requests.push(request);
      return handler(request);
    });
    const streams = captureStreams(internals);
    const peer = openIncoming(internals, message);
    await peer.opened;
    await tick();
    return { requests, reply: peer.written()[0], streams };
  }

  it('serves the whole track up to the Largest Object when there is no Location Filter', async () => {
    const { requests, reply, streams } = await serve(locationFetch());

    expect(requests[0]).toMatchObject({ start: { group: 0, object: 0 }, end: { group: 5, object: 2 } });
    if (draft === 'draft-23') {
      // d23 §3.2: FETCH_OK is a REQUEST_OK, with LARGEST_OBJECT when Largest Object is in the range
      expect(reply.type).toBe(MessageTypeDraft18.REQUEST_OK);
      expect((reply as RequestOkMessageDraft18).largestLocation).toEqual(LARGEST);
    } else {
      // d22 §9.12: the End Location is inclusive
      expect(reply.type).toBe(MessageTypeDraft18.FETCH_OK);
      expect((reply as FetchOkMessageDraft18).endLocation).toEqual(LARGEST);
    }
    expect(decodeFetchStream(streams[0].chunks, GroupOrder.ASCENDING, rules).objects.map((o) => `${o.group}/${o.object} ${o.payload}`)).toEqual([
      '0/0 before the range',
      '1/0 g1o0',
      '1/1 g1o1',
      '3/0 g3o0',
      '3/4 g3o4',
      '5/2 g5o2',
    ]);
  });

  it('ends at the requested End Location when it is before the Largest Object', async () => {
    const filter = {
      type: LocationFilterTypeDraft22.ABSOLUTE_RANGE,
      startLocation: { group: 1n, object: 1n },
      endGroupDelta: 2n,
      endObject: 0n,
    };
    const { requests, reply, streams } = await serve(locationFetch(filter));

    expect(requests[0]).toMatchObject({ start: { group: 1, object: 1 }, end: { group: 3, object: 0 } });
    if (draft === 'draft-23') {
      expect(reply.type).toBe(MessageTypeDraft18.REQUEST_OK);
      expect((reply as RequestOkMessageDraft18).largestLocation).toBeUndefined();
    } else {
      expect((reply as FetchOkMessageDraft18).endLocation).toEqual({ group: 3n, object: 0n });
    }
    expect(decodeFetchStream(streams[0].chunks, GroupOrder.ASCENDING, rules).objects.map((o) => `${o.group}/${o.object}`)).toEqual(['1/1', '3/0']);
  });

  it('ends a range of whole groups at the last object served in its End Group', async () => {
    const filter = { type: LocationFilterTypeDraft22.ABSOLUTE_START_GROUP_END, startLocation: { group: 1n, object: 0n }, endGroupDelta: 2n };
    const { requests, reply, streams } = await serve(locationFetch(filter));

    expect(requests[0].end).toEqual({ group: 3 });
    if (draft === 'draft-22') {
      expect((reply as FetchOkMessageDraft18).endLocation).toEqual({ group: 3n, object: 4n });
    }
    expect(decodeFetchStream(streams[0].chunks, GroupOrder.ASCENDING, rules).objects.map((o) => `${o.group}/${o.object}`)).toEqual(['1/0', '1/1', '3/0', '3/4']);
  });

  it('sends groups in descending order when asked', async () => {
    const filter = { type: LocationFilterTypeDraft22.ABSOLUTE_START, startLocation: { group: 1n, object: 0n } };
    const { streams } = await serve(locationFetch(filter, GroupOrder.DESCENDING));

    const { objects } = decodeFetchStream(streams[0].chunks, GroupOrder.DESCENDING, rules);
    expect(objects.map((o) => `${o.group}/${o.object}`)).toEqual(['5/2', '3/0', '3/4', '1/0', '1/1']);
  });

  it('still says INVALID_RANGE past the Largest Object, without calling the handler', async () => {
    const handler = vi.fn(() => stored);
    const filter = { type: LocationFilterTypeDraft22.ABSOLUTE_START, startLocation: { group: 5n, object: 3n } };
    const { requests, reply, streams } = await serve(locationFetch(filter), handler);

    expect((reply as RequestErrorMessageDraft18).errorCode).toBe(RequestErrorCodeDraft18.INVALID_RANGE);
    expect(requests).toHaveLength(0);
    expect(streams).toHaveLength(0);
  });
});

describe('fetch-responder helpers', () => {
  it('clamps an End Location beyond the Largest Object to {Largest.Group, Largest.Object + 1}', () => {
    expect(fetchEndLocation({ group: 5n, object: 0n }, LARGEST)).toEqual({ group: 5n, object: 3n });
    expect(fetchEndLocation({ group: 5n, object: 9n }, LARGEST)).toEqual({ group: 5n, object: 3n });
    expect(fetchEndLocation({ group: 5n, object: 3n }, LARGEST)).toEqual({ group: 5n, object: 3n });
    expect(fetchEndLocation({ group: 4n, object: 0n }, LARGEST)).toEqual({ group: 4n, object: 0n });
  });

  it('drops objects outside the range and duplicates', () => {
    const request: PublicationFetchRequest = { requestId: 0n, namespace: [], trackName: '', start: { group: 1, object: 1 }, end: { group: 3, object: 0 } };
    const objects = [...stored, { groupId: 1, objectId: 1, data: bytes('duplicate') }];
    expect(orderFetchedObjects(objects, request, false).map((o) => `${o.groupId}/${o.objectId}`)).toEqual(['1/1', '3/0']);
  });

  it('writes the first object with absolute IDs and priority, then only the deltas needed', () => {
    const first = Draft18StreamCodec.decodeFetchObject(encodeFetchedObject(stored[1], undefined, 7, false))[0];
    expect(first).toMatchObject({ groupIdDelta: 1n, objectIdDelta: 0n, publisherPriority: 7 });

    const next = Draft18StreamCodec.decodeFetchObject(encodeFetchedObject(stored[2], stored[1], 7, false))[0];
    expect(next.groupIdDelta).toBeUndefined();
    expect(next.objectIdDelta).toBeUndefined();
    expect(next.publisherPriority).toBeUndefined();

    const newGroup = Draft18StreamCodec.decodeFetchObject(encodeFetchedObject(stored[3], stored[2], 7, false))[0];
    expect(newGroup).toMatchObject({ groupIdDelta: 1n, objectIdDelta: 0n });
  });

  it('writes an Object ID Delta within a group as the gap, minus 2 in draft-23', () => {
    // 3/0 then 3/4: draft-18/22 add the delta (4), draft-23 adds the delta + 2 (2)
    expect(Draft18StreamCodec.decodeFetchObject(encodeFetchedObject(stored[4], stored[3], 7, false, 'draft-18'))[0].objectIdDelta).toBe(4n);
    expect(Draft18StreamCodec.decodeFetchObject(encodeFetchedObject(stored[4], stored[3], 7, false, 'draft-23'))[0].objectIdDelta).toBe(2n);
  });
});
