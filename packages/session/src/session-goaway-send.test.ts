// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Sending GOAWAY (draft-18 §10.4, draft-22 §9.2). A draft-18 GOAWAY on the
 * control stream names the smallest peer Request ID that might not have been
 * processed; requests that arrive after it are refused with GOING_AWAY.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  MOQTransport,
  MessageTypeDraft18,
  RequestErrorCodeDraft18,
  SubscriptionFilterDraft18,
  type ControlMessageDraft18,
  type GoAwayMessageDraft18,
  type RequestErrorMessageDraft18,
} from '@moq-web/core';

import { MOQTSession } from './session.js';

type Draft = 'draft-18' | 'draft-22';

const FIRST_PEER_REQUEST_ID = 1n;
const NEXT_PEER_REQUEST_ID = 3n;

interface Internals {
  codec: {
    encodeControlMessage: (m: unknown) => Uint8Array;
    decodeControlMessage: (b: Uint8Array) => [ControlMessageDraft18, number];
  };
  doSendControl: (b: Uint8Array) => Promise<void>;
  announcedNamespaces: Map<string, unknown>;
  processIncomingBidiStream: (s: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }) => Promise<void>;
}

function makeSession(draft: Draft) {
  const transport = new MOQTransport({ draft });
  (transport as unknown as { close: typeof transport.close }).close = vi.fn().mockResolvedValue(undefined);
  const session = new MOQTSession(transport);
  (session as unknown as { _state: string })._state = 'ready';
  const internals = session as unknown as Internals;
  const sent: Uint8Array[] = [];
  internals.doSendControl = async (bytes) => {
    sent.push(bytes);
  };

  return { session, internals, sent };
}

/** The peer opens a request stream carrying a SUBSCRIBE for an announced track */
async function peerSubscribe(draft: Draft, internals: Internals, requestId: bigint) {
  const written: Uint8Array[] = [];
  const closed = vi.fn();
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
  const writable = new WritableStream<Uint8Array>({
    write: (chunk) => {
      written.push(chunk);
    },
    close: closed,
  });
  await internals.processIncomingBidiStream({ readable, writable });

  return { written, closed };
}

describe('GOAWAY Request ID (draft-18 §10.4)', () => {
  it('is 1 when the peer has sent no requests', async () => {
    const { session, internals, sent } = makeSession('draft-18');

    await session.goAway();

    const goAway = internals.codec.decodeControlMessage(sent[0])[0] as GoAwayMessageDraft18;
    expect(goAway.requestId).toBe(FIRST_PEER_REQUEST_ID);
  });

  it('is the next peer Request ID after the ones seen', async () => {
    const { session, internals, sent } = makeSession('draft-18');
    internals.announcedNamespaces.set('ns', { namespace: ['ns'], options: {}, subscribers: new Map() });
    await peerSubscribe('draft-18', internals, FIRST_PEER_REQUEST_ID);
    await peerSubscribe('draft-18', internals, NEXT_PEER_REQUEST_ID);

    await session.goAway();

    const goAway = internals.codec.decodeControlMessage(sent[0])[0] as GoAwayMessageDraft18;
    expect(goAway.requestId).toBe(NEXT_PEER_REQUEST_ID + 2n);
  });

  it('is absent in draft-22, which dropped the field', async () => {
    const { session, internals, sent } = makeSession('draft-22');

    await session.goAway();

    const goAway = internals.codec.decodeControlMessage(sent[0])[0] as GoAwayMessageDraft18;
    expect(goAway.requestId).toBeUndefined();
  });
});

describe.each(['draft-18', 'draft-22'] as const)('requests after our GOAWAY (%s)', (draft) => {
  it('are refused with GOING_AWAY and a FIN', async () => {
    const { session, internals } = makeSession(draft);
    internals.announcedNamespaces.set('ns', { namespace: ['ns'], options: {}, subscribers: new Map() });
    await session.goAway();

    const stream = await peerSubscribe(draft, internals, FIRST_PEER_REQUEST_ID);

    const reply = internals.codec.decodeControlMessage(stream.written[0])[0] as RequestErrorMessageDraft18;
    expect(reply.type).toBe(MessageTypeDraft18.REQUEST_ERROR);
    expect(reply.errorCode).toBe(RequestErrorCodeDraft18.GOING_AWAY);
    expect(stream.closed).toHaveBeenCalled();
    expect(session.getSubscribers(['ns'])).toHaveLength(0);
  });
});
