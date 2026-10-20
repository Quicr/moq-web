// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * TRACK_STATUS as a publisher (draft-22 §9.13, draft-18 §10.14): handled
 * identically to a SUBSCRIBE that creates no state, so a track we announce
 * answers though nobody subscribed, and LARGEST_OBJECT is the track's. As a
 * requester, Track Properties are only valid in a TRACK_STATUS_OK (§9.3).
 */

import { describe, it, expect } from 'vitest';
import {
  MOQTVarInt,
  MessageTypeDraft18,
  RequestErrorCodeDraft18,
  SessionErrorCodeDraft18,
  TrackPropertyDraft18,
  type RequestOkMessageDraft18,
} from '@moq-web/core';

import { announce, makeSession, openIncoming, tick, type Draft } from './__tests__/incoming-peer.js';

const NAMESPACE = ['ns'];
const TRACK = 't';
const PEER_REQUEST_ID = 1n;
const properties = new Map([[TrackPropertyDraft18.MAX_CACHE_DURATION, MOQTVarInt.encode(15_000n)]]);

function trackStatus(namespace = NAMESPACE) {
  return { type: MessageTypeDraft18.TRACK_STATUS, requestId: PEER_REQUEST_ID, trackNamespace: namespace, trackName: TRACK };
}

describe.each(['draft-18', 'draft-22'] as const)('incoming TRACK_STATUS (%s)', (draft: Draft) => {
  it('answers for a track under an announced namespace nobody subscribed to', async () => {
    const { internals } = makeSession(draft);
    announce(internals, NAMESPACE);

    const peer = openIncoming(internals, trackStatus());
    await peer.opened;

    const [reply] = peer.written() as RequestOkMessageDraft18[];
    expect(reply.type).toBe(MessageTypeDraft18.REQUEST_OK);
    expect(reply.largestLocation).toBeUndefined();
    expect(peer.closed()).toBe(true);
  });

  it('reports what the track has published, though it has no publication now', async () => {
    const { internals } = makeSession(draft);
    announce(internals, NAMESPACE);
    internals.publicationManager.add({
      trackAlias: 3n,
      namespace: NAMESPACE,
      trackName: TRACK,
      priority: 128,
      deliveryMode: 'stream',
      requestId: 9n,
      cleanupHandlers: [],
      forward: 1,
    });
    internals.publicationManager.updateLatest(3n, 6n, 0n);
    (internals.publicationManager as unknown as { remove: (a: bigint) => void }).remove(3n);

    const peer = openIncoming(internals, trackStatus());
    await peer.opened;

    expect((peer.written()[0] as RequestOkMessageDraft18).largestLocation).toEqual({ group: 6n, object: 0n });
  });

  it('answers for a track we publish without announcing its namespace', async () => {
    const { internals } = makeSession(draft);
    internals.publicationManager.add({
      trackAlias: 3n,
      namespace: ['other'],
      trackName: TRACK,
      priority: 128,
      deliveryMode: 'stream',
      requestId: 9n,
      cleanupHandlers: [],
      forward: 1,
    });

    const peer = openIncoming(internals, trackStatus(['other']));
    await peer.opened;

    expect(peer.written()[0].type).toBe(MessageTypeDraft18.REQUEST_OK);
  });

  it('says DOES_NOT_EXIST for a track it knows nothing of', async () => {
    const { internals } = makeSession(draft);

    const peer = openIncoming(internals, trackStatus());
    await peer.opened;

    expect(peer.written()).toEqual([
      expect.objectContaining({ type: MessageTypeDraft18.REQUEST_ERROR, errorCode: RequestErrorCodeDraft18.DOES_NOT_EXIST }),
    ]);
  });
});

describe.each(['draft-18', 'draft-22'] as const)('REQUEST_OK Track Properties (%s)', (draft: Draft) => {
  it('are reported with the result of our TRACK_STATUS', async () => {
    const { session } = makeSession(draft);
    (session as unknown as { sendRequestAndWaitResponse: unknown }).sendRequestAndWaitResponse = async () => ({
      type: MessageTypeDraft18.REQUEST_OK,
      requestId: 0n,
      trackProperties: properties,
    });

    const result = await session.trackStatus(NAMESPACE, TRACK);

    expect(result.trackProperties).toEqual({ maxCacheDurationMs: 15_000 });
  });

  it.each(['publish', 'subscribe-namespace', 'publish-namespace'])(
    'close the session when the REQUEST_OK of a %s request has them',
    async (kind) => {
      const closed: unknown[] = [];
      const { internals } = makeSession(draft, (options) => closed.push(options));
      (internals as unknown as { outgoingRequests: Map<bigint, unknown> }).outgoingRequests.set(
        0n,
        { kind, answered: false, announced: new Set() },
      );

      const accepted = (internals as unknown as {
        acceptFirstResponse: (id: bigint, m: unknown) => boolean;
      }).acceptFirstResponse(0n, { type: MessageTypeDraft18.REQUEST_OK, requestId: 0n, trackProperties: properties });
      await tick();

      expect(accepted).toBe(false);
      expect(closed).toEqual([expect.objectContaining({ code: SessionErrorCodeDraft18.PROTOCOL_VIOLATION })]);
    },
  );
});
