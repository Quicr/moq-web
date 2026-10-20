// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Draft-18 §10.11: SUBSCRIPTION_ENDED means "the publisher reached the end of
 * an associated subscription filter". Once the End Group of an AbsoluteRange
 * is passed, the publisher ends the subscription with it. Draft-22 has no
 * such code and keeps a subscription open past its filter (§3.3.1).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  MessageTypeDraft18,
  PublishDoneErrorCodeDraft18,
  SubscriptionFilterDraft18,
  LocationFilterTypeDraft22,
  type PublishDoneMessageDraft18,
} from '@moq-web/core';

import { announce, makeSession, openIncoming, type Draft } from './__tests__/incoming-peer.js';

const PEER_REQUEST_ID = 1n;
const END_GROUP = 6;
const PAYLOAD = new Uint8Array([1]);

function subscribe(draft: Draft) {
  const range = draft === 'draft-18'
    ? { filter: SubscriptionFilterDraft18.ABSOLUTE_RANGE, startLocation: { group: 5n, object: 0n }, endGroupDelta: 1n }
    : {
      locationFilter: {
        type: LocationFilterTypeDraft22.ABSOLUTE_START_GROUP_END,
        startLocation: { group: 5n, object: 0n },
        endGroupDelta: 1n,
      },
    };

  return {
    type: MessageTypeDraft18.SUBSCRIBE,
    requestId: PEER_REQUEST_ID,
    trackNamespace: ['ns'],
    trackName: 't',
    forwardState: true,
    ...range,
  };
}

async function publishing(draft: Draft) {
  const { session, internals } = makeSession(draft);
  announce(internals, ['ns']);
  const sent = vi.fn().mockResolvedValue(undefined);
  (session as unknown as { sendSubgroupObject: unknown }).sendSubgroupObject = sent;
  const peer = openIncoming(internals, subscribe(draft));
  await peer.opened;
  const alias = internals.publicationManager.getByRequestId(PEER_REQUEST_ID)!.trackAlias as bigint;
  const send = (groupId: number) => session.sendObject(alias, PAYLOAD, { groupId, objectId: 0, type: 'data' });

  return { peer, send, sent };
}

const doneOf = (peer: Awaited<ReturnType<typeof publishing>>['peer']) =>
  peer.written().filter((m) => m.type === MessageTypeDraft18.PUBLISH_DONE) as PublishDoneMessageDraft18[];

describe('the end of a subscription filter', () => {
  it('ends a draft-18 subscription with SUBSCRIPTION_ENDED, once', async () => {
    const { peer, send, sent } = await publishing('draft-18');

    await send(END_GROUP);
    expect(doneOf(peer)).toHaveLength(0);
    await send(END_GROUP + 1);
    await send(END_GROUP + 2);

    expect(doneOf(peer)).toEqual([
      expect.objectContaining({ statusCode: BigInt(PublishDoneErrorCodeDraft18.SUBSCRIPTION_ENDED) }),
    ]);
    expect(sent).toHaveBeenCalledTimes(1);
    expect(peer.closed()).toBe(true);
  });

  it('leaves a draft-22 subscription open, as it has no such code', async () => {
    const { peer, send } = await publishing('draft-22');

    await send(END_GROUP);
    await send(END_GROUP + 1);

    expect(doneOf(peer)).toHaveLength(0);
    expect(peer.closed()).toBe(false);
  });
});
