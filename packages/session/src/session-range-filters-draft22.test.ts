// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Draft-22 Range Filters (§3.3.2, §9.1.6, §9.20.10-9.20.14) in the session.
 *
 * As subscriber: filters ride SUBSCRIBE, FETCH, REQUEST_UPDATE and
 * FILL_PARAMETERS, bounded by the peer's MAX_FILTER_RANGES (default 0). As
 * publisher we filter nothing, so we advertise no MAX_FILTER_RANGES and answer
 * any request with Ranges using INVALID_FILTER.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  Draft18MessageCodec,
  Draft22MessageCodec,
  MOQTransport,
  MessageTypeDraft18,
  MessageTypeDraft22,
  RequestErrorCodeDraft22,
  RequestParameterDraft22,
  type ControlMessageDraft18,
  type FetchMessageDraft22,
  type RangeFilterDraft22,
  type RequestUpdateMessageDraft22,
  type SubscribeMessageDraft22,
} from '@moq-web/core';

import { MOQTSession } from './session.js';
import { RequestRejectedError } from './request-rejected-error.js';

type Draft = 'draft-18' | 'draft-22';

const P = RequestParameterDraft22;
const PEER_MAX_RANGES = 3;
const PEER_REQUEST_ID = 3n;
const PEER_UPDATE_ID = 7n;

const objectIdFilter = (ranges: number, setId = 0): RangeFilterDraft22 => ({
  type: P.OBJECTID_FILTER,
  setId,
  ranges: Array.from({ length: ranges }, (_, i) => ({ start: BigInt(i * 10), end: BigInt(i * 10 + 5) })),
});

interface Internals {
  _state: string;
  nextRequestId: number;
  pendingSetupMessages: ControlMessageDraft18[];
  waitForServerSetupDraft18: () => Promise<void>;
  doSendControl: (b: Uint8Array) => Promise<void>;
  sendRequestAndWaitResponse: (b: Uint8Array, id: bigint) => Promise<unknown>;
  codec: {
    encodeControlMessage: (m: unknown) => Uint8Array;
    decodeControlMessage: (b: Uint8Array) => [ControlMessageDraft18, number];
  };
  announcedNamespaces: Map<string, unknown>;
  publicationManager: { getByRequestId: (id: bigint) => unknown };
  processIncomingBidiStream: (s: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }) => Promise<void>;
  transport: { createRequestStream: unknown };
}

function makeSession(draft: Draft = 'draft-22'): { session: MOQTSession; internals: Internals } {
  const transport = new MOQTransport({ draft });
  (transport as unknown as { close: typeof transport.close }).close = vi.fn().mockResolvedValue(undefined);
  const session = new MOQTSession(transport);
  const internals = session as unknown as Internals;
  internals._state = 'ready';

  return { session, internals };
}

/** Feed a SERVER_SETUP through the real handler, as the handshake does */
async function receiveServerSetup(internals: Internals, maxFilterRanges?: number): Promise<void> {
  internals.pendingSetupMessages.push({
    type: MessageTypeDraft18.SERVER_SETUP,
    maxFilterRanges,
  } as unknown as ControlMessageDraft18);
  await internals.waitForServerSetupDraft18();
}

/** A session whose SUBSCRIBE / FETCH go to `sent` and are answered with `response` */
function makeRequestingSession(
  options: { draft?: Draft; peerMax?: number; response?: unknown } = {},
): Promise<{ session: MOQTSession; internals: Internals; sent: Uint8Array[] }> {
  const { session, internals } = makeSession(options.draft);
  const sent: Uint8Array[] = [];
  internals.sendRequestAndWaitResponse = async (bytes) => {
    sent.push(bytes);

    return options.response ?? {
      type: MessageTypeDraft18.SUBSCRIBE_OK,
      requestId: 0n,
      largestLocation: { group: 0n, object: 0n },
      trackProperties: new Map(),
    };
  };

  return receiveServerSetup(internals, options.peerMax).then(() => {
    internals._state = 'ready';

    return { session, internals, sent };
  });
}

function decodeSent<T>(bytes: Uint8Array): T {
  return Draft22MessageCodec.decode(bytes)[0] as unknown as T;
}

