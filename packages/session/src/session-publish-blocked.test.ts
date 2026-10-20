// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * PUBLISH_BLOCKED (draft-18 §10.20) and PUBLISH_SKIPPED (draft-22 §3.6.3,
 * §9.19) travel on the SUBSCRIBE_TRACKS response stream and name the track by
 * namespace suffix and track name.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  MOQTransport,
  MessageTypeDraft18,
  MessageTypeDraft22,
  SessionErrorCodeDraft18,
  SubscriptionFilterDraft18,
  type ControlMessageDraft18,
} from '@moq-web/core';

import { MOQTSession } from './session.js';

type Draft = 'draft-18' | 'draft-22';

const PEER_REQUEST_ID = 1n;
const OWN_REQUEST_ID = 0n;
const SUFFIX = ['alice'];
const TRACK = 'video';

interface Internals {
  codec: {
    encodeControlMessage: (m: unknown) => Uint8Array;
    decodeControlMessage: (b: Uint8Array) => [ControlMessageDraft18, number];
  };
  doSendControl: (b: Uint8Array) => Promise<void>;
  processIncomingBidiStream: (s: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }) => Promise<void>;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function makeSession(draft: Draft) {
  const transport = new MOQTransport({ draft });
  (transport as unknown as { close: typeof transport.close }).close = vi.fn().mockResolvedValue(undefined);
  const session = new MOQTSession(transport);
  (session as unknown as { _state: string })._state = 'ready';
  const internals = session as unknown as Internals;
  const sendControl = vi.fn().mockResolvedValue(undefined);
  internals.doSendControl = sendControl;
  const close = vi.spyOn(session, 'close').mockResolvedValue(undefined);

  return { session, internals, sendControl, close };
}

describe.each(['draft-18', 'draft-22'] as const)('publisher side (%s)', (draft) => {
  it('writes the message on the SUBSCRIBE_TRACKS response stream', async () => {
    const { session, internals, sendControl } = makeSession(draft);
    const written: Uint8Array[] = [];
    const readable = new ReadableStream<Uint8Array>({
      start: (c) => {
        c.enqueue(internals.codec.encodeControlMessage({
          type: MessageTypeDraft18.SUBSCRIBE_TRACKS,
          requestId: PEER_REQUEST_ID,
          trackNamespacePrefix: ['room'],
          forwardState: true,
          ...(draft === 'draft-18' ? { filter: SubscriptionFilterDraft18.NEXT_GROUP_START } : {}),
        }));
      },
    });
    const writable = new WritableStream<Uint8Array>({ write: (chunk) => { written.push(chunk); } });
    await internals.processIncomingBidiStream({ readable, writable });
    const accepted = written.length;

    if (draft === 'draft-18') {
      await session.sendPublishBlocked(PEER_REQUEST_ID, SUFFIX, TRACK);
    } else {
      await session.sendPublishSkipped(PEER_REQUEST_ID, SUFFIX, TRACK);
    }

    expect(sendControl).not.toHaveBeenCalled();
    expect(written).toHaveLength(accepted + 1);
    const sent = internals.codec.decodeControlMessage(written[accepted])[0] as unknown as {
      type: number;
      trackNamespaceSuffix: string[];
      trackName: string;
    };
    expect(sent.type).toBe(draft === 'draft-18' ? MessageTypeDraft18.PUBLISH_BLOCKED : MessageTypeDraft22.PUBLISH_SKIPPED);
    expect(sent.trackNamespaceSuffix).toEqual(SUFFIX);
    expect(sent.trackName).toBe(TRACK);
  });

  it('refuses a Request ID that is not a SUBSCRIBE_TRACKS', async () => {
    const { session } = makeSession(draft);

    const send = draft === 'draft-18'
      ? session.sendPublishBlocked(PEER_REQUEST_ID, SUFFIX, TRACK)
      : session.sendPublishSkipped(PEER_REQUEST_ID, SUFFIX, TRACK);

    await expect(send).rejects.toThrow(/SUBSCRIBE_TRACKS/);
  });
});

describe.each(['draft-18', 'draft-22'] as const)('subscriber side (%s)', (draft) => {
  async function tracksStream() {
    const harness = makeSession(draft);
    const { session, internals } = harness;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    (session as unknown as { transport: { createRequestStream: unknown } }).transport.createRequestStream =
      vi.fn().mockResolvedValue({
        readable: new ReadableStream<Uint8Array>({ start: (c) => { controller = c; } }),
        writable: new WritableStream<Uint8Array>(),
      });
    const send = (message: unknown) => controller.enqueue(internals.codec.encodeControlMessage(message));
    send({ type: MessageTypeDraft18.REQUEST_OK, requestId: OWN_REQUEST_ID });
    await session.subscribeTracks(['room']);

    return { ...harness, send };
  }

  const notice = { type: MessageTypeDraft18.PUBLISH_BLOCKED, trackNamespaceSuffix: SUFFIX, trackName: TRACK };

  it('reports the track the publisher could not PUBLISH', async () => {
    const { session, send } = await tracksStream();
    const events: unknown[] = [];
    session.on(draft === 'draft-18' ? 'publish-blocked' : ('publish-skipped' as 'publish-blocked'), (e) => events.push(e));

    send(notice);
    await tick();

    expect(events).toEqual([{ requestId: OWN_REQUEST_ID, trackNamespaceSuffix: SUFFIX, trackName: TRACK }]);
  });

  it('closes the session when it arrives on another kind of request', async () => {
    const harness = makeSession(draft);
    const { session, internals, close } = harness;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    (session as unknown as { transport: { createRequestStream: unknown } }).transport.createRequestStream =
      vi.fn().mockResolvedValue({
        readable: new ReadableStream<Uint8Array>({ start: (c) => { controller = c; } }),
        writable: new WritableStream<Uint8Array>(),
      });
    controller.enqueue(internals.codec.encodeControlMessage({
      type: MessageTypeDraft18.SUBSCRIBE_OK,
      requestId: OWN_REQUEST_ID,
      trackAlias: 1n,
      largestLocation: { group: 0n, object: 0n },
    }));
    await session.subscribe(['room'], 'video');

    controller.enqueue(internals.codec.encodeControlMessage(notice));
    await tick();

    expect(close).toHaveBeenCalledWith(expect.objectContaining({ code: SessionErrorCodeDraft18.PROTOCOL_VIOLATION }));
  });
});
