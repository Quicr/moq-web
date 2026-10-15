// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Subscriber-side state (draft-22 §3.1.2-3.1.3, draft-18 §5.1, §11.1): a
 * Track Alias exists only once the publisher sends one, a failed or ended
 * request leaves no subscription behind, an alias names one Track, and
 * draft-18 allows one subscription per Track and role.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  MOQTransport,
  MessageTypeDraft18,
  MessageTypeDraft22,
  MOQTVarInt,
  RequestParameterDraft18,
  TrackPropertyDraft18,
  PublishDoneErrorCodeDraft18,
  RequestErrorCodeDraft18,
  SessionErrorCodeDraft18,
  SubscriptionFilterDraft18,
  type ControlMessageDraft18,
  type RequestErrorMessageDraft18,
} from '@moq-web/core';

import { MOQTSession } from './session.js';
import { RequestRejectedError } from './request-rejected-error.js';

type Draft = 'draft-18' | 'draft-22';

const OWN_REQUEST_ID = 0n;
const PEER_REQUEST_ID = 1n;
const ALIAS = 7n;

interface Internals {
  codec: {
    encodeControlMessage: (m: unknown) => Uint8Array;
    decodeControlMessage: (b: Uint8Array) => [ControlMessageDraft18, number];
  };
  announcedNamespaces: Map<string, unknown>;
  subscriptionManager: { getByAlias: (alias: bigint) => unknown };
  processIncomingBidiStream: (s: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }) => Promise<void>;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const violation = (code: SessionErrorCodeDraft18) => expect.objectContaining({ code });

function makeSession(draft: Draft) {
  const transport = new MOQTransport({ draft });
  (transport as unknown as { close: typeof transport.close }).close = vi.fn().mockResolvedValue(undefined);
  const session = new MOQTSession(transport);
  (session as unknown as { _state: string })._state = 'ready';
  const internals = session as unknown as Internals;
  const close = vi.spyOn(session, 'close').mockResolvedValue(undefined);

  return { session, internals, close };
}

/** The stream our next request opens: `send` plays the peer, `reset` and `fin` end it */
function ourStream(session: MOQTSession, internals: Internals) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancelled = vi.fn();
  const written: Uint8Array[] = [];
  (session as unknown as { transport: { createRequestStream: unknown } }).transport.createRequestStream =
    vi.fn().mockResolvedValue({
      readable: new ReadableStream<Uint8Array>({ start: (c) => { controller = c; }, cancel: cancelled }),
      writable: new WritableStream<Uint8Array>({ write: (chunk) => { written.push(chunk); } }),
    });

  return {
    cancelled,
    written,
    send: (m: unknown) => controller.enqueue(internals.codec.encodeControlMessage(m)),
    fin: () => controller.close(),
    reset: () => controller.error(new Error('reset')),
  };
}

function peerStream(internals: Internals, first: unknown) {
  const written: Uint8Array[] = [];
  const readable = new ReadableStream<Uint8Array>({
    start: (c) => { c.enqueue(internals.codec.encodeControlMessage(first)); },
  });
  const writable = new WritableStream<Uint8Array>({ write: (chunk) => { written.push(chunk); } });
  const opened = internals.processIncomingBidiStream({ readable, writable });

  return { opened, replies: () => written.map((b) => internals.codec.decodeControlMessage(b)[0]) };
}

const subscribeOk = (alias = ALIAS, requestId = OWN_REQUEST_ID) => ({
  type: MessageTypeDraft18.SUBSCRIBE_OK,
  requestId,
  trackAlias: alias,
  largestLocation: { group: 0n, object: 0n },
});

const peerPublish = (draft: Draft, trackName: string, alias: bigint, requestId = PEER_REQUEST_ID) => ({
  type: draft === 'draft-22' ? MessageTypeDraft22.PUBLISH : MessageTypeDraft18.PUBLISH,
  requestId,
  trackAlias: alias,
  trackNamespace: ['ns'],
  trackName,
  forwardState: true,
  ...(draft === 'draft-18' ? { largestLocation: { group: 0n, object: 0n } } : {}),
});

