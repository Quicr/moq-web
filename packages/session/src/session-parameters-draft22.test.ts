// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Draft-22 §9.20 message parameters — session send and receive paths.
 *
 * Only parameters a message allows are sent, and the draft-22 error code
 * registries apply.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  Draft22MessageCodec,
  MOQTransport,
  MOQTVarInt,
  MessageTypeDraft18,
  MessageTypeDraft22,
  RequestParameterDraft22,
  SessionErrorCodeDraft22,
  type PublishMessageDraft22,
  type RequestUpdateMessageDraft22,
  type SubscribeTracksMessageDraft22,
  type TrackStatusMessageDraft22,
} from '@moq-web/core';

import { MOQTSession } from './session.js';

interface Internals {
  sendRequestAndWaitResponse: (bytes: Uint8Array) => Promise<unknown>;
  closeRequestStream: (id: bigint) => Promise<void>;
  activeRequestStreams: Map<bigint, { write: (b: Uint8Array) => Promise<void> }>;
  activeFetches: Map<bigint, unknown>;
  publishDraft18: (...args: unknown[]) => Promise<void>;
  handleTransportClosed: (info: { closeCode: number; reason: string; remote: boolean }) => void;
  handleError: (err: Error) => void;
  dispatchRequestUpdateDraft18: (m: unknown) => void;
}

function makeSession(chunks: Uint8Array[]): { session: MOQTSession; internals: Internals } {
  const transport = new MOQTransport({ draft: 'draft-22' });
  (transport as unknown as { close: typeof transport.close }).close = vi.fn().mockResolvedValue(undefined);
  const session = new MOQTSession(transport);
  (session as unknown as { _state: string })._state = 'ready';
  const internals = session as unknown as Internals;
  internals.sendRequestAndWaitResponse = async (bytes) => {
    chunks.push(bytes);
    return { type: MessageTypeDraft18.REQUEST_OK, requestId: 0n };
  };
  internals.closeRequestStream = async () => undefined;
  internals.handleError = vi.fn();
  return { session, internals };
}

describe('draft-22 SUBSCRIBE_TRACKS (§9.18)', () => {
  it('sends only FORWARD and the caller parameters', async () => {
    const chunks: Uint8Array[] = [];
    const { session } = makeSession(chunks);

    await session.subscribeTracks(['media'], undefined, {
      forwardState: false,
      parameters: new Map([[RequestParameterDraft22.INCLUDE_PROPERTIES, new Uint8Array([1])]]),
    });

    const [decoded] = Draft22MessageCodec.decode(chunks[0]);
    const m = decoded as SubscribeTracksMessageDraft22;
    expect(m.type).toBe(MessageTypeDraft22.SUBSCRIBE_TRACKS);
    expect(m.trackNamespacePrefix).toEqual(['media']);
    expect(m.forwardState).toBe(false);
    expect(Array.from(m.parameters?.keys() ?? [])).toEqual([RequestParameterDraft22.INCLUDE_PROPERTIES]);
  });

  it('refuses namespacePrefixParam, since TRACK_NAMESPACE_PREFIX is REQUEST_UPDATE only', async () => {
    const chunks: Uint8Array[] = [];
    const { session } = makeSession(chunks);

    await expect(
      session.subscribeTracks(['media'], undefined, { namespacePrefixParam: ['media', 'video'] }),
    ).rejects.toThrow(/TRACK_NAMESPACE_PREFIX/);
    expect(chunks).toHaveLength(0);
  });
});

describe('draft-22 TRACK_STATUS (§9.13)', () => {
  it('sends a draft-22 TRACK_STATUS with no parameters', async () => {
    const chunks: Uint8Array[] = [];
    const { session } = makeSession(chunks);

    await session.trackStatus(['ns'], 'track');

    const [decoded] = Draft22MessageCodec.decode(chunks[0]);
    const m = decoded as TrackStatusMessageDraft22;
    expect(m.type).toBe(MessageTypeDraft22.TRACK_STATUS);
    expect(m.trackName).toBe('track');
    expect(m.parameters).toBeUndefined();
  });
});

