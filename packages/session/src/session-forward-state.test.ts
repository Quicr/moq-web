// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Forward State (draft-22 §3.1.1, §9.20.18; draft-18 §5.1, §10.2.12): the
 * initiator sets the initial state in SUBSCRIBE or PUBLISH, an omitted value
 * is 1 (unchanged in a REQUEST_UPDATE), and a paused subscription gets no
 * Objects.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  MOQTransport,
  MessageTypeDraft18,
  MessageTypeDraft22,
  RequestParameterDraft18,
  SubscriptionFilterDraft18,
} from '@moq-web/core';

import { MOQTSession } from './session.js';

type Draft = 'draft-18' | 'draft-22';

const OWN_REQUEST_ID = 0n;
const PEER_REQUEST_ID = 1n;
const FIRST_UPDATE_ID = 3n;
const PAUSED = 0;
const FORWARDING = 1;
const OBJECT = { groupId: 1, objectId: 0, type: 'video' as const };

interface Internals {
  codec: { encodeControlMessage: (m: unknown) => Uint8Array };
  announcedNamespaces: Map<string, unknown>;
  processIncomingBidiStream: (s: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }) => Promise<void>;
  publicationManager: { getByRequestId: (id: bigint) => { forward: number } | undefined };
  sendSubgroupObject: (...args: unknown[]) => Promise<void>;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function makeSession(draft: Draft) {
  const transport = new MOQTransport({ draft });
  (transport as unknown as { close: typeof transport.close }).close = vi.fn().mockResolvedValue(undefined);
  const session = new MOQTSession(transport);
  (session as unknown as { _state: string })._state = 'ready';
  const internals = session as unknown as Internals;
  internals.announcedNamespaces.set('ns', { namespace: ['ns'], options: {}, subscribers: new Map() });

  return { session, internals };
}

function openPeerStream(internals: Internals, first: unknown) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const readable = new ReadableStream<Uint8Array>({
    start: (c) => {
      controller = c;
      c.enqueue(internals.codec.encodeControlMessage(first));
    },
  });
  const opened = internals.processIncomingBidiStream({ readable, writable: new WritableStream<Uint8Array>() });

  return { opened, send: (m: unknown) => controller.enqueue(internals.codec.encodeControlMessage(m)) };
}

/** The stream our next request opens; `send` plays the peer's replies */
function ourStream(session: MOQTSession, internals: Internals) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  (session as unknown as { transport: { createRequestStream: unknown } }).transport.createRequestStream =
    vi.fn().mockResolvedValue({
      readable: new ReadableStream<Uint8Array>({ start: (c) => { controller = c; } }),
      writable: new WritableStream<Uint8Array>(),
    });

  return { send: (m: unknown) => controller.enqueue(internals.codec.encodeControlMessage(m)) };
}

function peerSubscribe(draft: Draft, forwardState: boolean) {
  return {
    type: MessageTypeDraft18.SUBSCRIBE,
    requestId: PEER_REQUEST_ID,
    trackNamespace: ['ns'],
    trackName: 't',
    forwardState,
    ...(draft === 'draft-18' ? { filter: SubscriptionFilterDraft18.NEXT_GROUP_START } : {}),
  };
}

describe.each(['draft-18', 'draft-22'] as const)('publisher side (%s)', (draft) => {
  it('starts a SUBSCRIBE with FORWARD=0 paused and sends it no Objects', async () => {
    const { session, internals } = makeSession(draft);
    await openPeerStream(internals, peerSubscribe(draft, false)).opened;
    const alias = (session.getSubscribers(['ns'])[0]).trackAlias;
    const send = vi.spyOn(internals, 'sendSubgroupObject');

    await session.sendObject(alias, new Uint8Array([1]), OBJECT);

    expect(internals.publicationManager.getByRequestId(PEER_REQUEST_ID)?.forward).toBe(PAUSED);
    expect(send).not.toHaveBeenCalled();
  });

  it('starts a SUBSCRIBE without FORWARD forwarding', async () => {
    const { internals } = makeSession(draft);

    await openPeerStream(internals, peerSubscribe(draft, true)).opened;

    expect(internals.publicationManager.getByRequestId(PEER_REQUEST_ID)?.forward).toBe(FORWARDING);
  });

  it('does not resume a paused publication on a REQUEST_UPDATE without FORWARD', async () => {
    const { internals } = makeSession(draft);
    const peer = openPeerStream(internals, peerSubscribe(draft, false));
    await peer.opened;

    peer.send({
      type: MessageTypeDraft18.REQUEST_UPDATE,
      requestId: FIRST_UPDATE_ID,
      parameters: new Map([[RequestParameterDraft18.SUBSCRIBER_PRIORITY, Uint8Array.of(9)]]),
    });
    await tick();

    expect(internals.publicationManager.getByRequestId(PEER_REQUEST_ID)?.forward).toBe(PAUSED);
  });

  it('starts our PUBLISH forwarding, so the first pause is a change', async () => {
    const { session, internals } = makeSession(draft);
    const { send } = ourStream(session, internals);
    send({ type: MessageTypeDraft18.REQUEST_OK, requestId: OWN_REQUEST_ID });
    await session.publish(['other'], 'video');
    const changes: unknown[] = [];
    session.on('forward-state-change', (e) => changes.push(e));
    expect(internals.publicationManager.getByRequestId(OWN_REQUEST_ID)?.forward).toBe(FORWARDING);

    send({ type: MessageTypeDraft18.REQUEST_UPDATE, requestId: FIRST_UPDATE_ID, forwardState: false });
    await tick();

    expect(changes).toEqual([{ trackAlias: expect.anything(), forward: PAUSED }]);
  });
});

describe('draft-18 PUBLISH_OK', () => {
  it('pauses our PUBLISH when it carries FORWARD=0', async () => {
    const { session, internals } = makeSession('draft-18');
    const { send } = ourStream(session, internals);
    send({ type: MessageTypeDraft18.REQUEST_OK, requestId: OWN_REQUEST_ID, forwardState: false });

    await session.publish(['other'], 'video');

    expect(internals.publicationManager.getByRequestId(OWN_REQUEST_ID)?.forward).toBe(PAUSED);
  });
});

describe('draft-22 subscriber side', () => {
  it('records a PUBLISH with FORWARD=0 as paused', async () => {
    const { session, internals } = makeSession('draft-22');
    ourStream(session, internals);
    await session.subscribeNamespace(['ns']);
    const incoming: Array<{ subscriptionId: number }> = [];
    session.on('incoming-publish', (e) => incoming.push(e));

    await openPeerStream(internals, {
      type: MessageTypeDraft22.PUBLISH,
      requestId: PEER_REQUEST_ID,
      trackAlias: 9n,
      trackNamespace: ['ns', 'cam'],
      trackName: 'video',
      forwardState: false,
    }).opened;

    expect(session.isSubscriptionPaused(incoming[0].subscriptionId)).toBe(true);
  });

  it('follows PUBLISH_STATE_NOTIFY on a subscription', async () => {
    const { session, internals } = makeSession('draft-22');
    const { send } = ourStream(session, internals);
    send({
      type: MessageTypeDraft18.SUBSCRIBE_OK,
      requestId: OWN_REQUEST_ID,
      trackAlias: 1n,
      largestLocation: { group: 0n, object: 0n },
    });
    const subscriptionId = await session.subscribe(['ns'], 't');

    send({ type: MessageTypeDraft22.PUBLISH_STATE_NOTIFY, forwardState: false });
    await tick();

    expect(session.isSubscriptionPaused(subscriptionId)).toBe(true);
  });
});
