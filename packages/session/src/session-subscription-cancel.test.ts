// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * A subscriber that cancels a subscription (draft-22 §3.1.2): the publisher
 * may drop its state but MUST reset every open stream of it, and produces
 * nothing more for it.
 */

import { describe, it, expect, vi } from 'vitest';
import { MOQTransport, StreamResetErrorCodeDraft18, type DraftVersion } from '@moq-web/core';

import { MOQTSession } from './session.js';
import { streamResetReason } from './stream-reset-reason.js';
import type { SubscriptionCancelledEvent } from './types.js';

const TRACK_ALIAS = 7n;
const REQUEST_ID = 3n;
const PAYLOAD = new Uint8Array([1, 2, 3]);
const OBJECT = { groupId: 4, objectId: 0, type: 'data' as const };

interface Internals {
  publicationManager: { add(p: unknown): void; getByRequestId(id: bigint): unknown };
  activeRequestStreams: Map<bigint, unknown>;
  doCreateStream: () => Promise<unknown>;
  doWriteStream: () => Promise<void>;
  handlePeerCancel: (id: bigint, stream: unknown) => Promise<void>;
}

function makeHarness(draft: DraftVersion) {
  const transport = new MOQTransport({ draft });
  (transport as unknown as { close: typeof transport.close }).close = vi.fn().mockResolvedValue(undefined);
  const session = new MOQTSession(transport);
  (session as unknown as { _state: string })._state = 'ready';
  const internals = session as unknown as Internals;

  const abort = vi.fn().mockResolvedValue(undefined);
  const createStream = vi.fn().mockResolvedValue({ writer: { abort, close: vi.fn() } });
  internals.doCreateStream = createStream;
  internals.doWriteStream = async () => {};
  internals.publicationManager.add({
    trackAlias: TRACK_ALIAS,
    namespace: ['ns'],
    trackName: 'track',
    priority: 128,
    deliveryMode: 'stream',
    requestId: REQUEST_ID,
    cleanupHandlers: [],
    forward: 1,
  });
  const requestStream = { abort: vi.fn().mockResolvedValue(undefined), close: vi.fn() };
  internals.activeRequestStreams.set(REQUEST_ID, requestStream);

  return { session, internals, abort, createStream, requestStream };
}

describe.each(['draft-18', 'draft-22'] as const)('subscription cancelled by the subscriber (%s)', (draft) => {
  it('resets the open subgroup stream and reports the cancellation', async () => {
    const h = makeHarness(draft);
    const cancelled: SubscriptionCancelledEvent[] = [];
    h.session.on('subscription-cancelled', (e) => cancelled.push(e));
    await h.session.sendObject(TRACK_ALIAS, PAYLOAD, OBJECT);

    await h.internals.handlePeerCancel(REQUEST_ID, h.requestStream);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.abort).toHaveBeenCalledWith(streamResetReason(StreamResetErrorCodeDraft18.CANCELLED));
    expect(h.internals.publicationManager.getByRequestId(REQUEST_ID)).toBeUndefined();
    expect(cancelled).toEqual([{ requestId: REQUEST_ID, trackAlias: TRACK_ALIAS }]);
  });

  it('sends nothing more on the dead alias', async () => {
    const h = makeHarness(draft);
    await h.internals.handlePeerCancel(REQUEST_ID, h.requestStream);

    await h.session.sendObject(TRACK_ALIAS, PAYLOAD, OBJECT);

    expect(h.createStream).not.toHaveBeenCalled();
  });
});
