// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Draft-18 §8 delivery-timeout enforcement — session-level integration.
 *
 * Publisher side: when `PublishOptions.deliveryTimeout` is configured and a
 * `sendObjectViaStream` call stalls past the deadline, the session must:
 *   1. Emit a `delivery-timeout` event with side='publisher' and
 *      resetCode = §15.10.4 DELIVERY_TIMEOUT.
 *   2. Abort the underlying stream writer (via `resetPublicationStream`).
 *
 * We stall the stream by stubbing `doCreateStream` to hand back a writer
 * whose `write()` never resolves, then advance fake timers past the
 * deadline.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MOQTransport, StreamResetErrorCodeDraft18 } from '@moq-web/core';

import { MOQTSession } from './session.js';
import type { DeliveryTimeoutEvent } from './types.js';

type StreamInfoLike = {
  writer: WritableStreamDefaultWriter<Uint8Array>;
  streamId: number;
};

interface PrivateSession {
  publisherTimeoutConfig: Map<string, { subgroupDeliveryTimeoutMs?: number }>;
  activeVideoStreams: Map<string, unknown>;
  doCreateStream: () => Promise<StreamInfoLike>;
  doWriteStream: (info: StreamInfoLike, data: Uint8Array, close?: boolean) => Promise<void>;
  doCloseStream: (info: { writer?: WritableStreamDefaultWriter<Uint8Array>; streamId?: number }) => Promise<void>;
}

function makeSession(): { session: MOQTSession; transport: MOQTransport } {
  const transport = new MOQTransport();
  (transport as unknown as { close: typeof transport.close }).close = vi.fn().mockResolvedValue(undefined);
  const session = new MOQTSession(transport);
  (session as unknown as { _state: string })._state = 'ready';
  return { session, transport };
}

describe('§8 publisher-side delivery-timeout enforcement', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits delivery-timeout(side=publisher, DELIVERY_TIMEOUT) when sendObjectViaStream stalls past the deadline', async () => {
    const { session } = makeSession();
    const priv = session as unknown as PrivateSession;

    // Register a publication timeout config so armPublisherSubgroupTimer arms.
    priv.publisherTimeoutConfig.set('7', { subgroupDeliveryTimeoutMs: 50 });

    // Fake writer whose write() never resolves — this is what "stall" looks like.
    const abortSpy = vi.fn().mockResolvedValue(undefined);
    const closeSpy = vi.fn().mockResolvedValue(undefined);
    const writer = {
      abort: abortSpy,
      close: closeSpy,
      write: vi.fn().mockImplementation(() => new Promise<void>(() => { /* stall */ })),
      releaseLock: vi.fn(),
      ready: Promise.resolve(),
      closed: new Promise<void>(() => { /* stalls */ }),
      desiredSize: null,
    } as unknown as WritableStreamDefaultWriter<Uint8Array>;

    // Stub the low-level stream primitives so we don't touch a real transport.
    priv.doCreateStream = vi.fn().mockResolvedValue({ writer, streamId: 100 });
    priv.doWriteStream = vi.fn().mockImplementation(() => new Promise<void>(() => { /* stall */ }));
    priv.doCloseStream = closeSpy;

    // Track the stream so resetPublicationStream has something to abort.
    priv.activeVideoStreams.set('7', {
      writer, streamId: 100, groupId: 0, objectCount: 0, previousObjectId: -1, hasExtensions: false,
    });

    const timeoutEvents: DeliveryTimeoutEvent[] = [];
    session.on('delivery-timeout', (ev) => timeoutEvents.push(ev as DeliveryTimeoutEvent));

    // Fire and forget — this call will stall in doWriteStream forever until
    // the timeout aborts the writer. We do not await it.
    void session.sendObjectViaStream(7n, new Uint8Array([0xaa]), { groupId: 0, objectId: 0 });

    // Let the microtask queue flush so the stream is created and timer armed.
    await Promise.resolve();
    await Promise.resolve();

    // Advance past the deadline.
    await vi.advanceTimersByTimeAsync(60);

    expect(timeoutEvents.length).toBe(1);
    expect(timeoutEvents[0].side).toBe('publisher');
    expect(timeoutEvents[0].reason).toBe('subgroup');
    expect(timeoutEvents[0].resetCode).toBe(StreamResetErrorCodeDraft18.DELIVERY_TIMEOUT);
    expect(timeoutEvents[0].trackAlias).toBe(7n);
    expect(timeoutEvents[0].groupId).toBe(0);
    // The publisher stream should have been aborted via resetPublicationStream.
    expect(abortSpy).toHaveBeenCalledTimes(1);
  });

  it('does not fire delivery-timeout when the publication has no deliveryTimeout configured', async () => {
    const { session } = makeSession();
    const priv = session as unknown as PrivateSession;

    const abortSpy = vi.fn().mockResolvedValue(undefined);
    const writer = {
      abort: abortSpy,
      close: vi.fn().mockResolvedValue(undefined),
      write: vi.fn().mockResolvedValue(undefined),
      releaseLock: vi.fn(),
      ready: Promise.resolve(),
      closed: Promise.resolve(),
      desiredSize: null,
    } as unknown as WritableStreamDefaultWriter<Uint8Array>;

    priv.doCreateStream = vi.fn().mockResolvedValue({ writer, streamId: 200 });
    priv.doWriteStream = vi.fn().mockResolvedValue(undefined);
    priv.doCloseStream = vi.fn().mockResolvedValue(undefined);

    const timeoutEvents: DeliveryTimeoutEvent[] = [];
    session.on('delivery-timeout', (ev) => timeoutEvents.push(ev as DeliveryTimeoutEvent));

    await session.sendObjectViaStream(11n, new Uint8Array([0xab]), { groupId: 0, objectId: 0 });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(timeoutEvents).toEqual([]);
    expect(abortSpy).not.toHaveBeenCalled();
  });
});
