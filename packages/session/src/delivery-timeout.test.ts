// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Draft-18 §8 delivery-timeout tracker unit tests.
 *
 * Uses vitest fake timers so we can advance the clock deterministically
 * without waiting real-time milliseconds.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StreamResetErrorCodeDraft18 } from '@moq-web/core';

import {
  DeliveryTimeoutTracker,
  reasonToResetCode,
  type DeliveryTimeoutReason,
} from './delivery-timeout.js';

describe('DeliveryTimeoutTracker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires onExpiry with DELIVERY_TIMEOUT reset code when the deadline elapses', () => {
    const fired: Array<[string, DeliveryTimeoutReason, StreamResetErrorCodeDraft18]> = [];
    const t = new DeliveryTimeoutTracker((key, reason, code) => {
      fired.push([key, reason, code]);
    });

    t.arm('sg:1:0', 'subgroup', 100);
    expect(t.isArmed('sg:1:0')).toBe(true);
    expect(fired).toEqual([]);

    vi.advanceTimersByTime(99);
    expect(fired).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(fired).toEqual([['sg:1:0', 'subgroup', StreamResetErrorCodeDraft18.DELIVERY_TIMEOUT]]);
    expect(t.isArmed('sg:1:0')).toBe(false);
  });

  it('disarm() cancels a pending deadline', () => {
    const onExpiry = vi.fn();
    const t = new DeliveryTimeoutTracker(onExpiry);

    t.arm('obj:1:0:0', 'object', 500);
    t.disarm('obj:1:0:0');
    vi.advanceTimersByTime(1000);

    expect(onExpiry).not.toHaveBeenCalled();
    expect(t.isArmed('obj:1:0:0')).toBe(false);
  });

  it('re-arming an active key replaces the old timer', () => {
    const onExpiry = vi.fn();
    const t = new DeliveryTimeoutTracker(onExpiry);

    t.arm('k', 'subgroup', 100);
    vi.advanceTimersByTime(50);
    // Extend to 200 from *now*
    t.arm('k', 'subgroup', 200);

    // Old 100ms would have fired at t=100 (50ms further); confirm no fire yet
    vi.advanceTimersByTime(199);
    expect(onExpiry).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onExpiry).toHaveBeenCalledTimes(1);
    // At t=250 the *new* timer fires — old handle is gone.
    vi.advanceTimersByTime(500);
    expect(onExpiry).toHaveBeenCalledTimes(1);
  });

  it('timeoutMs <= 0 disarms without arming a new timer', () => {
    const onExpiry = vi.fn();
    const t = new DeliveryTimeoutTracker(onExpiry);

    t.arm('k', 'subgroup', 100);
    t.arm('k', 'subgroup', 0);
    expect(t.isArmed('k')).toBe(false);

    vi.advanceTimersByTime(5_000);
    expect(onExpiry).not.toHaveBeenCalled();
  });

  it('clear() cancels every pending deadline', () => {
    const onExpiry = vi.fn();
    const t = new DeliveryTimeoutTracker(onExpiry);

    t.arm('a', 'subgroup', 100);
    t.arm('b', 'object', 200);
    t.arm('c', 'fill', 300);
    expect(t.size).toBe(3);

    t.clear();
    expect(t.size).toBe(0);

    vi.advanceTimersByTime(10_000);
    expect(onExpiry).not.toHaveBeenCalled();
  });

  it('swallows exceptions thrown from the expiry callback', () => {
    const t = new DeliveryTimeoutTracker(() => {
      throw new Error('boom');
    });

    t.arm('k', 'object', 10);
    expect(() => vi.advanceTimersByTime(10)).not.toThrow();
  });

  it('reasonToResetCode maps every reason to DELIVERY_TIMEOUT', () => {
    for (const r of ['subgroup', 'object', 'fill', 'rendezvous'] as DeliveryTimeoutReason[]) {
      expect(reasonToResetCode(r)).toBe(StreamResetErrorCodeDraft18.DELIVERY_TIMEOUT);
    }
  });
});
