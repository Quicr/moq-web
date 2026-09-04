// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Draft-18 §11.4.3 stream-reset event coverage.
 *
 *   • Publisher-side: `session.resetPublicationStream(alias, code, reason?)`
 *     aborts the underlying writer AND emits a typed `stream-reset` event
 *     carrying the §15.10.4 numeric code so consumers can distinguish
 *     TOO_FAR_BEHIND / EXCESSIVE_LOAD from an ordinary close.
 *   • Publisher-side helper: `resetPublicationStreamTooFarBehind()` short-
 *     circuits to the TOO_FAR_BEHIND code (§15.10.4 = 0x5).
 *   • Subscriber-side: a peer RESET_STREAM surfaces via the ObjectRouter's
 *     stream-reset callback, which the session translates into a
 *     `stream-reset` event with `side: 'subscriber'`.
 */

import { describe, expect, it, vi } from 'vitest';
import { MOQTransport, StreamResetErrorCodeDraft18 } from '@moq-web/core';

import { MOQTSession } from './session.js';
import type { StreamResetEvent } from './types.js';

type PrivateSession = MOQTSession & {
  activeVideoStreams: Map<string, {
    writer?: WritableStreamDefaultWriter<Uint8Array>;
    streamId?: number;
    groupId: number;
    objectCount: number;
    previousObjectId: number;
    hasExtensions: boolean;
  }>;
};

function makeSession(): MOQTSession {
  const transport = new MOQTransport();
  (transport as unknown as { close: typeof transport.close }).close = vi.fn().mockResolvedValue(undefined);
  return new MOQTSession(transport);
}

describe('draft-18 §11.4.3 publisher-side stream-reset event', () => {
  it('emits stream-reset with the requested §15.10.4 code and reason', async () => {
    const session = makeSession();
    const abortSpy = vi.fn().mockResolvedValue(undefined);
    (session as PrivateSession).activeVideoStreams.set('42', {
      writer: { abort: abortSpy } as unknown as WritableStreamDefaultWriter<Uint8Array>,
      groupId: 3,
      objectCount: 4,
      previousObjectId: 3,
      hasExtensions: false,
    });

    const events: StreamResetEvent[] = [];
    session.on('stream-reset', (e) => events.push(e));

    await session.resetPublicationStream(
      '42',
      StreamResetErrorCodeDraft18.EXCESSIVE_LOAD,
      'load-shedding',
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      side: 'publisher',
      code: StreamResetErrorCodeDraft18.EXCESSIVE_LOAD,
      reason: 'load-shedding',
      trackAlias: 42n,
      groupId: 3,
    });
    // Ensures we still tore down the underlying writer, not just emitted.
    expect(abortSpy).toHaveBeenCalledWith('load-shedding');
  });

  it('emits stream-reset with a code-derived reason when no reason is given', async () => {
    const session = makeSession();
    (session as PrivateSession).activeVideoStreams.set('7', {
      writer: { abort: vi.fn().mockResolvedValue(undefined) } as unknown as WritableStreamDefaultWriter<Uint8Array>,
      groupId: 0,
      objectCount: 0,
      previousObjectId: -1,
      hasExtensions: false,
    });

    const events: StreamResetEvent[] = [];
    session.on('stream-reset', (e) => events.push(e));

    await session.resetPublicationStream('7', StreamResetErrorCodeDraft18.TOO_FAR_BEHIND);

    expect(events).toHaveLength(1);
    // The reason string embeds the symbolic enum name so the peer's reason
    // field carries meaningful text rather than a bare integer.
    expect(events[0].reason).toContain('TOO_FAR_BEHIND');
    expect(events[0].reason).toContain(String(StreamResetErrorCodeDraft18.TOO_FAR_BEHIND));
    expect(events[0].code).toBe(StreamResetErrorCodeDraft18.TOO_FAR_BEHIND);
  });

  it('is silent when there is no active stream to reset', async () => {
    const session = makeSession();
    const events: StreamResetEvent[] = [];
    session.on('stream-reset', (e) => events.push(e));

    await session.resetPublicationStream(
      'no-such-alias',
      StreamResetErrorCodeDraft18.CANCELLED,
    );

    expect(events).toHaveLength(0);
  });

  it('resetPublicationStreamTooFarBehind() short-circuits to §15.10.4 = 0x5', async () => {
    const session = makeSession();
    const abortSpy = vi.fn().mockResolvedValue(undefined);
    (session as PrivateSession).activeVideoStreams.set('99', {
      writer: { abort: abortSpy } as unknown as WritableStreamDefaultWriter<Uint8Array>,
      groupId: 5,
      objectCount: 2,
      previousObjectId: 1,
      hasExtensions: false,
    });

    const events: StreamResetEvent[] = [];
    session.on('stream-reset', (e) => events.push(e));

    await session.resetPublicationStreamTooFarBehind('99', 'sub lagged 4 groups');

    expect(events).toHaveLength(1);
    expect(events[0].code).toBe(StreamResetErrorCodeDraft18.TOO_FAR_BEHIND);
    expect(events[0].reason).toBe('sub lagged 4 groups');
    expect(abortSpy).toHaveBeenCalledWith('sub lagged 4 groups');
  });
});