describe('draft-22 Range Filters, subscriber side', () => {
  describe('SUBSCRIBE (§9.6)', () => {
    it('encodes rangeFilters', async () => {
      const { session, sent } = await makeRequestingSession({ peerMax: PEER_MAX_RANGES });
      const filters = [objectIdFilter(2)];

      await session.subscribe(['ns'], 't', { rangeFilters: filters });

      expect(decodeSent<SubscribeMessageDraft22>(sent[0]).rangeFilters).toEqual(filters);
    });

    it('sends no range filter parameter when none is requested', async () => {
      const { session, sent } = await makeRequestingSession();

      await session.subscribe(['ns'], 't');

      expect(decodeSent<SubscribeMessageDraft22>(sent[0]).rangeFilters).toBeUndefined();
    });

    it('throws before sending when the Ranges exceed the peer MAX_FILTER_RANGES', async () => {
      const { session, internals, sent } = await makeRequestingSession({ peerMax: PEER_MAX_RANGES });
      const nextRequestId = internals.nextRequestId;

      await expect(
        session.subscribe(['ns'], 't', { rangeFilters: [objectIdFilter(2), objectIdFilter(2, 1)] }),
      ).rejects.toThrow(/MAX_FILTER_RANGES/);

      expect(sent).toHaveLength(0);
      expect(internals.nextRequestId).toBe(nextRequestId);
    });

    it('treats an absent peer MAX_FILTER_RANGES as 0 (§9.1.6)', async () => {
      const { session, sent } = await makeRequestingSession();

      await expect(session.subscribe(['ns'], 't', { rangeFilters: [objectIdFilter(1)] })).rejects.toThrow(
        /MAX_FILTER_RANGES/,
      );
      expect(sent).toHaveLength(0);
    });

    it('records MAX_FILTER_RANGES from SERVER_SETUP', async () => {
      const { session, sent } = await makeRequestingSession({ peerMax: PEER_MAX_RANGES });

      await session.subscribe(['ns'], 't', { rangeFilters: [objectIdFilter(PEER_MAX_RANGES)] });
      await expect(
        session.subscribe(['ns'], 't', { rangeFilters: [objectIdFilter(PEER_MAX_RANGES + 1)] }),
      ).rejects.toThrow(/MAX_FILTER_RANGES/);

      expect(sent).toHaveLength(1);
    });

    it('throws before sending on an invalid filter', async () => {
      const { session, sent } = await makeRequestingSession({ peerMax: PEER_MAX_RANGES });
      const filter: RangeFilterDraft22 = { type: P.PRIORITY_FILTER, setId: 0, ranges: [{ start: 300n }] };

      await expect(session.subscribe(['ns'], 't', { rangeFilters: [filter] })).rejects.toThrow(/INVALID_FILTER/);
      expect(sent).toHaveLength(0);
    });

    it('refuses TRACK_PROPERTY_FILTER, which SUBSCRIBE cannot carry', async () => {
      const { session, sent } = await makeRequestingSession({ peerMax: PEER_MAX_RANGES });
      const filter: RangeFilterDraft22 = {
        type: P.TRACK_PROPERTY_FILTER,
        setId: 0,
        propertyType: 2n,
        ranges: [{ start: 0n }],
      };

      await expect(session.subscribe(['ns'], 't', { rangeFilters: [filter] })).rejects.toThrow(/TRACK_PROPERTY_FILTER/);
      expect(sent).toHaveLength(0);
    });
  });

  describe('FETCH (§9.11)', () => {
    const range = { startGroup: 0, startObject: 0, endGroup: 1, endObject: 0 };
    const fetchOk = { type: MessageTypeDraft18.FETCH_OK, endOfTrack: false, endLocation: { group: 0n, object: 0n } };

    it('encodes rangeFilters', async () => {
      const { session, sent } = await makeRequestingSession({ peerMax: PEER_MAX_RANGES, response: fetchOk });
      const filters = [objectIdFilter(1)];

      await session.fetch(['ns'], 't', range, { rangeFilters: filters });

      expect(decodeSent<FetchMessageDraft22>(sent[0]).rangeFilters).toEqual(filters);
    });

    it('throws before sending when the Ranges exceed the peer MAX_FILTER_RANGES', async () => {
      const { session, sent } = await makeRequestingSession({ peerMax: PEER_MAX_RANGES, response: fetchOk });

      await expect(session.fetch(['ns'], 't', range, { rangeFilters: [objectIdFilter(PEER_MAX_RANGES + 1)] })).rejects
        .toThrow(/MAX_FILTER_RANGES/);
      expect(sent).toHaveLength(0);
    });
  });

  describe('FILL_PARAMETERS (§9.20.15)', () => {
    it('encodes fill rangeFilters inside FILL_PARAMETERS', async () => {
      const { session, sent } = await makeRequestingSession({ peerMax: PEER_MAX_RANGES });
      const fillFilters = [objectIdFilter(1)];

      await session.subscribe(['ns'], 't', { fill: { lastGroups: 2, rangeFilters: fillFilters } });

      const message = decodeSent<SubscribeMessageDraft22>(sent[0]);
      expect(message.fill?.rangeFilters).toEqual(fillFilters);
      expect(message.rangeFilters).toBeUndefined();
    });

    it('counts the fill Ranges with the subscription Ranges', async () => {
      const { session, sent } = await makeRequestingSession({ peerMax: PEER_MAX_RANGES });

      await expect(
        session.subscribe(['ns'], 't', {
          rangeFilters: [objectIdFilter(2)],
          fill: { lastGroups: 2, rangeFilters: [objectIdFilter(2)] },
        }),
      ).rejects.toThrow(/MAX_FILTER_RANGES/);
      expect(sent).toHaveLength(0);
    });
  });

  describe('REQUEST_UPDATE (§9.5)', () => {
    async function openSubscribed(peerMax = PEER_MAX_RANGES) {
      const { session, internals } = makeSession();
      await receiveServerSetup(internals, peerMax);
      internals._state = 'ready';

      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const readable = new ReadableStream<Uint8Array>({ start: (c) => { controller = c; } });
      const written: Uint8Array[] = [];
      const writable = new WritableStream<Uint8Array>({ write: (chunk) => { written.push(chunk); } });
      internals.transport.createRequestStream = vi.fn().mockResolvedValue({ readable, writable });
      controller.enqueue(internals.codec.encodeControlMessage({
        type: MessageTypeDraft18.SUBSCRIBE_OK,
        requestId: 0n,
        trackAlias: 1n,
        largestLocation: { group: 0n, object: 0n },
      }));
      const subscriptionId = await session.subscribe(['ns'], 't');

      return { session, written, requestId: BigInt(subscriptionId) };
    }

    it('encodes rangeFilters and leaves FORWARD out', async () => {
      const { session, written, requestId } = await openSubscribed();
      const filters = [objectIdFilter(2)];

      await session.sendRequestUpdate(requestId, true, { awaitAck: false, rangeFilters: filters });

      const update = decodeSent<RequestUpdateMessageDraft22>(written[1]);
      expect(update.rangeFilters).toEqual(filters);
      expect(update.forwardState).toBeUndefined();
    });

    it('throws before sending when the Ranges exceed the peer MAX_FILTER_RANGES', async () => {
      const { session, written, requestId } = await openSubscribed();

      await expect(
        session.sendRequestUpdate(requestId, true, {
          awaitAck: false,
          rangeFilters: [objectIdFilter(PEER_MAX_RANGES + 1)],
        }),
      ).rejects.toThrow(/MAX_FILTER_RANGES/);
      // Only the first-response write, no REQUEST_UPDATE
      expect(written).toHaveLength(1);
    });

    it('counts the Ranges of filters that stay in place (§9.1.6 "concurrently")', async () => {
      const { session, written, requestId } = await openSubscribed();

      await session.sendRequestUpdate(requestId, true, {
        awaitAck: false,
        rangeFilters: [objectIdFilter(2)],
      });
      const other: RangeFilterDraft22 = {
        type: P.SUBGROUP_FILTER,
        setId: 0,
        ranges: [{ start: 0n, end: 1n }, { start: 3n }],
      };

      await expect(
        session.sendRequestUpdate(requestId, true, { awaitAck: false, rangeFilters: [other] }),
      ).rejects.toThrow(/MAX_FILTER_RANGES/);
      expect(written).toHaveLength(2);
    });

    it('frees the Ranges of a removed filter', async () => {
      const { session, written, requestId } = await openSubscribed();
      await session.sendRequestUpdate(requestId, true, {
        awaitAck: false,
        rangeFilters: [objectIdFilter(PEER_MAX_RANGES)],
      });

      await session.sendRequestUpdate(requestId, true, {
        awaitAck: false,
        rangeFilters: [{ type: P.OBJECTID_FILTER, ranges: [] }],
      });
      await session.sendRequestUpdate(requestId, true, {
        awaitAck: false,
        rangeFilters: [{ type: P.SUBGROUP_FILTER, setId: 0, ranges: [{ start: 1n }] }],
      });

      expect(written).toHaveLength(4);
    });

    it('replaces the Ranges of a filter with the same type and SetID', async () => {
      const { session, written, requestId } = await openSubscribed();
      await session.sendRequestUpdate(requestId, true, {
        awaitAck: false,
        rangeFilters: [objectIdFilter(PEER_MAX_RANGES)],
      });

      await session.sendRequestUpdate(requestId, true, {
        awaitAck: false,
        rangeFilters: [objectIdFilter(1)],
      });

      expect(written).toHaveLength(3);
    });
  });

  describe('CLIENT_SETUP (§9.1.6)', () => {
    it('carries no MAX_FILTER_RANGES: the default 0 means the peer sends no filters', async () => {
      const { session, internals } = makeSession();
      internals._state = 'none';
      const control: Uint8Array[] = [];
      internals.doSendControl = async (data) => { control.push(data); };
      internals.waitForServerSetupDraft18 = async () => undefined;

      await session.setup();

      expect(Draft18MessageCodec.decodeSetupStream(control[0])[0].maxFilterRanges).toBeUndefined();
    });
  });

  describe('draft-18', () => {
    it('refuses rangeFilters on SUBSCRIBE before sending', async () => {
      const { session, sent } = await makeRequestingSession({ draft: 'draft-18', peerMax: PEER_MAX_RANGES });

      await expect(session.subscribe(['ns'], 't', { rangeFilters: [objectIdFilter(1)] })).rejects.toThrow(/draft-22/);
      expect(sent).toHaveLength(0);
    });

    it('refuses rangeFilters on FETCH before sending', async () => {
      const { session, sent } = await makeRequestingSession({ draft: 'draft-18' });
      const range = { startGroup: 0, startObject: 0, endGroup: 1, endObject: 0 };

      await expect(session.fetch(['ns'], 't', range, { rangeFilters: [objectIdFilter(1)] })).rejects.toThrow(/draft-22/);
      expect(sent).toHaveLength(0);
    });

    it('refuses rangeFilters in a fill', async () => {
      const { session, sent } = await makeRequestingSession({ draft: 'draft-18' });

      await expect(
        session.subscribe(['ns'], 't', { fill: { lastGroups: 1, rangeFilters: [objectIdFilter(1)] } }),
      ).rejects.toThrow(/draft-22/);
      expect(sent).toHaveLength(0);
    });
  });
});

