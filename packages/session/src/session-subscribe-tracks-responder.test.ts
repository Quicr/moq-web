// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Responding to a peer's SUBSCRIBE_TRACKS (draft-22 §3.6, draft-18 §10.19).
 *
 * The peer asks for PUBLISH messages for the tracks under a prefix. Our
 * tracks are PUBLISHed by the application, so the session reports the request
 * and the application publishes, or sends PUBLISH_SKIPPED. A prefix that
 * shares a common prefix with an established SUBSCRIBE_TRACKS is refused with
 * PREFIX_OVERLAP; SUBSCRIBE_TRACKS and SUBSCRIBE_NAMESPACE have independent
 * overlap spaces.
 */

import { describe, it, expect } from 'vitest';
import { MessageTypeDraft18, RequestErrorCodeDraft18, SubscriptionFilterDraft18 } from '@moq-web/core';

import { announce, makeSession, openIncoming, tick, type Draft } from './__tests__/incoming-peer.js';

const FIRST_PEER_ID = 1n;
const SECOND_PEER_ID = 3n;

function subscribeTracks(draft: Draft, requestId: bigint, prefix: string[], forwardState = true) {
  return {
    type: MessageTypeDraft18.SUBSCRIBE_TRACKS,
    requestId,
    trackNamespacePrefix: prefix,
    forwardState,
    ...(draft === 'draft-18' ? { filter: SubscriptionFilterDraft18.NEXT_GROUP_START } : {}),
  };
}

describe.each(['draft-18', 'draft-22'] as const)('incoming SUBSCRIBE_TRACKS (%s)', (draft) => {
  it('is reported to the application with its prefix and Forward State', async () => {
    const { session, internals } = makeSession(draft);
    const requests: unknown[] = [];
    session.on('incoming-subscribe-tracks', (event) => requests.push(event));

    const peer = openIncoming(internals, subscribeTracks(draft, FIRST_PEER_ID, ['room'], false));
    await peer.opened;

    expect(peer.written()).toEqual([expect.objectContaining({ type: MessageTypeDraft18.REQUEST_OK })]);
    expect(requests).toEqual([{ requestId: FIRST_PEER_ID, namespacePrefix: ['room'], forwardState: false }]);
  });

  it('does not report our existing tracks as subscriptions', async () => {
    const { session, internals } = makeSession(draft);
    announce(internals, ['room']);
    const subscribed: unknown[] = [];
    session.on('incoming-subscribe', (event) => subscribed.push(event));
    await openIncoming(internals, {
      type: MessageTypeDraft18.SUBSCRIBE,
      requestId: FIRST_PEER_ID,
      trackNamespace: ['room'],
      trackName: 't',
      forwardState: true,
      ...(draft === 'draft-18' ? { filter: SubscriptionFilterDraft18.NEXT_GROUP_START } : {}),
    }).opened;
    subscribed.length = 0;

    await openIncoming(internals, subscribeTracks(draft, SECOND_PEER_ID, ['room'])).opened;

    expect(subscribed).toEqual([]);
  });

  it.each([
    ['a prefix of it', ['room'], ['room', 'a']],
    ['an extension of it', ['room', 'a'], ['room']],
    ['the same prefix', ['room'], ['room']],
    ['the empty prefix', ['room'], []],
  ])('refuses %s with PREFIX_OVERLAP', async (_name, established, overlapping) => {
    const { session, internals } = makeSession(draft);
    const requests: unknown[] = [];
    session.on('incoming-subscribe-tracks', (event) => requests.push(event));
    await openIncoming(internals, subscribeTracks(draft, FIRST_PEER_ID, established)).opened;

    const second = openIncoming(internals, subscribeTracks(draft, SECOND_PEER_ID, overlapping));
    await second.opened;

    expect(second.written()).toEqual([
      expect.objectContaining({ type: MessageTypeDraft18.REQUEST_ERROR, errorCode: RequestErrorCodeDraft18.PREFIX_OVERLAP }),
    ]);
    expect(second.closed()).toBe(true);
    expect(requests).toHaveLength(1);
  });

  it('accepts a disjoint prefix, and the same one once the first ended', async () => {
    const { internals } = makeSession(draft);
    const first = openIncoming(internals, subscribeTracks(draft, FIRST_PEER_ID, ['room']));
    await first.opened;

    const disjoint = openIncoming(internals, subscribeTracks(draft, SECOND_PEER_ID, ['rooms']));
    await disjoint.opened;
    first.fin();
    await tick();
    const again = openIncoming(internals, subscribeTracks(draft, 5n, ['room']));
    await again.opened;

    expect(disjoint.written()[0].type).toBe(MessageTypeDraft18.REQUEST_OK);
    expect(again.written()[0].type).toBe(MessageTypeDraft18.REQUEST_OK);
  });

  it('has its own overlap space apart from SUBSCRIBE_NAMESPACE', async () => {
    const { internals } = makeSession(draft);
    await openIncoming(internals, {
      type: MessageTypeDraft18.SUBSCRIBE_NAMESPACE,
      requestId: FIRST_PEER_ID,
      trackNamespacePrefix: ['room'],
    }).opened;

    const peer = openIncoming(internals, subscribeTracks(draft, SECOND_PEER_ID, ['room']));
    await peer.opened;

    expect(peer.written()[0].type).toBe(MessageTypeDraft18.REQUEST_OK);
  });
});