describe.each(['draft-18', 'draft-22'] as const)('subscriber state (%s)', (draft) => {
  it('has no Track Alias until the publisher sends one', async () => {
    const { session, internals } = makeSession(draft);
    const stream = ourStream(session, internals);

    const subscribing = session.subscribe(['ns'], 't');
    await tick();

    expect(internals.subscriptionManager.getByAlias(OWN_REQUEST_ID)).toBeUndefined();
    stream.send(subscribeOk());
    const subscriptionId = await subscribing;
    expect(session.getSubscription(subscriptionId)?.trackAlias).toBe(ALIAS);
    expect(internals.subscriptionManager.getByAlias(OWN_REQUEST_ID)).toBeUndefined();
  });

  it('is dropped when the SUBSCRIBE is refused', async () => {
    const { session, internals } = makeSession(draft);
    const stream = ourStream(session, internals);
    stream.send({
      type: MessageTypeDraft18.REQUEST_ERROR,
      requestId: OWN_REQUEST_ID,
      errorCode: RequestErrorCodeDraft18.DOES_NOT_EXIST,
      reasonPhrase: 'no',
    });

    await expect(session.subscribe(['ns'], 't')).rejects.toBeInstanceOf(RequestRejectedError);

    expect(session.getSubscriptions()).toHaveLength(0);
  });

  it('asks for a new Group with the largest known plus 1, only on a DYNAMIC_GROUPS track', async () => {
    const { session, internals } = makeSession(draft);
    const stream = ourStream(session, internals);
    stream.send({
      ...subscribeOk(),
      largestLocation: { group: 9n, object: 2n },
      trackProperties: new Map([[TrackPropertyDraft18.DYNAMIC_GROUPS, MOQTVarInt.encode(1n)]]),
    });
    const subscriptionId = await session.subscribe(['ns'], 't');

    await session.sendRequestUpdate(OWN_REQUEST_ID, true, { newGroupRequest: true, awaitAck: false });

    const update = internals.codec.decodeControlMessage(stream.written[stream.written.length - 1])[0] as unknown as {
      parameters: Map<number, Uint8Array>;
    };
    expect(MOQTVarInt.decode(update.parameters.get(RequestParameterDraft18.NEW_GROUP_REQUEST)!)[0]).toBe(10n);
    expect(session.getSubscription(subscriptionId)).toBeDefined();
  });

  describe.each([['FIN', 'closed'], ['reset', 'reset']] as const)('when the stream ends by %s before PUBLISH_DONE', (_name, how) => {
    it('drops the subscription and reports it ended', async () => {
      const { session, internals } = makeSession(draft);
      const stream = ourStream(session, internals);
      stream.send(subscribeOk());
      await session.subscribe(['ns'], 't');
      const ended: Array<{ statusCode?: number }> = [];
      session.on('publish-done', (e) => ended.push(e));

      if (how === 'closed') {
        stream.fin();
      } else {
        stream.reset();
      }
      await tick();

      expect(session.getSubscriptions()).toHaveLength(0);
      expect(ended).toHaveLength(1);
      expect(ended[0].statusCode).toBe(PublishDoneErrorCodeDraft18.INTERNAL_ERROR);
    });
  });
});

