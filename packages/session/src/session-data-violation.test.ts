// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * A data-plane protocol violation closes the session with PROTOCOL_VIOLATION
 * (d22 §6.4.1, §11.2.1; d18 §3.4, §11.3.1).
 */

import { describe, it, expect, vi } from 'vitest';
import { MOQTransport, SessionErrorCodeDraft18, type DraftVersion } from '@moq-web/core';

import { MOQTSession } from './session.js';

const UNKNOWN_STREAM_TYPE = 0x45;

function makeSession(draft: DraftVersion) {
  const transport = new MOQTransport({ draft });
  (transport as unknown as { close: typeof transport.close }).close = vi.fn().mockResolvedValue(undefined);
  const session = new MOQTSession(transport);
  (session as unknown as { _state: string })._state = 'ready';
  const close = vi.spyOn(session, 'close').mockResolvedValue(undefined);

  return { session, close };
}

describe.each(['draft-18', 'draft-22'] as const)('data-plane violation (%s)', (draft) => {
  it('closes the session on an unknown stream type', async () => {
    const { session, close } = makeSession(draft);
    const router = (session as unknown as { objectRouter: { handleIncomingStream(s: ReadableStream<Uint8Array>): Promise<void> } }).objectRouter;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([UNKNOWN_STREAM_TYPE, 0, 0]));
        controller.close();
      },
    });

    await router.handleIncomingStream(stream);

    expect(close).toHaveBeenCalledWith(
      expect.objectContaining({ code: SessionErrorCodeDraft18.PROTOCOL_VIOLATION }),
    );
  });
});
