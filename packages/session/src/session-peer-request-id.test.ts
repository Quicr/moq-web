// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Peer Request IDs (draft-22 §6.4.2.1, draft-18 §10.1): the peer is the
 * server, so its IDs are odd, and each is used once. A wrong parity or a
 * repeat, on a request or on a REQUEST_UPDATE, closes the session with
 * INVALID_REQUEST_ID.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  MOQTransport,
  MessageTypeDraft18,
  SessionErrorCodeDraft18,
  SubscriptionFilterDraft18,
} from '@moq-web/core';

import { MOQTSession } from './session.js';

type Draft = 'draft-18' | 'draft-22';

const PEER_REQUEST_ID = 1n;
const EVEN_ID = 2n;
const FIRST_UPDATE_ID = 3n;

interface Internals {
  codec: { encodeControlMessage: (m: unknown) => Uint8Array };
  announcedNamespaces: Map<string, unknown>;
  activeRequestStreams: Map<bigint, unknown>;
  processIncomingBidiStream: (s: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }) => Promise<void>;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const invalidId = expect.objectContaining({ code: SessionErrorCodeDraft18.INVALID_REQUEST_ID });

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

function subscribe(draft: Draft, requestId: bigint) {
  return {
    type: MessageTypeDraft18.SUBSCRIBE,
    requestId,
    trackNamespace: ['ns'],
    trackName: 't',
    forwardState: true,
    ...(draft === 'draft-18' ? { filter: SubscriptionFilterDraft18.NEXT_GROUP_START } : {}),
  };
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

describe.each(['draft-18', 'draft-22'] as const)('peer Request IDs (%s)', (draft) => {
  it('close the session when a request has the wrong parity', async () => {
    const { internals, close } = makeSession(draft);

    await openPeerStream(internals, subscribe(draft, EVEN_ID)).opened;

    expect(close).toHaveBeenCalledWith(invalidId);
  });

  it('do not replace the stream of one of our requests', async () => {
    const { internals, close } = makeSession(draft);
    const ours = { sentinel: true };
    internals.activeRequestStreams.set(EVEN_ID, ours);

    await openPeerStream(internals, subscribe(draft, EVEN_ID)).opened;

    expect(internals.activeRequestStreams.get(EVEN_ID)).toBe(ours);
    expect(close).toHaveBeenCalledWith(invalidId);
  });

  it('close the session when a request ID is reused', async () => {
    const { internals, close } = makeSession(draft);
    await openPeerStream(internals, subscribe(draft, PEER_REQUEST_ID)).opened;
    expect(close).not.toHaveBeenCalled();

    await openPeerStream(internals, subscribe(draft, PEER_REQUEST_ID)).opened;

    expect(close).toHaveBeenCalledWith(invalidId);
  });

  it('close the session when a REQUEST_UPDATE reuses an ID', async () => {
    const { internals, close } = makeSession(draft);
    const peer = openPeerStream(internals, subscribe(draft, PEER_REQUEST_ID));
    await peer.opened;
    const update = { type: MessageTypeDraft18.REQUEST_UPDATE, requestId: FIRST_UPDATE_ID, forwardState: true };

    peer.send(update);
    await tick();
    expect(close).not.toHaveBeenCalled();
    peer.send(update);
    await tick();

    expect(close).toHaveBeenCalledWith(invalidId);
  });

  it('close the session when a REQUEST_UPDATE has the wrong parity', async () => {
    const { internals, close } = makeSession(draft);
    const peer = openPeerStream(internals, subscribe(draft, PEER_REQUEST_ID));
    await peer.opened;

    peer.send({ type: MessageTypeDraft18.REQUEST_UPDATE, requestId: EVEN_ID, forwardState: true });
    await tick();

    expect(close).toHaveBeenCalledWith(invalidId);
  });
});
