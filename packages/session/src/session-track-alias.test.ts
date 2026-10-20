// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Track Aliases of the tracks we publish (draft-22 §3.1.3, draft-18 §11.1):
 * the alias in a SUBSCRIBE_OK and the alias in a PUBLISH never name two of
 * our tracks, and a peer's alias is never reused as ours.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  MOQTransport,
  MessageTypeDraft18,
  SubscriptionFilterDraft18,
  type ControlMessageDraft18,
  type SubscribeOkMessageDraft18,
} from '@moq-web/core';

import { MOQTSession } from './session.js';

type Draft = 'draft-18' | 'draft-22';

const PEER_ALIAS = 7n;
const FIRST_PEER_REQUEST_ID = 1n;
const PAST_OLD_ALIAS_BASE = 1000;

interface Internals {
  codec: {
    encodeControlMessage: (m: unknown) => Uint8Array;
    decodeControlMessage: (b: Uint8Array) => [ControlMessageDraft18, number];
  };
  nextRequestId: number;
  announcedNamespaces: Map<string, unknown>;
  sendRequestAndWaitResponse: (bytes: Uint8Array, id: bigint, kind: string) => Promise<ControlMessageDraft18>;
  processIncomingBidiStream: (s: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }) => Promise<void>;
}

function makeSession(draft: Draft) {
  const transport = new MOQTransport({ draft });
  (transport as unknown as { close: typeof transport.close }).close = vi.fn().mockResolvedValue(undefined);
  const session = new MOQTSession(transport);
  (session as unknown as { _state: string })._state = 'ready';
  const internals = session as unknown as Internals;
  internals.sendRequestAndWaitResponse = async (_bytes, requestId, kind) => (
    kind === 'subscribe'
      ? {
        type: MessageTypeDraft18.SUBSCRIBE_OK,
        requestId,
        trackAlias: PEER_ALIAS,
        largestLocation: { group: 0n, object: 0n },
      } as SubscribeOkMessageDraft18
      : { type: MessageTypeDraft18.REQUEST_OK, requestId } as ControlMessageDraft18
  );

  return { session, internals };
}

/** A peer SUBSCRIBE for an announced track; returns the alias in our SUBSCRIBE_OK */
async function acceptPeerSubscribe(draft: Draft, internals: Internals, requestId: bigint): Promise<bigint> {
  const written: Uint8Array[] = [];
  const readable = new ReadableStream<Uint8Array>({
    start: (c) => {
      c.enqueue(internals.codec.encodeControlMessage({
        type: MessageTypeDraft18.SUBSCRIBE,
        requestId,
        trackNamespace: ['ns'],
        trackName: 't',
        forwardState: true,
        ...(draft === 'draft-18' ? { filter: SubscriptionFilterDraft18.NEXT_GROUP_START } : {}),
      }));
    },
  });
  const writable = new WritableStream<Uint8Array>({ write: (chunk) => { written.push(chunk); } });
  await internals.processIncomingBidiStream({ readable, writable });

  return (internals.codec.decodeControlMessage(written[0])[0] as SubscribeOkMessageDraft18).trackAlias!;
}

describe.each(['draft-18', 'draft-22'] as const)('our Track Aliases (%s)', (draft) => {
  it('do not collide between SUBSCRIBE_OK and PUBLISH, however many Request IDs were used', async () => {
    const { session, internals } = makeSession(draft);
    internals.announcedNamespaces.set('ns', { namespace: ['ns'], options: {}, subscribers: new Map() });
    const subscribeOkAlias = await acceptPeerSubscribe(draft, internals, FIRST_PEER_REQUEST_ID);

    // Request IDs run well past where announce-flow aliases used to start
    internals.nextRequestId = PAST_OLD_ALIAS_BASE;
    const publishAlias = await session.publish(['other'], 'video');

    expect(publishAlias).not.toBe(subscribeOkAlias);
  });

  it('never reuse the alias a peer chose for our own subscription to the same track', async () => {
    const { session } = makeSession(draft);
    await session.subscribe(['ns'], 't');

    const publishAlias = await session.publish(['ns'], 't');

    expect(publishAlias).not.toBe(PEER_ALIAS);
  });

  it('differ for each track we publish', async () => {
    const { session } = makeSession(draft);

    const first = await session.publish(['ns'], 'a');
    const second = await session.publish(['ns'], 'b');

    expect(second).not.toBe(first);
  });
});
