// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Incoming unidirectional streams on draft-18/22 (d22 §6.4.1, §3.4.1, §11.5.1).
 *
 * The stream type is a vi64 that may arrive split across reads. A consumer
 * that cancels a data stream it was handed must reach the receive stream, so
 * the peer gets STOP_SENDING.
 */

import { describe, expect, it, vi } from 'vitest';

import { MOQTransport } from './transport.js';
import { MOQTVarInt } from '../encoding/moqt-varint.js';
import { StreamTypeDraft18 } from '../messages/types.js';

const FETCH_REQUEST_ID = 7;
const CANCEL_REASON = 'stop';
// vi64 two-byte (non-minimal) form of FETCH_HEADER, split after its first byte
const WIDE_FETCH_TYPE = [0x80, StreamTypeDraft18.FETCH_HEADER];

type Handler = (s: ReadableStream<Uint8Array>) => Promise<void>;

function makeTransport(draft: 'draft-18' | 'draft-22') {
  const transport = new MOQTransport({ draft });
  const emitted: ReadableStream<Uint8Array>[] = [];
  transport.on('unidirectional-stream', (stream) => emitted.push(stream));
  const handle = (transport as unknown as { handleDraft18UnidirectionalStream: Handler })
    .handleDraft18UnidirectionalStream.bind(transport);

  return { emitted, handle };
}

function chunked(chunks: number[][], cancel?: (reason: unknown) => void) {
  let next = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (next < chunks.length) {
        controller.enqueue(new Uint8Array(chunks[next++]));
        return;
      }
      // Stay open so a consumer's cancel is observable
    },
    cancel,
  });

  return { stream, chunksRead: () => next };
}

describe.each(['draft-18', 'draft-22'] as const)('incoming unidirectional streams (%s)', (draft) => {
  it('reads a stream type split across reads and forwards every byte', async () => {
    const { emitted, handle } = makeTransport(draft);
    const { stream } = chunked([[WIDE_FETCH_TYPE[0]], [WIDE_FETCH_TYPE[1], FETCH_REQUEST_ID]]);

    await handle(stream);

    expect(emitted).toHaveLength(1);
    const reader = emitted[0].getReader();
    const received: number[] = [];
    while (received.length < WIDE_FETCH_TYPE.length + 1) {
      const { value } = await reader.read();
      received.push(...value!);
    }
    expect(received).toEqual([...WIDE_FETCH_TYPE, FETCH_REQUEST_ID]);
  });

  it('drains a padding stream whose type is split across reads', async () => {
    const { emitted, handle } = makeTransport(draft);
    const type = Array.from(MOQTVarInt.encode(BigInt(StreamTypeDraft18.PADDING)));
    const { stream, chunksRead } = chunked([type.slice(0, 1), [...type.slice(1), 0, 0], [0, 0]]);

    await handle(stream);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(emitted).toHaveLength(0);
    // Draining keeps reading past the type
    expect(chunksRead()).toBe(3);
  });

  it('cancels the receive stream when the consumer cancels a data stream', async () => {
    const { emitted, handle } = makeTransport(draft);
    const cancelled = vi.fn();
    const { stream } = chunked([[StreamTypeDraft18.FETCH_HEADER, FETCH_REQUEST_ID]], cancelled);

    await handle(stream);
    await emitted[0].cancel(CANCEL_REASON);

    expect(cancelled).toHaveBeenCalledWith(CANCEL_REASON);
  });
});
