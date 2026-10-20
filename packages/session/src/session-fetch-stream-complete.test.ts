// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * `fetch-stream-complete` marks the end of a FETCH data stream: a FIN or a
 * reset (d22 §3.2.4), once per stream. A group change within the stream is
 * not completion, and an empty fetch (FETCH_HEADER then FIN) completes too
 * (d22 §3.2.1).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  Draft18StreamCodec,
  DataStreamType,
  FetchSubgroupMode,
  MOQTransport,
  MOQTVarInt,
  type DraftVersion,
  type FetchObjectDraft18,
} from '@moq-web/core';

import { MOQTSession } from './session.js';
import type { FetchStreamCompleteEvent } from './types.js';

const REQUEST_ID = 7n;
const PRIORITY = 128;

interface Internals {
  objectRouter: { handleIncomingStream(s: ReadableStream<Uint8Array>): Promise<void> };
}

function makeSession(draft: DraftVersion) {
  const transport = new MOQTransport({ draft });
  (transport as unknown as { close: typeof transport.close }).close = vi.fn().mockResolvedValue(undefined);
  const session = new MOQTSession(transport);
  (session as unknown as { _state: string })._state = 'ready';
  const events: FetchStreamCompleteEvent[] = [];
  session.on('fetch-stream-complete', (event) => events.push(event));

  return { internals: session as unknown as Internals, events };
}

function objectAt(fields: Partial<FetchObjectDraft18>): Uint8Array {
  const object: FetchObjectDraft18 = {
    subgroupMode: FetchSubgroupMode.ZERO,
    publisherPriority: PRIORITY,
    payloadLength: 1n,
    ...fields,
  };

  return new Uint8Array([...Draft18StreamCodec.encodeFetchObject(object), 0xaa]);
}

function fetchHeader(): Uint8Array {
  return new Uint8Array([
    ...MOQTVarInt.encode(BigInt(DataStreamType.FETCH_HEADER)),
    ...MOQTVarInt.encode(REQUEST_ID),
  ]);
}

describe.each(['draft-18', 'draft-22'] as const)('fetch-stream-complete (%s)', (draft) => {
  it('fires once at the FIN of a multi-group fetch, not at each group change', async () => {
    const { internals, events } = makeSession(draft);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([
          ...fetchHeader(),
          ...objectAt({ groupIdDelta: 4n, objectIdDelta: 0n }),
          ...objectAt({ groupIdDelta: 0n, objectIdDelta: 0n }),
          ...objectAt({ groupIdDelta: 0n, objectIdDelta: 0n }),
        ]));
        controller.close();
      },
    });

    await internals.objectRouter.handleIncomingStream(stream);

    expect(events).toEqual([{ requestId: REQUEST_ID, lastGroupId: 6n }]);
  });

  it('fires for an empty fetch, a header followed by FIN', async () => {
    const { internals, events } = makeSession(draft);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(fetchHeader());
        controller.close();
      },
    });

    await internals.objectRouter.handleIncomingStream(stream);

    expect(events).toEqual([{ requestId: REQUEST_ID }]);
  });

  it('fires when the fetch stream is reset', async () => {
    const { internals, events } = makeSession(draft);
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        if (pulls === 1) {
          controller.enqueue(new Uint8Array([...fetchHeader(), ...objectAt({ groupIdDelta: 2n, objectIdDelta: 0n })]));
          return;
        }
        controller.error(new Error('reset'));
      },
    });

    await internals.objectRouter.handleIncomingStream(stream);

    expect(events).toEqual([{ requestId: REQUEST_ID, lastGroupId: 2n }]);
  });
});
