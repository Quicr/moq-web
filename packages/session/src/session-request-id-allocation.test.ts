// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Our Request IDs (draft-22 §6.4.2.1, draft-18 §10.1): even, from 0, up by 2
 * per request. Local bookkeeping spends none, and a new connection starts
 * again at 0.
 */

import { describe, it, expect, vi } from 'vitest';
import { MOQTransport, MessageTypeDraft18, MessageTypeDraft22 } from '@moq-web/core';

import { MOQTSession } from './session.js';

type Draft = 'draft-18' | 'draft-22';

const PEER_REQUEST_ID = 5n;
const SPENT_REQUEST_IDS = 40;

interface Internals {
  nextRequestId: number;
  codec: { encodeControlMessage: (m: unknown) => Uint8Array };
  doSendControl: (b: Uint8Array) => Promise<void>;
  waitForServerSetupDraft18: () => Promise<void>;
  processIncomingBidiStream: (s: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }) => Promise<void>;
}

function makeSession(draft: Draft) {
  const transport = new MOQTransport({ draft });
  (transport as unknown as { close: typeof transport.close }).close = vi.fn().mockResolvedValue(undefined);
  transport.createRequestStream = vi.fn().mockResolvedValue({
    readable: new ReadableStream<Uint8Array>(),
    writable: new WritableStream<Uint8Array>(),
  });
  const session = new MOQTSession(transport);
  const internals = session as unknown as Internals;
  internals.doSendControl = async () => {};
  internals.waitForServerSetupDraft18 = async () => {};

  return { session, internals };
}

describe.each(['draft-18', 'draft-22'] as const)('Request IDs (%s)', (draft) => {
  it('are not spent on an incoming PUBLISH', async () => {
    const { session, internals } = makeSession(draft);
    (session as unknown as { _state: string })._state = 'ready';
    await session.subscribeNamespace(['ns']);
    const before = internals.nextRequestId;
    const incoming: Array<{ subscriptionId: number }> = [];
    session.on('incoming-publish', (e) => incoming.push(e));

    await internals.processIncomingBidiStream({
      readable: new ReadableStream<Uint8Array>({
        start: (c) => {
          c.enqueue(internals.codec.encodeControlMessage({
            type: draft === 'draft-22' ? MessageTypeDraft22.PUBLISH : MessageTypeDraft18.PUBLISH,
            requestId: PEER_REQUEST_ID,
            trackAlias: 9n,
            trackNamespace: ['ns', 'cam'],
            trackName: 'video',
            forwardState: true,
            ...(draft === 'draft-18' ? { largestLocation: { group: 0n, object: 0n } } : {}),
          }));
        },
      }),
      writable: new WritableStream<Uint8Array>(),
    });

    expect(internals.nextRequestId).toBe(before);
    expect(incoming[0].subscriptionId).toBe(Number(PEER_REQUEST_ID));
  });

  it('restart at 0 on a new connection', async () => {
    const { session, internals } = makeSession(draft);
    internals.nextRequestId = SPENT_REQUEST_IDS;

    await session.setup();

    expect(internals.nextRequestId).toBe(0);
  });
});
