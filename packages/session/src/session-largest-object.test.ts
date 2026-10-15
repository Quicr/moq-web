// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * LARGEST_OBJECT (draft-22 §9.20.17, draft-18 §10.2.11): "If Objects have
 * been published on this Track the Publisher MUST include this parameter."
 * Object {0, 0} is a real location, and absence means nothing was published.
 */

import { describe, it, expect } from 'vitest';
import {
  MessageTypeDraft18,
  Draft18MessageCodec,
  Draft22MessageCodec,
  SubscriptionFilterDraft18,
  type PublishMessageDraft18,
  type RequestOkMessageDraft18,
  type SubscribeOkMessageDraft18,
} from '@moq-web/core';

import { announce, makeSession, openIncoming, tick, type Draft, type SessionInternals } from './__tests__/incoming-peer.js';
import type { MOQTSession } from './session.js';

const FIRST_REQUEST_ID = 1n;
const SECOND_REQUEST_ID = 3n;
const UPDATE_REQUEST_ID = 5n;
const NAMESPACE = ['ns'];
const TRACK = 't';

function subscribe(draft: Draft, requestId: bigint) {
  return {
    type: MessageTypeDraft18.SUBSCRIBE,
    requestId,
    trackNamespace: NAMESPACE,
    trackName: TRACK,
    forwardState: true,
    ...(draft === 'draft-18' ? { filter: SubscriptionFilterDraft18.NEXT_GROUP_START } : {}),
  };
}

function ready(draft: Draft) {
  const { session, internals } = makeSession(draft);
  announce(internals, NAMESPACE);

  return { session, internals };
}

async function subscribeOk(internals: SessionInternals, draft: Draft, requestId: bigint) {
  const peer = openIncoming(internals, subscribe(draft, requestId));
  await peer.opened;

  return { peer, ok: peer.written()[0] as SubscribeOkMessageDraft18 };
}

function aliasOf(internals: SessionInternals, requestId: bigint): bigint {
  return internals.publicationManager.getByRequestId(requestId)!.trackAlias as bigint;
}

describe.each(['draft-18', 'draft-22'] as const)('publisher LARGEST_OBJECT (%s)', (draft) => {
  it('is omitted from SUBSCRIBE_OK while nothing was published', async () => {
    const { internals } = ready(draft);

    const { ok } = await subscribeOk(internals, draft, FIRST_REQUEST_ID);

    expect(ok.type).toBe(MessageTypeDraft18.SUBSCRIBE_OK);
    expect(ok.largestLocation).toBeUndefined();
  });

  it.each([
    ['the first Object', 0n, 0n],
    ['a later Object', 7n, 3n],
  ])('reports %s in SUBSCRIBE_OK, though its subscriber left', async (_name, group, object) => {
    const { internals } = ready(draft);
    const first = await subscribeOk(internals, draft, FIRST_REQUEST_ID);
    const alias = aliasOf(internals, FIRST_REQUEST_ID);
    internals.publicationManager.updateLatest(alias, group, object);
    (internals.publicationManager as unknown as { remove: (a: bigint) => void }).remove(alias);

    const { ok } = await subscribeOk(internals, draft, SECOND_REQUEST_ID);

    expect(first.ok.largestLocation).toBeUndefined();
    expect(ok.largestLocation).toEqual({ group, object });
  });

  it('is in the REQUEST_OK that answers a REQUEST_UPDATE', async () => {
    const { internals } = ready(draft);
    const { peer } = await subscribeOk(internals, draft, FIRST_REQUEST_ID);
    internals.publicationManager.updateLatest(aliasOf(internals, FIRST_REQUEST_ID), 2n, 0n);

    peer.send({ type: MessageTypeDraft18.REQUEST_UPDATE, requestId: UPDATE_REQUEST_ID, forwardState: true });
    await tick();

    const reply = peer.written()[1] as RequestOkMessageDraft18;
    expect(reply.type).toBe(MessageTypeDraft18.REQUEST_OK);
    expect(reply.largestLocation).toEqual({ group: 2n, object: 0n });
  });

  it('is in our PUBLISH once Objects were published', async () => {
    const { session, internals } = ready(draft);
    const sent: Uint8Array[] = [];
    (session as unknown as { sendRequestAndWaitResponse: unknown }).sendRequestAndWaitResponse = async (bytes: Uint8Array) => {
      sent.push(bytes);
      return { type: MessageTypeDraft18.REQUEST_OK, requestId: 0n };
    };
    const decode = draft === 'draft-18' ? Draft18MessageCodec.decode : Draft22MessageCodec.decode;
    const published = async (): Promise<PublishMessageDraft18> => {
      const alias = await session.publish(NAMESPACE, TRACK);
      const [message] = decode(sent[sent.length - 1]);
      internals.publicationManager.updateLatest(alias, 9n, 1n);
      await session.unpublish(alias);

      return message as PublishMessageDraft18;
    };

    const first = await published();
    const second = await published();

    expect(first.largestLocation).toBeUndefined();
    expect(second.largestLocation).toEqual({ group: 9n, object: 1n });
  });
});

describe.each(['draft-18', 'draft-22'] as const)('subscriber LARGEST_OBJECT (%s)', (draft) => {
  async function subscribedWith(largestLocation?: { group: bigint; object: bigint }) {
    const { session } = makeSession(draft);
    (session as unknown as { sendRequestAndWaitResponse: unknown }).sendRequestAndWaitResponse = async () => ({
      type: MessageTypeDraft18.SUBSCRIBE_OK,
      requestId: 0n,
      trackAlias: 1n,
      largestLocation,
    });
    const events: Array<{ contentExists: boolean; largestGroupId?: bigint; largestObjectId?: bigint }> = [];
    (session as MOQTSession).on('subscribe-ok', (e) => events.push(e));

    await session.subscribe(NAMESPACE, TRACK);

    return events[0];
  }

  it('takes {0, 0} as content that exists', async () => {
    const event = await subscribedWith({ group: 0n, object: 0n });

    expect(event).toMatchObject({ contentExists: true, largestGroupId: 0n, largestObjectId: 0n });
  });

  it('takes an omitted parameter as no content', async () => {
    const event = await subscribedWith(undefined);

    expect(event.contentExists).toBe(false);
  });
});
