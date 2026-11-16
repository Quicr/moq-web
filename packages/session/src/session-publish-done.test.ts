// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Draft-18/22 §9.9 PUBLISH_DONE — session send path.
 *
 * PUBLISH_DONE MUST be the final message on the PUBLISH request's bidi
 * stream (not the control stream), and Stream Count MUST equal the number
 * of data streams opened for the subscription.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  MOQTransport,
  MessageTypeDraft18,
  type DraftVersion,
  type PublishDoneMessageDraft18,
} from '@moq-web/core';

import { MOQTSession } from './session.js';
import type { Draft18RequestStream } from './session-helpers.js';
import type { InternalPublication } from './publication-manager.js';

const REQUEST_ID = 4n;
const TRACK_ALIAS = 7n;
const UNKNOWN_REQUEST_ID = 99n;

interface Harness {
  session: MOQTSession;
  internals: {
    activeRequestStreams: Map<bigint, Draft18RequestStream>;
    publicationManager: { add(p: InternalPublication): void };
    doSendControl: (bytes: Uint8Array) => Promise<void>;
    doCreateStream: (opts?: { sendOrder?: number }) => Promise<unknown>;
    doWriteStream: (info: unknown, data: Uint8Array, close?: boolean) => Promise<void>;
    doCloseStream: (info: { streamId: number }) => Promise<void>;
  };
  controlSends: Uint8Array[];
  streamWrites: Uint8Array[];
  streamClose: ReturnType<typeof vi.fn>;
}

function makeHarness(draft: DraftVersion): Harness {
  const transport = new MOQTransport({ draft });
  (transport as unknown as { close: typeof transport.close }).close = vi.fn().mockResolvedValue(undefined);
  const session = new MOQTSession(transport);
  (session as unknown as { _state: string })._state = 'ready';
  const internals = session as unknown as Harness['internals'];

  const controlSends: Uint8Array[] = [];
  internals.doSendControl = async (bytes) => {
    controlSends.push(bytes);
  };
  internals.doCreateStream = async () => ({ streamId: 1 });
  internals.doWriteStream = async () => {};

  const streamWrites: Uint8Array[] = [];
  const streamClose = vi.fn().mockResolvedValue(undefined);
  const fakeStream = {
    write: async (data: Uint8Array) => {
      streamWrites.push(data);
    },
    close: streamClose,
  } as unknown as Draft18RequestStream;
  internals.activeRequestStreams.set(REQUEST_ID, fakeStream);

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

  return { session, internals, controlSends, streamWrites, streamClose };
}

function decodeDone(session: MOQTSession, bytes: Uint8Array): PublishDoneMessageDraft18 {
  const codec = (session as unknown as { codec: { decodeControlMessage(b: Uint8Array): [unknown, number] } }).codec;
  const [decoded] = codec.decodeControlMessage(bytes);
  expect((decoded as { type: number }).type).toBe(MessageTypeDraft18.PUBLISH_DONE);
  return decoded as PublishDoneMessageDraft18;
}

describe.each(['draft-18', 'draft-22', 'draft-23'] as const)('%s §9.9 PUBLISH_DONE send path', (draft) => {
  it('writes on the PUBLISH request stream, then closes it', async () => {
    const h = makeHarness(draft);

    await h.session.sendPublishDone(REQUEST_ID, 0, 0);

    expect(h.controlSends).toHaveLength(0);
    expect(h.streamWrites).toHaveLength(1);
    decodeDone(h.session, h.streamWrites[0]);
    expect(h.streamClose).toHaveBeenCalledTimes(1);
    expect(h.internals.activeRequestStreams.has(REQUEST_ID)).toBe(false);
  });

  it('sets Stream Count to the number of data streams opened', async () => {
    const h = makeHarness(draft);
    const opened = 3;

    for (let i = 0; i < opened; i++) {
      await h.session.sendObjectViaStream(
        TRACK_ALIAS,
        new Uint8Array([1, 2, 3]),
        { groupId: i, objectId: 0 } as Parameters<MOQTSession['sendObjectViaStream']>[2],
      );
    }
    await h.session.sendPublishDone(REQUEST_ID, 0, 0);

    expect(decodeDone(h.session, h.streamWrites[0]).streamCount).toBe(BigInt(opened));
  });

  it('sets Stream Count to 0 when no streams were opened', async () => {
    const h = makeHarness(draft);

    await h.session.sendPublishDone(REQUEST_ID, 0, 0);

    expect(decodeDone(h.session, h.streamWrites[0]).streamCount).toBe(0n);
  });

  it('opens the next group while the old FIN drains and waits for both before PUBLISH_DONE', async () => {
    const h = makeHarness(draft);
    let created = 0;
    h.internals.doCreateStream = async () => ({ streamId: ++created });
    let commitOldFin!: () => void;
    const oldFin = new Promise<void>((resolve) => { commitOldFin = resolve; });
    const close = vi.fn(async ({ streamId }: { streamId: number }) => {
      if (streamId === 1) await oldFin;
    });
    h.internals.doCloseStream = close;
    const send = (groupId: number) =>
      h.session.sendObject(TRACK_ALIAS, new Uint8Array([1]), { groupId, objectId: 0 });

    await send(0);
    const next = send(1);
    try {
      await vi.waitFor(() => expect(created).toBe(2));
      const end = h.session.unpublish(TRACK_ALIAS);
      const alsoEnd = h.session.unpublish(TRACK_ALIAS);
      await send(2);
      await vi.waitFor(() => expect(close.mock.calls.map(([s]) => s.streamId)).toEqual([1, 2]));
      expect(h.streamWrites).toHaveLength(0);
      expect(created).toBe(2);

      commitOldFin();
      await Promise.all([next, end, alsoEnd]);
      expect(h.streamWrites).toHaveLength(1);
      expect(decodeDone(h.session, h.streamWrites[0]).streamCount).toBe(2n);
    } finally {
      commitOldFin();
    }
  });

  it('drains subgroup writes submitted before unpublish', async () => {
    const h = makeHarness(draft);
    const write = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    h.internals.doWriteStream = write;
    h.internals.doCloseStream = close;
    const pending = [0, 1].map((objectId) =>
      h.session.sendObjectViaStream(TRACK_ALIAS, new Uint8Array([1]), { groupId: 0, objectId }),
    );

    await Promise.all([...pending, h.session.unpublish(TRACK_ALIAS)]);

    expect(write).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(1);
    expect(write.mock.invocationCallOrder[1]).toBeLessThan(close.mock.invocationCallOrder[0]);
    expect(decodeDone(h.session, h.streamWrites[0]).streamCount).toBe(1n);
  });

  it('sets the unknown Stream Count sentinel of the negotiated draft', async () => {
    const h = makeHarness(draft);
    (h.internals.publicationManager as unknown as { getByRequestId: () => undefined }).getByRequestId = () => undefined;

    await h.session.sendPublishDone(REQUEST_ID, 0, 0);

    // draft-18 §10.11: 2^62 - 1; draft-22 §9.9: 2^64 - 1
    const expected = draft === 'draft-18' ? (1n << 62n) - 1n : (1n << 64n) - 1n;
    expect(decodeDone(h.session, h.streamWrites[0]).streamCount).toBe(expected);
  });

  it('throws when no request stream exists, sending nothing', async () => {
    const h = makeHarness(draft);

    await expect(h.session.sendPublishDone(UNKNOWN_REQUEST_ID, 0, 0)).rejects.toThrow(
      UNKNOWN_REQUEST_ID.toString(),
    );

    expect(h.controlSends).toHaveLength(0);
    expect(h.streamWrites).toHaveLength(0);
  });
});
