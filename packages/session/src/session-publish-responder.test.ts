// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Answering a peer's PUBLISH (draft-22 §2.4.2, §3.1; draft-18 §9.5, §5.1):
 * namespaces match a prefix field by field, never as joined strings, and the
 * subscriber answers every PUBLISH with PUBLISH_OK or PUBLISH_ERROR.
 */

import { describe, it, expect } from 'vitest';
import { MessageTypeDraft18, RequestErrorCodeDraft18 } from '@moq-web/core';

import { makeSession, openIncoming, type Draft, type SessionInternals } from './__tests__/incoming-peer.js';
import { PublicationManager } from './publication-manager.js';
import { SubscriptionManager } from './subscription-manager.js';

const PEER_REQUEST_ID = 1n;
const TRACK_ALIAS = 9n;

function publish(namespace: string[], requestId = PEER_REQUEST_ID) {
  return {
    type: MessageTypeDraft18.PUBLISH,
    requestId,
    trackAlias: TRACK_ALIAS,
    trackNamespace: namespace,
    trackName: 'cam',
    forwardState: true,
  };
}

function subscribeTo(internals: SessionInternals, prefix: string[]): void {
  const namespaceSubscriptions = (internals as unknown as { namespaceSubscriptions: Map<number, unknown> }).namespaceSubscriptions;
  namespaceSubscriptions.set(1, { subscriptionId: 1, requestId: 100n, namespacePrefix: prefix, tracks: new Map() });
}

async function answerTo(internals: SessionInternals, namespace: string[]) {
  const peer = openIncoming(internals, publish(namespace));
  await peer.opened;

  return peer.written();
}

const accepted = [expect.objectContaining({ type: MessageTypeDraft18.REQUEST_OK })];
const uninterested = [
  expect.objectContaining({ type: MessageTypeDraft18.REQUEST_ERROR, errorCode: RequestErrorCodeDraft18.UNINTERESTED }),
];

describe.each(['draft-18', 'draft-22'] as const)('incoming PUBLISH (%s)', (draft: Draft) => {
  it('is accepted under the prefix of a namespace subscription', async () => {
    const { internals } = makeSession(draft);
    subscribeTo(internals, ['foo']);

    expect(await answerTo(internals, ['foo', 'bar'])).toEqual(accepted);
  });

  it('is not matched by a prefix that is only a string prefix of a field', async () => {
    const { internals } = makeSession(draft);
    subscribeTo(internals, ['foo']);

    expect(await answerTo(internals, ['foobar'])).toEqual(uninterested);
  });

  it('is not matched across a field that contains a slash', async () => {
    const { internals } = makeSession(draft);
    subscribeTo(internals, ['a/b']);

    expect(await answerTo(internals, ['a', 'b', 'c'])).toEqual(uninterested);
  });

  it('is answered, not dropped, when the track is our own', async () => {
    const { session, internals } = makeSession(draft);
    subscribeTo(internals, ['studio']);
    session.setOwnNamespacePrefix('studio/room/alice');

    expect(await answerTo(internals, ['studio', 'room', 'alice', 'cam'])).toEqual(uninterested);
  });

  it('is not taken for our own when a field only starts with ours', async () => {
    const { session, internals } = makeSession(draft);
    subscribeTo(internals, ['studio']);
    session.setOwnNamespacePrefix('studio/room/alice');

    expect(await answerTo(internals, ['studio', 'room', 'alice2', 'cam'])).toEqual(accepted);
  });
});

describe('track lookup by name', () => {
  const publication = (namespace: string[], trackName: string, trackAlias: bigint) => ({
    trackAlias,
    namespace,
    trackName,
    priority: 128,
    deliveryMode: 'stream' as const,
    requestId: trackAlias,
    cleanupHandlers: [],
    forward: 1,
  });

  it('keeps publications apart whose fields differ only in where the slashes are', () => {
    const manager = new PublicationManager();
    manager.add(publication(['a', 'b'], 'c', 1n));
    manager.add(publication(['a/b'], 'c', 2n));

    expect(manager.getByTrackName(['a/b'], 'c')?.trackAlias).toBe(2n);
    expect(manager.getByTrackName(['a', 'b'], 'c')?.trackAlias).toBe(1n);
  });

  it('keeps subscriptions apart whose fields differ only in where the slashes are', () => {
    const manager = new SubscriptionManager();
    const subscription = (namespace: string[], trackName: string, subscriptionId: number) => ({
      subscriptionId,
      requestId: BigInt(subscriptionId),
      namespace,
      trackName,
      paused: false,
      onObject: () => {},
    });
    manager.add(subscription(['a', 'b'], 'c', 1));
    manager.add(subscription(['a'], 'b/c', 2));

    expect(manager.getByTrackName(['a'], 'b/c')?.subscriptionId).toBe(2);
    expect(manager.getByFullTrackName(['a', 'b'], 'c')?.subscriptionId).toBe(1);
  });
});