describe('draft-22 Range Filter errors reach the caller (§12.3)', () => {
  it.each([
    ['INVALID_FILTER', RequestErrorCodeDraft22.INVALID_FILTER],
    ['CONFLICTING_FILTERS', RequestErrorCodeDraft22.CONFLICTING_FILTERS],
  ])('rejects SUBSCRIBE with %s and its code', async (_name, code) => {
    const { session } = await makeRequestingSession({
      peerMax: PEER_MAX_RANGES,
      response: { type: MessageTypeDraft18.REQUEST_ERROR, requestId: 0n, errorCode: code, reasonPhrase: 'no' },
    });

    const failure = await session.subscribe(['ns'], 't', { rangeFilters: [objectIdFilter(1)] }).catch((e) => e);

    expect(failure).toBeInstanceOf(RequestRejectedError);
    expect(failure.errorCode).toBe(code);
    expect(failure.message).toMatch(/SUBSCRIBE failed: no/);
  });

  it('emits fetch-error with the code', async () => {
    const { session } = await makeRequestingSession({
      peerMax: PEER_MAX_RANGES,
      response: {
        type: MessageTypeDraft18.REQUEST_ERROR,
        requestId: 0n,
        errorCode: RequestErrorCodeDraft22.INVALID_FILTER,
        reasonPhrase: 'no',
      },
    });
    const errors: Array<{ errorCode: number }> = [];
    session.on('fetch-error', (e) => errors.push(e));

    await session.fetch(['ns'], 't', { startGroup: 0, startObject: 0, endGroup: 1, endObject: 0 }, {
      rangeFilters: [objectIdFilter(1)],
    });

    expect(errors.map((e) => e.errorCode)).toEqual([RequestErrorCodeDraft22.INVALID_FILTER]);
  });
});

