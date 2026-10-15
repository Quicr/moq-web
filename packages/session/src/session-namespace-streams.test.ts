// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Namespace requests ride request streams (draft-22 §4, §3.6; draft-18 §6).
 * Cancelling one ends its stream; the response stream is checked as it is
 * read (§4.2); TRACK_STATUS has its own stream (§9.13).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  MOQTransport,
  MessageTypeDraft18,
  SessionErrorCodeDraft18,
  TrackStatusCode,
  type ControlMessageDraft18,
} from '@moq-web/core';

import { MOQTSession } from './session.js';

type Draft = 'draft-18' | 'draft-22';

const REQUEST_ID = 0n;
const NAMESPACE_SUFFIX = ['room', 'alice'];
const LARGEST_GROUP = 7n;
const LARGEST_OBJECT = 3n;

interface Internals {
  codec: {
    encodeControlMessage: (m: unknown) => Uint8Array;
    decodeControlMessage: (b: Uint8Array) => [ControlMessageDraft18, number];
  };
  doSendControl: (b: Uint8Array) => Promise<void>;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function makeSession(draft: Draft) {
  const transport = new MOQTransport({ draft });
  (transport as unknown as { close: typeof transport.close }).close = vi.fn().mockResolvedValue(undefined);
  const session = new MOQTSession(transport);
  (session as unknown as { _state: string })._state = 'ready';
  const internals = session as unknown as Internals;
  const close = vi.spyOn(session, 'close').mockResolvedValue(undefined);
  const sendControl = vi.fn().mockResolvedValue(undefined);
  internals.doSendControl = sendControl;

  return { session, internals, close, sendControl };
}

/** The request stream the next request opens: `send` plays the peer, `written` is what we wrote. */
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
  const aborted = vi.fn();
  const writable = new WritableStream<Uint8Array>({
    write: (chunk) => {
      written.push(chunk);
    },
    abort: aborted,
  });
  const transport = (session as unknown as { transport: { createRequestStream: unknown } }).transport;
  transport.createRequestStream = vi.fn().mockResolvedValue({ readable, writable });
  const internals = session as unknown as Internals;

  return {
    written,
    cancelled,
    aborted,
    send: (message: unknown) => controller.enqueue(internals.codec.encodeControlMessage(message)),
    fin: () => controller.close(),
  };
}

const requestOk = { type: MessageTypeDraft18.REQUEST_OK, requestId: REQUEST_ID };

describe.each(['draft-18', 'draft-22'] as const)('cancelling namespace requests (%s)', (draft) => {
  it('ends the SUBSCRIBE_NAMESPACE stream instead of sending UNSUBSCRIBE_NAMESPACE', async () => {
    const { session, sendControl } = makeSession(draft);
    const peer = installPeerStream(session);
    peer.send(requestOk);
    const subscriptionId = await session.subscribeNamespace(['room']);
    await tick();

    await session.unsubscribeNamespace(subscriptionId);

    expect(peer.cancelled).toHaveBeenCalled();
    expect(peer.aborted).toHaveBeenCalled();
    expect(sendControl).not.toHaveBeenCalled();
    expect(session.getNamespaceSubscriptions()).toHaveLength(0);
  });

  it('ends the PUBLISH_NAMESPACE stream instead of sending PUBLISH_NAMESPACE_CANCEL', async () => {
    const { session, sendControl } = makeSession(draft);
    const peer = installPeerStream(session);
    peer.send(requestOk);
    await session.announceNamespace(['room']);

    await session.cancelAnnounce(['room']);

    expect(peer.cancelled).toHaveBeenCalled();
    expect(peer.aborted).toHaveBeenCalled();
    expect(sendControl).not.toHaveBeenCalled();
    expect(session.getAnnouncedNamespaces()).toHaveLength(0);
  });

  it('asks for track status on its own request stream', async () => {
    const { session, internals, sendControl } = makeSession(draft);
    const peer = installPeerStream(session);
    peer.send({ ...requestOk, largestLocation: { group: LARGEST_GROUP, object: LARGEST_OBJECT } });

    const status = await session.requestTrackStatus(['room'], 'video');

    expect(sendControl).not.toHaveBeenCalled();
    expect(internals.codec.decodeControlMessage(peer.written[0])[0].type).toBe(MessageTypeDraft18.TRACK_STATUS);
    expect(status.statusCode).toBe(TrackStatusCode.IN_PROGRESS);
    expect(status.lastGroupId).toBe(LARGEST_GROUP);
    expect(status.lastObjectId).toBe(LARGEST_OBJECT);
  });
});

describe.each(['draft-18', 'draft-22'] as const)('namespace response stream (%s)', (draft) => {
  const violation = expect.objectContaining({ code: SessionErrorCodeDraft18.PROTOCOL_VIOLATION });

  async function subscribed() {
    const harness = makeSession(draft);
    const peer = installPeerStream(harness.session);
    const events = { announced: [] as string[][], done: [] as string[][] };
    harness.session.on('namespace-announced', (e) => events.announced.push((e as { namespace: string[] }).namespace));
    harness.session.on('namespace-done', (e) => events.done.push((e as { namespace: string[] }).namespace));
    await harness.session.subscribeNamespace(['room']);

    return { ...harness, peer, events };
  }

  it('closes the session when the first message is not a response', async () => {
    const { close, peer } = await subscribed();

    peer.send({
      type: MessageTypeDraft18.NAMESPACE,
      trackNamespace: NAMESPACE_SUFFIX,
    });
    await tick();

    expect(close).toHaveBeenCalledWith(violation);
  });

  it('closes the session on a NAMESPACE_DONE that follows no NAMESPACE', async () => {
    const { close, peer } = await subscribed();

    peer.send(requestOk);
    peer.send({ type: MessageTypeDraft18.NAMESPACE_DONE, finalNamespace: NAMESPACE_SUFFIX });
    await tick();

    expect(close).toHaveBeenCalledWith(violation);
  });

  it('reports a NAMESPACE and its NAMESPACE_DONE under the subscribed prefix', async () => {
    const { close, peer, events } = await subscribed();

    peer.send(requestOk);
    peer.send({ type: MessageTypeDraft18.NAMESPACE, trackNamespace: NAMESPACE_SUFFIX });
    peer.send({ type: MessageTypeDraft18.NAMESPACE_DONE, finalNamespace: NAMESPACE_SUFFIX });
    await tick();

    expect(close).not.toHaveBeenCalled();
    expect(events.announced).toEqual([['room', ...NAMESPACE_SUFFIX]]);
    expect(events.done).toEqual([['room', ...NAMESPACE_SUFFIX]]);
  });

  it('treats each active namespace as done when the stream ends', async () => {
    const { session, peer, events } = await subscribed();

    peer.send(requestOk);
    peer.send({ type: MessageTypeDraft18.NAMESPACE, trackNamespace: NAMESPACE_SUFFIX });
    await tick();
    peer.fin();
    await tick();

    expect(events.done).toEqual([['room', ...NAMESPACE_SUFFIX]]);
    expect(session.getNamespaceSubscriptions()).toHaveLength(0);
  });

  it('closes the session when SUBSCRIBE_TRACKS gets a non-response first', async () => {
    const { session, close } = makeSession(draft);
    const peer = installPeerStream(session);
    peer.send({
      type: MessageTypeDraft18.SUBSCRIBE_OK,
      requestId: REQUEST_ID,
      trackAlias: 1n,
      largestLocation: { group: 0n, object: 0n },
    });

    await expect(session.subscribeTracks(['room'])).rejects.toThrow();

    expect(close).toHaveBeenCalledWith(violation);
  });
});