describe('draft-22 PUBLISH (§9.8)', () => {
  it('sends FORWARD and no LARGEST_OBJECT before any Object is published', async () => {
    const chunks: Uint8Array[] = [];
    const { internals } = makeSession(chunks);

    await internals.publishDraft18(1n, ['ns'], 'track', 7n, { skipForwardWait: true });

    const [decoded] = Draft22MessageCodec.decode(chunks[0]);
    const m = decoded as PublishMessageDraft22;
    expect(m.type).toBe(MessageTypeDraft22.PUBLISH);
    expect(m.trackAlias).toBe(7n);
    expect(m.forwardState).toBe(true);
    expect(m.largestLocation).toBeUndefined();
  });
});

describe('draft-22 REQUEST_UPDATE (§9.5)', () => {
  function withStream(internals: Internals, rid: bigint, writes: Uint8Array[]): void {
    internals.activeRequestStreams.set(rid, {
      write: async (b: Uint8Array) => {
        writes.push(b);
      },
    });
  }

  it('sends FORWARD and NEW_GROUP_REQUEST for a subscription', async () => {
    const { session, internals } = makeSession([]);
    const writes: Uint8Array[] = [];
    withStream(internals, 5n, writes);

    await session.sendRequestUpdate(5n, false, { awaitAck: false, newGroupRequest: 3 });

    const [decoded] = Draft22MessageCodec.decode(writes[0]);
    const m = decoded as RequestUpdateMessageDraft22;
    expect(m.type).toBe(MessageTypeDraft22.REQUEST_UPDATE);
    expect(m.forwardState).toBe(false);
    expect(m.parameters?.get(RequestParameterDraft22.NEW_GROUP_REQUEST)).toEqual(MOQTVarInt.encode(3n));
  });

  it('does not send FORWARD when the request is a FETCH, which does not allow it', async () => {
    const { session, internals } = makeSession([]);
    const writes: Uint8Array[] = [];
    withStream(internals, 6n, writes);
    internals.activeFetches.set(6n, {});

    await session.sendRequestUpdate(6n, false, { awaitAck: false });

    const [decoded] = Draft22MessageCodec.decode(writes[0]);
    expect((decoded as RequestUpdateMessageDraft22).forwardState).toBeUndefined();
  });

  it('cancelFetch sends no REQUEST_UPDATE', async () => {
    const { session, internals } = makeSession([]);
    const writes: Uint8Array[] = [];
    withStream(internals, 6n, writes);
    internals.activeFetches.set(6n, {});

    await session.cancelFetch(6n);

    expect(writes).toHaveLength(0);
  });

  it('leaves forward state alone when an incoming update omits FORWARD', () => {
    const { session, internals } = makeSession([]);
    const events: string[] = [];
    session.on('forward-paused', () => events.push('paused'));
    session.on('forward-resumed', () => events.push('resumed'));

    internals.dispatchRequestUpdateDraft18({
      type: MessageTypeDraft22.REQUEST_UPDATE,
      requestId: 9n,
      forwardState: undefined,
    });

    expect(events).toEqual([]);
  });
});

describe('draft-22 error code registries (§12)', () => {
  it('keeps TOO_MANY_REQUEST_UPDATES on session-terminated', () => {
    const { session, internals } = makeSession([]);
    const codes: number[] = [];
    session.on('session-terminated', (e: unknown) => codes.push((e as { code: number }).code));

    internals.handleTransportClosed({
      closeCode: SessionErrorCodeDraft22.TOO_MANY_REQUEST_UPDATES,
      reason: 'x',
      remote: true,
    });

    expect(codes).toEqual([SessionErrorCodeDraft22.TOO_MANY_REQUEST_UPDATES]);
  });
});
