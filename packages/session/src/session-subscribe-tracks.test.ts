// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Unit tests for the draft-18 SUBSCRIBE_TRACKS (§10.19) send path and the
 * PUBLISH_BLOCKED (§10.20) publisher helper. Wire-level round-trips for
 * SUBSCRIBE_TRACKS live in `draft18-message-codec.test.ts`; these tests
 * confirm the session forwards its options into the message so the codec
 * receives complete input.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  Draft18MessageCodec,
  IS_DRAFT_18,
  MOQTransport,
  MessageTypeDraft18,
  RequestParameterDraft18,
  SubscriptionFilterDraft18,
  type ControlMessageDraft18,
  type PublishBlockedMessageDraft18,
  type SubscribeTracksMessageDraft18,
} from '@moq-web/core';

import { MOQTSession } from './session.js';

function makeSession(): MOQTSession {
  const transport = new MOQTransport();
  (transport as unknown as { close: typeof transport.close }).close = vi.fn().mockResolvedValue(undefined);
  const session = new MOQTSession(transport);
  // subscribeTracks() gates on isReady; flip the state so the test doesn't have to
  // stand up the whole setup handshake.
  (session as unknown as { _state: string })._state = 'ready';
  return session;
}

function captureControlWrites(session: MOQTSession): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  (session as unknown as { doSendControl: (data: Uint8Array) => Promise<void> }).doSendControl =
    async (data: Uint8Array) => { chunks.push(data); };
  return chunks;
}

describe.skipIf(!IS_DRAFT_18)('draft-18 §10.19 subscribeTracks() send path', () => {
  it('emits FORWARD=1 and SUBSCRIPTION_FILTER=NEXT_GROUP_START by default', async () => {
    const session = makeSession();
    const chunks = captureControlWrites(session);
    // Stub sendRequestAndWaitResponse to short-circuit the send + await.
    (session as unknown as {
      sendRequestAndWaitResponse: (bytes: Uint8Array, id: number) => Promise<ControlMessageDraft18>;
    }).sendRequestAndWaitResponse = async (bytes) => {
      chunks.push(bytes);
      return { type: MessageTypeDraft18.REQUEST_OK, requestId: 0n } as ControlMessageDraft18;
    };

    await session.subscribeTracks(['media', 'video']);

    expect(chunks.length).toBeGreaterThan(0);
    const [decoded] = Draft18MessageCodec.decode(chunks[0]);
    const m = decoded as SubscribeTracksMessageDraft18;
    expect(m.type).toBe(MessageTypeDraft18.SUBSCRIBE_TRACKS);
    expect(m.trackNamespacePrefix).toEqual(['media', 'video']);
    expect(m.forwardState).toBe(true);
    expect(m.filter).toBe(SubscriptionFilterDraft18.NEXT_GROUP_START);
  });

  it('propagates forwardState=false into the encoded FORWARD parameter', async () => {
    const session = makeSession();
    const chunks: Uint8Array[] = [];
    (session as unknown as {
      sendRequestAndWaitResponse: (bytes: Uint8Array, id: number) => Promise<ControlMessageDraft18>;
    }).sendRequestAndWaitResponse = async (bytes) => {
      chunks.push(bytes);
      return { type: MessageTypeDraft18.REQUEST_OK, requestId: 0n } as ControlMessageDraft18;
    };

    await session.subscribeTracks(['ns'], undefined, { forwardState: false });

    const [decoded] = Draft18MessageCodec.decode(chunks[0]);
    expect((decoded as SubscribeTracksMessageDraft18).forwardState).toBe(false);
  });

  it('propagates ABSOLUTE_RANGE filter + startLocation + endGroupDelta', async () => {
    const session = makeSession();
    const chunks: Uint8Array[] = [];
    (session as unknown as {
      sendRequestAndWaitResponse: (bytes: Uint8Array, id: number) => Promise<ControlMessageDraft18>;
    }).sendRequestAndWaitResponse = async (bytes) => {
      chunks.push(bytes);
      return { type: MessageTypeDraft18.REQUEST_OK, requestId: 0n } as ControlMessageDraft18;
    };

    await session.subscribeTracks(['ns', 'r'], undefined, {
      filter: SubscriptionFilterDraft18.ABSOLUTE_RANGE,
      startLocation: { group: 4n, object: 0n },
      endGroupDelta: 5n,
    });

    const [decoded] = Draft18MessageCodec.decode(chunks[0]);
    const m = decoded as SubscribeTracksMessageDraft18;
    expect(m.filter).toBe(SubscriptionFilterDraft18.ABSOLUTE_RANGE);
    expect(m.startLocation).toEqual({ group: 4n, object: 0n });
    expect(m.endGroupDelta).toBe(5n);
  });

  it('carries pass-through raw parameters (e.g. TRACK_NAMESPACE_PREFIX)', async () => {
    const session = makeSession();
    const chunks: Uint8Array[] = [];
    (session as unknown as {
      sendRequestAndWaitResponse: (bytes: Uint8Array, id: number) => Promise<ControlMessageDraft18>;
    }).sendRequestAndWaitResponse = async (bytes) => {
      chunks.push(bytes);
      return { type: MessageTypeDraft18.REQUEST_OK, requestId: 0n } as ControlMessageDraft18;
    };

    const extra = new Map<number, Uint8Array>([
      [RequestParameterDraft18.TRACK_NAMESPACE_PREFIX, new Uint8Array([0x01, 0x02, 0x03])],
    ]);
    await session.subscribeTracks(['ns'], undefined, { parameters: extra });

    const [decoded] = Draft18MessageCodec.decode(chunks[0]);
    const m = decoded as SubscribeTracksMessageDraft18;
    expect(m.parameters?.get(RequestParameterDraft18.TRACK_NAMESPACE_PREFIX)).toEqual(
      new Uint8Array([0x01, 0x02, 0x03]),
    );
  });
});

describe.skipIf(!IS_DRAFT_18)('draft-18 §10.20 sendPublishBlocked()', () => {
  it('writes a PUBLISH_BLOCKED message carrying the trackAlias', async () => {
    const session = makeSession();
    const chunks = captureControlWrites(session);

    await session.sendPublishBlocked(0xDECAFn);

    expect(chunks.length).toBe(1);
    const [decoded] = Draft18MessageCodec.decode(chunks[0]);
    const m = decoded as PublishBlockedMessageDraft18;
    expect(m.type).toBe(MessageTypeDraft18.PUBLISH_BLOCKED);
    expect(m.trackAlias).toBe(0xDECAFn);
  });

  it('accepts number and string trackAlias inputs and coerces to bigint', async () => {
    const session = makeSession();
    const chunks = captureControlWrites(session);

    await session.sendPublishBlocked(7);
    await session.sendPublishBlocked('42');

    expect(chunks.length).toBe(2);
    const [m0] = Draft18MessageCodec.decode(chunks[0]);
    const [m1] = Draft18MessageCodec.decode(chunks[1]);
    expect((m0 as PublishBlockedMessageDraft18).trackAlias).toBe(7n);
    expect((m1 as PublishBlockedMessageDraft18).trackAlias).toBe(42n);
  });
});
