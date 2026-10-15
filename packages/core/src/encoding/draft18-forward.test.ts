// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Draft-18 FORWARD (§10.2.12): the value reaches the receiver in SUBSCRIBE,
 * PUBLISH and PUBLISH_OK, an omitted value is 1, and an omitted value in
 * REQUEST_UPDATE leaves the subscription's state alone (Review C-07).
 */

import { describe, it, expect } from 'vitest';
import { Draft18MessageCodec } from './draft18-message-codec';
import {
  MessageTypeDraft18,
  RequestParameterDraft18,
  SubscriptionFilterDraft18,
  type PublishMessageDraft18,
  type RequestOkMessageDraft18,
  type RequestUpdateMessageDraft18,
  type SubscribeMessageDraft18,
} from '../messages/types';

const subscribe: SubscribeMessageDraft18 = {
  type: MessageTypeDraft18.SUBSCRIBE,
  requestId: 1n,
  trackNamespace: ['ns'],
  trackName: 't',
  forwardState: true,
  filter: SubscriptionFilterDraft18.NEXT_GROUP_START,
};

const publish: PublishMessageDraft18 = {
  type: MessageTypeDraft18.PUBLISH,
  requestId: 1n,
  trackAlias: 5n,
  trackNamespace: ['ns'],
  trackName: 't',
  forwardState: true,
  largestLocation: { group: 0n, object: 0n },
};

function roundTrip<T>(message: unknown): T {
  return Draft18MessageCodec.decode(Draft18MessageCodec.encode(message as never))[0] as unknown as T;
}

describe('draft-18 FORWARD', () => {
  it('carries SUBSCRIBE forwardState false', () => {
    expect(roundTrip<SubscribeMessageDraft18>({ ...subscribe, forwardState: false }).forwardState).toBe(false);
    expect(roundTrip<SubscribeMessageDraft18>(subscribe).forwardState).toBe(true);
  });

  it('keeps FORWARD out of the SUBSCRIBE parameter map', () => {
    expect(roundTrip<SubscribeMessageDraft18>({ ...subscribe, forwardState: false }).parameters).toBeUndefined();
  });

  it('carries PUBLISH forwardState false', () => {
    expect(roundTrip<PublishMessageDraft18>({ ...publish, forwardState: false }).forwardState).toBe(false);
    expect(roundTrip<PublishMessageDraft18>(publish).forwardState).toBe(true);
  });

  it('carries FORWARD in a PUBLISH_OK, absent when omitted', () => {
    const ok: RequestOkMessageDraft18 = { type: MessageTypeDraft18.REQUEST_OK, requestId: 0n };

    expect(roundTrip<RequestOkMessageDraft18>({ ...ok, forwardState: false }).forwardState).toBe(false);
    expect(roundTrip<RequestOkMessageDraft18>(ok).forwardState).toBeUndefined();
  });

  it('leaves forwardState undefined in a REQUEST_UPDATE that omits FORWARD', () => {
    const update: RequestUpdateMessageDraft18 = {
      type: MessageTypeDraft18.REQUEST_UPDATE,
      requestId: 3n,
      parameters: new Map([[RequestParameterDraft18.SUBSCRIBER_PRIORITY, Uint8Array.of(9)]]),
    };

    const decoded = roundTrip<RequestUpdateMessageDraft18>(update);

    expect(decoded.forwardState).toBeUndefined();
    expect(decoded.parameters?.get(RequestParameterDraft18.SUBSCRIBER_PRIORITY)).toEqual(Uint8Array.of(9));
  });

  it('writes FORWARD in a REQUEST_UPDATE only when set', () => {
    const update: RequestUpdateMessageDraft18 = { type: MessageTypeDraft18.REQUEST_UPDATE, requestId: 3n };

    expect(roundTrip<RequestUpdateMessageDraft18>(update).forwardState).toBeUndefined();
    expect(roundTrip<RequestUpdateMessageDraft18>({ ...update, forwardState: false }).forwardState).toBe(false);
  });
});
