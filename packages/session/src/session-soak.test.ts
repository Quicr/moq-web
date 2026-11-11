// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Soak: hundreds of request open/close cycles of every kind, in both
 * directions, then every per-request map and set in the session must be
 * empty. A leak here is memory a long-lived session never gets back.
 */

import { describe, it, expect } from 'vitest';
import {
  MessageTypeDraft18,
  SubscriptionFilterDraft18,
  type ControlMessageDraft18,
} from '@moq-web/core';

import { announce, makeSession, openIncoming, tick, type Draft } from './__tests__/incoming-peer.js';
import type { MOQTSession } from './session.js';

const ROUNDS = 200;

type Sized = { size: number };

/** The session state that must drain once every request has ended */
interface Drainable {
  incomingRequestKinds: Sized;
  activeRequestStreams: Sized;
  outgoingRequests: Sized;
  pendingRequestUpdates: Sized;
  goAwayStreams: Sized;
  namespaceSubscriptions: Sized;
  namespaceSubscriptionByRequestId: Sized;
  activeFetches: Sized;
  fetchStreamBuffers: Sized;
  fillStreams: Sized;
  trackStatusCallbacks: Sized;
  pendingFetchResponses: Sized;
  announceRequestIdToNamespace: Sized;
  retireTimers: Sized;
  subscriptionManager: Sized;
  publicationManager: Sized;
  seenPeerRequestIds: { sparseSize: number };
  incomingNamespaces: { subscriptions: Sized };
  incomingTrackSubs: { subscriptions: Sized };
}

function sizes(session: MOQTSession): Record<string, number> {
  const s = session as unknown as Drainable;
  return {
    incomingRequestKinds: s.incomingRequestKinds.size,
    activeRequestStreams: s.activeRequestStreams.size,
    outgoingRequests: s.outgoingRequests.size,
    pendingRequestUpdates: s.pendingRequestUpdates.size,
    goAwayStreams: s.goAwayStreams.size,
    namespaceSubscriptions: s.namespaceSubscriptions.size,
    namespaceSubscriptionByRequestId: s.namespaceSubscriptionByRequestId.size,
    activeFetches: s.activeFetches.size,
    fetchStreamBuffers: s.fetchStreamBuffers.size,
    fillStreams: s.fillStreams.size,
    trackStatusCallbacks: s.trackStatusCallbacks.size,
    pendingFetchResponses: s.pendingFetchResponses.size,
    announceRequestIdToNamespace: s.announceRequestIdToNamespace.size,
    retireTimers: s.retireTimers.size,
    subscriptions: s.subscriptionManager.size,
    publications: s.publicationManager.size,
    peerRequestIdsAboveFloor: s.seenPeerRequestIds.sparseSize,
    incomingNamespaceSubscriptions: s.incomingNamespaces.subscriptions.size,
    incomingTrackSubscriptions: s.incomingTrackSubs.subscriptions.size,
  };
}

const allZero = (record: Record<string, number>) => Object.fromEntries(Object.keys(record).map((k) => [k, 0]));

/**
 * Answer our outgoing requests like a relay would: the first response for
 * each kind, then FIN once we end our side.
 */
function scriptedPeer(session: MOQTSession, draft: Draft): void {
  const internals = session as unknown as {
    codec: { encodeControlMessage: (m: unknown) => Uint8Array; decodeControlMessage: (b: Uint8Array) => [ControlMessageDraft18, number] };
    transport: { createRequestStream: () => Promise<{ readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }> };
  };
  const { codec } = internals;
  internals.transport.createRequestStream = async () => {
    let toUs!: ReadableStreamDefaultController<Uint8Array>;
    let answered = false;
    const end = () => {
      try { toUs.close(); } catch { /* already ended */ }
    };
    const readable = new ReadableStream<Uint8Array>({ start: (c) => { toUs = c; } });
    const writable = new WritableStream<Uint8Array>({
      write: (chunk) => {
        if (answered) {
          return;
        }
        answered = true;
        const [request] = codec.decodeControlMessage(chunk);
        const requestId = (request as { requestId: bigint }).requestId;
        const reply = (m: unknown) => toUs.enqueue(codec.encodeControlMessage(m));
        switch (request.type as number) {
          case MessageTypeDraft18.SUBSCRIBE:
            reply({ type: MessageTypeDraft18.SUBSCRIBE_OK, requestId, trackAlias: requestId + 1000n });
            break;
          case MessageTypeDraft18.FETCH:
            if (draft === 'draft-23') {
              reply({ type: MessageTypeDraft18.REQUEST_OK, requestId });
            } else {
              reply({ type: MessageTypeDraft18.FETCH_OK, requestId, endOfTrack: false, endLocation: { group: 1n, object: 0n } });
            }
            break;
          default:
            reply({ type: MessageTypeDraft18.REQUEST_OK, requestId });
        }
      },
      close: end,
      abort: end,
    });

    return { readable, writable };
  };
}

