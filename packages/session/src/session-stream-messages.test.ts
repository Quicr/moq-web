// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Which messages may appear on a request stream (draft-22 §6.3, §9.5, §9.10;
 * draft-18 §3.3, §10.9): a stream begins with a request, and later messages
 * must suit the request's kind and who sent it. Anything else closes the
 * session with PROTOCOL_VIOLATION and changes no state.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  MOQTransport,
  MessageTypeDraft18,
  MessageTypeDraft22,
  SessionErrorCodeDraft18,
  SubscriptionFilterDraft18,
} from '@moq-web/core';

import { MOQTSession } from './session.js';

type Draft = 'draft-18' | 'draft-22';

const OWN_REQUEST_ID = 0n;
const PEER_REQUEST_ID = 1n;
const PEER_UPDATE_ID = 3n;
const PAUSED = 0;

interface Internals {
  codec: { encodeControlMessage: (m: unknown) => Uint8Array };
  announcedNamespaces: Map<string, unknown>;
  processIncomingBidiStream: (s: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }) => Promise<void>;
  publicationManager: {
    add: (p: unknown) => void;
    getByRequestId: (id: bigint) => { forward: number } | undefined;
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const violation = expect.objectContaining({ code: SessionErrorCodeDraft18.PROTOCOL_VIOLATION });

function makeSession(draft: Draft) {
  const transport = new MOQTransport({ draft });
  (transport as unknown as { close: typeof transport.close }).close = vi.fn().mockResolvedValue(undefined);
  const session = new MOQTSession(transport);
  (session as unknown as { _state: string })._state = 'ready';
  const internals = session as unknown as Internals;
  const close = vi.spyOn(session, 'close').mockResolvedValue(undefined);
  internals.announcedNamespaces.set('ns', { namespace: ['ns'], options: {}, subscribers: new Map() });

  return { session, internals, close };
}

/** A stream the peer opens to us; `send` plays the peer */
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

/** A stream we opened; `send` plays the peer's replies */
async function openOurStream(session: MOQTSession, internals: Internals, first: unknown, request: () => Promise<unknown>) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  (session as unknown as { transport: { createRequestStream: unknown } }).transport.createRequestStream =
    vi.fn().mockResolvedValue({
      readable: new ReadableStream<Uint8Array>({ start: (c) => { controller = c; } }),
      writable: new WritableStream<Uint8Array>(),
    });
  const send = (m: unknown) => controller.enqueue(internals.codec.encodeControlMessage(m));
  send(first);
  await request();

  return { send };
}

const subscribeOk = {
  type: MessageTypeDraft18.SUBSCRIBE_OK,
  requestId: OWN_REQUEST_ID,
  trackAlias: 1n,
  largestLocation: { group: 0n, object: 0n },
};
const requestOk = { type: MessageTypeDraft18.REQUEST_OK, requestId: OWN_REQUEST_ID };
const update = { type: MessageTypeDraft18.REQUEST_UPDATE, requestId: PEER_UPDATE_ID, forwardState: true };

function peerSubscribe(draft: Draft) {
  return {
    type: MessageTypeDraft18.SUBSCRIBE,
    requestId: PEER_REQUEST_ID,
    trackNamespace: ['ns'],
    trackName: 't',
    forwardState: true,
    ...(draft === 'draft-18' ? { filter: SubscriptionFilterDraft18.NEXT_GROUP_START } : {}),
  };
}

