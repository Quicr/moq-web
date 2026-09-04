// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Draft-18 §8 delivery-timeout enforcement primitive.
 *
 * Tracks per-subgroup and per-object deadlines. A caller arms a timer when
 * a subgroup opens (or an object is queued), disarms it on delivery, and
 * receives an `onExpiry` callback if the deadline elapses. The callback
 * receives the stream-reset code the peer expects (§15.10.4 DELIVERY_TIMEOUT).
 *
 * The primitive is transport-agnostic — subscriber-side wiring calls it when
 * a subgroup header arrives and each object completes; publisher-side wiring
 * calls it when an object is enqueued for send and when the write completes.
 * The reset action itself lives with the caller (WritableStream.abort()
 * on the publisher side, WebTransportReceiveStream cancel() + notify on
 * the subscriber side).
 */

import { Logger, StreamResetErrorCodeDraft18 } from '@moq-web/core';

const log = Logger.create('moqt:session:delivery-timeout');

/**
 * Reason a deadline fired. Maps directly to a §15.10.4 reset code.
 */
export type DeliveryTimeoutReason =
  | 'subgroup'
  | 'object'
  | 'fill'
  | 'rendezvous';

/**
 * Callback fired when a deadline elapses. `key` echoes the value the caller
 * passed to `arm()` so it can look up the associated stream/object.
 */
export type DeliveryTimeoutExpiryHandler = (
  key: string,
  reason: DeliveryTimeoutReason,
  resetCode: StreamResetErrorCodeDraft18,
) => void;

interface Timer {
  readonly key: string;
  readonly reason: DeliveryTimeoutReason;
  readonly handle: ReturnType<typeof setTimeout>;
}

/**
 * Options controlling how the tracker schedules timers. `now` and
 * `scheduler` are injected so unit tests can drive fake time.
 */
export interface DeliveryTimeoutOptions {
  now?: () => number;
  scheduler?: {
    setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
    clearTimeout: (h: ReturnType<typeof setTimeout>) => void;
  };
}

/**
 * Tracks live deadlines keyed by an opaque string (caller chooses shape,
 * typically `${trackAlias}:${groupId}:${subgroupId}` for subgroups or
 * `${trackAlias}:${groupId}:${objectId}` for objects).
 *
 * The tracker never resets streams itself — it invokes the caller-provided
 * `onExpiry` callback and lets the caller decide how to react (abort a
 * WritableStream on the publisher side, drop the object on the subscriber
 * side, etc.).
 */
export class DeliveryTimeoutTracker {
  private readonly timers = new Map<string, Timer>();
  private readonly setTimeoutFn: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimeoutFn: (h: ReturnType<typeof setTimeout>) => void;

  constructor(
    private readonly onExpiry: DeliveryTimeoutExpiryHandler,
    options: DeliveryTimeoutOptions = {},
  ) {
    this.setTimeoutFn = options.scheduler?.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = options.scheduler?.clearTimeout ?? ((h) => clearTimeout(h));
  }

  /**
   * Arm a deadline. If one is already armed under `key`, it is replaced —
   * this lets a caller extend or shorten a running timer without leaking
   * the previous handle.
   *
   * A `timeoutMs` of 0 or negative disarms any existing timer and returns
   * without arming a new one (matches the spec's "value 0 disables" rule).
   */
  arm(key: string, reason: DeliveryTimeoutReason, timeoutMs: number): void {
    this.disarm(key);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return;

    const handle = this.setTimeoutFn(() => {
      this.timers.delete(key);
      const resetCode = reasonToResetCode(reason);
      log.debug('Delivery timeout expired', { key, reason, resetCode, timeoutMs });
      try {
        this.onExpiry(key, reason, resetCode);
      } catch (err) {
        log.warn('onExpiry callback threw', { key, error: (err as Error).message });
      }
    }, timeoutMs);

    this.timers.set(key, { key, reason, handle });
  }

  /**
   * Cancel a pending deadline. No-op when nothing is armed under `key`.
   */
  disarm(key: string): void {
    const t = this.timers.get(key);
    if (!t) return;
    this.clearTimeoutFn(t.handle);
    this.timers.delete(key);
  }

  /**
   * Cancel every pending deadline. Called on session close / unsubscribe.
   */
  clear(): void {
    for (const t of this.timers.values()) {
      this.clearTimeoutFn(t.handle);
    }
    this.timers.clear();
  }

  /** Test-only introspection. */
  get size(): number {
    return this.timers.size;
  }

  /** Test-only introspection: is `key` armed? */
  isArmed(key: string): boolean {
    return this.timers.has(key);
  }
}

/**
 * Map a timeout reason to the §15.10.4 stream-reset code peers expect on the
 * abort side. `fill` and `rendezvous` are subscriber-side hints without a
 * dedicated reset code; they map to DELIVERY_TIMEOUT because the wire signal
 * carries the same operational meaning to the peer.
 */
export function reasonToResetCode(reason: DeliveryTimeoutReason): StreamResetErrorCodeDraft18 {
  switch (reason) {
    case 'subgroup':
    case 'object':
    case 'fill':
    case 'rendezvous':
      return StreamResetErrorCodeDraft18.DELIVERY_TIMEOUT;
  }
}
