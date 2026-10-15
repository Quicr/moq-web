// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Publisher mapping of objects to subgroup streams (draft-18 §2.2, §11.4.2;
 * draft-22 §2.2, §11.3.1, §12.1).
 *
 * Objects of one subgroup go on one stream. FIRST_OBJECT is set only when the
 * stream starts at the subgroup's first object. A track keeps one Delivery
 * Mode, so an oversize datagram object is refused, not sent on a stream.
 */

import { describe, it, expect, vi } from 'vitest';
import { Draft18StreamCodec, MOQTransport, SubgroupFlags, type DraftVersion } from '@moq-web/core';

import { MOQTSession } from './session.js';
import type { InternalPublication } from './publication-manager.js';

const TRACK_ALIAS = 7n;
const GROUP = 4;
const NEXT_GROUP = 5;
const PAYLOAD = new Uint8Array([1, 2, 3]);
const OVERSIZE_PAYLOAD = new Uint8Array(2000);

interface Write {
  streamId: number;
  data: Uint8Array;
}

interface Internals {
  publicationManager: { add(p: InternalPublication): void };
  doCreateStream: () => Promise<{ streamId: number }>;
  doWriteStream: (info: { streamId: number }, data: Uint8Array, close?: boolean) => Promise<void>;
  doCloseStream: (info: { streamId: number }) => Promise<void>;
  doSendDatagram: (data: Uint8Array) => Promise<void>;
}

function makeHarness(draft: DraftVersion, deliveryMode: 'stream' | 'datagram' = 'stream') {
  const transport = new MOQTransport({ draft });
  (transport as unknown as { close: typeof transport.close }).close = vi.fn().mockResolvedValue(undefined);
  const session = new MOQTSession(transport);
  (session as unknown as { _state: string })._state = 'ready';
  const internals = session as unknown as Internals;

  let nextStreamId = 1;
  const created: number[] = [];
  const closed: number[] = [];
  const writes: Write[] = [];
  const datagrams: Uint8Array[] = [];
  internals.doCreateStream = async () => {
    created.push(nextStreamId);
    return { streamId: nextStreamId++ };
  };
  internals.doWriteStream = async (info, data) => {
    writes.push({ streamId: info.streamId, data });
  };
  internals.doCloseStream = async (info) => {
    closed.push(info.streamId);
  };
  internals.doSendDatagram = async (data) => {
    datagrams.push(data);
  };

  internals.publicationManager.add({
    trackAlias: TRACK_ALIAS,
    namespace: ['ns'],
    trackName: 'track',
    priority: 128,
    deliveryMode,
    requestId: 4n,
    cleanupHandlers: [],
    forward: 1,
  });

  return { session, internals, created, closed, writes, datagrams };
}

describe.each(['draft-18', 'draft-22'] as const)('subgroup streams (%s)', (draft) => {
  it('keeps the objects of one group on one stream', async () => {
    const h = makeHarness(draft);

    await h.session.sendObject(TRACK_ALIAS, PAYLOAD, { groupId: GROUP, objectId: 0, type: 'data' });
    await h.session.sendObject(TRACK_ALIAS, PAYLOAD, { groupId: GROUP, objectId: 1, type: 'data' });

    expect(h.created).toHaveLength(1);
    expect(h.writes.map((w) => w.streamId)).toEqual([1, 1]);
    expect(h.closed).toEqual([]);
  });

  it('opens at the first object with FIRST_OBJECT set, and no second header', async () => {
    const h = makeHarness(draft);

    await h.session.sendObject(TRACK_ALIAS, PAYLOAD, { groupId: GROUP, objectId: 0, type: 'data' });
    await h.session.sendObject(TRACK_ALIAS, PAYLOAD, { groupId: GROUP, objectId: 1, type: 'data' });

    const [header] = Draft18StreamCodec.decodeSubgroupHeader(h.writes[0].data);
    expect(header.firstObject).toBe(true);
    // Second write is Object ID Delta 0 | Payload Length 3 | payload
    expect(Array.from(h.writes[1].data)).toEqual([0x00, PAYLOAD.length, ...PAYLOAD]);
  });

  it('finishes the previous stream and opens a new one for the next group', async () => {
    const h = makeHarness(draft);

    await h.session.sendObject(TRACK_ALIAS, PAYLOAD, { groupId: GROUP, objectId: 0, type: 'data' });
    await h.session.sendObject(TRACK_ALIAS, PAYLOAD, { groupId: NEXT_GROUP, objectId: 0, type: 'data' });

    expect(h.created).toHaveLength(2);
    expect(h.closed).toEqual([1]);
    const [header] = Draft18StreamCodec.decodeSubgroupHeader(h.writes[1].data);
    expect(header.groupId).toBe(BigInt(NEXT_GROUP));
  });

  it('reopens without FIRST_OBJECT after the peer stops the stream mid-group', async () => {
    const h = makeHarness(draft);
    await h.session.sendObject(TRACK_ALIAS, PAYLOAD, { groupId: GROUP, objectId: 0, type: 'data' });

    let failed = false;
    const write = h.internals.doWriteStream;
    h.internals.doWriteStream = async (info, data, close) => {
      if (!failed) {
        failed = true;
        throw new Error('STOP_SENDING');
      }
      await write(info, data, close);
    };
    await h.session.sendObject(TRACK_ALIAS, PAYLOAD, { groupId: GROUP, objectId: 1, type: 'data' });

    const reopened = h.writes[h.writes.length - 1];
    const [header] = Draft18StreamCodec.decodeSubgroupHeader(reopened.data);
    expect(header.firstObject).toBe(false);
    expect(reopened.data[0] & SubgroupFlags.FIRST_OBJECT).toBe(0);
  });

  it('does not move an oversize datagram object onto a stream', async () => {
    const h = makeHarness(draft, 'datagram');

    await expect(
      h.session.sendObject(TRACK_ALIAS, OVERSIZE_PAYLOAD, { groupId: GROUP, objectId: 0, type: 'data' }),
    ).rejects.toThrow(/datagram/i);

    expect(h.created).toHaveLength(0);
    expect(h.datagrams).toHaveLength(0);
  });
});
