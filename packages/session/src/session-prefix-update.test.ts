// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * TRACK_NAMESPACE_PREFIX in a REQUEST_UPDATE (draft-22 §9.5.2, §9.20.20;
 * draft-18 §10.9.2): the prefix of an established SUBSCRIBE_NAMESPACE or
 * SUBSCRIBE_TRACKS changes. The new prefix must not share a common prefix
 * with another active request of the same type (PREFIX_OVERLAP, which also
 * ends the request), and NAMESPACE and NAMESPACE_DONE sent after the
 * REQUEST_OK carry suffixes relative to the updated prefix.
 */

import { describe, it, expect } from 'vitest';
import {
  Draft18BufferWriter,
  MessageTypeDraft18,
  RequestErrorCodeDraft18,
  RequestParameterDraft18,
  SubscriptionFilterDraft18,
  encodeTrackNamespace,
} from '@moq-web/core';

import { announce, makeSession, openIncoming, tick, type Draft } from './__tests__/incoming-peer.js';

const FIRST_ID = 1n;
const SECOND_ID = 3n;
const UPDATE_ID = 5n;
const NEXT_UPDATE_ID = 7n;

function prefixUpdate(requestId: bigint, prefix: string[]) {
  const writer = new Draft18BufferWriter();
  encodeTrackNamespace(writer, prefix);

  return {
    type: MessageTypeDraft18.REQUEST_UPDATE,
    requestId,
    parameters: new Map([[RequestParameterDraft18.TRACK_NAMESPACE_PREFIX, writer.toUint8Array()]]),
  };
}

const subscribeNamespace = (requestId: bigint, prefix: string[]) =>
  ({ type: MessageTypeDraft18.SUBSCRIBE_NAMESPACE, requestId, trackNamespacePrefix: prefix });

const subscribeTracks = (draft: Draft, requestId: bigint, prefix: string[]) => ({
  type: MessageTypeDraft18.SUBSCRIBE_TRACKS,
  requestId,
  trackNamespacePrefix: prefix,
  forwardState: true,
  ...(draft === 'draft-18' ? { filter: SubscriptionFilterDraft18.NEXT_GROUP_START } : {}),
});

const overlap = expect.objectContaining({
  type: MessageTypeDraft18.REQUEST_ERROR,
  errorCode: RequestErrorCodeDraft18.PREFIX_OVERLAP,
});

describe.each(['draft-18', 'draft-22'] as const)('prefix update of SUBSCRIBE_NAMESPACE (%s)', (draft: Draft) => {
  it('sends NAMESPACE for what the new prefix adds, relative to it, after the REQUEST_OK', async () => {
    const { internals } = makeSession(draft);
    announce(internals, ['conf', 'a']);
    announce(internals, ['x', 'y']);
    const peer = openIncoming(internals, subscribeNamespace(FIRST_ID, ['conf']));
    await peer.opened;

    peer.send(prefixUpdate(UPDATE_ID, ['x']));
    await tick();

    expect(peer.written().slice(2)).toEqual([
      expect.objectContaining({ type: MessageTypeDraft18.REQUEST_OK }),
      expect.objectContaining({ type: MessageTypeDraft18.NAMESPACE, trackNamespace: ['y'] }),
    ]);
  });

  it('does not repeat a namespace the old prefix announced and the new one still matches', async () => {
    const { internals } = makeSession(draft);
    announce(internals, ['conf', 'a']);
    const peer = openIncoming(internals, subscribeNamespace(FIRST_ID, ['conf']));
    await peer.opened;

    peer.send(prefixUpdate(UPDATE_ID, ['conf', 'a']));
    await tick();

    expect(peer.written()).toHaveLength(3);
  });

  it('follows the updated prefix: suffixes are relative to it, and old matches are dropped', async () => {
    const { session, internals } = makeSession(draft);
    announce(internals, ['x', 'y']);
    const peer = openIncoming(internals, subscribeNamespace(FIRST_ID, ['conf']));
    await peer.opened;
    peer.send(prefixUpdate(UPDATE_ID, ['x']));
    await tick();

    await session.cancelAnnounce(['x', 'y']);
    (session as unknown as { sendRequestAndWaitResponse: unknown }).sendRequestAndWaitResponse = async () => ({
      type: MessageTypeDraft18.REQUEST_OK,
      requestId: 0n,
    });
    await session.announceNamespace(['conf', 'late']);
    await tick();

    const messages = peer.written().slice(3);
    expect(messages).toEqual([expect.objectContaining({ type: MessageTypeDraft18.NAMESPACE_DONE, finalNamespace: ['y'] })]);
  });

  it('refuses a prefix that overlaps another request, and ends the request', async () => {
    const { internals } = makeSession(draft);
    await openIncoming(internals, subscribeNamespace(FIRST_ID, ['a'])).opened;
    const second = openIncoming(internals, subscribeNamespace(SECOND_ID, ['b']));
    await second.opened;

    second.send(prefixUpdate(UPDATE_ID, ['a', 'c']));
    await tick();

    expect(second.written()[1]).toEqual(overlap);
    expect(second.closed()).toBe(true);
  });

  it('may extend its own prefix, and frees the old one', async () => {
    const { internals } = makeSession(draft);
    const first = openIncoming(internals, subscribeNamespace(FIRST_ID, ['a']));
    await first.opened;
    first.send(prefixUpdate(UPDATE_ID, ['a', 'b']));
    await tick();

    const second = openIncoming(internals, subscribeNamespace(SECOND_ID, ['a', 'z']));
    await second.opened;
    first.send(prefixUpdate(NEXT_UPDATE_ID, ['q']));
    await tick();
    const third = openIncoming(internals, subscribeNamespace(9n, ['a', 'b']));
    await third.opened;

    expect(first.written()[2]).toMatchObject({ type: MessageTypeDraft18.REQUEST_OK });
    expect(second.written()[0]).toMatchObject({ type: MessageTypeDraft18.REQUEST_OK });
    expect(third.written()[0]).toMatchObject({ type: MessageTypeDraft18.REQUEST_OK });
  });
});

describe.each(['draft-18', 'draft-22'] as const)('prefix update of SUBSCRIBE_TRACKS (%s)', (draft: Draft) => {
  it('refuses an overlapping prefix with PREFIX_OVERLAP, in its own overlap space', async () => {
    const { internals } = makeSession(draft);
    await openIncoming(internals, subscribeNamespace(FIRST_ID, ['a'])).opened;
    await openIncoming(internals, subscribeTracks(draft, SECOND_ID, ['b'])).opened;
    const tracks = openIncoming(internals, subscribeTracks(draft, 9n, ['c']));
    await tracks.opened;

    tracks.send(prefixUpdate(UPDATE_ID, ['a']));
    await tick();
    expect(tracks.written()[1]).toMatchObject({ type: MessageTypeDraft18.REQUEST_OK });

    tracks.send(prefixUpdate(NEXT_UPDATE_ID, ['b', 'x']));
    await tick();
    expect(tracks.written()[2]).toEqual(overlap);
    expect(tracks.closed()).toBe(true);
  });
});
