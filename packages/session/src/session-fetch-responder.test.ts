// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Refusing a FETCH as a publisher. We keep no objects, so a FETCH we could
 * otherwise serve gets NOT_SUPPORTED. The errors the spec mandates come
 * first: DOES_NOT_EXIST for a track we do not publish, INVALID_RANGE when
 * nothing was published or the Start Location is past the Largest Object
 * (draft-22 §3.2, draft-18 §10.12.3), and for a Joining FETCH on a paused
 * subscription; INVALID_JOINING_REQUEST_ID for an unknown subscription
 * (draft-18 §10.12.2).
 */

import { describe, it, expect } from 'vitest';
import {
  FetchTypeDraft18,
  GroupOrder,
  LocationFilterTypeDraft22,
  MessageTypeDraft18,
  RequestErrorCodeDraft18,
  SubscriptionFilterDraft18,
  type RequestErrorMessageDraft18,
} from '@moq-web/core';

import { announce, makeSession, openIncoming, type Draft, type SessionInternals } from './__tests__/incoming-peer.js';

const SUBSCRIBE_ID = 1n;
const FETCH_ID = 3n;
const NAMESPACE = ['ns'];
const TRACK = 't';
const LARGEST_GROUP = 5n;
const LARGEST_OBJECT = 2n;
const PAUSED = 0;

type Start = { group: bigint; object: bigint };

function fetch(draft: Draft, start: Start, namespace = NAMESPACE) {
  const common = {
    type: MessageTypeDraft18.FETCH,
    requestId: FETCH_ID,
    trackNamespace: namespace,
    trackName: TRACK,
    subscriberPriority: 128,
    groupOrder: GroupOrder.ASCENDING,
  };
  if (draft === 'draft-22') {
    return { ...common, locationFilter: { type: LocationFilterTypeDraft22.ABSOLUTE_START, startLocation: start } };
  }

  return { ...common, fetchType: FetchTypeDraft18.STANDALONE, joiningFlag: false, startLocation: start, endLocation: { group: 9n, object: 0n } };
}

async function subscribed(internals: SessionInternals, draft: Draft) {
  const peer = openIncoming(internals, {
    type: MessageTypeDraft18.SUBSCRIBE,
    requestId: SUBSCRIBE_ID,
    trackNamespace: NAMESPACE,
    trackName: TRACK,
    forwardState: true,
    ...(draft === 'draft-18' ? { filter: SubscriptionFilterDraft18.NEXT_GROUP_START } : {}),
  });
  await peer.opened;

  return peer;
}

function publish(internals: SessionInternals): void {
  const alias = internals.publicationManager.getByRequestId(SUBSCRIBE_ID)!.trackAlias as bigint;
  internals.publicationManager.updateLatest(alias, LARGEST_GROUP, LARGEST_OBJECT);
}

async function refusal(internals: SessionInternals, message: unknown): Promise<RequestErrorMessageDraft18> {
  const peer = openIncoming(internals, message);
  await peer.opened;
  const [reply] = peer.written();
  expect(reply.type).toBe(MessageTypeDraft18.REQUEST_ERROR);
  expect(peer.closed()).toBe(true);

  return reply as RequestErrorMessageDraft18;
}

describe.each(['draft-18', 'draft-22'] as const)('FETCH as a publisher (%s)', (draft) => {
  const start = { group: 1n, object: 0n };

  it('says DOES_NOT_EXIST for a track it does not publish', async () => {
    const { internals } = makeSession(draft);

    const error = await refusal(internals, fetch(draft, start));

    expect(error.errorCode).toBe(RequestErrorCodeDraft18.DOES_NOT_EXIST);
  });

  it('says INVALID_RANGE while nothing was published', async () => {
    const { internals } = makeSession(draft);
    announce(internals, NAMESPACE);

    const error = await refusal(internals, fetch(draft, start));

    expect(error.errorCode).toBe(RequestErrorCodeDraft18.INVALID_RANGE);
  });

  it('says INVALID_RANGE when the start is after the Largest Object', async () => {
    const { internals } = makeSession(draft);
    announce(internals, NAMESPACE);
    await subscribed(internals, draft);
    publish(internals);

    const error = await refusal(internals, fetch(draft, { group: LARGEST_GROUP, object: LARGEST_OBJECT + 1n }));

    expect(error.errorCode).toBe(RequestErrorCodeDraft18.INVALID_RANGE);
  });

  it('says NOT_SUPPORTED for a range it cannot serve, as it keeps no objects', async () => {
    const { internals } = makeSession(draft);
    announce(internals, NAMESPACE);
    await subscribed(internals, draft);
    publish(internals);

    const error = await refusal(internals, fetch(draft, { group: LARGEST_GROUP, object: LARGEST_OBJECT }));

    expect(error.errorCode).toBe(RequestErrorCodeDraft18.NOT_SUPPORTED);
  });
});

describe('Joining FETCH as a publisher (draft-18)', () => {
  const draft = 'draft-18';
  const joining = (subscribeRequestId: bigint) => ({
    type: MessageTypeDraft18.FETCH,
    requestId: FETCH_ID,
    fetchType: FetchTypeDraft18.JOINING_RELATIVE,
    joiningFlag: true,
    subscribeRequestId,
    joiningStart: 1n,
    subscriberPriority: 128,
    groupOrder: GroupOrder.ASCENDING,
    startLocation: { group: 0n, object: 0n },
    endLocation: { group: 0n, object: 0n },
  });

  it('says INVALID_JOINING_REQUEST_ID for a subscription it does not have', async () => {
    const { internals } = makeSession(draft);
    announce(internals, NAMESPACE);

    const error = await refusal(internals, joining(SUBSCRIBE_ID));

    expect(error.errorCode).toBe(RequestErrorCodeDraft18.INVALID_JOINING_REQUEST_ID);
  });

  it('says INVALID_RANGE while nothing was published', async () => {
    const { internals } = makeSession(draft);
    announce(internals, NAMESPACE);
    await subscribed(internals, draft);

    const error = await refusal(internals, joining(SUBSCRIBE_ID));

    expect(error.errorCode).toBe(RequestErrorCodeDraft18.INVALID_RANGE);
  });

  it('says INVALID_RANGE for a subscription with Forward State 0', async () => {
    const { internals } = makeSession(draft);
    announce(internals, NAMESPACE);
    await subscribed(internals, draft);
    publish(internals);
    internals.publicationManager.getByRequestId(SUBSCRIBE_ID)!.forward = PAUSED;

    const error = await refusal(internals, joining(SUBSCRIBE_ID));

    expect(error.errorCode).toBe(RequestErrorCodeDraft18.INVALID_RANGE);
  });

  it('says NOT_SUPPORTED for a joining range it cannot serve', async () => {
    const { internals } = makeSession(draft);
    announce(internals, NAMESPACE);
    await subscribed(internals, draft);
    publish(internals);

    const error = await refusal(internals, joining(SUBSCRIBE_ID));

    expect(error.errorCode).toBe(RequestErrorCodeDraft18.NOT_SUPPORTED);
  });
});
