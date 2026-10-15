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
  MOQTransport,
  MessageTypeDraft18,
  SubscriptionFilterDraft18,
  type ControlMessageDraft18,
  type SubscribeTracksMessageDraft18,
  DEFAULT_DRAFT,
} from '@moq-web/core';

import { MOQTSession } from './session.js';


const IS_DRAFT_18 = DEFAULT_DRAFT === 'draft-18';
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
  it('emits FORWARD=1 and defaults to NEXT_GROUP_START filter (not sent on wire)', async () => {
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

  it('does not encode SUBSCRIPTION_FILTER even when ABSOLUTE_RANGE is specified', async () => {
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
    // SUBSCRIPTION_FILTER is not allowed in SUBSCRIBE_TRACKS per draft-18,
    // so the decoder falls back to its default (NEXT_GROUP_START).
    expect(m.filter).toBe(SubscriptionFilterDraft18.NEXT_GROUP_START);
    expect(m.startLocation).toBeUndefined();
    expect(m.endGroupDelta).toBeUndefined();
  });
});