describe.each(['draft-18', 'draft-22', 'draft-23'] as const)('session soak (%s)', (draft: Draft) => {
  it(`drains every per-request structure after ${ROUNDS} rounds of requests we accept`, async () => {
    const { session, internals } = makeSession(draft);
    announce(internals, ['soak']);
    const subscribeFilter = draft === 'draft-18' ? { filter: SubscriptionFilterDraft18.NEXT_GROUP_START } : {};
    let id = 1n;
    const next = () => {
      const current = id;
      id += 2n;
      return current;
    };

    for (let round = 0; round < ROUNDS; round++) {
      const peers = [
        openIncoming(internals, { type: MessageTypeDraft18.SUBSCRIBE, requestId: next(), trackNamespace: ['soak'], trackName: `t${round}`, forwardState: true, ...subscribeFilter }),
        openIncoming(internals, { type: MessageTypeDraft18.SUBSCRIBE_NAMESPACE, requestId: next(), trackNamespacePrefix: ['soak', `n${round}`] }),
        openIncoming(internals, { type: MessageTypeDraft18.SUBSCRIBE_TRACKS, requestId: next(), trackNamespacePrefix: ['soak', `s${round}`], forwardState: true, ...subscribeFilter }),
        openIncoming(internals, { type: MessageTypeDraft18.TRACK_STATUS, requestId: next(), trackNamespace: ['soak'], trackName: `t${round}` }),
        openIncoming(internals, { type: MessageTypeDraft18.PUBLISH_NAMESPACE, requestId: next(), trackNamespacePrefix: ['peer', `p${round}`] }),
      ];
      await Promise.all(peers.map((p) => p.opened));
      // A SUBSCRIBE is cancelled by a reset: a FIN only says the subscriber
      // sends no more (d22 §6.4.2.2). The namespace requests end on FIN.
      peers[0].reset();
      for (const peer of peers.slice(1)) {
        peer.fin();
      }
      await tick();
    }
    await tick();

    expect(sizes(session)).toEqual(allZero(sizes(session)));
  });

  it(`drains every per-request structure after ${ROUNDS} rounds of requests we send`, async () => {
    const { session } = makeSession(draft);
    scriptedPeer(session, draft);

    for (let round = 0; round < ROUNDS; round++) {
      const subscriptionId = await session.subscribe(['soak'], `t${round}`);
      const namespaceId = await session.subscribeNamespace(['soak', `n${round}`]);
      await session.trackStatus(['soak'], `t${round}`);
      await session.fetch(['soak'], `t${round}`, { startGroup: 0, startObject: 0, endGroup: 1, endObject: 0 });
      const fetchId = [...(session as unknown as { activeFetches: Map<bigint, unknown> }).activeFetches.keys()].pop();

      await session.unsubscribe(subscriptionId);
      await session.unsubscribeNamespace(namespaceId);
      if (fetchId !== undefined) {
        await session.cancelFetch(fetchId);
      }
      await tick();
    }
    await tick();

    expect(sizes(session)).toEqual(allZero(sizes(session)));
  });
});


describe('a subscriber FIN is not a cancel (d22 §6.4.2.2)', () => {
  it('keeps the subscription, which ends with PUBLISH_DONE', async () => {
    const { session, internals } = makeSession('draft-23');
    announce(internals, ['soak']);
    const peer = openIncoming(internals, { type: MessageTypeDraft18.SUBSCRIBE, requestId: 1n, trackNamespace: ['soak'], trackName: 't', forwardState: true });
    await peer.opened;

    peer.fin();
    await tick();

    const left = sizes(session);
    expect(left.publications).toBe(1);
    expect(left.activeRequestStreams).toBe(1);
  });
});
