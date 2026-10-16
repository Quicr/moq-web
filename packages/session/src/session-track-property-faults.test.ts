// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Track Properties we cannot accept (draft-22 §3.7, §10.5-10.7; draft-18
 * §2.5.1, §12.5-12.7). A Mandatory Track Property we do not understand, in a
 * PUBLISH, SUBSCRIBE_OK or FETCH_OK, makes the track unusable: PUBLISH_ERROR
 * UNSUPPORTED_EXTENSION, or the subscription or fetch is cancelled. An
 * out-of-range value or Immutable Properties that do not parse close the
 * session with PROTOCOL_VIOLATION.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  Draft18BufferWriter,
  GroupOrder,
  MOQTVarInt,
  MessageTypeDraft18,
  RequestErrorCodeDraft18,
  SessionErrorCodeDraft18,
  TrackPropertyDraft18,
  encodeKeyValuePairs,
} from '@moq-web/core';

import { makeSession, openIncoming, type Draft } from './__tests__/incoming-peer.js';
import type { FetchErrorEvent } from './types.js';

const MANDATORY = 0x4000;
const NAMESPACE = ['ns'];
const TRACK = 't';
const RANGE = { startGroup: 0, startObject: 0, endGroup: 1, endObject: 0 };
const enc = (n: number): Uint8Array => MOQTVarInt.encode(BigInt(n));

const mandatory = new Map([[MANDATORY, enc(1)]]);
const badGroupOrder = new Map([[TrackPropertyDraft18.DEFAULT_PUBLISHER_GROUP_ORDER, enc(3)]]);

function immutable(properties: Map<number, Uint8Array>): Map<number, Uint8Array> {
  const writer = new Draft18BufferWriter();
  encodeKeyValuePairs(writer, properties);

  return new Map([[TrackPropertyDraft18.IMMUTABLE_PROPERTIES, writer.toUint8Array()]]);
}

const closedWith = (code: SessionErrorCodeDraft18) => expect.objectContaining({ code });

