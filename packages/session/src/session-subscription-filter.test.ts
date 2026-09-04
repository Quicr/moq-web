// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Draft-18 §10.2.9 SUBSCRIPTION_FILTER — session send path.
 *
 * Verifies that every `SubscribeOptions.filterType` value maps to the correct
 * `SubscriptionFilterDraft18` variant on the wire and carries the
 * `startLocation` / `endGroupDelta` fields the filter requires.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  Draft18MessageCodec,
  IS_DRAFT_18,
  MOQTransport,
  MessageTypeDraft18,
  SubscriptionFilterDraft18,
  type ControlMessageDraft18,
  type SubscribeMessageDraft18,
  type SubscribeOkMessageDraft18,
} from '@moq-web/core';

import { MOQTSession } from './session.js';

function makeSession(): MOQTSession {
  const transport = new MOQTransport();
  (transport as unknown as { close: typeof transport.close }).close = vi.fn().mockResolvedValue(undefined);
  const session = new MOQTSession(transport);
  (session as unknown as { _state: string })._state = 'ready';
  return session;
}

function stubSubscribeResponse(session: MOQTSession, chunks: Uint8Array[]): void {
  (session as unknown as {
    sendRequestAndWaitResponse: (bytes: Uint8Array, id: number) => Promise<ControlMessageDraft18>;
  }).sendRequestAndWaitResponse = async (bytes) => {
    chunks.push(bytes);
    return {
      type: MessageTypeDraft18.SUBSCRIBE_OK,
      requestId: 0n,
      trackAlias: 42n,
      expires: 0n,
      groupOrder: 1,
      largestLocation: { group: 0n, object: 0n },
      parameters: undefined,
    } as SubscribeOkMessageDraft18;
  };
}

async function subscribeAndDecode(
  session: MOQTSession,
  options: Parameters<MOQTSession['subscribe']>[2],
): Promise<SubscribeMessageDraft18> {
  const chunks: Uint8Array[] = [];
  stubSubscribeResponse(session, chunks);

  await session.subscribe(['ns'], 'track', options);

  expect(chunks.length).toBeGreaterThan(0);
  const [decoded] = Draft18MessageCodec.decode(chunks[0]);
  return decoded as SubscribeMessageDraft18;
}

describe.skipIf(!IS_DRAFT_18)('draft-18 §10.2.9 SubscribeOptions.filterType mapping', () => {
  it('defaults to NEXT_GROUP_START (no filterType provided)', async () => {
    const m = await subscribeAndDecode(makeSession(), undefined);
    expect(m.filter).toBe(SubscriptionFilterDraft18.NEXT_GROUP_START);
    expect(m.startLocation).toBeUndefined();
    expect(m.endGroupDelta).toBeUndefined();
  });

  it("filterType='latest' → NEXT_GROUP_START", async () => {
    const m = await subscribeAndDecode(makeSession(), { filterType: 'latest' });
    expect(m.filter).toBe(SubscriptionFilterDraft18.NEXT_GROUP_START);
  });

  it("filterType='next-group' → NEXT_GROUP_START", async () => {
    const m = await subscribeAndDecode(makeSession(), { filterType: 'next-group' });
    expect(m.filter).toBe(SubscriptionFilterDraft18.NEXT_GROUP_START);
  });

  it("filterType='largest-object' → LARGEST_OBJECT with no start location", async () => {
    const m = await subscribeAndDecode(makeSession(), { filterType: 'largest-object' });
    expect(m.filter).toBe(SubscriptionFilterDraft18.LARGEST_OBJECT);
    expect(m.startLocation).toBeUndefined();
    expect(m.endGroupDelta).toBeUndefined();
  });

  it("filterType='absolute-start' → ABSOLUTE_START with startGroup+startObject", async () => {
    const m = await subscribeAndDecode(makeSession(), {
      filterType: 'absolute-start',
      startGroup: 7,
      startObject: 3,
    });
    expect(m.filter).toBe(SubscriptionFilterDraft18.ABSOLUTE_START);
    expect(m.startLocation).toEqual({ group: 7n, object: 3n });
    expect(m.endGroupDelta).toBeUndefined();
  });

  it("filterType='absolute' (legacy alias) → ABSOLUTE_START", async () => {
    const m = await subscribeAndDecode(makeSession(), {
      filterType: 'absolute',
      startGroup: 1,
      startObject: 0,
    });
    expect(m.filter).toBe(SubscriptionFilterDraft18.ABSOLUTE_START);
    expect(m.startLocation).toEqual({ group: 1n, object: 0n });
  });

  it("filterType='absolute-range' → ABSOLUTE_RANGE with endGroup translated to delta", async () => {
    const m = await subscribeAndDecode(makeSession(), {
      filterType: 'absolute-range',
      startGroup: 10,
      startObject: 0,
      endGroup: 15,
    });
    expect(m.filter).toBe(SubscriptionFilterDraft18.ABSOLUTE_RANGE);
    expect(m.startLocation).toEqual({ group: 10n, object: 0n });
    // endGroup - startGroup = 5
    expect(m.endGroupDelta).toBe(5n);
  });

  it('absolute-range with endGroup < startGroup clamps delta to 0', async () => {
    const m = await subscribeAndDecode(makeSession(), {
      filterType: 'absolute-range',
      startGroup: 20,
      startObject: 0,
      endGroup: 10,
    });
    expect(m.filter).toBe(SubscriptionFilterDraft18.ABSOLUTE_RANGE);
    expect(m.endGroupDelta).toBe(0n);
  });

  it('absolute-range without endGroup defaults delta to 0 (single-group range)', async () => {
    const m = await subscribeAndDecode(makeSession(), {
      filterType: 'absolute-range',
      startGroup: 4,
      startObject: 0,
    });
    expect(m.filter).toBe(SubscriptionFilterDraft18.ABSOLUTE_RANGE);
    expect(m.startLocation).toEqual({ group: 4n, object: 0n });
    expect(m.endGroupDelta).toBe(0n);
  });
});
