// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * The peer ends the stream of a request we sent, by FIN or reset: the state
 * we hold for it must go and the application must hear of it. A PUBLISH_NAMESPACE
 * and a SUBSCRIBE_TRACKS end either way (draft-22 §4, draft-18 §6); a FETCH
 * is cancelled by a reset only, since its data stream ends it (§3.2.4).
 */

import { describe, it, expect, vi } from 'vitest';
import { MOQTransport, MessageTypeDraft18 } from '@moq-web/core';

import { MOQTSession } from './session.js';

type Draft = 'draft-18' | 'draft-22' | 'draft-23';

const REQUEST_ID = 0n;

interface Internals {
  codec: { encodeControlMessage: (m: unknown) => Uint8Array };
  doSendControl: (b: Uint8Array) => Promise<void>;
  transport: { createRequestStream: unknown };
  announcedNamespaces: Map<string, unknown>;
  namespaceSubscriptions: Map<number, unknown>;
  activeFetches: Map<bigint, unknown>;
  activeRequestStreams: Map<bigint, unknown>;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A session whose next request stream is played by `send`, `fin` and `reset` */
function makeSession(draft: Draft) {
  const transport = new MOQTransport({ draft });
  (transport as unknown as { close: typeof transport.close }).close = vi.fn().mockResolvedValue(undefined);
  const session = new MOQTSession(transport);
  (session as unknown as { _state: string })._state = 'ready';
  vi.spyOn(session, 'close').mockResolvedValue(undefined);
  const internals = session as unknown as Internals;
  internals.doSendControl = vi.fn().mockResolvedValue(undefined);

  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const readable = new ReadableStream<Uint8Array>({ start: (c) => { controller = c; } });
  internals.transport.createRequestStream = vi.fn().mockResolvedValue({ readable, writable: new WritableStream<Uint8Array>() });

  return {
    session,
    internals,
    send: (message: unknown) => controller.enqueue(internals.codec.encodeControlMessage(message)),
    end: { fin: () => controller.close(), reset: () => controller.error(new Error('stream reset by peer')) },
  };
}

const requestOk = { type: MessageTypeDraft18.REQUEST_OK, requestId: REQUEST_ID };

function fetchOk(draft: Draft) {
  return draft === 'draft-23'
    ? requestOk
    : { type: MessageTypeDraft18.FETCH_OK, requestId: REQUEST_ID, endOfTrack: false, endLocation: { group: 1n, object: 0n } };
}

describe.each(['draft-18', 'draft-22', 'draft-23'] as const)('the peer ends a request we sent (%s)', (draft) => {
  describe.each(['fin', 'reset'] as const)('by %s', (how) => {
    it('withdraws our PUBLISH_NAMESPACE', async () => {
      const { session, internals, send, end } = makeSession(draft);
      const errors = vi.fn();
      session.on('namespace-error', errors);
      send(requestOk);
      await session.announceNamespace(['room']);

      end[how]();
      await tick();

      expect(session.getAnnouncedNamespaces()).toHaveLength(0);
      expect(internals.activeRequestStreams.size).toBe(0);
      expect(errors).toHaveBeenCalledWith(expect.objectContaining({ kind: 'publish-namespace', namespace: ['room'] }));
    });

    it('forgets our SUBSCRIBE_TRACKS', async () => {
      const { session, internals, send, end } = makeSession(draft);
      send(requestOk);
      await session.subscribeTracks(['room']);

      end[how]();
      await tick();

      expect(internals.namespaceSubscriptions.size).toBe(0);
      expect(internals.activeRequestStreams.size).toBe(0);
    });
  });

  it('fails our FETCH when its request stream is reset', async () => {
    const { session, internals, send, end } = makeSession(draft);
    const errors = vi.fn();
    session.on('fetch-error', errors);
    send(fetchOk(draft));
    await session.fetch(['room'], 'video', { startGroup: 0, startObject: 0, endGroup: 1, endObject: 0 });

    end.reset();
    await tick();

    expect(internals.activeFetches.size).toBe(0);
    expect(errors).toHaveBeenCalledWith(expect.objectContaining({ requestId: REQUEST_ID }));
  });

  it('keeps our FETCH on a FIN, for its data stream to end', async () => {
    const { session, internals, send, end } = makeSession(draft);
    const errors = vi.fn();
    session.on('fetch-error', errors);
    send(fetchOk(draft));
    await session.fetch(['room'], 'video', { startGroup: 0, startObject: 0, endGroup: 1, endObject: 0 });

    end.fin();
    await tick();

    expect(internals.activeFetches.size).toBe(1);
    expect(errors).not.toHaveBeenCalled();
  });

  it('drops a PUBLISH_NAMESPACE whose stream ends before a response', async () => {
    const { session, end } = makeSession(draft);
    const announced = session.announceNamespace(['room']);
    await tick();

    end.reset();

    await expect(announced).rejects.toThrow();
    expect(session.getAnnouncedNamespaces()).toHaveLength(0);
  });
});