describe.each(['draft-18', 'draft-22'] as const)('Track Properties of a PUBLISH (%s)', (draft: Draft) => {
  function publish(trackProperties: Map<number, Uint8Array>) {
    return {
      type: MessageTypeDraft18.PUBLISH,
      requestId: 1n,
      trackAlias: 9n,
      trackNamespace: NAMESPACE,
      trackName: TRACK,
      forwardState: true,
      trackProperties,
    };
  }

  function wanting() {
    const onClose = vi.fn();
    const { session, internals } = makeSession(draft, onClose);
    (internals as unknown as { namespaceSubscriptions: Map<number, unknown> }).namespaceSubscriptions.set(
      1,
      { subscriptionId: 1, requestId: 100n, namespacePrefix: NAMESPACE, tracks: new Map() },
    );

    return { session, internals, onClose };
  }

  it('is answered with UNSUPPORTED_EXTENSION when it has a Mandatory Track Property', async () => {
    const { session, internals } = wanting();

    const peer = openIncoming(internals, publish(mandatory));
    await peer.opened;

    expect(peer.written()).toEqual([
      expect.objectContaining({ type: MessageTypeDraft18.REQUEST_ERROR, errorCode: RequestErrorCodeDraft18.UNSUPPORTED_EXTENSION }),
    ]);
    expect((session as unknown as { subscriptionManager: { size: number } }).subscriptionManager.size).toBe(0);
  });

  it('is answered the same when the Mandatory Track Property is inside Immutable Properties', async () => {
    const { internals } = wanting();

    const peer = openIncoming(internals, publish(immutable(mandatory)));
    await peer.opened;

    expect(peer.written()[0]).toMatchObject({ errorCode: RequestErrorCodeDraft18.UNSUPPORTED_EXTENSION });
  });

  it('closes the session for a group order out of range', async () => {
    const { internals, onClose } = wanting();

    await openIncoming(internals, publish(badGroupOrder)).opened;

    expect(onClose).toHaveBeenCalledWith(closedWith(SessionErrorCodeDraft18.PROTOCOL_VIOLATION));
  });

  it('is accepted with understood properties, including those inside Immutable Properties', async () => {
    const { internals, onClose } = wanting();
    const understood = immutable(new Map([
      [TrackPropertyDraft18.DEFAULT_PUBLISHER_GROUP_ORDER, enc(GroupOrder.DESCENDING)],
      [TrackPropertyDraft18.DYNAMIC_GROUPS, enc(1)],
    ]));

    const peer = openIncoming(internals, publish(understood));
    await peer.opened;

    expect(peer.written()[0].type).toBe(MessageTypeDraft18.REQUEST_OK);
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe.each(['draft-18', 'draft-22'] as const)('Track Properties of a SUBSCRIBE_OK (%s)', (draft: Draft) => {
  function subscribing(trackProperties: Map<number, Uint8Array>) {
    const onClose = vi.fn();
    const { session, internals } = makeSession(draft, onClose);
    const hooks = session as unknown as { sendRequestAndWaitResponse: unknown; abortRequestStream: unknown };
    hooks.sendRequestAndWaitResponse = async () => ({
      type: MessageTypeDraft18.SUBSCRIBE_OK,
      requestId: 0n,
      trackAlias: 1n,
      trackProperties,
    });
    const aborted = vi.fn().mockResolvedValue(undefined);
    hooks.abortRequestStream = aborted;

    return { session, internals, onClose, aborted };
  }

  it('cancels the subscription for a Mandatory Track Property', async () => {
    const { session, internals, aborted } = subscribing(mandatory);

    await expect(session.subscribe(NAMESPACE, TRACK)).rejects.toMatchObject({
      errorCode: RequestErrorCodeDraft18.UNSUPPORTED_EXTENSION,
    });

    expect(aborted).toHaveBeenCalledTimes(1);
    expect((internals as unknown as { subscriptionManager: { size: number } }).subscriptionManager.size).toBe(0);
  });

  it('closes the session for DYNAMIC_GROUPS above 1', async () => {
    const { session, onClose } = subscribing(new Map([[TrackPropertyDraft18.DYNAMIC_GROUPS, enc(2)]]));

    await session.subscribe(NAMESPACE, TRACK).catch(() => {});

    expect(onClose).toHaveBeenCalledWith(closedWith(SessionErrorCodeDraft18.PROTOCOL_VIOLATION));
  });

  it('reads the dynamic groups flag from Immutable Properties', async () => {
    const { session } = subscribing(immutable(new Map([[TrackPropertyDraft18.DYNAMIC_GROUPS, enc(1)]])));
    const events: Array<{ trackProperties?: { dynamicGroups?: boolean } }> = [];
    session.on('subscribe-ok', (event) => events.push(event));

    await session.subscribe(NAMESPACE, TRACK);

    expect(events[0].trackProperties?.dynamicGroups).toBe(true);
  });
});

describe.each(['draft-18', 'draft-22'] as const)('Track Properties of a FETCH_OK (%s)', (draft: Draft) => {
  function fetching(trackProperties: Map<number, Uint8Array>) {
    const { session } = makeSession(draft);
    const hooks = session as unknown as { sendRequestAndWaitResponse: unknown; abortRequestStream: unknown };
    hooks.sendRequestAndWaitResponse = async () => ({
      type: MessageTypeDraft18.FETCH_OK,
      requestId: 0n,
      endOfTrack: false,
      endLocation: { group: 1n, object: 1n },
      trackProperties,
    });
    const aborted = vi.fn().mockResolvedValue(undefined);
    hooks.abortRequestStream = aborted;
    const errors: FetchErrorEvent[] = [];
    session.on('fetch-error', (event) => errors.push(event));

    return { session, aborted, errors };
  }

  it('cancels the fetch for a Mandatory Track Property', async () => {
    const { session, aborted, errors } = fetching(mandatory);

    await session.fetch(NAMESPACE, TRACK, RANGE);

    expect(aborted).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([expect.objectContaining({ errorCode: RequestErrorCodeDraft18.UNSUPPORTED_EXTENSION })]);
  });
});
