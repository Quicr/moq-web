// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Draft-22 §9.11 FETCH — session send path.
 *
 * Verifies that `FetchRange` maps onto the LOCATION_FILTER fields on the wire
 * (end is inclusive, no draft-18 +1) and that unsupported requests are
 * refused before anything is sent.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  Draft22MessageCodec,
  MOQTransport,
  MessageTypeDraft18,
  MessageTypeDraft22,
  LocationFilterTypeDraft22,
  FetchTypeDraft18,
  GroupOrder,
  RequestParameterDraft22,
  decodeDraft18AuthToken,
  type FetchMessageDraft22,
} from '@moq-web/core';

import { MOQTSession } from './session.js';

function makeSession(): MOQTSession {
  const transport = new MOQTransport({ draft: 'draft-22' });
  (transport as unknown as { close: typeof transport.close }).close = vi.fn().mockResolvedValue(undefined);
  const session = new MOQTSession(transport);
  (session as unknown as { _state: string })._state = 'ready';
  return session;
}

function captureFetch(session: MOQTSession, chunks: Uint8Array[]): void {
  (session as unknown as {
    sendRequestAndWaitResponse: (bytes: Uint8Array) => Promise<unknown>;
  }).sendRequestAndWaitResponse = async (bytes) => {
    chunks.push(bytes);
    return {
      type: MessageTypeDraft18.FETCH_OK,
      endOfTrack: false,
      endLocation: { group: 0n, object: 0n },
    };
  };
}

async function fetchAndDecode(
  range: Parameters<MOQTSession['fetch']>[2],
  options?: Parameters<MOQTSession['fetch']>[3],
): Promise<FetchMessageDraft22> {
  const session = makeSession();
  const chunks: Uint8Array[] = [];
  captureFetch(session, chunks);

  await session.fetch(['ns'], 'track', range, options);

  expect(chunks).toHaveLength(1);
  const [decoded] = Draft22MessageCodec.decode(chunks[0]);
  expect(decoded.type).toBe(MessageTypeDraft22.FETCH);
  return decoded as FetchMessageDraft22;
}

describe('draft-22 §9.11 FETCH send path', () => {
  it('sends FetchOptions.authToken as a vi64 Token in authTokens', async () => {
    const tokenBytes = new Uint8Array([0x11, 0x22]);

    const m = await fetchAndDecode(
      { startGroup: 1, startObject: 0, endGroup: 3, endObject: 5 },
      { authToken: { tokenBytes } },
    );

    expect(m.authTokens).toHaveLength(1);
    expect(decodeDraft18AuthToken(m.authTokens![0]).tokenValue).toEqual(tokenBytes);
    expect(m.parameters?.has(RequestParameterDraft22.AUTHORIZATION_TOKEN)).toBeFalsy();
  });

  it('maps a specific endObject to ABSOLUTE_RANGE without a +1', async () => {
    const m = await fetchAndDecode({ startGroup: 1, startObject: 0, endGroup: 3, endObject: 5 });

    expect(m.locationFilter).toEqual({
      type: LocationFilterTypeDraft22.ABSOLUTE_RANGE,
      startLocation: { group: 1n, object: 0n },
      endGroupDelta: 2n,
      endObject: 5n,
    });
    expect(m.trackNamespace).toEqual(['ns']);
    expect(m.trackName).toBe('track');
  });

  it('maps endObject 0 (whole end group) to ABSOLUTE_START_GROUP_END', async () => {
    const m = await fetchAndDecode({ startGroup: 4, startObject: 2, endGroup: 6, endObject: 0 });

    expect(m.locationFilter).toEqual({
      type: LocationFilterTypeDraft22.ABSOLUTE_START_GROUP_END,
      startLocation: { group: 4n, object: 2n },
      endGroupDelta: 2n,
    });
  });

  it('sends priority and group order, defaulting to 128 / ascending', async () => {
    const defaults = await fetchAndDecode({ startGroup: 0, startObject: 0, endGroup: 0, endObject: 0 });
    expect(defaults.subscriberPriority).toBe(128);
    expect(defaults.groupOrder).toBe(GroupOrder.ASCENDING);

    const custom = await fetchAndDecode(
      { startGroup: 0, startObject: 0, endGroup: 0, endObject: 0 },
      { priority: 9, groupOrder: GroupOrder.DESCENDING },
    );
    expect(custom.subscriberPriority).toBe(9);
    expect(custom.groupOrder).toBe(GroupOrder.DESCENDING);
  });

  it('sends FILL_TIMEOUT when fillTimeout is set', async () => {
    const m = await fetchAndDecode(
      { startGroup: 0, startObject: 0, endGroup: 1, endObject: 0 },
      { fillTimeout: 2500 },
    );

    expect(m.fillTimeoutMs).toBe(2500n);
  });

  it('sends FILL_TIMEOUT 0 (only immediately available objects)', async () => {
    const m = await fetchAndDecode(
      { startGroup: 0, startObject: 0, endGroup: 1, endObject: 0 },
      { fillTimeout: 0 },
    );

    expect(m.fillTimeoutMs).toBe(0n);
  });

  it('clears the router group order when the FETCH is rejected', async () => {
    const session = makeSession();
    (session as unknown as {
      sendRequestAndWaitResponse: () => Promise<unknown>;
    }).sendRequestAndWaitResponse = async () => ({
      type: MessageTypeDraft18.REQUEST_ERROR,
      errorCode: 0,
      reasonPhrase: 'nope',
    });
    const router = (session as unknown as {
      objectRouter: { fetchGroupOrders: Map<bigint, GroupOrder> };
    }).objectRouter;

    await session.fetch(['ns'], 'track', { startGroup: 0, startObject: 0, endGroup: 1, endObject: 0 });

    expect(router.fetchGroupOrders.size).toBe(0);
  });

  it('records the fetch group order on the object router', async () => {
    const session = makeSession();
    captureFetch(session, []);
    const router = (session as unknown as {
      objectRouter: { setFetchGroupOrder: (id: bigint, order: GroupOrder) => void };
    }).objectRouter;
    const spy = vi.spyOn(router, 'setFetchGroupOrder');

    const requestId = await session.fetch(
      ['ns'], 'track',
      { startGroup: 0, startObject: 0, endGroup: 1, endObject: 0 },
      { groupOrder: GroupOrder.DESCENDING },
    );

    expect(spy).toHaveBeenCalledWith(requestId, GroupOrder.DESCENDING);
  });

  it('throws when endGroup < startGroup, sending nothing', async () => {
    const session = makeSession();
    const chunks: Uint8Array[] = [];
    captureFetch(session, chunks);

    await expect(
      session.fetch(['ns'], 'track', { startGroup: 5, startObject: 0, endGroup: 4, endObject: 0 }),
    ).rejects.toThrow(/endGroup/);
    expect(chunks).toHaveLength(0);
  });

  it('throws for joining fetch types', async () => {
    const session = makeSession();
    const chunks: Uint8Array[] = [];
    captureFetch(session, chunks);

    await expect(
      session.fetch(
        ['ns'], 'track',
        { startGroup: 0, startObject: 0, endGroup: 0, endObject: 0 },
        { fetchType: FetchTypeDraft18.JOINING_RELATIVE, subscribeRequestId: 1n },
      ),
    ).rejects.toThrow(/joining FETCH not supported in draft-22/);
    expect(chunks).toHaveLength(0);
  });
});
