// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Publisher delivery timeouts (draft-18 §8 / draft-22 §5.2).
 *
 * - SUBGROUP_DELIVERY_TIMEOUT starts when the subgroup's FIN is written and
 *   resets the stream if it is not committed in time. A subgroup still being
 *   written is never reset.
 * - OBJECT_DELIVERY_TIMEOUT is checked before an object reaches the
 *   transport; an expired object resets its stream and the subgroup gets no
 *   new stream.
 * - The effective value is the smaller of the track's and the subscriber's.
 * - Nothing is enforced that nobody asked for.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MOQTransport, StreamResetErrorCodeDraft18, type DraftVersion } from '@moq-web/core';

import { MOQTSession } from './session.js';
import { streamResetReason } from './stream-reset-reason.js';
import type { DeliveryTimeoutEvent } from './types.js';

const TRACK_ALIAS = 7n;
const GROUP = 4;
const NEXT_GROUP = 5;
const PAYLOAD = new Uint8Array([1, 2, 3]);
const TIMEOUT_MS = 50;
const PAST_TIMEOUT_MS = 60;
const LONG_GOP_MS = 10_000;

interface FakeStream {
  writer: WritableStreamDefaultWriter<Uint8Array>;
  streamId: number;
  abort: ReturnType<typeof vi.fn>;
  /** Settles the pending close, as a transport does once all data is committed */
  commit(): void;
}

interface Internals {
  publisherTimeoutConfig: Map<string, { subgroupDeliveryTimeoutMs?: number }>;
  publicationManager: {
    add(p: unknown): void;
    get(alias: bigint): { subscriberSubgroupTimeoutMs?: number; subscriberObjectTimeoutMs?: number } | undefined;
  };
  doCreateStream: () => Promise<FakeStream>;
  doWriteStream: (info: FakeStream, data: Uint8Array) => Promise<void>;
}

function fakeStream(streamId: number): FakeStream {
  const abort = vi.fn();
  let settle!: () => void;
  const closing = new Promise<void>((resolve, reject) => {
    settle = resolve;
    // An abort fails the pending close, as on a real stream
    abort.mockImplementation(async () => reject(new Error('aborted')));
  });
  closing.catch(() => {});
  const writer = {
    abort,
    close: vi.fn(() => closing),
    write: vi.fn().mockResolvedValue(undefined),
    releaseLock: vi.fn(),
  } as unknown as WritableStreamDefaultWriter<Uint8Array>;

  return { writer, streamId, abort, commit: settle };
}

function makeHarness(
  draft: DraftVersion,
  timeouts: { track?: number; subscriberSubgroup?: number; subscriberObject?: number } = {},
) {
  const transport = new MOQTransport({ draft });
  (transport as unknown as { close: typeof transport.close }).close = vi.fn().mockResolvedValue(undefined);
  const session = new MOQTSession(transport);
  (session as unknown as { _state: string })._state = 'ready';
  const internals = session as unknown as Internals;

  const streams: FakeStream[] = [];
  const writes: Uint8Array[] = [];
  internals.doCreateStream = async () => {
    const stream = fakeStream(streams.length + 1);
    streams.push(stream);
    return stream;
  };
  internals.doWriteStream = async (_info, data) => {
    writes.push(data);
  };

  internals.publicationManager.add({
    trackAlias: TRACK_ALIAS,
    namespace: ['ns'],
    trackName: 'track',
    priority: 128,
    deliveryMode: 'stream',
    requestId: 4n,
    cleanupHandlers: [],
    forward: 1,
  });
  const publication = internals.publicationManager.get(TRACK_ALIAS)!;
  publication.subscriberSubgroupTimeoutMs = timeouts.subscriberSubgroup;
  publication.subscriberObjectTimeoutMs = timeouts.subscriberObject;
  if (timeouts.track !== undefined) {
    internals.publisherTimeoutConfig.set(TRACK_ALIAS.toString(), { subgroupDeliveryTimeoutMs: timeouts.track });
  }

  const events: DeliveryTimeoutEvent[] = [];
  session.on('delivery-timeout', (event) => events.push(event as DeliveryTimeoutEvent));
  const send = (groupId: number, objectId: number) =>
    session.sendObject(TRACK_ALIAS, PAYLOAD, { groupId, objectId, type: 'data' });

  return { session, internals, streams, writes, events, send };
}

