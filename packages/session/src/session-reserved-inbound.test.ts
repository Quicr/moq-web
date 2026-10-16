// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Requests under reserved namespaces (draft-22 §2.4.3, §6.5; draft-18 §3.2.1,
 * §3.2.2). A namespace whose first field is exactly "." is rejected with
 * DOES_NOT_EXIST. So is anything under ".session", as we define no
 * session-level tracks or namespaces and such a request is not passed to the
 * application. Another namespace starting with "." is passed on.
 */

import { describe, it, expect } from 'vitest';
import {
  GroupOrder,
  MessageTypeDraft18,
  RequestErrorCodeDraft18,
  SubscriptionFilterDraft18,
  LocationFilterTypeDraft22,
  FetchTypeDraft18,
} from '@moq-web/core';

import { announce, makeSession, openIncoming, type Draft } from './__tests__/incoming-peer.js';

const REQUEST_ID = 1n;
const NOT_SERVED = [['.'], ['.', 'x'], ['.session'], ['.session', 'clock']];

function requests(draft: Draft, namespace: string[]): Array<[string, object]> {
  const base = { requestId: REQUEST_ID };
  const track = { trackNamespace: namespace, trackName: 't' };
  const fetchRange = draft === 'draft-22'
    ? { locationFilter: { type: LocationFilterTypeDraft22.ABSOLUTE_START, startLocation: { group: 0n, object: 0n } } }
    : {
      fetchType: FetchTypeDraft18.STANDALONE,
      joiningFlag: false,
      startLocation: { group: 0n, object: 0n },
      endLocation: { group: 1n, object: 0n },
    };

  return [
    ['SUBSCRIBE', {
      type: MessageTypeDraft18.SUBSCRIBE, ...base, ...track, forwardState: true,
      ...(draft === 'draft-18' ? { filter: SubscriptionFilterDraft18.NEXT_GROUP_START } : {}),
    }],
    ['PUBLISH', { type: MessageTypeDraft18.PUBLISH, ...base, ...track, trackAlias: 5n, forwardState: true }],
    ['FETCH', {
      type: MessageTypeDraft18.FETCH, ...base, ...track, subscriberPriority: 128, groupOrder: GroupOrder.ASCENDING, ...fetchRange,
    }],
    ['TRACK_STATUS', { type: MessageTypeDraft18.TRACK_STATUS, ...base, ...track }],
    ['SUBSCRIBE_NAMESPACE', { type: MessageTypeDraft18.SUBSCRIBE_NAMESPACE, ...base, trackNamespacePrefix: namespace }],
    ['PUBLISH_NAMESPACE', { type: MessageTypeDraft18.PUBLISH_NAMESPACE, ...base, trackNamespacePrefix: namespace }],
    ['SUBSCRIBE_TRACKS', {
      type: MessageTypeDraft18.SUBSCRIBE_TRACKS, ...base, trackNamespacePrefix: namespace, forwardState: true,
      ...(draft === 'draft-18' ? { filter: SubscriptionFilterDraft18.NEXT_GROUP_START } : {}),
    }],
  ];
}

describe.each(['draft-18', 'draft-22'] as const)('inbound requests under reserved namespaces (%s)', (draft: Draft) => {
  describe.each(NOT_SERVED)('namespace %j', (...namespace) => {
    it.each(requests(draft, namespace))('%s is rejected with DOES_NOT_EXIST', async (_name, message) => {
      const { internals } = makeSession(draft);
      announce(internals, ['ns']);
      (internals as unknown as { namespaceSubscriptions: Map<number, unknown> }).namespaceSubscriptions.set(
        1,
        { subscriptionId: 1, requestId: 100n, namespacePrefix: [], tracks: new Map() },
      );

      const peer = openIncoming(internals, message);
      await peer.opened;

      expect(peer.written()).toEqual([
        expect.objectContaining({ type: MessageTypeDraft18.REQUEST_ERROR, errorCode: RequestErrorCodeDraft18.DOES_NOT_EXIST }),
      ]);
      expect(peer.closed()).toBe(true);
    });
  });

  it('passes a request under another reserved namespace to the application', async () => {
    const { internals } = makeSession(draft);
    const [, message] = requests(draft, ['.other']).find(([name]) => name === 'PUBLISH_NAMESPACE')!;

    const peer = openIncoming(internals, message);
    await peer.opened;

    expect(peer.written()).toEqual([expect.objectContaining({ type: MessageTypeDraft18.REQUEST_OK })]);
  });
});
