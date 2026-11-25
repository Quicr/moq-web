// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * A request can end while a read on its stream is pending: the peer's
 * STOP_SENDING aborts it (draft-18 §3.3.2) while a message it sent first,
 * such as the PUBLISH_DONE that ends a PUBLISH (§5.1), is still in flight.
 * Seen with a relay that ends a PUBLISH it pushed for SUBSCRIBE_TRACKS with
 * STOP_SENDING followed by PUBLISH_DONE. That message is for no request any
 * more and is dropped; it must not fail the allow-list and close the session.
 */

import { describe, it, expect, vi } from 'vitest';
import { MOQTransport, MessageTypeDraft18, type ControlMessageDraft18 } from '@moq-web/core';

import { MOQTSession } from './session.js';

const REQUEST_ID = 1n;

type SessionInternals = {
  activeRequestStreams: Map<bigint, unknown>;
  incomingRequestKinds: Map<bigint, string>;
  readRequestStream: (id: bigint, stream: unknown) => Promise<void>;
  dispatchStreamMessage: (id: bigint, m: ControlMessageDraft18) => Promise<void>;
  close: (options?: unknown) => Promise<void>;
};

describe.each(['draft-18', 'draft-22'] as const)('a message read after its request ended (%s)', (draft) => {
  it('is dropped without closing the session', async () => {
    const transport = new MOQTransport({ draft });
    const session = new MOQTSession(transport);
    (session as unknown as { _state: string })._state = 'ready';
    const internals = session as unknown as SessionInternals;
    const close = vi.fn().mockResolvedValue(undefined);
    internals.close = close;
    const dispatch = vi.spyOn(internals, 'dispatchStreamMessage');

    let deliver!: (m: ControlMessageDraft18) => void;
    const stream = {
      readMessage: vi.fn(() => new Promise<ControlMessageDraft18>((resolve) => (deliver = resolve))),
      abort: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    internals.activeRequestStreams.set(REQUEST_ID, stream);
    internals.incomingRequestKinds.set(REQUEST_ID, 'publish');

    const reading = internals.readRequestStream(REQUEST_ID, stream);

    // The peer's STOP_SENDING ends the request while the read is pending ...
    internals.activeRequestStreams.delete(REQUEST_ID);
    internals.incomingRequestKinds.delete(REQUEST_ID);
    // ... and the PUBLISH_DONE it sent before arrives afterwards
    deliver({ type: MessageTypeDraft18.PUBLISH_DONE, requestId: REQUEST_ID } as unknown as ControlMessageDraft18);
    await reading;

    expect(dispatch).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(stream.readMessage).toHaveBeenCalledTimes(1);
  });

  it('is still dispatched while the request is active', async () => {
    const transport = new MOQTransport({ draft });
    const session = new MOQTSession(transport);
    (session as unknown as { _state: string })._state = 'ready';
    const internals = session as unknown as SessionInternals;
    const dispatch = vi.spyOn(internals, 'dispatchStreamMessage').mockImplementation(async () => {
      internals.activeRequestStreams.delete(REQUEST_ID);
    });

    const message = { type: MessageTypeDraft18.PUBLISH_DONE, requestId: REQUEST_ID } as unknown as ControlMessageDraft18;
    const stream = {
      readMessage: vi.fn().mockResolvedValue(message),
      abort: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    internals.activeRequestStreams.set(REQUEST_ID, stream);

    await internals.readRequestStream(REQUEST_ID, stream);

    expect(dispatch).toHaveBeenCalledWith(REQUEST_ID, message);
  });
});
