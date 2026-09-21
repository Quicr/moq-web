// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Regression coverage for B7 — objects delivered on a subscribed track between
 * SUBSCRIBE-request-send and SUBSCRIBE_OK were silently dropped because the
 * async iterator wasn't wired until after the OK. The fix buffers arriving
 * objects into a bounded queue (drop-oldest at 256) from the moment the
 * `onObject` callback is handed to the underlying session, then drains that
 * queue into the caller's iterator.
 *
 * We stub the minimum MOQTSession surface used by `UnifiedSession.subscribe`
 * (subscribe/unsubscribe + a couple of getters) so the test doesn't need a
 * real transport.
 */

import { describe, expect, it } from 'vitest';
import { SubscriptionFilter } from '@moq-web/core';

import { UnifiedSession } from './unified-session.js';
import type { MOQTSession } from './session.js';

type ObjectCb = (data: Uint8Array, groupId: number, objectId: number, ts: number) => void;

interface StubHandles {
  /** Resolve the pending SUBSCRIBE promise (simulates SUBSCRIBE_OK). */
  resolveSubscribe: (subscriptionId: number) => void;
  /** Emit an object as if it arrived from the wire. */
  emit: (data: Uint8Array, groupId: number, objectId: number) => void;
  /** Report captured unsubscribe calls. */
  unsubscribed: number[];
}

function makeStubSession(): { session: MOQTSession; handles: StubHandles } {
  let pendingResolve: ((id: number) => void) | null = null;
  let capturedCb: ObjectCb | undefined;
  const unsubscribed: number[] = [];

  const stub = {
    // Minimal getters used by UnifiedSession state/version/capabilities plus
    // the two methods the test path exercises.
    state: 'ready' as const,
    draft: 'draft-18' as const,
    subscribe(_ns: string[], _tn: string, _opts: unknown, onObject?: ObjectCb): Promise<number> {
      // Capture the callback synchronously — this mirrors the real session,
      // which registers the callback on the internal subscription BEFORE the
      // wire SUBSCRIBE is emitted. That's exactly the window where early
      // objects used to be dropped.
      capturedCb = onObject;
      return new Promise<number>((resolve) => {
        pendingResolve = resolve;
      });
    },
    async unsubscribe(id: number): Promise<void> {
      unsubscribed.push(id);
    },
  };

  const handles: StubHandles = {
    resolveSubscribe(subscriptionId: number) {
      if (!pendingResolve) throw new Error('subscribe() not called yet');
      const r = pendingResolve;
      pendingResolve = null;
      r(subscriptionId);
    },
    emit(data, groupId, objectId) {
      if (!capturedCb) throw new Error('onObject callback not captured');
      capturedCb(data, groupId, objectId, 0);
    },
    unsubscribed,
  };

  return { session: stub as unknown as MOQTSession, handles };
}

describe('UnifiedSession.subscribe — B7 pre-OK buffering', () => {
  it('does NOT drop objects that arrive before SUBSCRIBE_OK', async () => {
    const { session, handles } = makeStubSession();
    const unified = UnifiedSession.fromLegacy(session);

    // Start subscribe — the underlying session.subscribe() promise is not
    // yet resolved (no SUBSCRIBE_OK).
    const subPromise = unified.subscribe({
      trackNamespace: ['ns'],
      trackName: 'track',
      filter: SubscriptionFilter.LATEST_GROUP,
    });

    // Emit two objects BEFORE SUBSCRIBE_OK. Pre-fix these would be silently
    // discarded; post-fix they land in the bounded buffer.
    handles.emit(new Uint8Array([1]), 0, 0);
    handles.emit(new Uint8Array([2]), 0, 1);

    // Now deliver the OK so the promise resolves and the caller can drain.
    handles.resolveSubscribe(42);

    const subscription = await subPromise;

    // Emit one more object after OK for good measure.
    handles.emit(new Uint8Array([3]), 0, 2);

    const iter = subscription.objects[Symbol.asyncIterator]();
    const seen: number[] = [];
    for (let i = 0; i < 3; i++) {
      const { value, done } = await iter.next();
      expect(done).toBe(false);
      expect(value).toBeDefined();
      seen.push(value!.payload[0]);
    }
    expect(seen).toEqual([1, 2, 3]);

    await subscription.unsubscribe();
    expect(handles.unsubscribed).toEqual([42]);
  });

  it('bounds the pre-OK buffer at 256 with drop-oldest', async () => {
    const { session, handles } = makeStubSession();
    const unified = UnifiedSession.fromLegacy(session);

    const subPromise = unified.subscribe({
      trackNamespace: ['ns'],
      trackName: 'track',
      filter: SubscriptionFilter.LATEST_GROUP,
    });

    // Emit 260 objects while SUBSCRIBE is still in flight.
    for (let i = 0; i < 260; i++) {
      handles.emit(new Uint8Array([i & 0xff]), 0, i);
    }

    handles.resolveSubscribe(7);
    const subscription = await subPromise;

    const iter = subscription.objects[Symbol.asyncIterator]();
    // Buffer holds the *newest* 256 — the first 4 (objectId 0..3) were dropped.
    const first = await iter.next();
    expect(first.done).toBe(false);
    // objectId of the first surviving object should be 4 (0..3 dropped).
    expect(Number(first.value!.objectId)).toBe(4);

    await subscription.unsubscribe();
  });

  it('resolves an awaiting iterator directly when an object arrives after OK', async () => {
    const { session, handles } = makeStubSession();
    const unified = UnifiedSession.fromLegacy(session);

    const subPromise = unified.subscribe({
      trackNamespace: ['ns'],
      trackName: 'track',
      filter: SubscriptionFilter.LATEST_GROUP,
    });
    handles.resolveSubscribe(1);
    const subscription = await subPromise;

    const iter = subscription.objects[Symbol.asyncIterator]();
    const pending = iter.next();

    // Give the iterator a microtask to install its resolver, then emit.
    await Promise.resolve();
    handles.emit(new Uint8Array([9]), 3, 4);

    const { value, done } = await pending;
    expect(done).toBe(false);
    expect(value!.payload[0]).toBe(9);
    expect(Number(value!.groupId)).toBe(3);
    expect(Number(value!.objectId)).toBe(4);

    await subscription.unsubscribe();
  });
});