describe.each(['draft-18', 'draft-22'] as const)('publisher delivery timeouts (%s)', (draft) => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('never resets a healthy subgroup that stays open for a long GOP', async () => {
    const h = makeHarness(draft, { track: TIMEOUT_MS });

    await h.send(GROUP, 0);
    await vi.advanceTimersByTimeAsync(LONG_GOP_MS);
    await h.send(GROUP, 1);

    expect(h.streams[0].abort).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
  });

  it('applies no default timeout when none was advertised or requested', async () => {
    const h = makeHarness(draft);

    await h.send(GROUP, 0);
    const next = h.send(NEXT_GROUP, 0);
    await vi.advanceTimersByTimeAsync(LONG_GOP_MS);
    h.streams[0].commit();
    await next;

    expect(h.streams[0].abort).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
  });

  it('resets a finished subgroup that is not committed within the timeout, with DELIVERY_TIMEOUT', async () => {
    const h = makeHarness(draft, { track: TIMEOUT_MS });

    await h.send(GROUP, 0);
    const next = h.send(NEXT_GROUP, 0);
    await vi.advanceTimersByTimeAsync(PAST_TIMEOUT_MS);
    await next;

    expect(h.streams[0].abort).toHaveBeenCalledWith(streamResetReason(StreamResetErrorCodeDraft18.DELIVERY_TIMEOUT));
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({ side: 'publisher', reason: 'subgroup', groupId: GROUP });
  });

  it('leaves a subgroup alone when its FIN is committed in time', async () => {
    const h = makeHarness(draft, { track: TIMEOUT_MS });

    await h.send(GROUP, 0);
    const next = h.send(NEXT_GROUP, 0);
    h.streams[0].commit();
    await next;
    await vi.advanceTimersByTimeAsync(PAST_TIMEOUT_MS);

    expect(h.streams[0].abort).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
  });

  it('uses the smaller of the track and subscriber subgroup timeouts', async () => {
    const h = makeHarness(draft, { track: LONG_GOP_MS, subscriberSubgroup: TIMEOUT_MS });

    await h.send(GROUP, 0);
    const next = h.send(NEXT_GROUP, 0);
    await vi.advanceTimersByTimeAsync(PAST_TIMEOUT_MS);
    await next;

    expect(h.streams[0].abort).toHaveBeenCalledTimes(1);
  });

  it('drops an object that waited past OBJECT_DELIVERY_TIMEOUT, resetting the stream and not reopening the subgroup', async () => {
    const h = makeHarness(draft, { subscriberObject: TIMEOUT_MS });
    const create = h.internals.doCreateStream;
    // The transport takes longer to open the stream than the object may wait
    h.internals.doCreateStream = async () => {
      await new Promise((resolve) => setTimeout(resolve, PAST_TIMEOUT_MS));
      return create();
    };

    const first = h.send(GROUP, 0);
    await vi.advanceTimersByTimeAsync(PAST_TIMEOUT_MS);
    await first;
    await h.send(GROUP, 1);
    await vi.advanceTimersByTimeAsync(PAST_TIMEOUT_MS);

    expect(h.writes).toEqual([]);
    expect(h.streams).toHaveLength(1);
    expect(h.streams[0].abort).toHaveBeenCalledWith(streamResetReason(StreamResetErrorCodeDraft18.DELIVERY_TIMEOUT));
    expect(h.events[0]).toMatchObject({ side: 'publisher', reason: 'object', groupId: GROUP });
  });
});
