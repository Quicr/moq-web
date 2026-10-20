// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * FILL_PARAMETERS as a publisher (draft-22 §3.4, §3.4.1).
 *
 * A SUBSCRIBE or REQUEST_UPDATE with FILL_PARAMETERS makes the publisher open
 * a fill fetch stream, carrying the Request ID of that message. We keep no
 * object cache, so the stream is reset right after its FETCH_HEADER: "it MUST
 * open a fill fetch stream and reset it immediately after the FETCH_HEADER".
 * No stream is opened for an empty fill range or a paused subscription.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  Draft18StreamCodec,
  LocationFilterTypeDraft22,
  MessageTypeDraft18,
  StreamResetErrorCodeDraft18,
  type FillParametersDraft22,
  type LocationFilterDraft22,
  type PublishDoneMessageDraft18,
} from '@moq-web/core';

import { announce, makeSession, openIncoming, tick, type SessionInternals } from './__tests__/incoming-peer.js';
import { streamResetReason } from './stream-reset-reason.js';

const DRAFT = 'draft-22';
const FIRST_REQUEST_ID = 1n;
const SECOND_REQUEST_ID = 3n;
const UPDATE_REQUEST_ID = 5n;
const NAMESPACE = ['ns'];
const TRACK = 't';
const CURRENT_GROUP = 5n;
const LAST_OBJECT = 2n;

const currentGroup: FillParametersDraft22 = {
  locationFilter: {
    type: LocationFilterTypeDraft22.RELATIVE_START,
    startLocation: { group: 1n, object: 0n },
  },
};
const nextObject: LocationFilterDraft22 = { type: LocationFilterTypeDraft22.NEXT_OBJECT };

function subscribe(requestId: bigint, extra: object = {}) {
  return {
    type: MessageTypeDraft18.SUBSCRIBE,
    requestId,
    trackNamespace: NAMESPACE,
    trackName: TRACK,
    forwardState: true,
    ...extra,
  };
}

/** A session that has published up to {CURRENT_GROUP, LAST_OBJECT}, with the data streams it opens recorded. */
async function harness(published = true) {
  const { session, internals } = makeSession(DRAFT);
  announce(internals, NAMESPACE);
  const streams: Array<{ written: Uint8Array[]; abort: ReturnType<typeof vi.fn> }> = [];
  const hooks = session as unknown as {
    doCreateStream: () => Promise<unknown>;
    doWriteStream: (s: unknown, data: Uint8Array) => Promise<void>;
  };
  hooks.doCreateStream = async () => {
    const stream = { written: [] as Uint8Array[], abort: vi.fn().mockResolvedValue(undefined) };
    streams.push(stream);

    return { writer: stream };
  };
  hooks.doWriteStream = async (s, data) => {
    (s as { writer: { written: Uint8Array[] } }).writer.written.push(data);
  };

  if (published) {
    const earlier = openIncoming(internals, subscribe(FIRST_REQUEST_ID));
    await earlier.opened;
    const alias = internals.publicationManager.getByRequestId(FIRST_REQUEST_ID)!.trackAlias as bigint;
    internals.publicationManager.updateLatest(alias, CURRENT_GROUP, LAST_OBJECT);
  }

  return { session, internals, streams };
}

function fillHeader(requestId: bigint): Uint8Array {
  return Draft18StreamCodec.encodeFetchHeader(requestId);
}

