// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * A Track Namespace field or Track Name that is not UTF-8 cannot be carried
 * as the strings this client uses. The request naming it is refused as a
 * malformed message, which closes the session with PROTOCOL_VIOLATION,
 * rather than served under a name altered by decoding.
 */

import { describe, it, expect } from 'vitest';
import { MessageTypeDraft18, SessionErrorCodeDraft18, SubscriptionFilterDraft18 } from '@moq-web/core';

import { makeSession, tick, type Draft, type SessionInternals } from './__tests__/incoming-peer.js';

const NOT_UTF8 = [0xff, 0xfe];

async function open(internals: SessionInternals, message: object, marker: string): Promise<void> {
  const wire = new Uint8Array(internals.codec.encodeControlMessage(message));
  const at = wire.findIndex((_, i) => marker.split('').every((c, j) => wire[i + j] === c.charCodeAt(0)));
  NOT_UTF8.forEach((byte, i) => {
    wire[at + i] = byte;
  });
  const readable = new ReadableStream<Uint8Array>({ start: (c) => c.enqueue(wire) });
  await internals.processIncomingBidiStream({ readable, writable: new WritableStream<Uint8Array>() });
  await tick();
}

describe.each(['draft-18', 'draft-22'] as const)('non-UTF-8 names in incoming requests (%s)', (draft: Draft) => {
  it.each([
    ['Track Name', { trackNamespace: ['ns'], trackName: 'zz' }],
    ['Track Namespace Field', { trackNamespace: ['zz'], trackName: 't' }],
  ])('close the session when the %s is not UTF-8', async (_what, names) => {
    const closed: unknown[] = [];
    const { internals } = makeSession(draft, (options) => closed.push(options));
    const subscribe = {
      type: MessageTypeDraft18.SUBSCRIBE,
      requestId: 1n,
      ...names,
      forwardState: true,
      ...(draft === 'draft-18' ? { filter: SubscriptionFilterDraft18.NEXT_GROUP_START } : {}),
    };

    await open(internals, subscribe, 'zz');

    expect(closed).toEqual([expect.objectContaining({ code: SessionErrorCodeDraft18.PROTOCOL_VIOLATION })]);
  });

  it('close the session when a SUBSCRIBE_NAMESPACE prefix is not UTF-8', async () => {
    const closed: unknown[] = [];
    const { internals } = makeSession(draft, (options) => closed.push(options));

    await open(internals, { type: MessageTypeDraft18.SUBSCRIBE_NAMESPACE, requestId: 1n, trackNamespacePrefix: ['zz'] }, 'zz');

    expect(closed).toEqual([expect.objectContaining({ code: SessionErrorCodeDraft18.PROTOCOL_VIOLATION })]);
  });
});
