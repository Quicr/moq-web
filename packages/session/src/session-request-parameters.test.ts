// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Parameters each request may carry (d22 §9.20.1, d18 §10.2.1): SUBSCRIBE
 * takes delivery and rendezvous timeouts, FETCH takes FILL_TIMEOUT (0
 * included), and neither takes the other's.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  MOQTransport,
  MessageTypeDraft18,
  RequestParameterDraft18,
  type ControlMessageDraft18,
  type FetchMessageDraft18,
} from '@moq-web/core';

import { MOQTSession } from './session.js';

interface Internals {
  codec: { decodeControlMessage: (b: Uint8Array) => [ControlMessageDraft18, number] };
  sendRequestAndWaitResponse: (bytes: Uint8Array, id: bigint, kind: string) => Promise<ControlMessageDraft18>;
  buildFetchDraft18: (
    requestId: bigint,
    namespace: string[],
    trackName: string,
    range: { startGroup: number; startObject: number; endGroup: number; endObject: number },
    options?: { fillTimeout?: number },
  ) => FetchMessageDraft18;
}

function makeSession() {
  const transport = new MOQTransport({ draft: 'draft-18' });
  (transport as unknown as { close: typeof transport.close }).close = vi.fn().mockResolvedValue(undefined);
  const session = new MOQTSession(transport);
  (session as unknown as { _state: string })._state = 'ready';

  return { session, internals: session as unknown as Internals };
}

describe('draft-18 request parameters', () => {
  it('SUBSCRIBE carries delivery and rendezvous timeouts but no FILL_TIMEOUT', async () => {
    const { session, internals } = makeSession();
    const sent: Uint8Array[] = [];
    internals.sendRequestAndWaitResponse = async (bytes) => {
      sent.push(bytes);
      return {
        type: MessageTypeDraft18.SUBSCRIBE_OK,
        requestId: 0n,
        trackAlias: 1n,
        largestLocation: { group: 0n, object: 0n },
      } as ControlMessageDraft18;
    };

    await session.subscribe(['ns'], 't', { objectDeliveryTimeout: 200, rendezvousTimeout: 50 });

    const decoded = internals.codec.decodeControlMessage(sent[0])[0] as unknown as {
      parameters?: Map<number, Uint8Array>;
    };
    expect(Array.from(decoded.parameters?.keys() ?? [])).toEqual(
      expect.arrayContaining([RequestParameterDraft18.OBJECT_DELIVERY_TIMEOUT, RequestParameterDraft18.RENDEZVOUS_TIMEOUT]),
    );
    expect(decoded.parameters?.has(RequestParameterDraft18.FILL_TIMEOUT)).toBe(false);
  });

  it('FETCH carries FILL_TIMEOUT 0, which asks for only what is available now', () => {
    const { internals } = makeSession();
    const range = { startGroup: 1, startObject: 0, endGroup: 2, endObject: 0 };

    const fetch = internals.buildFetchDraft18(1n, ['ns'], 't', range, { fillTimeout: 0 });

    expect(Array.from(fetch.parameters?.keys() ?? [])).toEqual([RequestParameterDraft18.FILL_TIMEOUT]);
    expect(fetch.parameters?.get(RequestParameterDraft18.FILL_TIMEOUT)).toEqual(Uint8Array.of(0));
  });

  it('FETCH carries no timeout when none is set', () => {
    const { internals } = makeSession();
    const range = { startGroup: 1, startObject: 0, endGroup: 2, endObject: 0 };

    const fetch = internals.buildFetchDraft18(1n, ['ns'], 't', range);

    expect(fetch.parameters?.size ?? 0).toBe(0);
  });
});
