// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Draft-23 REQUEST_UPDATE rules: NEW_GROUP_REQUEST may be sent before the
 * track's DYNAMIC_GROUPS is known (#2008), and REQUEST_UPDATEs on a request
 * stream are processed and answered in order (#1938).
 */

import { describe, it, expect } from 'vitest';
import {
  Draft18BufferWriter,
  MOQTVarInt,
  MessageTypeDraft18,
  RequestParameterDraft18,
  encodeTrackNamespace,
  type RequestUpdateMessageDraft22,
} from '@moq-web/core';

import { announce, makeSession, openIncoming, tick, type Draft } from './__tests__/incoming-peer.js';

interface Internals {
  activeRequestStreams: Map<bigint, { write: (bytes: Uint8Array) => Promise<void> }>;
  subscriptionManager: { add: (s: unknown) => void };
  codec: { decodeControlMessage: (b: Uint8Array) => [unknown, number] };
}

function subscribed(draft: Draft, dynamicGroups: boolean | undefined) {
  const { session } = makeSession(draft);
  const internals = session as unknown as Internals;
  const chunks: Uint8Array[] = [];
  internals.activeRequestStreams.set(3n, { write: async (bytes) => { chunks.push(bytes); } });
  internals.subscriptionManager.add({
    subscriptionId: 1,
    requestId: 3n,
    namespace: ['ns'],
    trackName: 't',
    trackAlias: 3n,
    paused: false,
    dynamicGroups,
  });
  const send = () => session.sendRequestUpdate(3n, true, { awaitAck: false, newGroupRequest: true });

  return { internals, chunks, send };
}

describe.each(['draft-22', 'draft-23'] as const)('NEW_GROUP_REQUEST before DYNAMIC_GROUPS is known (%s)', (draft) => {
  it('is sent from draft-23, refused before', async () => {
    const { internals, chunks, send } = subscribed(draft, undefined);

    if (draft !== 'draft-23') {
      await expect(send()).rejects.toThrow(/DYNAMIC_GROUPS/);
      return;
    }
    await send();
    const [update] = internals.codec.decodeControlMessage(chunks[0]) as [RequestUpdateMessageDraft22, number];
    expect(MOQTVarInt.decode(update.parameters!.get(RequestParameterDraft18.NEW_GROUP_REQUEST)!)[0]).toBe(0n);
  });

  it('is refused once the track says it is not dynamic', async () => {
    await expect(subscribed(draft, false).send()).rejects.toThrow(/DYNAMIC_GROUPS/);
  });

  it('is sent for a dynamic track', async () => {
    const { chunks, send } = subscribed(draft, true);
    await send();
    expect(chunks).toHaveLength(1);
  });
});

function prefixUpdate(requestId: bigint, prefix: string[]) {
  const writer = new Draft18BufferWriter();
  encodeTrackNamespace(writer, prefix);

  return {
    type: MessageTypeDraft18.REQUEST_UPDATE,
    requestId,
    parameters: new Map([[RequestParameterDraft18.TRACK_NAMESPACE_PREFIX, writer.toUint8Array()]]),
  };
}

describe('ordered REQUEST_UPDATE processing (draft-23 §9.5, #1938)', () => {
  it('answers back-to-back updates in order, each before the next takes effect', async () => {
    const { internals } = makeSession('draft-23');
    announce(internals, ['a', '1']);
    announce(internals, ['b', '2']);
    const peer = openIncoming(internals, { type: MessageTypeDraft18.SUBSCRIBE_NAMESPACE, requestId: 1n, trackNamespacePrefix: ['z'] });
    await peer.opened;

    peer.send(prefixUpdate(3n, ['a']), prefixUpdate(5n, ['b']), prefixUpdate(7n, ['a']));
    await tick();

    // Neither update is coalesced: each REQUEST_OK is followed by what its own prefix adds
    expect(peer.written().slice(1)).toEqual([
      expect.objectContaining({ type: MessageTypeDraft18.REQUEST_OK }),
      expect.objectContaining({ type: MessageTypeDraft18.NAMESPACE, trackNamespace: ['1'] }),
      expect.objectContaining({ type: MessageTypeDraft18.REQUEST_OK }),
      expect.objectContaining({ type: MessageTypeDraft18.NAMESPACE, trackNamespace: ['2'] }),
      expect.objectContaining({ type: MessageTypeDraft18.REQUEST_OK }),
      expect.objectContaining({ type: MessageTypeDraft18.NAMESPACE, trackNamespace: ['1'] }),
    ]);
  });
});
