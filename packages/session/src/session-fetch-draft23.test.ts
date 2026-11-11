// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Draft-23 FETCH requester: the response is a REQUEST_OK (§9.3, #2009). Its
 * end is LARGEST_OBJECT when inside the range, else the requested end; End
 * of Track comes from the data stream (§11.4.2.2).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  Draft23MessageCodec,
  MOQTransport,
  MessageTypeDraft18,
  MessageTypeDraft22,
  MOQTVarInt,
  SessionErrorCodeDraft23,
  type FetchMessageDraft22,
  type RequestOkMessageDraft18,
} from '@moq-web/core';

import { MOQTSession } from './session.js';
import type { FetchCompleteEvent } from './types.js';

interface Internals {
  sendRequestAndWaitResponse: (bytes: Uint8Array) => Promise<unknown>;
  outgoingRequests: Map<bigint, { kind: string; answered: boolean; announced: Set<string> }>;
  acceptFirstResponse: (requestId: bigint, response: unknown) => boolean;
}

function makeSession(): MOQTSession {
  const transport = new MOQTransport({ draft: 'draft-23' });
  (transport as unknown as { close: typeof transport.close }).close = vi.fn().mockResolvedValue(undefined);
  const session = new MOQTSession(transport);
  (session as unknown as { _state: string })._state = 'ready';
  return session;
}

async function fetchWith(response: Partial<RequestOkMessageDraft18>, range = { startGroup: 2, startObject: 0, endGroup: 9, endObject: 4 }) {
  const session = makeSession();
  const sent: Uint8Array[] = [];
  (session as unknown as Internals).sendRequestAndWaitResponse = async (bytes) => {
    sent.push(bytes);
    return { type: MessageTypeDraft18.REQUEST_OK, requestId: 0n, ...response };
  };
  const close = vi.spyOn(session, 'close').mockResolvedValue(undefined);
  const complete: FetchCompleteEvent[] = [];
  session.on('fetch-complete', (e) => complete.push(e as FetchCompleteEvent));

  await session.fetch(['ns'], 'track', range);
  return { sent, complete, close };
}

describe('draft-23 FETCH requester', () => {
  it('sends FETCH with draft-23 framing', async () => {
    const { sent } = await fetchWith({});
    const [decoded, bytesRead] = Draft23MessageCodec.decode(sent[0]);
    expect(bytesRead).toBe(sent[0].length);
    expect(decoded.type).toBe(MessageTypeDraft22.FETCH);
    expect((decoded as FetchMessageDraft22).trackName).toBe('track');
  });

  it('ends at LARGEST_OBJECT when the REQUEST_OK carries it', async () => {
    const { complete } = await fetchWith({ largestLocation: { group: 6n, object: 3n } });
    expect(complete).toEqual([expect.objectContaining({ largestGroupId: 6n, largestObjectId: 3n, endOfTrack: false })]);
  });

  it('ends at the requested end otherwise', async () => {
    const { complete } = await fetchWith({});
    expect(complete).toEqual([expect.objectContaining({ largestGroupId: 9n, largestObjectId: 4n })]);
  });

  it('a requested whole End Group names no end Object', async () => {
    const { complete } = await fetchWith({}, { startGroup: 2, startObject: 0, endGroup: 9, endObject: 0 });
    expect(complete[0].largestGroupId).toBe(9n);
    expect(complete[0].largestObjectId).toBeUndefined();
  });

  it('accepts Track Properties in the REQUEST_OK for a FETCH', async () => {
    const { complete, close } = await fetchWith({ trackProperties: new Map([[0x30, MOQTVarInt.encode(1)]]) });
    expect(close).not.toHaveBeenCalled();
    expect(complete).toHaveLength(1);
  });

  it('closes with INVALID_FIELD when LARGEST_OBJECT is before the Start Location', async () => {
    const { complete, close } = await fetchWith({ largestLocation: { group: 1n, object: 0n } });
    expect(complete).toEqual([]);
    expect(close).toHaveBeenCalledWith(expect.objectContaining({ code: SessionErrorCodeDraft23.INVALID_FIELD }));
  });
});

