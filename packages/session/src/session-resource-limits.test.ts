// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Unit tests for B3 SEC per-session resource limits.
 *
 * The session gates subscribe/publish/stream-open on `maxSubscriptions`,
 * `maxTracks`, and `maxOpenStreams`. When a cap is exceeded the call throws.
 * Draft-14/16 also terminate the session with PROTOCOL_VIOLATION; draft-18/22
 * keep it and refuse the peer's request with EXCESSIVE_LOAD (d22 §12.3).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  MOQTransport,
  MessageTypeDraft18,
  RequestErrorCodeDraft18,
  SessionErrorCodeDraft18,
  SubscriptionFilterDraft18,
  type DraftVersion,
  type RequestErrorMessageDraft18,
} from '@moq-web/core';

import { MOQTSession } from './session.js';

type PrivateSession = {
  _state: 'none' | 'setup-sent' | 'ready' | 'closing';
  maxSubscriptions: number;
  maxTracks: number;
  maxOpenStreams: number;
  openStreamCount: number;
  subscriptionManager: { size: number; add: (s: unknown) => void };
  publicationManager: { size: number };
  enforceResourceLimit: (
    what: 'subscriptions' | 'tracks' | 'streams',
    currentCount: number,
    limit: number,
  ) => void;
  handleIncomingSubscribe: (message: unknown) => Promise<void>;
};

function makeSession(draft: DraftVersion = 'draft-16'): {
  session: MOQTSession;
  transport: MOQTransport;
  closeSpy: ReturnType<typeof vi.fn>;
} {
  const transport = new MOQTransport({ draft });
  const closeSpy = vi.fn().mockResolvedValue(undefined);
  (transport as unknown as { close: typeof transport.close }).close = closeSpy;
  const session = new MOQTSession(transport);
  // Force session ready so subscribe/publish don't short-circuit on isReady.
  (session as unknown as PrivateSession)._state = 'ready';
  return { session, transport, closeSpy };
}