describe.each(['draft-18', 'draft-22'] as const)('Track Aliases (%s)', (draft) => {
  it('close the session when SUBSCRIBE_OK reuses the alias of another track', async () => {
    const { session, internals, close } = makeSession(draft);
    const first = ourStream(session, internals);
    first.send(subscribeOk());
    await session.subscribe(['ns'], 'a');
    const second = ourStream(session, internals);
    second.send(subscribeOk(ALIAS, 2n));

    await expect(session.subscribe(['ns'], 'b')).rejects.toThrow();

    expect(close).toHaveBeenCalledWith(violation(SessionErrorCodeDraft18.DUPLICATE_TRACK_ALIAS));
  });

  it('close the session when a PUBLISH reuses the alias of another track, without accepting it', async () => {
    const { session, internals, close } = makeSession(draft);
    const stream = ourStream(session, internals);
    stream.send(subscribeOk());
    await session.subscribe(['ns'], 'a');
    ourStream(session, internals).send(requestOk());
    await session.subscribeNamespace(['ns']);

    const peer = peerStream(internals, peerPublish(draft, 'b', ALIAS));
    await peer.opened;

    expect(close).toHaveBeenCalledWith(violation(SessionErrorCodeDraft18.DUPLICATE_TRACK_ALIAS));
    expect(peer.replies()).toHaveLength(0);
  });
});

function requestOk() {
  return { type: MessageTypeDraft18.REQUEST_OK, requestId: 2n };
}

describe('draft-18 one subscription per Track and role (§5.1)', () => {
  async function withNamespaceSubscription() {
    const harness = makeSession('draft-18');
    const { session, internals } = harness;
    ourStream(session, internals).send({ type: MessageTypeDraft18.REQUEST_OK, requestId: OWN_REQUEST_ID });
    await session.subscribeNamespace(['ns']);

    return harness;
  }

  it('refuses a PUBLISH for a Track we are subscribed to', async () => {
    const { session, internals } = await withNamespaceSubscription();
    ourStream(session, internals).send(subscribeOk(ALIAS, 2n));
    await session.subscribe(['ns', 'cam'], 'video');

    const peer = peerStream(internals, { ...peerPublish('draft-18', 'video', 9n), trackNamespace: ['ns', 'cam'] });
    await peer.opened;

    expect(peer.replies()).toEqual([expect.objectContaining({
      type: MessageTypeDraft18.REQUEST_ERROR,
      errorCode: RequestErrorCodeDraft18.DUPLICATE_SUBSCRIPTION,
    } satisfies Partial<RequestErrorMessageDraft18>)]);
    expect(session.getSubscriptions()).toHaveLength(1);
  });

  it('ends our pending SUBSCRIBE before accepting a PUBLISH for the same Track', async () => {
    const { session, internals } = await withNamespaceSubscription();
    const pending = ourStream(session, internals);
    const subscribing = session.subscribe(['ns', 'cam'], 'video');
    subscribing.catch(() => {});
    await tick();

    const peer = peerStream(internals, { ...peerPublish('draft-18', 'video', 9n), trackNamespace: ['ns', 'cam'] });
    await peer.opened;

    expect(pending.cancelled).toHaveBeenCalled();
    expect(peer.replies()[0]).toMatchObject({ type: MessageTypeDraft18.REQUEST_OK });
    await expect(subscribing).rejects.toThrow();
  });

  it('refuses a SUBSCRIBE for a Track we already publish', async () => {
    const { session, internals } = makeSession('draft-18');
    internals.announcedNamespaces.set('ns', { namespace: ['ns'], options: {}, subscribers: new Map() });
    const subscribe = (requestId: bigint) => ({
      type: MessageTypeDraft18.SUBSCRIBE,
      requestId,
      trackNamespace: ['ns'],
      trackName: 't',
      forwardState: true,
      filter: SubscriptionFilterDraft18.NEXT_GROUP_START,
    });
    await peerStream(internals, subscribe(PEER_REQUEST_ID)).opened;

    const second = peerStream(internals, subscribe(3n));
    await second.opened;

    expect(second.replies()).toEqual([expect.objectContaining({
      type: MessageTypeDraft18.REQUEST_ERROR,
      errorCode: RequestErrorCodeDraft18.DUPLICATE_SUBSCRIPTION,
    })]);
    expect(session.getSubscribers(['ns'])).toHaveLength(1);
  });
});
