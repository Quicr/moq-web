// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Draft-18 §10.2.10 EXPIRES, §10.2.13 NEW_GROUP_REQUEST, and §10.2.14
 * TRACK_NAMESPACE_PREFIX at the session layer.
 *
 * Complements the codec round-trips in `draft18-message-codec.test.ts` — these
 * tests confirm that:
 *
 *   • Publisher advertises `AnnounceOptions.expires` on outbound SUBSCRIBE_OK.
 *   • Publisher advertises `SubscribeNamespaceOptions.expires` on outbound
 *     REQUEST_OK for accepted incoming PUBLISH.
 *   • Subscriber's `sendRequestUpdate({ newGroupRequest })` puts the parameter
 *     on the REQUEST_UPDATE wire.
 *   • Incoming REQUEST_UPDATE carrying NEW_GROUP_REQUEST emits a typed event.
 *   • `subscribeTracks({ namespacePrefixParam })` encodes the parameter into
 *     the SUBSCRIBE_TRACKS parameter map.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  Draft18MessageCodec,
  IS_DRAFT_18,
  MOQTransport,
  MOQTVarInt,
  MessageTypeDraft18,
  RequestParameterDraft18,
  type ControlMessageDraft18,
  type RequestUpdateMessageDraft18,
  type SubscribeMessageDraft18,
  type SubscribeOkMessageDraft18,
  type SubscribeTracksMessageDraft18,
} from '@moq-web/core';

import { MOQTSession } from './session.js';
import type { NewGroupRequestEvent } from './types.js';

function makeSession(): MOQTSession {
  const transport = new MOQTransport();
  (transport as unknown as { close: typeof transport.close }).close = vi.fn().mockResolvedValue(undefined);
  const session = new MOQTSession(transport);
  (session as unknown as { _state: string })._state = 'ready';
  return session;
}

/**
 * Capture bytes written on an incoming SUBSCRIBE reply stream so we can decode
 * the outbound SUBSCRIBE_OK the session produced.
 */
function captureWritable(): { writable: WritableStream<Uint8Array>; chunks: Uint8Array[] } {
  const chunks: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk) { chunks.push(chunk); },
  });
  return { writable, chunks };
}

describe.skipIf(!IS_DRAFT_18)('draft-18 §10.2.10 EXPIRES on outbound SUBSCRIBE_OK', () => {
  it('carries AnnounceOptions.expires when a subscriber lands on the track', async () => {
    const session = makeSession();

    // Register an announced namespace with an expires hint.
    (session as unknown as { announcedNamespaces: Map<string, unknown> }).announcedNamespaces.set(
      'ns',
      {
        namespace: ['ns'],
        namespaceStr: 'ns',
        subscribers: new Map(),
        options: { expires: 5000 },
        acknowledged: true,
      },
    );

    const { writable, chunks } = captureWritable();
    const incoming: SubscribeMessageDraft18 = {
      type: MessageTypeDraft18.SUBSCRIBE,
      requestId: 3n,
      trackAlias: 0n,
      trackNamespace: ['ns'],
      trackName: 'video',
      subscriberPriority: 128,
      groupOrder: 1,
      forwardState: true,
      filter: 1,
      parameters: undefined,
    };

    await (session as unknown as {
      handleIncomingSubscribeDraft18: (m: SubscribeMessageDraft18, w: WritableStream<Uint8Array>) => Promise<void>;
    }).handleIncomingSubscribeDraft18(incoming, writable);

    expect(chunks.length).toBeGreaterThan(0);
    const [decoded] = Draft18MessageCodec.decode(chunks[0]);
    const ok = decoded as SubscribeOkMessageDraft18;
    expect(ok.type).toBe(MessageTypeDraft18.SUBSCRIBE_OK);
    expect(ok.expires).toBe(5000n);
  });

  it('omits EXPIRES when AnnounceOptions.expires is not set', async () => {
    const session = makeSession();
    (session as unknown as { announcedNamespaces: Map<string, unknown> }).announcedNamespaces.set(
      'ns',
      {
        namespace: ['ns'],
        namespaceStr: 'ns',
        subscribers: new Map(),
        options: {},
        acknowledged: true,
      },
    );

    const { writable, chunks } = captureWritable();
    const incoming: SubscribeMessageDraft18 = {
      type: MessageTypeDraft18.SUBSCRIBE,
      requestId: 4n,
      trackAlias: 0n,
      trackNamespace: ['ns'],
      trackName: 'video',
      subscriberPriority: 128,
      groupOrder: 1,
      forwardState: true,
      filter: 1,
      parameters: undefined,
    };

    await (session as unknown as {
      handleIncomingSubscribeDraft18: (m: SubscribeMessageDraft18, w: WritableStream<Uint8Array>) => Promise<void>;
    }).handleIncomingSubscribeDraft18(incoming, writable);

    const [decoded] = Draft18MessageCodec.decode(chunks[0]);
    const ok = decoded as SubscribeOkMessageDraft18;
    expect(ok.expires).toBeUndefined();
  });
});

