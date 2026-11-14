// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Draft-23 SUBSCRIBE_TRACKS: a PUBLISH that answers one names it with
 * SUBSCRIBE_TRACKS_ID, for a Track under its prefix not yet published for it
 * (§9.19.21, §9.5.2). Cancelling a SUBSCRIBE_TRACKS does not end the
 * subscriptions it led to (§9.18).
 */

import { describe, it, expect } from 'vitest';
import {
  MessageTypeDraft18,
  RequestErrorCodeDraft18,
  type PublishMessageDraft22,
} from '@moq-web/core';

import { makeSession, openIncoming, tick } from './__tests__/incoming-peer.js';

const PEER_REQUEST = 1n;

interface Internals {
  codec: { decodeControlMessage: (b: Uint8Array) => [unknown, number] };
  sendRequestAndWaitResponse: (bytes: Uint8Array, requestId: bigint, kind: string) => Promise<unknown>;
  publicationManager: { getByTrackName: (ns: string[], name: string) => unknown };
  subscriptionManager: { getByTrackName: (ns: string[], name: string) => unknown };
  abortRequestStream: (id: bigint) => Promise<void>;
}

/** A draft-23 session the peer sent SUBSCRIBE_TRACKS for `room` to, whose PUBLISHes get `answer` */
async function asked(answer: () => unknown = () => ({ type: MessageTypeDraft18.REQUEST_OK, requestId: 0n })) {
  const { session, internals } = makeSession('draft-23');
  const hooks = session as unknown as Internals;
  const published: PublishMessageDraft22[] = [];
  hooks.sendRequestAndWaitResponse = async (bytes) => {
    published.push(hooks.codec.decodeControlMessage(bytes)[0] as PublishMessageDraft22);
    return answer();
  };
  const peer = openIncoming(internals, {
    type: MessageTypeDraft18.SUBSCRIBE_TRACKS,
    requestId: PEER_REQUEST,
    trackNamespacePrefix: ['room'],
    forwardState: true,
  });
  await peer.opened;

  return { session, hooks, peer, published };
}

describe('PUBLISH answering a SUBSCRIBE_TRACKS (draft-23)', () => {
  it('carries SUBSCRIBE_TRACKS_ID', async () => {
    const { session, published } = await asked();

    await session.publish(['room', 'a'], 'video', { subscribeTracksId: PEER_REQUEST });

    expect(published[0].subscribeTracksId).toBe(PEER_REQUEST);
  });

  it('is refused for a Track already published for that SUBSCRIBE_TRACKS', async () => {
    const { session, published } = await asked();
    await session.publish(['room', 'a'], 'video', { subscribeTracksId: PEER_REQUEST });

    await expect(session.publish(['room', 'a'], 'video', { subscribeTracksId: PEER_REQUEST })).rejects.toThrow(/already-published/);
    expect(published).toHaveLength(1);
  });

  it('is refused outside the prefix, or for an unknown request, before anything is sent', async () => {
    const { session, hooks, published } = await asked();

    await expect(session.publish(['other'], 'video', { subscribeTracksId: PEER_REQUEST })).rejects.toThrow(/outside-prefix/);
    await expect(session.publish(['room'], 'video', { subscribeTracksId: 99n })).rejects.toThrow(/unknown-request/);
    expect(published).toEqual([]);
    expect(hooks.publicationManager.getByTrackName(['other'], 'video')).toBeUndefined();
  });

  it('may be retried once the peer refused it', async () => {
    let refuse = true;
    const { session, published } = await asked(() => (refuse
      ? { type: MessageTypeDraft18.REQUEST_ERROR, requestId: 0n, errorCode: RequestErrorCodeDraft18.INTERNAL_ERROR, reasonPhrase: 'busy' }
      : { type: MessageTypeDraft18.REQUEST_OK, requestId: 0n }));

    await expect(session.publish(['room'], 'video', { subscribeTracksId: PEER_REQUEST })).rejects.toThrow();
    refuse = false;
    await session.publish(['room'], 'video', { subscribeTracksId: PEER_REQUEST });

    expect(published).toHaveLength(2);
  });

  it('keeps its publication when the peer cancels the SUBSCRIBE_TRACKS (§9.18)', async () => {
    const { session, hooks, peer } = await asked();
    await session.publish(['room'], 'video', { subscribeTracksId: PEER_REQUEST });

    peer.fin();
    await tick();

    expect(hooks.publicationManager.getByTrackName(['room'], 'video')).toBeDefined();
    await expect(session.publish(['room'], 'audio', { subscribeTracksId: PEER_REQUEST })).rejects.toThrow(/unknown-request/);
  });
});

describe('cancelling our SUBSCRIBE_TRACKS (draft-23 §9.18)', () => {
  it('leaves the subscriptions its PUBLISHes made', async () => {
    const { session, internals } = makeSession('draft-23');
    const hooks = session as unknown as Internals;
    hooks.sendRequestAndWaitResponse = async () => ({ type: MessageTypeDraft18.REQUEST_OK, requestId: 0n });
    hooks.abortRequestStream = async () => {};
    const id = await session.subscribeTracks(['room'], () => {});

    const publisher = openIncoming(internals, {
      type: MessageTypeDraft18.PUBLISH,
      requestId: 1n,
      trackAlias: 5n,
      trackNamespace: ['room'],
      trackName: 'video',
      forwardState: true,
    });
    await publisher.opened;
    expect(publisher.written()[0]).toMatchObject({ type: MessageTypeDraft18.REQUEST_OK });

    await session.unsubscribeNamespace(id);

    expect(hooks.subscriptionManager.getByTrackName(['room'], 'video')).toBeDefined();
    expect(publisher.closed()).toBe(false);
  });
});

describe('a PUBLISH answering our SUBSCRIBE_TRACKS (draft-23 §9.19.21)', () => {
  it('passes its SUBSCRIBE_TRACKS_ID on in incoming-publish', async () => {
    const { session, internals } = makeSession('draft-23');
    const hooks = session as unknown as Internals;
    hooks.sendRequestAndWaitResponse = async () => ({ type: MessageTypeDraft18.REQUEST_OK, requestId: 0n });
    await session.subscribeTracks(['room'], () => {});
    const ids: Array<bigint | undefined> = [];
    session.on('incoming-publish', (evt) => ids.push(evt.subscribeTracksId));

    for (const [requestId, trackName, subscribeTracksId] of [[1n, 'video', 0n], [3n, 'audio', undefined]] as const) {
      await openIncoming(internals, {
        type: MessageTypeDraft18.PUBLISH,
        requestId,
        trackAlias: requestId,
        trackNamespace: ['room'],
        trackName,
        forwardState: true,
        subscribeTracksId,
      }).opened;
    }

    expect(ids).toEqual([0n, undefined]);
  });
});
