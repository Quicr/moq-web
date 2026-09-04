// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * ObjectRouter §8 delivery-timeout integration tests.
 *
 * Feeds a real ReadableStream carrying an encoded subgroup header and one
 * object; drives fake timers to make the subgroup-delivery deadline fire
 * mid-stream and asserts the router:
 *   1. Notifies the `onDeliveryTimeout` callback with the DELIVERY_TIMEOUT
 *      reset code.
 *   2. Cancels the underlying reader (proxied via a controlled stream).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ObjectCodec, StreamResetErrorCodeDraft18 } from '@moq-web/core';

import { ObjectRouter } from './object-router.js';
import { SubscriptionManager, type InternalSubscription } from './subscription-manager.js';

function makeSub(overrides: Partial<InternalSubscription>): InternalSubscription {
  return {
    subscriptionId: 1,
    requestId: 1,
    namespace: ['ns'],
    trackName: 'track',
    trackAlias: 1n,
    paused: false,
    ...overrides,
  };
}

/**
 * Build a subgroup stream containing exactly one object. Uses the shared
 * `ObjectCodec.encodeSubgroupHeader` + `encodeStreamObject` so the bytes are
 * whatever the current draft codec produces — we don't hard-code wire
 * shapes here.
 */
function encodeSubgroupStream(trackAlias: bigint, groupId: number, objectId: number, payload: Uint8Array): Uint8Array {
  const [header, hasExt] = ObjectCodec.encodeSubgroupHeader(
    { trackAlias, groupId, subgroupId: 0, publisherPriority: 128 },
    false,
  );
  const obj = ObjectCodec.encodeStreamObject(objectId, payload, 0 /* NORMAL */, -1, hasExt);
  const out = new Uint8Array(header.length + obj.length);
  out.set(header, 0);
  out.set(obj, header.length);
  return out;
}

describe('ObjectRouter §8 delivery-timeout enforcement', () => {
  let subs: SubscriptionManager;
  let router: ObjectRouter;

  beforeEach(() => {
    vi.useFakeTimers();
    subs = new SubscriptionManager();
    router = new ObjectRouter(subs);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires onDeliveryTimeout and cancels the reader when the subgroup deadline elapses', async () => {
    const sub = makeSub({
      subscriptionId: 42,
      trackAlias: 7n,
      subgroupDeliveryTimeoutMs: 100,
    });
    subs.add(sub);

    const cancelled = { called: false, reason: null as unknown };
    const timeoutHits: Array<{ reason: string; resetCode: number; subId: number }> = [];
    router.setDeliveryTimeoutCallback((s, reason, resetCode) => {
      timeoutHits.push({ reason, resetCode, subId: s.subscriptionId });
    });

    // First chunk carries the subgroup header + first object. We hold back
    // the *next* object so the reader is waiting when the deadline fires.
    const chunk1 = encodeSubgroupStream(7n, 0, 0, new Uint8Array([0xaa]));

    // Custom stream that yields chunk1 then blocks forever.
    let neverResolve: ((v: { value?: Uint8Array; done: boolean }) => void) | undefined;
    let firstDelivered = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!firstDelivered) {
          firstDelivered = true;
          controller.enqueue(chunk1);
        }
        // subsequent pulls: block until cancel()
        return new Promise<void>((_res) => {
          // never resolves — waits for cancel
          neverResolve = (v) => { void v; _res(); };
        });
      },
      cancel(reason) {
        cancelled.called = true;
        cancelled.reason = reason;
        if (neverResolve) neverResolve({ done: true });
      },
    });

    const p = router.handleIncomingStream(stream);

    // Let the microtask queue flush so the first chunk is consumed and the
    // subgroup timer is armed.
    await Promise.resolve();
    await Promise.resolve();

    // Advance past the 100ms deadline.
    await vi.advanceTimersByTimeAsync(150);

    // Wait for the handler to finish reacting.
    await p.catch(() => {}); // may reject on cancel

    expect(timeoutHits.length).toBe(1);
    expect(timeoutHits[0].reason).toBe('subgroup');
    expect(timeoutHits[0].resetCode).toBe(StreamResetErrorCodeDraft18.DELIVERY_TIMEOUT);
    expect(timeoutHits[0].subId).toBe(42);
    expect(cancelled.called).toBe(true);
  });

  it('does not fire onDeliveryTimeout when no §8 deadline is configured on the subscription', async () => {
    subs.add(makeSub({ trackAlias: 9n }));
    const timeoutHits: unknown[] = [];
    router.setDeliveryTimeoutCallback(() => {
      timeoutHits.push(1);
    });

    const chunk = encodeSubgroupStream(9n, 0, 0, new Uint8Array([0xaa, 0xbb]));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.close();
      },
    });

    await router.handleIncomingStream(stream);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(timeoutHits).toEqual([]);
    // Tracker should be empty since nothing was armed.
    expect(router.deliveryTimeoutTracker.size).toBe(0);
  });

  it('clearDeliveryTimeouts() cancels every pending timer', () => {
    subs.add(makeSub({ trackAlias: 3n, subgroupDeliveryTimeoutMs: 500 }));
    // Arm a timer by faking a subgroup-header decode via the tracker path
    // directly (we're testing the aggregate clear, not the stream loop).
    router.deliveryTimeoutTracker.arm('sg:3:0:0', 'subgroup', 500);
    router.deliveryTimeoutTracker.arm('obj:3:0:0:0', 'object', 500);
    expect(router.deliveryTimeoutTracker.size).toBe(2);

    router.clearDeliveryTimeouts();
    expect(router.deliveryTimeoutTracker.size).toBe(0);
  });
});