describe('draft-22 Range Filters, publisher side (§9.1.6, §3.3.2)', () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  function installIncomingStream(session: MOQTSession) {
    const internals = session as unknown as Internals;
    internals.announcedNamespaces.set('ns', { namespace: ['ns'], options: {}, subscribers: new Map() });

    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const readable = new ReadableStream<Uint8Array>({ start: (c) => { controller = c; } });
    const written: Uint8Array[] = [];
    const closed = vi.fn();
    const writable = new WritableStream<Uint8Array>({ write: (chunk) => { written.push(chunk); }, close: closed });

    return {
      closed,
      send: (message: unknown) => controller.enqueue(internals.codec.encodeControlMessage(message)),
      open: () => internals.processIncomingBidiStream({ readable, writable }),
      replies: () => written.map((bytes) => internals.codec.decodeControlMessage(bytes)[0]),
    };
  }

  const subscribe = (extra: object = {}) => ({
    type: MessageTypeDraft18.SUBSCRIBE,
    requestId: PEER_REQUEST_ID,
    trackNamespace: ['ns'],
    trackName: 't',
    forwardState: true,
    ...extra,
  });

  // The request stream carries the Request ID, so REQUEST_ERROR has none on the wire
  const invalidFilter = {
    type: MessageTypeDraft18.REQUEST_ERROR,
    errorCode: RequestErrorCodeDraft22.INVALID_FILTER,
  };

  it('answers a SUBSCRIBE with Ranges with REQUEST_ERROR INVALID_FILTER', async () => {
    const { session, internals } = makeSession();
    const peer = installIncomingStream(session);
    peer.send(subscribe({ rangeFilters: [objectIdFilter(1)] }));

    await peer.open();

    expect(peer.replies()).toEqual([expect.objectContaining(invalidFilter)]);
    expect(peer.closed).toHaveBeenCalled();
    expect(internals.publicationManager.getByRequestId(PEER_REQUEST_ID)).toBeUndefined();
  });

  it('counts the Ranges in FILL_PARAMETERS', async () => {
    const { session } = makeSession();
    const peer = installIncomingStream(session);
    peer.send(subscribe({ fill: { rangeFilters: [objectIdFilter(1)] } }));

    await peer.open();

    expect(peer.replies()).toEqual([expect.objectContaining(invalidFilter)]);
  });

  it('answers a FETCH with Ranges with REQUEST_ERROR INVALID_FILTER', async () => {
    const { session } = makeSession();
    const peer = installIncomingStream(session);
    peer.send({
      type: MessageTypeDraft18.FETCH,
      requestId: PEER_REQUEST_ID,
      trackNamespace: ['ns'],
      trackName: 't',
      subscriberPriority: 128,
      groupOrder: 1,
      rangeFilters: [objectIdFilter(1)],
    });

    await peer.open();

    expect(peer.replies()).toEqual([expect.objectContaining(invalidFilter)]);
  });

  it('answers a SUBSCRIBE_TRACKS with Ranges with REQUEST_ERROR INVALID_FILTER', async () => {
    const { session } = makeSession();
    const peer = installIncomingStream(session);
    peer.send({
      type: MessageTypeDraft22.SUBSCRIBE_TRACKS,
      requestId: PEER_REQUEST_ID,
      trackNamespacePrefix: ['ns'],
      forwardState: true,
      rangeFilters: [{ type: P.TRACK_PROPERTY_FILTER, setId: 0, propertyType: 2n, ranges: [{ start: 1n }] }],
    });

    await peer.open();

    expect(peer.replies()).toEqual([expect.objectContaining(invalidFilter)]);
  });

  it('answers a REQUEST_UPDATE with Ranges with REQUEST_ERROR and keeps the request', async () => {
    const { session, internals } = makeSession();
    const peer = installIncomingStream(session);
    peer.send(subscribe());
    await peer.open();

    peer.send({ type: MessageTypeDraft18.REQUEST_UPDATE, requestId: PEER_UPDATE_ID, rangeFilters: [objectIdFilter(1)] });
    await tick();

    const replies = peer.replies();
    expect(replies[replies.length - 1]).toMatchObject({
      type: MessageTypeDraft18.REQUEST_ERROR,
      errorCode: RequestErrorCodeDraft22.INVALID_FILTER,
    });
    expect(internals.publicationManager.getByRequestId(PEER_REQUEST_ID)).toBeDefined();
  });

  it('accepts a REQUEST_UPDATE that only removes filters (zero Ranges)', async () => {
    const { session } = makeSession();
    const peer = installIncomingStream(session);
    peer.send(subscribe());
    await peer.open();

    peer.send({
      type: MessageTypeDraft18.REQUEST_UPDATE,
      requestId: PEER_UPDATE_ID,
      rangeFilters: [{ type: P.OBJECTID_FILTER, ranges: [] }],
    });
    await tick();

    const replies = peer.replies();
    expect(replies[replies.length - 1]).toMatchObject({ type: MessageTypeDraft18.REQUEST_OK });
  });

  it('still accepts a SUBSCRIBE without Ranges', async () => {
    const { session, internals } = makeSession();
    const peer = installIncomingStream(session);
    peer.send(subscribe());

    await peer.open();

    expect(internals.publicationManager.getByRequestId(PEER_REQUEST_ID)).toBeDefined();
  });
});
