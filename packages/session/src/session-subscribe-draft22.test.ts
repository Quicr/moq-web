// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Draft-22 §9.7 SUBSCRIBE — session send path.
 *
 * Verifies that `SubscribeOptions.filterType` maps onto draft-22
 * LOCATION_FILTER types (§9.20.9) on the wire, not draft-18 SUBSCRIPTION_FILTER
 * values.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  Draft22MessageCodec,
  MOQTransport,
  MessageTypeDraft18,
  MessageTypeDraft22,
  LocationFilterTypeDraft22,
  AuthTokenAliasType,
  RequestParameterDraft22,
  decodeDraft18AuthToken,
  type SubscribeMessageDraft22,
} from '@moq-web/core';

import { MOQTSession } from './session.js';

function makeSession(chunks: Uint8Array[]): MOQTSession {
  const transport = new MOQTransport({ draft: 'draft-22' });
  (transport as unknown as { close: typeof transport.close }).close = vi.fn().mockResolvedValue(undefined);
  const session = new MOQTSession(transport);
  (session as unknown as { _state: string })._state = 'ready';
  (session as unknown as {
    sendRequestAndWaitResponse: (bytes: Uint8Array) => Promise<unknown>;
  }).sendRequestAndWaitResponse = async (bytes) => {
    chunks.push(bytes);
    return {
      type: MessageTypeDraft18.SUBSCRIBE_OK,
      requestId: 0n,
      largestLocation: { group: 0n, object: 0n },
      trackProperties: new Map(),
    };
  };
  return session;
}

async function subscribeAndDecode(
  options?: Parameters<MOQTSession['subscribe']>[2],
): Promise<SubscribeMessageDraft22> {
  const chunks: Uint8Array[] = [];
  const session = makeSession(chunks);

  await session.subscribe(['ns'], 'track', options);

  expect(chunks).toHaveLength(1);
  const [decoded] = Draft22MessageCodec.decode(chunks[0]);
  expect(decoded.type).toBe(MessageTypeDraft22.SUBSCRIBE);
  return decoded as SubscribeMessageDraft22;
}

describe('draft-22 §9.7 SUBSCRIBE send path', () => {
  it('maps largest-object to NEXT_OBJECT', async () => {
    const m = await subscribeAndDecode({ filterType: 'largest-object' });

    expect(m.locationFilter).toEqual({ type: LocationFilterTypeDraft22.NEXT_OBJECT });
    expect(m.trackNamespace).toEqual(['ns']);
    expect(m.trackName).toBe('track');
    expect(m.forwardState).toBe(true);
  });

  it('maps absolute-start to ABSOLUTE_START', async () => {
    const m = await subscribeAndDecode({ filterType: 'absolute-start', startGroup: 7, startObject: 2 });

    expect(m.locationFilter).toEqual({
      type: LocationFilterTypeDraft22.ABSOLUTE_START,
      startLocation: { group: 7n, object: 2n },
    });
  });

  it('maps absolute to ABSOLUTE_START', async () => {
    const m = await subscribeAndDecode({ filterType: 'absolute', startGroup: 1 });

    expect(m.locationFilter).toEqual({
      type: LocationFilterTypeDraft22.ABSOLUTE_START,
      startLocation: { group: 1n, object: 0n },
    });
  });

  it('maps absolute-range to ABSOLUTE_START_GROUP_END', async () => {
    const m = await subscribeAndDecode({
      filterType: 'absolute-range',
      startGroup: 4,
      startObject: 1,
      endGroup: 9,
    });

    expect(m.locationFilter).toEqual({
      type: LocationFilterTypeDraft22.ABSOLUTE_START_GROUP_END,
      startLocation: { group: 4n, object: 1n },
      endGroupDelta: 5n,
    });
  });

  it('maps latest, next-group and no filter to RELATIVE_START 0', async () => {
    for (const filterType of ['latest', 'next-group', undefined] as const) {
      const m = await subscribeAndDecode(filterType ? { filterType } : undefined);

      expect(m.locationFilter).toEqual({
        type: LocationFilterTypeDraft22.RELATIVE_START,
        startLocation: { group: 0n, object: 0n },
      });
    }
  });

  it('sends SubscribeOptions.authToken as a vi64 Token in authTokens', async () => {
    const tokenBytes = new Uint8Array([0xaa, 0xbb]);

    const m = await subscribeAndDecode({ authToken: { tokenBytes, tokenType: 0x63346d } });

    expect(m.authTokens).toHaveLength(1);
    expect(decodeDraft18AuthToken(m.authTokens![0])).toEqual({
      aliasType: AuthTokenAliasType.USE_VALUE,
      tokenType: 0x63346d,
      tokenValue: tokenBytes,
    });
    expect(m.parameters?.has(RequestParameterDraft22.AUTHORIZATION_TOKEN)).toBeFalsy();
  });

  it('throws when endGroup < startGroup, sending nothing', async () => {
    const chunks: Uint8Array[] = [];
    const session = makeSession(chunks);

    await expect(
      session.subscribe(['ns'], 'track', { filterType: 'absolute-range', startGroup: 5, endGroup: 4 }),
    ).rejects.toThrow(/endGroup/);
    expect(chunks).toHaveLength(0);
  });
});