describe('draft-23 first-response checks', () => {
  function accept(kind: string, response: unknown) {
    const session = makeSession();
    const close = vi.spyOn(session, 'close').mockResolvedValue(undefined);
    const internals = session as unknown as Internals;
    internals.outgoingRequests.set(4n, { kind, answered: false, announced: new Set() });
    return { ok: internals.acceptFirstResponse(4n, response), close };
  }

  it('REQUEST_OK answers a FETCH', () => {
    expect(accept('fetch', { type: MessageTypeDraft18.REQUEST_OK, requestId: 0n }).ok).toBe(true);
  });

  it('a wrong response type closes with UNEXPECTED_MESSAGE', () => {
    const { ok, close } = accept('fetch', { type: MessageTypeDraft18.SUBSCRIBE_OK, requestId: 0n, trackAlias: 1n });
    expect(ok).toBe(false);
    expect(close).toHaveBeenCalledWith(expect.objectContaining({ code: SessionErrorCodeDraft23.UNEXPECTED_MESSAGE }));
  });

  it('Track Properties in a REQUEST_OK for PUBLISH_NAMESPACE close with INVALID_FIELD', () => {
    const { ok, close } = accept('publish-namespace', {
      type: MessageTypeDraft18.REQUEST_OK,
      requestId: 0n,
      trackProperties: new Map([[0x3c, MOQTVarInt.encode(1)]]),
    });
    expect(ok).toBe(false);
    expect(close).toHaveBeenCalledWith(expect.objectContaining({ code: SessionErrorCodeDraft23.INVALID_FIELD }));
  });
});

describe('fetch-gap event', () => {
  type Gap = (id: bigint, kind: string, end: { group: bigint; object?: bigint }) => void;
  const router = (session: MOQTSession) =>
    (session as unknown as { objectRouter: { onFetchGap: Gap }; fillStreams: Map<bigint, unknown> });

  it('reports the router indicators of a fetch, and a handler that throws is contained', () => {
    const session = makeSession();
    const gaps: unknown[] = [];
    session.on('fetch-gap', () => {
      throw new Error('app bug');
    });
    session.on('fetch-gap', (e) => gaps.push(e));

    router(session).objectRouter.onFetchGap(5n, 'gone', { group: 2n, object: 7n });

    expect(gaps).toEqual([{ requestId: 5n, kind: 'gone', end: { group: 2n, object: 7n } }]);
  });

  it('is not raised for a fill stream', () => {
    const session = makeSession();
    const gaps: unknown[] = [];
    session.on('fetch-gap', (e) => gaps.push(e));
    router(session).fillStreams.set(9n, {});

    router(session).objectRouter.onFetchGap(9n, 'end-of-group', { group: 1n });

    expect(gaps).toEqual([]);
  });
});

describe('wire options beside a transport', () => {
  it('grease and MAX_CONTROL_MESSAGE_SIZE apply without a worker config', () => {
    const transport = new MOQTransport({ draft: 'draft-23' });
    const session = new MOQTSession(transport, { grease: true, maxControlMessageSize: 200_000 });
    const internals = session as unknown as {
      codec: { encodeControlMessage: (m: unknown) => Uint8Array; controlFraming: { maxReceiveLength?: number } };
      maxControlMessageSize?: number;
    };
    const error = { type: MessageTypeDraft18.REQUEST_ERROR, requestId: 0n, errorCode: 0, reasonPhrase: '' };
    const plain = new MOQTSession(new MOQTransport({ draft: 'draft-23' })) as unknown as typeof internals;

    expect(internals.codec.encodeControlMessage(error).length).toBeGreaterThan(plain.codec.encodeControlMessage(error).length);
    expect(internals.maxControlMessageSize).toBe(200_000);
  });
});