describe('FILL_PARAMETERS on SUBSCRIBE (draft-22)', () => {
  it('opens a fill stream, resets it after the FETCH_HEADER, and counts it', async () => {
    const { internals, streams } = await harness();

    const peer = openIncoming(internals, subscribe(SECOND_REQUEST_ID, { fill: currentGroup }));
    await peer.opened;

    expect(streams).toHaveLength(1);
    expect(streams[0].written).toEqual([fillHeader(SECOND_REQUEST_ID)]);
    expect(streams[0].abort).toHaveBeenCalledWith(streamResetReason(StreamResetErrorCodeDraft18.INTERNAL_ERROR));
    expect(internals.publicationManager.getByRequestId(SECOND_REQUEST_ID)).toMatchObject({ streamsOpened: 1 });
  });

  it('sends SUBSCRIBE_OK before the fill stream', async () => {
    const { internals } = await harness();

    const peer = openIncoming(internals, subscribe(SECOND_REQUEST_ID, { fill: currentGroup }));
    await peer.opened;

    expect(peer.written()[0].type).toBe(MessageTypeDraft18.SUBSCRIBE_OK);
  });

  it('opens none without FILL_PARAMETERS', async () => {
    const { internals, streams } = await harness();

    await openIncoming(internals, subscribe(SECOND_REQUEST_ID)).opened;

    expect(streams).toHaveLength(0);
  });

  it('opens none while nothing has been published', async () => {
    const { internals, streams } = await harness(false);

    await openIncoming(internals, subscribe(SECOND_REQUEST_ID, { fill: currentGroup })).opened;

    expect(streams).toHaveLength(0);
  });

  it('opens none when the fill range starts after Largest Object', async () => {
    const { internals, streams } = await harness();
    const nextGroup = { locationFilter: { type: LocationFilterTypeDraft22.RELATIVE_START, startLocation: { group: 0n, object: 0n } } };

    await openIncoming(internals, subscribe(SECOND_REQUEST_ID, { fill: nextGroup })).opened;
    await openIncoming(internals, subscribe(7n, { fill: { locationFilter: nextObject } })).opened;

    expect(streams).toHaveLength(0);
  });

  it('fills the whole track when no Location filter selects the range', async () => {
    const { internals, streams } = await harness();

    await openIncoming(internals, subscribe(SECOND_REQUEST_ID, { fill: {} })).opened;

    expect(streams).toHaveLength(1);
  });

  it('takes the fill range from the subscription filter when FILL_PARAMETERS has none', async () => {
    const { internals, streams } = await harness();

    await openIncoming(internals, subscribe(SECOND_REQUEST_ID, { locationFilter: nextObject, fill: {} })).opened;

    expect(streams).toHaveLength(0);
  });

  it('opens none for a subscription that starts paused', async () => {
    const { internals, streams } = await harness();

    await openIncoming(internals, subscribe(SECOND_REQUEST_ID, { forwardState: false, fill: currentGroup })).opened;

    expect(streams).toHaveLength(0);
  });

  it('counts the fill stream in PUBLISH_DONE', async () => {
    const { session, internals } = await harness();
    const peer = openIncoming(internals, subscribe(SECOND_REQUEST_ID, { fill: currentGroup }));
    await peer.opened;

    await (session as unknown as { sendPublishDone: (...a: unknown[]) => Promise<void> }).sendPublishDone(SECOND_REQUEST_ID, 5, 2);

    const done = peer.written().find((m) => m.type === MessageTypeDraft18.PUBLISH_DONE) as PublishDoneMessageDraft18;
    expect(done.streamCount).toBe(1n);
  });
});

describe('FILL_PARAMETERS on REQUEST_UPDATE (draft-22)', () => {
  async function subscribed(internals: SessionInternals, extra: object = {}) {
    const peer = openIncoming(internals, subscribe(SECOND_REQUEST_ID, extra));
    await peer.opened;

    return peer;
  }

  it('labels the fill stream with the REQUEST_UPDATE Request ID', async () => {
    const { internals, streams } = await harness();
    const peer = await subscribed(internals);

    peer.send({ type: MessageTypeDraft18.REQUEST_UPDATE, requestId: UPDATE_REQUEST_ID, fill: currentGroup });
    await tick();

    expect(streams).toHaveLength(1);
    expect(streams[0].written).toEqual([fillHeader(UPDATE_REQUEST_ID)]);
    expect(streams[0].abort).toHaveBeenCalled();
  });

  it('opens none while the subscription is paused, nor on resuming without FILL_PARAMETERS', async () => {
    const { internals, streams } = await harness();
    const peer = await subscribed(internals, { forwardState: false });

    peer.send({ type: MessageTypeDraft18.REQUEST_UPDATE, requestId: UPDATE_REQUEST_ID, fill: currentGroup });
    await tick();
    peer.send({ type: MessageTypeDraft18.REQUEST_UPDATE, requestId: 7n, forwardState: true });
    await tick();

    expect(streams).toHaveLength(0);
  });

  it('opens one when the same update resumes the subscription', async () => {
    const { internals, streams } = await harness();
    const peer = await subscribed(internals, { forwardState: false });

    peer.send({ type: MessageTypeDraft18.REQUEST_UPDATE, requestId: UPDATE_REQUEST_ID, forwardState: true, fill: currentGroup });
    await tick();

    expect(streams).toHaveLength(1);
  });

  it('answers the update with REQUEST_OK before any fill stream', async () => {
    const { internals } = await harness();
    const peer = await subscribed(internals);

    peer.send({ type: MessageTypeDraft18.REQUEST_UPDATE, requestId: UPDATE_REQUEST_ID, fill: currentGroup });
    await tick();

    expect(peer.written()[1].type).toBe(MessageTypeDraft18.REQUEST_OK);
  });
});
