// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * REQUEST_ERROR (draft-22 §9.4, §9.4.1, §9.4.2): the Retry Interval is the
 * wait in ms plus one, 0 meaning do not retry; a Redirect names where to
 * retry, and carries no Track Name for a namespace-scoped request.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  MOQTransport,
  MessageTypeDraft18,
  RequestErrorCodeDraft18,
  SessionErrorCodeDraft18,
} from '@moq-web/core';

import { MOQTSession } from './session.js';
import { RequestRejectedError } from './request-rejected-error.js';

type Draft = 'draft-18' | 'draft-22';

const REDIRECT = { connectUri: 'https://other.example/moq', trackNamespace: ['moved'], trackName: 'video' };

function makeSession(draft: Draft, error: Record<string, unknown>) {
  const transport = new MOQTransport({ draft });
  (transport as unknown as { close: typeof transport.close }).close = vi.fn().mockResolvedValue(undefined);
  const session = new MOQTSession(transport);
  (session as unknown as { _state: string })._state = 'ready';
  const codec = (session as unknown as { codec: { encodeControlMessage: (m: unknown) => Uint8Array } }).codec;
  transport.createRequestStream = vi.fn().mockResolvedValue({
    readable: new ReadableStream<Uint8Array>({
      start: (c) => {
        c.enqueue(codec.encodeControlMessage({
          type: MessageTypeDraft18.REQUEST_ERROR,
          requestId: 0n,
          errorCode: RequestErrorCodeDraft18.DOES_NOT_EXIST,
          reasonPhrase: 'no',
          ...error,
        }));
      },
    }),
    writable: new WritableStream<Uint8Array>(),
  });
  const close = vi.spyOn(session, 'close').mockResolvedValue(undefined);

  return { session, close };
}

async function rejection(promise: Promise<unknown>): Promise<RequestRejectedError> {
  const err = await promise.then(() => undefined, (e: unknown) => e);
  expect(err).toBeInstanceOf(RequestRejectedError);

  return err as RequestRejectedError;
}

describe.each(['draft-18', 'draft-22'] as const)('REQUEST_ERROR Retry Interval (%s)', (draft) => {
  it('is the wait plus one', async () => {
    const { session } = makeSession(draft, { retryInterval: 1001n });

    expect((await rejection(session.subscribe(['ns'], 't'))).retryAfterMs).toBe(1000);
  });

  it('1 means retry at once', async () => {
    const { session } = makeSession(draft, { retryInterval: 1n });

    expect((await rejection(session.subscribe(['ns'], 't'))).retryAfterMs).toBe(0);
  });

  it('0 means do not retry', async () => {
    const { session } = makeSession(draft, { retryInterval: 0n });

    expect((await rejection(session.subscribe(['ns'], 't'))).retryAfterMs).toBeUndefined();
  });

  it('is also reported for a PUBLISH_NAMESPACE refusal', async () => {
    const { session } = makeSession(draft, { retryInterval: 51n });

    expect((await rejection(session.announceNamespace(['room']))).retryAfterMs).toBe(50);
  });
});

describe.each(['draft-18', 'draft-22'] as const)('REQUEST_ERROR Redirect (%s)', (draft) => {
  it('is surfaced on a refused SUBSCRIBE', async () => {
    const { session, close } = makeSession(draft, { errorCode: RequestErrorCodeDraft18.REDIRECT, redirect: REDIRECT });

    const err = await rejection(session.subscribe(['ns'], 't'));

    expect(err.errorCode).toBe(RequestErrorCodeDraft18.REDIRECT);
    expect(err.redirect).toEqual(REDIRECT);
    expect(close).not.toHaveBeenCalled();
  });

  it('with a Track Name closes the session when it answers a namespace request', async () => {
    const { session, close } = makeSession(draft, { errorCode: RequestErrorCodeDraft18.REDIRECT, redirect: REDIRECT });

    await session.announceNamespace(['room']).catch(() => {});

    expect(close).toHaveBeenCalledWith(expect.objectContaining({ code: SessionErrorCodeDraft18.PROTOCOL_VIOLATION }));
  });

  it('with an empty Track Name is fine for a namespace request', async () => {
    const { session, close } = makeSession(draft, {
      errorCode: RequestErrorCodeDraft18.REDIRECT,
      redirect: { ...REDIRECT, trackName: '' },
    });

    const err = await rejection(session.announceNamespace(['room']));

    expect(err.redirect?.trackNamespace).toEqual(['moved']);
    expect(close).not.toHaveBeenCalled();
  });
});