describe('B3 SEC: per-session resource limits', () => {
  it('exposes maxSubscriptions, maxTracks, maxOpenStreams as private caps', () => {
    const { session } = makeSession();
    const priv = session as unknown as PrivateSession;
    expect(priv.maxSubscriptions).toBe(4096);
    expect(priv.maxTracks).toBe(4096);
    expect(priv.maxOpenStreams).toBe(8192);
  });

  it('subscribe() rejects with resource-limit-exceeded once maxSubscriptions is reached', async () => {
    const { session } = makeSession();
    const priv = session as unknown as PrivateSession;
    // Lower the cap so we don't have to build 4k subscriptions in test.
    (priv as unknown as { maxSubscriptions: number }).maxSubscriptions = 2;
    // Inject dummy subscriptions to reach the cap.
    (priv.subscriptionManager as unknown as {
      subscriptions: Map<number, unknown>;
    }).subscriptions = new Map([
      [1, { subscriptionId: 1 }],
      [2, { subscriptionId: 2 }],
    ]);
    expect(priv.subscriptionManager.size).toBe(2);

    let caught: unknown;
    try {
      await session.subscribe(['ns'], 'track');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect((caught as { code?: string }).code).toBe('resource-limit-exceeded');
  });

  it('publish() rejects with resource-limit-exceeded once maxTracks is reached', async () => {
    const { session } = makeSession();
    const priv = session as unknown as PrivateSession;
    (priv as unknown as { maxTracks: number }).maxTracks = 3;
    (priv.publicationManager as unknown as {
      publications: Map<string, unknown>;
    }).publications = new Map([
      ['a', { trackAlias: 'a' }],
      ['b', { trackAlias: 'b' }],
      ['c', { trackAlias: 'c' }],
    ]);
    expect(priv.publicationManager.size).toBe(3);

    let caught: unknown;
    try {
      await session.publish(['ns'], 'track');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect((caught as { code?: string }).code).toBe('resource-limit-exceeded');
  });

  it('draft-16 enforceResourceLimit closes the session with PROTOCOL_VIOLATION and a matching reason string', async () => {
    const { session, closeSpy } = makeSession();
    const priv = session as unknown as PrivateSession;
    expect(() => priv.enforceResourceLimit('subscriptions', 100, 10)).toThrow();
    // close() runs a publication drain loop before touching the transport;
    // with a clean publicationManager and no active streams it awaits nothing,
    // so a couple of microtask flushes are enough.
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(closeSpy).toHaveBeenCalledWith(
      SessionErrorCodeDraft18.PROTOCOL_VIOLATION,
      expect.stringContaining('subscriptions'),
    );
  });

  it('draft-16 enforceResourceLimit is idempotent — a second trip does not re-close', () => {
    const { session, closeSpy } = makeSession();
    const priv = session as unknown as PrivateSession;
    // Two consecutive trips should only produce one close attempt.
    expect(() => priv.enforceResourceLimit('streams', 10, 5)).toThrow();
    expect(() => priv.enforceResourceLimit('streams', 10, 5)).toThrow();
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('draft-16 maxOpenStreams: enforceResourceLimit trips when openStreamCount reaches maxOpenStreams', () => {
    const { session, closeSpy } = makeSession();
    const priv = session as unknown as PrivateSession;
    (priv as unknown as { maxOpenStreams: number }).maxOpenStreams = 2;
    priv.openStreamCount = 2;
    let caught: unknown;
    try {
      priv.enforceResourceLimit('streams', priv.openStreamCount, priv.maxOpenStreams);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect((caught as { code?: string }).code).toBe('resource-limit-exceeded');
    expect(closeSpy).toHaveBeenCalledWith(
      SessionErrorCodeDraft18.PROTOCOL_VIOLATION,
      expect.stringContaining('streams'),
    );
  });
});

describe.each(['draft-18', 'draft-22'] as const)('resource limits (%s)', (draft) => {
  it('throw without closing the session', () => {
    const { session } = makeSession(draft);
    const close = vi.spyOn(session, 'close');
    const priv = session as unknown as PrivateSession;

    expect(() => priv.enforceResourceLimit('subscriptions', 100, 10)).toThrow();

    expect(close).not.toHaveBeenCalled();
  });

  async function overCap(first: object, setCap: (p: PrivateSession) => void) {
    const { session } = makeSession(draft);
    const close = vi.spyOn(session, 'close');
    const priv = session as unknown as PrivateSession & {
      codec: {
        encodeControlMessage: (m: unknown) => Uint8Array;
        decodeControlMessage: (b: Uint8Array) => [RequestErrorMessageDraft18, number];
      };
      processIncomingBidiStream: (s: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }) => Promise<void>;
    };
    setCap(priv);
    const written: Uint8Array[] = [];

    await priv.processIncomingBidiStream({
      readable: new ReadableStream<Uint8Array>({ start: (c) => { c.enqueue(priv.codec.encodeControlMessage(first)); } }),
      writable: new WritableStream<Uint8Array>({ write: (chunk) => { written.push(chunk); } }),
    });

    return { close, reply: priv.codec.decodeControlMessage(written[0])[0] };
  }

  it('refuse a SUBSCRIBE over the track cap with EXCESSIVE_LOAD', async () => {
    const { close, reply } = await overCap({
      type: MessageTypeDraft18.SUBSCRIBE,
      requestId: 1n,
      trackNamespace: ['ns'],
      trackName: 't',
      forwardState: true,
      ...(draft === 'draft-18' ? { filter: SubscriptionFilterDraft18.NEXT_GROUP_START } : {}),
    }, (p) => { p.maxTracks = 0; });

    expect(reply).toMatchObject({ type: MessageTypeDraft18.REQUEST_ERROR, errorCode: RequestErrorCodeDraft18.EXCESSIVE_LOAD });
    expect(close).not.toHaveBeenCalled();
  });

  it('refuse a PUBLISH over the subscription cap with EXCESSIVE_LOAD', async () => {
    const { close, reply } = await overCap({
      type: MessageTypeDraft18.PUBLISH,
      requestId: 1n,
      trackAlias: 9n,
      trackNamespace: ['ns'],
      trackName: 't',
      forwardState: true,
      ...(draft === 'draft-18' ? { largestLocation: { group: 0n, object: 0n } } : {}),
    }, (p) => { p.maxSubscriptions = 0; });

    expect(reply).toMatchObject({ type: MessageTypeDraft18.REQUEST_ERROR, errorCode: RequestErrorCodeDraft18.EXCESSIVE_LOAD });
    expect(close).not.toHaveBeenCalled();
  });
});
