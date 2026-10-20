// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Request cancellation and rejection on request streams.
 *
 * Draft-22 §6.4.2.3 / draft-18 §3.3.2: requests are cancelled by abruptly
 * terminating the stream (RESET_STREAM / STOP_SENDING); a rejection is a
 * REQUEST_ERROR followed by a FIN. §3.2.4: cancelling a FETCH MUST
 * STOP_SENDING the request stream.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  MOQTransport,
  MessageTypeDraft18,
  StreamResetErrorCodeDraft18,
  type FetchMessageDraft18,
} from '@moq-web/core';

import { MOQTSession } from './session.js';

const REQUEST_ID = 4n;
const SUBSCRIPTION_ID = 7;

type SessionInternals = {
  activeRequestStreams: Map<bigint, unknown>;
  activeFetches: Map<bigint, unknown>;
  objectRouter: { cancelFetchStream: (id: bigint) => void };
  sendRequestUpdate: (...args: unknown[]) => Promise<void>;
  subscriptionManager: { add: (sub: unknown) => void };
  handleIncomingFetchDraft18: (m: FetchMessageDraft18, w: WritableStream<Uint8Array>) => Promise<void>;
};

function makeSession(draft: 'draft-18' | 'draft-22'): MOQTSession {
  const transport = new MOQTransport({ draft });
  (transport as unknown as { close: typeof transport.close }).close = vi.fn().mockResolvedValue(undefined);
  const session = new MOQTSession(transport);
  (session as unknown as { _state: string })._state = 'ready';
  return session;
}

function internals(session: MOQTSession): SessionInternals {
  return session as unknown as SessionInternals;
}

function fakeRequestStream() {
  return { abort: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) };
}

function registerFetch(session: MOQTSession) {
  const stream = fakeRequestStream();
  internals(session).activeRequestStreams.set(REQUEST_ID, stream);
  internals(session).activeFetches.set(REQUEST_ID, {
    requestId: REQUEST_ID, namespace: ['ns'], trackName: 't', range: {}, completed: false,
  });
  const cancelFetchStream = vi.spyOn(internals(session).objectRouter, 'cancelFetchStream');
  const sendRequestUpdate = vi.fn().mockResolvedValue(undefined);
  internals(session).sendRequestUpdate = sendRequestUpdate;

  return { stream, cancelFetchStream, sendRequestUpdate };
}

describe.each(['draft-18', 'draft-22'] as const)('cancelFetch (%s)', (draft) => {
  it('aborts the request stream instead of closing it', async () => {
    const session = makeSession(draft);
    const { stream } = registerFetch(session);

    await session.cancelFetch(REQUEST_ID);

    expect(stream.abort).toHaveBeenCalledWith(StreamResetErrorCodeDraft18.CANCELLED);
    expect(stream.close).not.toHaveBeenCalled();
    expect(internals(session).activeRequestStreams.has(REQUEST_ID)).toBe(false);
  });

  it('stops local delivery through the router', async () => {
    const session = makeSession(draft);
    const { cancelFetchStream } = registerFetch(session);

    await session.cancelFetch(REQUEST_ID);

    expect(cancelFetchStream).toHaveBeenCalledWith(REQUEST_ID);
  });
});

describe('cancelFetch REQUEST_UPDATE', () => {
  it('draft-22 sends no REQUEST_UPDATE (cancel is the stream abort)', async () => {
    const session = makeSession('draft-22');
    const { sendRequestUpdate } = registerFetch(session);

    await session.cancelFetch(REQUEST_ID);

    expect(sendRequestUpdate).not.toHaveBeenCalled();
  });
});

describe.each(['draft-18', 'draft-22'] as const)('unsubscribe (%s)', (draft) => {
  it('aborts the request stream without a REQUEST_UPDATE (d22 §3.1, d18 §5.1: STOP_SENDING)', async () => {
    const session = makeSession(draft);
    const stream = fakeRequestStream();
    internals(session).activeRequestStreams.set(REQUEST_ID, stream);
    const sendRequestUpdate = vi.fn().mockResolvedValue(undefined);
    internals(session).sendRequestUpdate = sendRequestUpdate;
    internals(session).subscriptionManager.add({
      subscriptionId: SUBSCRIPTION_ID,
      requestId: REQUEST_ID,
      namespace: ['ns'],
      trackName: 't',
      trackAlias: 1n,
      paused: false,
      onObject: () => {},
    });

    await session.unsubscribe(SUBSCRIPTION_ID);

    expect(stream.abort).toHaveBeenCalledWith(StreamResetErrorCodeDraft18.CANCELLED);
    expect(stream.close).not.toHaveBeenCalled();
    expect(sendRequestUpdate).not.toHaveBeenCalled();
  });
});

describe('rejecting an incoming request', () => {
  it('writes REQUEST_ERROR then FINs the stream (§6.4.2.3)', async () => {
    const session = makeSession('draft-22');
    const written: Uint8Array[] = [];
    const closed = vi.fn();
    const writable = new WritableStream<Uint8Array>({
      write: (chunk) => { written.push(chunk); },
      close: closed,
    });

    await internals(session).handleIncomingFetchDraft18(
      { type: MessageTypeDraft18.FETCH, requestId: REQUEST_ID } as unknown as FetchMessageDraft18,
      writable,
    );

    expect(written).toHaveLength(1);
    expect(closed).toHaveBeenCalledTimes(1);
  });
});
