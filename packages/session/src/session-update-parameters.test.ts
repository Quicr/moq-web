// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * REQUEST_UPDATE parameters by the request they update (draft-22 §9.5;
 * draft-18 §10.2): one the request does not allow closes the session.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  MOQTransport,
  MessageTypeDraft18,
  MessageTypeDraft22,
  RequestParameterDraft18,
  RequestParameterDraft22,
  SessionErrorCodeDraft18,
  SubscriptionFilterDraft18,
} from '@moq-web/core';

import { MOQTSession } from './session.js';
import { disallowedUpdateParameter } from './session-helpers.js';

type Draft = 'draft-18' | 'draft-22';

const PEER_REQUEST_ID = 1n;
const UPDATE_ID = 3n;
const PRIORITY = Uint8Array.of(5);

describe('disallowedUpdateParameter', () => {
  it('allows what a subscription takes and names what it does not (draft-22)', () => {
    const subscribe = (message: object) => disallowedUpdateParameter(message, 'subscribe', 'draft-22');

    expect(subscribe({ forwardState: true, parameters: new Map([[RequestParameterDraft22.SUBSCRIBER_PRIORITY, PRIORITY]]) }))
      .toBeUndefined();
    expect(subscribe({ rangeFilters: [{ type: RequestParameterDraft22.OBJECTID_FILTER }] })).toBeUndefined();
    expect(subscribe({ rangeFilters: [{ type: RequestParameterDraft22.TRACK_PROPERTY_FILTER }] }))
      .toBe(RequestParameterDraft22.TRACK_PROPERTY_FILTER);
    expect(subscribe({ parameters: new Map([[RequestParameterDraft22.TRACK_NAMESPACE_PREFIX, PRIORITY]]) }))
      .toBe(RequestParameterDraft22.TRACK_NAMESPACE_PREFIX);
  });

  it('allows a namespace request only its own parameters (draft-22)', () => {
    const update = (kind: string, message: object) => disallowedUpdateParameter(message, kind, 'draft-22');

    expect(update('subscribe-namespace', { parameters: new Map([[RequestParameterDraft22.TRACK_NAMESPACE_PREFIX, PRIORITY]]) }))
      .toBeUndefined();
    expect(update('subscribe-namespace', { forwardState: true })).toBe(RequestParameterDraft22.FORWARD);
    expect(update('subscribe-tracks', { forwardState: true })).toBeUndefined();
    expect(update('publish-namespace', { authTokens: [new Uint8Array(1)] })).toBeUndefined();
    expect(update('publish-namespace', { fill: {} })).toBe(RequestParameterDraft22.FILL_PARAMETERS);
    expect(update('fetch', { parameters: new Map([[RequestParameterDraft22.SUBSCRIBER_PRIORITY, PRIORITY]]) }))
      .toBeUndefined();
    expect(update('fetch', { forwardState: false })).toBe(RequestParameterDraft22.FORWARD);
  });

  it('applies the draft-18 parameter lists', () => {
    const update = (kind: string, message: object) => disallowedUpdateParameter(message, kind, 'draft-18');

    expect(update('subscribe', { filter: SubscriptionFilterDraft18.ABSOLUTE_START, forwardState: true })).toBeUndefined();
    expect(update('publish-namespace', { forwardState: true })).toBe(RequestParameterDraft18.FORWARD);
    expect(update('subscribe-namespace', { parameters: new Map([[RequestParameterDraft18.SUBSCRIBER_PRIORITY, PRIORITY]]) }))
      .toBe(RequestParameterDraft18.SUBSCRIBER_PRIORITY);
  });
});

describe.each(['draft-18', 'draft-22'] as const)('REQUEST_UPDATE on a request stream (%s)', (draft) => {
  async function peerRequest(first: object, update: object) {
    const transport = new MOQTransport({ draft: draft as Draft });
    (transport as unknown as { close: typeof transport.close }).close = vi.fn().mockResolvedValue(undefined);
    const session = new MOQTSession(transport);
    (session as unknown as { _state: string })._state = 'ready';
    const internals = session as unknown as {
      codec: { encodeControlMessage: (m: unknown) => Uint8Array };
      announcedNamespaces: Map<string, unknown>;
      processIncomingBidiStream: (s: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }) => Promise<void>;
    };
    internals.announcedNamespaces.set('ns', { namespace: ['ns'], options: {}, subscribers: new Map() });
    const close = vi.spyOn(session, 'close').mockResolvedValue(undefined);
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    await internals.processIncomingBidiStream({
      readable: new ReadableStream<Uint8Array>({
        start: (c) => {
          controller = c;
          c.enqueue(internals.codec.encodeControlMessage(first));
        },
      }),
      writable: new WritableStream<Uint8Array>(),
    });

    controller.enqueue(internals.codec.encodeControlMessage(update));
    await new Promise((resolve) => setTimeout(resolve, 0));

    return close;
  }

  const priorityUpdate = {
    type: MessageTypeDraft18.REQUEST_UPDATE,
    requestId: UPDATE_ID,
    parameters: new Map([[RequestParameterDraft18.SUBSCRIBER_PRIORITY, PRIORITY]]),
  };

  it('closes the session on a priority change for a SUBSCRIBE_NAMESPACE', async () => {
    const close = await peerRequest(
      { type: MessageTypeDraft18.SUBSCRIBE_NAMESPACE, requestId: PEER_REQUEST_ID, trackNamespacePrefix: ['ns'] },
      priorityUpdate,
    );

    expect(close).toHaveBeenCalledWith(expect.objectContaining({ code: SessionErrorCodeDraft18.PROTOCOL_VIOLATION }));
  });

  it('accepts the same change for a SUBSCRIBE', async () => {
    const close = await peerRequest(
      {
        type: draft === 'draft-22' ? MessageTypeDraft22.SUBSCRIBE : MessageTypeDraft18.SUBSCRIBE,
        requestId: PEER_REQUEST_ID,
        trackNamespace: ['ns'],
        trackName: 't',
        forwardState: true,
        ...(draft === 'draft-18' ? { filter: SubscriptionFilterDraft18.NEXT_GROUP_START } : {}),
      },
      priorityUpdate,
    );

    expect(close).not.toHaveBeenCalled();
  });
});
