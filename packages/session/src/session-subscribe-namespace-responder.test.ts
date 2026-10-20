// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Responding to a peer's SUBSCRIBE_NAMESPACE (draft-22 §4.2, §9.16, §9.17;
 * draft-18 §10.16-10.18): NAMESPACE and NAMESPACE_DONE carry the suffix after
 * the prefix, the set is kept current as it changes, and prefixes that overlap
 * an established subscription are refused with PREFIX_OVERLAP.
 */

import { describe, it, expect } from 'vitest';
import {
  MessageTypeDraft18,
  RequestErrorCodeDraft18,
  type ControlMessageDraft18,
} from '@moq-web/core';

import { announce, makeSession, openIncoming, tick, type Draft } from './__tests__/incoming-peer.js';
import type { MOQTSession } from './session.js';

const FIRST_PEER_ID = 1n;
const SECOND_PEER_ID = 3n;

function subscribeNamespace(requestId: bigint, prefix: string[]) {
  return { type: MessageTypeDraft18.SUBSCRIBE_NAMESPACE, requestId, trackNamespacePrefix: prefix };
}

function types(messages: ControlMessageDraft18[]) {
  return messages.map((m) => m.type);
}

/** Announce through the public API, with the peer's PUBLISH_NAMESPACE answered. */
async function announceOk(session: MOQTSession, namespace: string[]) {
  (session as unknown as { sendRequestAndWaitResponse: unknown }).sendRequestAndWaitResponse = async () => ({
    type: MessageTypeDraft18.REQUEST_OK,
    requestId: 0n,
  });
  await session.announceNamespace(namespace);
}

describe.each(['draft-18', 'draft-22'] as const)('incoming SUBSCRIBE_NAMESPACE (%s)', (draft: Draft) => {
  it('answers with suffixes and no NAMESPACE_DONE', async () => {
    const { internals } = makeSession(draft);
    announce(internals, ['conf', 'room1']);
    announce(internals, ['other']);

    const peer = openIncoming(internals, subscribeNamespace(FIRST_PEER_ID, ['conf']));
    await peer.opened;

    const written = peer.written();
    expect(types(written)).toEqual([MessageTypeDraft18.REQUEST_OK, MessageTypeDraft18.NAMESPACE]);
    expect(written[1]).toMatchObject({ trackNamespace: ['room1'] });
  });

  it('matches the prefix field by field, not by string', async () => {
    const { internals } = makeSession(draft);
    announce(internals, ['foobar']);

    const peer = openIncoming(internals, subscribeNamespace(FIRST_PEER_ID, ['foo']));
    await peer.opened;

    expect(types(peer.written())).toEqual([MessageTypeDraft18.REQUEST_OK]);
  });

  it('announces a namespace equal to the prefix with an empty suffix', async () => {
    const { internals } = makeSession(draft);
    announce(internals, ['conf']);

    const peer = openIncoming(internals, subscribeNamespace(FIRST_PEER_ID, ['conf']));
    await peer.opened;

    expect(peer.written()[1]).toMatchObject({ type: MessageTypeDraft18.NAMESPACE, trackNamespace: [] });
  });

  it('sends NAMESPACE and NAMESPACE_DONE as the announced set changes', async () => {
    const { session, internals } = makeSession(draft);
    const peer = openIncoming(internals, subscribeNamespace(FIRST_PEER_ID, ['conf']));
    await peer.opened;

    await announceOk(session, ['conf', 'room2']);
    await announceOk(session, ['elsewhere']);
    await session.cancelAnnounce(['conf', 'room2']);
    await tick();

    const written = peer.written();
    expect(types(written)).toEqual([
      MessageTypeDraft18.REQUEST_OK,
      MessageTypeDraft18.NAMESPACE,
      MessageTypeDraft18.NAMESPACE_DONE,
    ]);
    expect(written[1]).toMatchObject({ trackNamespace: ['room2'] });
    expect(written[2]).toMatchObject({ finalNamespace: ['room2'] });
  });

  it('stops sending once the subscription stream ends', async () => {
    const { session, internals } = makeSession(draft);
    const peer = openIncoming(internals, subscribeNamespace(FIRST_PEER_ID, ['conf']));
    await peer.opened;
    peer.fin();
    await tick();

    await announceOk(session, ['conf', 'late']);

    expect(types(peer.written())).toEqual([MessageTypeDraft18.REQUEST_OK]);
  });

  it.each([
    ['a prefix of it', ['conf'], ['conf', 'room1']],
    ['an extension of it', ['conf', 'room1'], ['conf']],
    ['the same prefix', ['conf'], ['conf']],
    ['the empty prefix', ['conf'], []],
  ])('refuses %s with PREFIX_OVERLAP', async (_name, established, overlapping) => {
    const { internals } = makeSession(draft);
    const first = openIncoming(internals, subscribeNamespace(FIRST_PEER_ID, established));
    await first.opened;

    const second = openIncoming(internals, subscribeNamespace(SECOND_PEER_ID, overlapping));
    await second.opened;

    expect(second.written()).toEqual([
      expect.objectContaining({ type: MessageTypeDraft18.REQUEST_ERROR, errorCode: RequestErrorCodeDraft18.PREFIX_OVERLAP }),
    ]);
    expect(second.closed()).toBe(true);
  });

  it('accepts a disjoint prefix, and a repeat after the first ended', async () => {
    const { internals } = makeSession(draft);
    const first = openIncoming(internals, subscribeNamespace(FIRST_PEER_ID, ['conf']));
    await first.opened;

    const disjoint = openIncoming(internals, subscribeNamespace(SECOND_PEER_ID, ['conference']));
    await disjoint.opened;
    expect(types(disjoint.written())).toEqual([MessageTypeDraft18.REQUEST_OK]);

    first.fin();
    await tick();
    const again = openIncoming(internals, subscribeNamespace(5n, ['conf']));
    await again.opened;
    expect(types(again.written())).toEqual([MessageTypeDraft18.REQUEST_OK]);
  });
});

describe.each(['draft-18', 'draft-22'] as const)('announced namespaces that differ only by a slash (%s)', (draft: Draft) => {
  it('are announced and withdrawn separately', async () => {
    const { session } = makeSession(draft);

    await announceOk(session, ['a/b']);
    await announceOk(session, ['a', 'b']);
    await session.cancelAnnounce(['a', 'b']);

    expect(session.getAnnouncedNamespaces().map((info) => info.namespace)).toEqual([['a/b']]);
  });
});
