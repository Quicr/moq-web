// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Draft-18 §11.5.1 receiver-side padding stream discard.
 *
 * When a peer opens a unidirectional stream whose first varint is the
 * PADDING stream type (0x132B3E28), the transport must drain the rest
 * silently — it must NOT emit `unidirectional-stream` (which would surface
 * the bytes to the object router / decoder path).
 */

import { describe, expect, it, vi } from 'vitest';

import { MOQTransport } from './transport.js';
import { MOQTVarInt } from '../encoding/moqt-varint.js';
import { StreamTypeDraft18 } from '../messages/types.js';
import { IS_DRAFT_18 } from '../version/constants.js';

describe.skipIf(!IS_DRAFT_18)('draft-18 §11.5.1 padding stream receiver-side discard', () => {
  it('does not emit unidirectional-stream for a PADDING stream and drains all bytes', async () => {
    const transport = new MOQTransport();
    const emitted: ReadableStream<Uint8Array>[] = [];
    transport.on('unidirectional-stream', (stream) => emitted.push(stream));

    const typeBytes = MOQTVarInt.encode(BigInt(StreamTypeDraft18.PADDING));
    // Build a stream that yields [PADDING type prefix + 24 zero bytes], then EOF.
    const payload = new Uint8Array(typeBytes.length + 24);
    payload.set(typeBytes);
    let delivered = false;
    const readMock = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        readMock();
        if (!delivered) {
          delivered = true;
          controller.enqueue(payload);
          return;
        }
        controller.close();
      },
    });

    await (transport as unknown as {
      handleDraft18UnidirectionalStream: (s: ReadableStream<Uint8Array>) => Promise<void>;
    }).handleDraft18UnidirectionalStream(stream);

    // The padding-drain runs .then in the microtask queue after handle returns.
    // Yield a couple times so the drain loop reaches EOF before we assert.
    await Promise.resolve();
    await Promise.resolve();

    expect(emitted).toHaveLength(0);
    expect(readMock).toHaveBeenCalled();
  });
});
