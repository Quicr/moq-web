// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Pausing a subscription mid-subgroup (d22 §11.3.2, d18 §11.4.3).
 *
 * Objects omitted because the subscription is paused still exist. A FIN on a
 * stream flagged END_OF_GROUP would tell the receiver they do not, so the open
 * subgroup stream is reset instead.
 */

import { describe, it, expect, vi } from 'vitest';
import { MOQTransport, StreamResetErrorCodeDraft18, type DraftVersion } from '@moq-web/core';

import { MOQTSession } from './session.js';
import { streamResetReason } from './stream-reset-reason.js';

const TRACK_ALIAS = 7n;
const REQUEST_ID = 4n;
const GROUP = 4;
const PAYLOAD = new Uint8Array([1, 2, 3]);
const PAUSED = 0;
const FORWARDING = 1;

interface Internals {
  publicationManager: { add(p: unknown): void; setForwardByRequestId(id: bigint, forward: number): boolean };
  doCreateStream: () => Promise<unknown>;
  doWriteStream: () => Promise<void>;
  doCloseStream: () => Promise<void>;
}

function makeHarness(draft: DraftVersion) {
  const transport = new MOQTransport({ draft });
  (transport as unknown as { close: typeof transport.close }).close = vi.fn().mockResolvedValue(undefined);
  const session = new MOQTSession(transport);
  (session as unknown as { _state: string })._state = 'ready';
  const internals = session as unknown as Internals;

  const abort = vi.fn().mockResolvedValue(undefined);
  const close = vi.fn().mockResolvedValue(undefined);
  const writer = { abort, close } as unknown as WritableStreamDefaultWriter<Uint8Array>;
  internals.doCreateStream = async () => ({ writer });
  internals.doWriteStream = async () => {};
  internals.doCloseStream = close;
  internals.publicationManager.add({
    trackAlias: TRACK_ALIAS,
    namespace: ['ns'],
    trackName: 'track',
    priority: 128,
    deliveryMode: 'stream',
    requestId: REQUEST_ID,
    cleanupHandlers: [],
    forward: FORWARDING,
  });

  return { session, internals, abort, close };
}

describe.each(['draft-18', 'draft-22'] as const)('pausing mid-subgroup (%s)', (draft) => {
  it('resets the open subgroup stream instead of finishing it', async () => {
    const h = makeHarness(draft);
    await h.session.sendObject(TRACK_ALIAS, PAYLOAD, { groupId: GROUP, objectId: 0, type: 'data' });

    h.internals.publicationManager.setForwardByRequestId(REQUEST_ID, PAUSED);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.abort).toHaveBeenCalledWith(streamResetReason(StreamResetErrorCodeDraft18.CANCELLED));
    expect(h.close).not.toHaveBeenCalled();
  });

  it('does nothing when no subgroup stream is open', async () => {
    const h = makeHarness(draft);

    h.internals.publicationManager.setForwardByRequestId(REQUEST_ID, PAUSED);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.abort).not.toHaveBeenCalled();
  });
});