describe.skipIf(!IS_DRAFT_18)('draft-18 §10.2.13 NEW_GROUP_REQUEST', () => {
  it("subscriber's sendRequestUpdate({ newGroupRequest: true }) encodes the parameter", async () => {
    const session = makeSession();

    const chunks: Uint8Array[] = [];
    const fakeStream = {
      write: async (bytes: Uint8Array) => { chunks.push(bytes); },
      readMessage: async () => ({
        type: MessageTypeDraft18.REQUEST_OK,
        requestId: 7n,
      } as ControlMessageDraft18),
    };
    (session as unknown as { activeRequestStreams: Map<number, typeof fakeStream> })
      .activeRequestStreams.set(7, fakeStream);

    await session.sendRequestUpdate(7, true, { newGroupRequest: true });

    expect(chunks.length).toBe(1);
    const [decoded] = Draft18MessageCodec.decode(chunks[0]);
    const update = decoded as RequestUpdateMessageDraft18;
    expect(update.type).toBe(MessageTypeDraft18.REQUEST_UPDATE);
    expect(update.forwardState).toBe(true);
    const ngrBytes = update.parameters?.get(RequestParameterDraft18.NEW_GROUP_REQUEST);
    expect(ngrBytes).toBeDefined();
    // `true` is normalised to varint(1).
    const [decodedValue] = MOQTVarInt.decode(ngrBytes!);
    expect(decodedValue).toBe(1n);
  });

  it('numeric newGroupRequest overrides the default varint value', async () => {
    const session = makeSession();

    const chunks: Uint8Array[] = [];
    const fakeStream = {
      write: async (bytes: Uint8Array) => { chunks.push(bytes); },
      readMessage: async () => ({
        type: MessageTypeDraft18.REQUEST_OK,
        requestId: 9n,
      } as ControlMessageDraft18),
    };
    (session as unknown as { activeRequestStreams: Map<number, typeof fakeStream> })
      .activeRequestStreams.set(9, fakeStream);

    await session.sendRequestUpdate(9, true, { newGroupRequest: 42 });

    const [decoded] = Draft18MessageCodec.decode(chunks[0]);
    const update = decoded as RequestUpdateMessageDraft18;
    const [value] = MOQTVarInt.decode(update.parameters!.get(RequestParameterDraft18.NEW_GROUP_REQUEST)!);
    expect(value).toBe(42n);
  });

  it('omits NEW_GROUP_REQUEST when option is absent or false', async () => {
    const session = makeSession();

    const chunks: Uint8Array[] = [];
    const fakeStream = {
      write: async (bytes: Uint8Array) => { chunks.push(bytes); },
      readMessage: async () => ({
        type: MessageTypeDraft18.REQUEST_OK,
        requestId: 11n,
      } as ControlMessageDraft18),
    };
    (session as unknown as { activeRequestStreams: Map<number, typeof fakeStream> })
      .activeRequestStreams.set(11, fakeStream);

    await session.sendRequestUpdate(11, false);
    await session.sendRequestUpdate(11, true, { newGroupRequest: false });

    expect(chunks.length).toBe(2);
    for (const c of chunks) {
      const [decoded] = Draft18MessageCodec.decode(c);
      const update = decoded as RequestUpdateMessageDraft18;
      expect(update.parameters?.get(RequestParameterDraft18.NEW_GROUP_REQUEST)).toBeUndefined();
    }
  });

  it('publisher emits new-group-request event when incoming REQUEST_UPDATE carries the parameter', async () => {
    const session = makeSession();

    // The REQUEST_UPDATE dispatcher looks up the request kind to decide which
    // subscription is being updated. Register the request as a subscribe.
    (session as unknown as { incomingRequestKinds: Map<number, string> })
      .incomingRequestKinds.set(21, 'subscribe');

    const events: NewGroupRequestEvent[] = [];
    session.on('new-group-request', (e) => events.push(e));

    const params = new Map<number, Uint8Array>();
    params.set(RequestParameterDraft18.NEW_GROUP_REQUEST, MOQTVarInt.encode(1n));

    const incoming: RequestUpdateMessageDraft18 = {
      type: MessageTypeDraft18.REQUEST_UPDATE,
      requestId: 21n,
      forwardState: true,
      parameters: params,
    };

    (session as unknown as {
      dispatchRequestUpdateDraft18: (m: RequestUpdateMessageDraft18) => void;
    }).dispatchRequestUpdateDraft18(incoming);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ requestId: 21, value: 1, forwardState: true });
  });

  it('does not emit new-group-request when parameter value is zero', async () => {
    const session = makeSession();
    (session as unknown as { incomingRequestKinds: Map<number, string> })
      .incomingRequestKinds.set(23, 'subscribe');

    const events: NewGroupRequestEvent[] = [];
    session.on('new-group-request', (e) => events.push(e));

    const params = new Map<number, Uint8Array>();
    params.set(RequestParameterDraft18.NEW_GROUP_REQUEST, MOQTVarInt.encode(0n));

    const incoming: RequestUpdateMessageDraft18 = {
      type: MessageTypeDraft18.REQUEST_UPDATE,
      requestId: 23n,
      forwardState: true,
      parameters: params,
    };

    (session as unknown as {
      dispatchRequestUpdateDraft18: (m: RequestUpdateMessageDraft18) => void;
    }).dispatchRequestUpdateDraft18(incoming);

    expect(events).toHaveLength(0);
  });
});

