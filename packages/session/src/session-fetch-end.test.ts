// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * FETCH_OK End Location (draft-22 §9.12, draft-18 §10.13): before the FETCH's
 * Start Location it closes the session; draft-18 sends the last Object plus
 * 1 (0 for the whole group), which fetch-complete reports as the last Object.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  MOQTransport,
  MessageTypeDraft18,
  SessionErrorCodeDraft18,
  type ControlMessageDraft18,
} from '@moq-web/core';

import { MOQTSession } from './session.js';
import type { FetchCompleteEvent } from './types.js';

type Draft = 'draft-18' | 'draft-22';

const START_GROUP = 5;
const START_OBJECT = 3;
const RANGE = { startGroup: START_GROUP, startObject: START_OBJECT, endGroup: 8, endObject: 4 };

function makeSession(draft: Draft, endLocation: { group: bigint; object: bigint }) {
  const transport = new MOQTransport({ draft });
  (transport as unknown as { close: typeof transport.close }).close = vi.fn().mockResolvedValue(undefined);
  const session = new MOQTSession(transport);
  (session as unknown as { _state: string })._state = 'ready';
  (session as unknown as {
    sendRequestAndWaitResponse: () => Promise<ControlMessageDraft18>;
  }).sendRequestAndWaitResponse = async () => ({
    type: MessageTypeDraft18.FETCH_OK,
    requestId: 0n,
    endOfTrack: false,
    endLocation,
  } as unknown as ControlMessageDraft18);
  const close = vi.spyOn(session, 'close').mockResolvedValue(undefined);
  const completed: FetchCompleteEvent[] = [];
  session.on('fetch-complete', (e) => completed.push(e));

  return { session, close, completed };
}

describe.each(['draft-18', 'draft-22'] as const)('FETCH_OK End Location (%s)', (draft) => {
  it('closes the session when it is before the Start Location', async () => {
    const { session, close, completed } = makeSession(draft, { group: BigInt(START_GROUP - 1), object: 9n });

    await session.fetch(['ns'], 't', RANGE);

    expect(close).toHaveBeenCalledWith(expect.objectContaining({ code: SessionErrorCodeDraft18.PROTOCOL_VIOLATION }));
    expect(completed).toHaveLength(0);
  });

  it('closes the session when it is in the start group but before the start object', async () => {
    // draft-18 sends last + 1: object 3 means the last Object is 2
    const object = draft === 'draft-18' ? BigInt(START_OBJECT) : BigInt(START_OBJECT - 1);
    const { session, close } = makeSession(draft, { group: BigInt(START_GROUP), object });

    await session.fetch(['ns'], 't', RANGE);

    expect(close).toHaveBeenCalledWith(expect.objectContaining({ code: SessionErrorCodeDraft18.PROTOCOL_VIOLATION }));
  });

  it('reports the last Object as inclusive', async () => {
    const wireObject = draft === 'draft-18' ? 8n : 7n;
    const { session, close, completed } = makeSession(draft, { group: 7n, object: wireObject });

    await session.fetch(['ns'], 't', RANGE);

    expect(close).not.toHaveBeenCalled();
    expect(completed).toEqual([{ requestId: 0n, largestGroupId: 7n, largestObjectId: 7n, endOfTrack: false }]);
  });
});

describe('draft-18 whole-group End Location', () => {
  it('names no last Object', async () => {
    const { session, completed } = makeSession('draft-18', { group: 7n, object: 0n });

    await session.fetch(['ns'], 't', RANGE);

    expect(completed[0].largestGroupId).toBe(7n);
    expect(completed[0].largestObjectId).toBeUndefined();
  });

  it('refuses to send a standalone FETCH that ends before it starts', async () => {
    const { session } = makeSession('draft-18', { group: 7n, object: 0n });

    await expect(session.fetch(['ns'], 't', { ...RANGE, endGroup: START_GROUP - 1 })).rejects.toThrow(/before start/);
    await expect(session.fetch(['ns'], 't', { ...RANGE, endGroup: START_GROUP, endObject: START_OBJECT - 1 }))
      .rejects.toThrow(/before start/);
  });
});
