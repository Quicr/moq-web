// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Unit tests for the draft-18 §7 priority helpers.
 */

import { describe, expect, it } from 'vitest';
import { GroupOrder } from '@moq-web/core';

import { computeSendOrder, parseSubscriberSchedulingParams } from './priority.js';

describe('computeSendOrder — §7.2 ordering', () => {
  it('lower subscriberPriority yields a larger sendOrder (higher precedence ships first)', () => {
    const high = computeSendOrder(0, 128, GroupOrder.ASCENDING, 0);
    const low = computeSendOrder(255, 128, GroupOrder.ASCENDING, 0);
    expect(high).toBeGreaterThan(low);
  });

  it('subscriberPriority dominates publisherPriority (subscriber breaks ties first)', () => {
    // Better subscriber priority but worse publisher priority — still ships first.
    const a = computeSendOrder(0, 255, GroupOrder.ASCENDING, 0);
    const b = computeSendOrder(1, 0, GroupOrder.ASCENDING, 0);
    expect(a).toBeGreaterThan(b);
  });

  it('publisherPriority breaks subscriberPriority ties', () => {
    const better = computeSendOrder(64, 0, GroupOrder.ASCENDING, 0);
    const worse = computeSendOrder(64, 255, GroupOrder.ASCENDING, 0);
    expect(better).toBeGreaterThan(worse);
  });

  it('ASCENDING: lower groupId ships first (larger sendOrder)', () => {
    const g0 = computeSendOrder(0, 0, GroupOrder.ASCENDING, 0);
    const g100 = computeSendOrder(0, 0, GroupOrder.ASCENDING, 100);
    expect(g0).toBeGreaterThan(g100);
  });

  it('DESCENDING: higher groupId ships first (larger sendOrder)', () => {
    const g0 = computeSendOrder(0, 0, GroupOrder.DESCENDING, 0);
    const g100 = computeSendOrder(0, 0, GroupOrder.DESCENDING, 100);
    expect(g100).toBeGreaterThan(g0);
  });

  it('groupOrder tiebreak stays below the priority fields', () => {
    // Even with an extreme groupId gap, a single-step subscriber-priority
    // improvement should dominate.
    const worseSubBestGroup = computeSendOrder(1, 0, GroupOrder.ASCENDING, 0);
    const betterSubWorstGroup = computeSendOrder(0, 0, GroupOrder.ASCENDING, 2 ** 36 - 1);
    expect(betterSubWorstGroup).toBeGreaterThan(worseSubBestGroup);
  });

  it('clamps out-of-range priority values (negative → 0, >255 → 255)', () => {
    const clampedLow = computeSendOrder(-10, -10, GroupOrder.ASCENDING, 0);
    const zero = computeSendOrder(0, 0, GroupOrder.ASCENDING, 0);
    expect(clampedLow).toBe(zero);

    const clampedHigh = computeSendOrder(1000, 1000, GroupOrder.ASCENDING, 0);
    const max = computeSendOrder(255, 255, GroupOrder.ASCENDING, 0);
    expect(clampedHigh).toBe(max);
  });

  it('non-finite priorities fall back to 128 (mid)', () => {
    const nan = computeSendOrder(Number.NaN, Number.NaN, GroupOrder.ASCENDING, 0);
    const mid = computeSendOrder(128, 128, GroupOrder.ASCENDING, 0);
    expect(nan).toBe(mid);
  });

  it('fits safely in a JS Number (< 2^53) and is non-negative', () => {
    const v = computeSendOrder(0, 0, GroupOrder.ASCENDING, 0);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(Number.MAX_SAFE_INTEGER);
    expect(Number.isSafeInteger(v)).toBe(true);
  });
});

describe('parseSubscriberSchedulingParams', () => {
  it('returns an empty object when params are undefined', () => {
    expect(parseSubscriberSchedulingParams(undefined)).toEqual({});
  });

  it('extracts SUBSCRIBER_PRIORITY (0x20) as a single byte', () => {
    const params = new Map<number, Uint8Array>();
    params.set(0x20, new Uint8Array([64]));
    expect(parseSubscriberSchedulingParams(params)).toEqual({ subscriberPriority: 64 });
  });

  it('maps GROUP_ORDER (0x22) byte 1 → ASCENDING and 2 → DESCENDING', () => {
    const asc = new Map<number, Uint8Array>([[0x22, new Uint8Array([1])]]);
    const desc = new Map<number, Uint8Array>([[0x22, new Uint8Array([2])]]);
    expect(parseSubscriberSchedulingParams(asc).groupOrder).toBe(GroupOrder.ASCENDING);
    expect(parseSubscriberSchedulingParams(desc).groupOrder).toBe(GroupOrder.DESCENDING);
  });

  it('unknown GROUP_ORDER values fall back to ASCENDING', () => {
    const params = new Map<number, Uint8Array>([[0x22, new Uint8Array([99])]]);
    expect(parseSubscriberSchedulingParams(params).groupOrder).toBe(GroupOrder.ASCENDING);
  });

  it('returns both fields when both parameters are present', () => {
    const params = new Map<number, Uint8Array>();
    params.set(0x20, new Uint8Array([32]));
    params.set(0x22, new Uint8Array([2]));
    expect(parseSubscriberSchedulingParams(params)).toEqual({
      subscriberPriority: 32,
      groupOrder: GroupOrder.DESCENDING,
    });
  });

  it('ignores zero-length parameter values', () => {
    const params = new Map<number, Uint8Array>();
    params.set(0x20, new Uint8Array([]));
    params.set(0x22, new Uint8Array([]));
    expect(parseSubscriberSchedulingParams(params)).toEqual({});
  });
});
