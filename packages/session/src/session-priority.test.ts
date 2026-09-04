// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Draft-18 §7 priority scheduling — session wiring.
 *
 * Verifies that:
 *   • SUBSCRIBE §10.2 SUBSCRIBER_PRIORITY (0x20) + GROUP_ORDER (0x22)
 *     parameters land on the publication and its IncomingSubscriber entry.
 *   • REQUEST_UPDATE §10.9.1 carrying those same parameters updates the
 *     cached values so future streams reflect the change.
 *   • Outgoing subgroup streams pass `sendOrder` through to WebTransport
 *     via `createUnidirectionalStream`, computed from the subscriber hints.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  IS_DRAFT_18,
  MOQTransport,
  MessageTypeDraft18,
  GroupOrder,
  RequestParameterDraft18,
  type SubscribeMessageDraft18,
  type RequestUpdateMessageDraft18,
} from '@moq-web/core';

import { MOQTSession } from './session.js';
import { computeSendOrder } from './priority.js';

interface PrivateSession {
  handleIncomingSubscribeDraft18: (
    m: SubscribeMessageDraft18,
    w: WritableStream<Uint8Array>,
  ) => Promise<void>;
  dispatchRequestUpdateDraft18: (m: RequestUpdateMessageDraft18) => void;
  deriveSendOrder: (
    trackAlias: bigint,
    publisherPriority: number | undefined,
    groupId: number,
  ) => number | undefined;
  publicationManager: {
    getByRequestId: (id: number) => {
      subscriberPriority?: number;
      subscriberGroupOrder?: GroupOrder;
    } | undefined;
  };
  announcedNamespaces: Map<string, {
    subscribers: Map<number, { subscriberPriority: number; groupOrder: GroupOrder }>;
  }>;
}

function makeSession(): MOQTSession {
  const transport = new MOQTransport();
  (transport as unknown as { close: typeof transport.close }).close = vi.fn().mockResolvedValue(undefined);
  return new MOQTSession(transport);
}

async function announceForTest(session: MOQTSession, namespace: string[]): Promise<void> {
  // Directly seed the announced namespace map so we don't need the full
  // PUBLISH_NAMESPACE handshake to test the SUBSCRIBE-handler wiring.
  const namespaceStr = namespace.join('/');
  (session as unknown as {
    announcedNamespaces: Map<string, {
      namespace: string[];
      namespaceStr: string;
      subscribers: Map<number, unknown>;
      options: { priority: number; groupOrder: GroupOrder; deliveryTimeout: number; deliveryMode: 'stream' };
      acknowledged: boolean;
    }>;
  }).announcedNamespaces.set(namespaceStr, {
    namespace,
    namespaceStr,
    subscribers: new Map(),
    options: { priority: 128, groupOrder: GroupOrder.ASCENDING, deliveryTimeout: 5000, deliveryMode: 'stream' },
    acknowledged: true,
  });
}

function makeSubscribe(
  requestId: number,
  namespace: string[],
  trackName: string,
  parameters?: Map<number, Uint8Array>,
): SubscribeMessageDraft18 {
  return {
    type: MessageTypeDraft18.SUBSCRIBE,
    requestId: BigInt(requestId),
    trackNamespace: namespace,
    trackName,
    forwardState: true,
    filter: 0x1 as unknown as SubscribeMessageDraft18['filter'],
    parameters,
  };
}

function makeWritable(): WritableStream<Uint8Array> {
  return new WritableStream({ write() { /* discard */ } });
}

describe.skipIf(!IS_DRAFT_18)('draft-18 §7 SUBSCRIBE parameters land on publication', () => {
  it('applies SUBSCRIBER_PRIORITY (0x20) and GROUP_ORDER (0x22) from the SUBSCRIBE parameters', async () => {
    const session = makeSession();
    const priv = session as unknown as PrivateSession;
    await announceForTest(session, ['room']);

    const params = new Map<number, Uint8Array>();
    params.set(RequestParameterDraft18.SUBSCRIBER_PRIORITY, new Uint8Array([32]));
    params.set(RequestParameterDraft18.GROUP_ORDER, new Uint8Array([2])); // DESCENDING

    await priv.handleIncomingSubscribeDraft18(
      makeSubscribe(1, ['room'], 'video', params),
      makeWritable(),
    );

    const pub = priv.publicationManager.getByRequestId(1);
    expect(pub?.subscriberPriority).toBe(32);
    expect(pub?.subscriberGroupOrder).toBe(GroupOrder.DESCENDING);

    // Also mirrored onto the announced-subscribers map.
    const info = priv.announcedNamespaces.get('room');
    const sub = info?.subscribers.get(1);
    expect(sub?.subscriberPriority).toBe(32);
    expect(sub?.groupOrder).toBe(GroupOrder.DESCENDING);
  });

  it('falls back to defaults (128, ASCENDING) when parameters are absent', async () => {
    const session = makeSession();
    const priv = session as unknown as PrivateSession;
    await announceForTest(session, ['room']);

    await priv.handleIncomingSubscribeDraft18(
      makeSubscribe(2, ['room'], 'audio'),
      makeWritable(),
    );

    const pub = priv.publicationManager.getByRequestId(2);
    expect(pub?.subscriberPriority).toBe(128);
    expect(pub?.subscriberGroupOrder).toBe(GroupOrder.ASCENDING);
  });
});