describe.skipIf(!IS_DRAFT_18)('draft-18 §10.2.14 TRACK_NAMESPACE_PREFIX on SUBSCRIBE_TRACKS', () => {
  it('encodes namespacePrefixParam as a namespace tuple in the parameter map', async () => {
    const session = makeSession();

    const chunks: Uint8Array[] = [];
    (session as unknown as {
      sendRequestAndWaitResponse: (bytes: Uint8Array, id: number) => Promise<ControlMessageDraft18>;
    }).sendRequestAndWaitResponse = async (bytes) => {
      chunks.push(bytes);
      return { type: MessageTypeDraft18.REQUEST_OK, requestId: 0n } as ControlMessageDraft18;
    };

    await session.subscribeTracks(['media'], undefined, {
      namespacePrefixParam: ['media', 'video', 'high'],
    });

    expect(chunks.length).toBeGreaterThan(0);
    const [decoded] = Draft18MessageCodec.decode(chunks[0]);
    const m = decoded as SubscribeTracksMessageDraft18;
    const paramBytes = m.parameters?.get(RequestParameterDraft18.TRACK_NAMESPACE_PREFIX);
    expect(paramBytes).toBeDefined();

    // Inline decode of the tuple: count | (len | utf-8)*
    const [count, off0] = MOQTVarInt.decode(paramBytes!);
    let offset = off0;
    const tuple: string[] = [];
    for (let i = 0; i < Number(count); i++) {
      const [len, next] = MOQTVarInt.decode(paramBytes!.subarray(offset));
      offset += next;
      const l = Number(len);
      tuple.push(new TextDecoder().decode(paramBytes!.subarray(offset, offset + l)));
      offset += l;
    }
    expect(tuple).toEqual(['media', 'video', 'high']);
  });

  it('merges namespacePrefixParam with caller-supplied parameters', async () => {
    const session = makeSession();

    const chunks: Uint8Array[] = [];
    (session as unknown as {
      sendRequestAndWaitResponse: (bytes: Uint8Array, id: number) => Promise<ControlMessageDraft18>;
    }).sendRequestAndWaitResponse = async (bytes) => {
      chunks.push(bytes);
      return { type: MessageTypeDraft18.REQUEST_OK, requestId: 0n } as ControlMessageDraft18;
    };

    // Pick an odd key (length-prefixed byte string) so we don't collide with
    // the §10.2 varint decoder logic and can prove pass-through survives.
    const passthroughKey = 0x51;
    const extra = new Map<number, Uint8Array>([
      [passthroughKey, new Uint8Array([0xde, 0xad])],
    ]);

    await session.subscribeTracks(['media'], undefined, {
      namespacePrefixParam: ['media', 'audio'],
      parameters: extra,
    });

    const [decoded] = Draft18MessageCodec.decode(chunks[0]);
    const m = decoded as SubscribeTracksMessageDraft18;
    expect(m.parameters?.has(RequestParameterDraft18.TRACK_NAMESPACE_PREFIX)).toBe(true);
    expect(m.parameters?.get(passthroughKey)).toEqual(new Uint8Array([0xde, 0xad]));
  });
});