describe.each(['draft-18', 'draft-22'] as const)('first message of a peer stream (%s)', (draft) => {
  const notRequests: Array<[string, unknown]> = [
    ['GOAWAY', { type: MessageTypeDraft18.GOAWAY, newSessionUri: 'https://x.example/moq', timeout: 0n }],
    ['REQUEST_UPDATE', update],
    ['PUBLISH_DONE', {
      type: MessageTypeDraft18.PUBLISH_DONE,
      requestId: 0n,
      finalLocation: { group: 0n, object: 0n },
      statusCode: 0n,
      streamCount: 0n,
    }],
    ['REQUEST_OK', { type: MessageTypeDraft18.REQUEST_OK, requestId: PEER_REQUEST_ID }],
  ];

  it.each(notRequests)('closes the session on %s and moves nothing', async (_name, first) => {
    const { session, internals, close } = makeSession(draft);
    const goaways: unknown[] = [];
    session.on('goaway', (e) => goaways.push(e));

    await openPeerStream(internals, first).opened;

    expect(close).toHaveBeenCalledWith(violation);
    expect(goaways).toHaveLength(0);
    expect(session.state).toBe('ready');
  });

  it('closes the session on PUBLISH_STATE_NOTIFY', async () => {
    const { internals, close } = makeSession('draft-22');

    await openPeerStream(internals, { type: MessageTypeDraft22.PUBLISH_STATE_NOTIFY, forwardState: false }).opened;

    expect(close).toHaveBeenCalledWith(violation);
  });

  it('does not resume paused publications on a stray REQUEST_UPDATE', async () => {
    const { internals, close } = makeSession(draft);
    internals.publicationManager.add({
      trackAlias: 9n, namespace: ['other'], trackName: 'x', priority: 128, deliveryMode: 'stream',
      audioDeliveryMode: 'datagram', requestId: 8n, cleanupHandlers: [], forward: PAUSED,
    });

    await openPeerStream(internals, update).opened;

    expect(close).toHaveBeenCalledWith(violation);
    expect(internals.publicationManager.getByRequestId(8n)?.forward).toBe(PAUSED);
  });
});

describe.each(['draft-18', 'draft-22'] as const)('later messages on a request stream (%s)', (draft) => {
  it('close the session on a REQUEST_UPDATE for a SUBSCRIBE of ours', async () => {
    const { session, internals, close } = makeSession(draft);
    const { send } = await openOurStream(session, internals, subscribeOk, () => session.subscribe(['ns'], 't'));

    send({ ...update, requestId: PEER_UPDATE_ID });
    await tick();

    expect(close).toHaveBeenCalledWith(violation);
  });

  it('close the session on a REQUEST_UPDATE for a PUBLISH_NAMESPACE of ours', async () => {
    const { session, internals, close } = makeSession(draft);
    const { send } = await openOurStream(session, internals, requestOk, () => session.announceNamespace(['room']));

    send(update);
    await tick();

    expect(close).toHaveBeenCalledWith(violation);
  });

  it('close the session on a PUBLISH_DONE for a SUBSCRIBE_NAMESPACE of ours', async () => {
    const { session, internals, close } = makeSession(draft);
    const { send } = await openOurStream(session, internals, requestOk, () => session.subscribeNamespace(['room']));

    send({
      type: MessageTypeDraft18.PUBLISH_DONE,
      requestId: 0n,
      finalLocation: { group: 0n, object: 0n },
      statusCode: 0n,
      streamCount: 0n,
    });
    await tick();

    expect(close).toHaveBeenCalledWith(violation);
  });

  it('close the session on PUBLISH_STATE_NOTIFY from a subscriber', async () => {
    if (draft !== 'draft-22') {
      return;
    }
    const { internals, close } = makeSession(draft);
    const peer = openPeerStream(internals, peerSubscribe(draft));
    await peer.opened;

    peer.send({ type: MessageTypeDraft22.PUBLISH_STATE_NOTIFY, forwardState: false });
    await tick();

    expect(close).toHaveBeenCalledWith(violation);
  });

  it('accept a REQUEST_UPDATE for a SUBSCRIBE the peer sent', async () => {
    const { internals, close } = makeSession(draft);
    const peer = openPeerStream(internals, peerSubscribe(draft));
    await peer.opened;

    peer.send({ ...update, forwardState: false });
    await tick();

    expect(close).not.toHaveBeenCalled();
    expect(internals.publicationManager.getByRequestId(PEER_REQUEST_ID)?.forward).toBe(PAUSED);
  });
});