describe('draft-18 §11.4.3 subscriber-side stream-reset event', () => {
  it('translates the object-router stream-reset callback into a session event', () => {
    const session = makeSession();
    const events: StreamResetEvent[] = [];
    session.on('stream-reset', (e) => events.push(e));

    // Simulate the ObjectRouter firing the callback the way it would when a
    // peer RESET_STREAM lands on an incoming subgroup stream. Reach into the
    // private router handle rather than driving a WebTransport fake — the
    // WebTransportError → code plumbing is tested at the router layer.
    const router = (session as unknown as {
      objectRouter: { setStreamResetCallback: (cb: (...args: unknown[]) => void) => void };
    }).objectRouter;

    // Capture the callback that the session registered so we can invoke it
    // directly. (The setter overwrites, so re-registering here would replace
    // the session's wiring — instead we exercise the pre-installed one via
    // the router's private field.)
    const routerAny = router as unknown as {
      onStreamReset?: (
        sub: unknown,
        code: number,
        reason: string,
        detail: { groupId?: number; subgroupId?: number; trackAlias?: bigint },
      ) => void;
    };
    expect(routerAny.onStreamReset).toBeDefined();
    routerAny.onStreamReset!(
      { subscriptionId: 17, trackAlias: 55n },
      StreamResetErrorCodeDraft18.TOO_FAR_BEHIND,
      'Received RESET_STREAM',
      { groupId: 12, subgroupId: 0, trackAlias: 55n },
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      side: 'subscriber',
      code: StreamResetErrorCodeDraft18.TOO_FAR_BEHIND,
      reason: 'Received RESET_STREAM',
      trackAlias: 55n,
      subscriptionId: 17,
      groupId: 12,
      subgroupId: 0,
    });
  });

  it('emits stream-reset even when subscription lookup fails (unknown alias)', () => {
    const session = makeSession();
    const events: StreamResetEvent[] = [];
    session.on('stream-reset', (e) => events.push(e));

    const routerAny = (session as unknown as {
      objectRouter: {
        onStreamReset?: (
          sub: unknown,
          code: number,
          reason: string,
          detail: { groupId?: number; subgroupId?: number; trackAlias?: bigint },
        ) => void;
      };
    }).objectRouter;

    routerAny.onStreamReset!(
      undefined,
      StreamResetErrorCodeDraft18.INTERNAL_ERROR,
      'stream aborted',
      { trackAlias: 100n },
    );

    expect(events).toHaveLength(1);
    expect(events[0].side).toBe('subscriber');
    expect(events[0].subscriptionId).toBeUndefined();
    expect(events[0].trackAlias).toBe(100n);
  });
});