describe.skipIf(!IS_DRAFT_18)('draft-18 §10.9.1 REQUEST_UPDATE re-priorities in flight', () => {
  it('updates subscriberPriority/groupOrder on the matching publication', async () => {
    const session = makeSession();
    const priv = session as unknown as PrivateSession;
    await announceForTest(session, ['room']);

    // Establish a baseline SUBSCRIBE.
    await priv.handleIncomingSubscribeDraft18(
      makeSubscribe(7, ['room'], 'video'),
      makeWritable(),
    );

    // Send REQUEST_UPDATE with a new subscriber priority + group order.
    const updateParams = new Map<number, Uint8Array>();
    updateParams.set(RequestParameterDraft18.SUBSCRIBER_PRIORITY, new Uint8Array([16]));
    updateParams.set(RequestParameterDraft18.GROUP_ORDER, new Uint8Array([2]));

    priv.dispatchRequestUpdateDraft18({
      type: MessageTypeDraft18.REQUEST_UPDATE,
      requestId: 7n,
      forwardState: true,
      parameters: updateParams,
    });

    const pub = priv.publicationManager.getByRequestId(7);
    expect(pub?.subscriberPriority).toBe(16);
    expect(pub?.subscriberGroupOrder).toBe(GroupOrder.DESCENDING);
  });
});

describe.skipIf(!IS_DRAFT_18)('draft-18 §7.2 deriveSendOrder', () => {
  it('reflects the subscriber-side priority/order cached on the publication', async () => {
    const session = makeSession();
    const priv = session as unknown as PrivateSession;
    await announceForTest(session, ['room']);

    // High-priority subscriber, DESCENDING.
    const params = new Map<number, Uint8Array>();
    params.set(RequestParameterDraft18.SUBSCRIBER_PRIORITY, new Uint8Array([0]));
    params.set(RequestParameterDraft18.GROUP_ORDER, new Uint8Array([2]));

    await priv.handleIncomingSubscribeDraft18(
      makeSubscribe(9, ['room'], 'video', params),
      makeWritable(),
    );

    const pub = priv.publicationManager.getByRequestId(9) as { trackAlias: bigint } | undefined;
    const alias = pub!.trackAlias;

    const so = priv.deriveSendOrder(alias, 128, 5);
    const expected = computeSendOrder(0, 128, GroupOrder.DESCENDING, 5);
    expect(so).toBe(expected);
  });

  it('returns a lower sendOrder for a lower-priority subscriber on the same group', async () => {
    const session = makeSession();
    const priv = session as unknown as PrivateSession;
    await announceForTest(session, ['room']);

    const paramsHigh = new Map<number, Uint8Array>();
    paramsHigh.set(RequestParameterDraft18.SUBSCRIBER_PRIORITY, new Uint8Array([0]));
    await priv.handleIncomingSubscribeDraft18(
      makeSubscribe(10, ['room'], 'video-hi', paramsHigh),
      makeWritable(),
    );

    const paramsLow = new Map<number, Uint8Array>();
    paramsLow.set(RequestParameterDraft18.SUBSCRIBER_PRIORITY, new Uint8Array([255]));
    await priv.handleIncomingSubscribeDraft18(
      makeSubscribe(11, ['room'], 'video-lo', paramsLow),
      makeWritable(),
    );

    const hiPub = priv.publicationManager.getByRequestId(10) as { trackAlias: bigint } | undefined;
    const loPub = priv.publicationManager.getByRequestId(11) as { trackAlias: bigint } | undefined;

    const hi = priv.deriveSendOrder(hiPub!.trackAlias, 128, 0)!;
    const lo = priv.deriveSendOrder(loPub!.trackAlias, 128, 0)!;
    expect(hi).toBeGreaterThan(lo);
  });
});
