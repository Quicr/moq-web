// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { describe, it, expect } from 'vitest';
import { MOQTVarInt, GroupOrder, TrackPropertyDraft18 } from '@moq-web/core';

import { parseTrackProperties } from './track-properties.js';

const enc = (n: bigint | number): Uint8Array => MOQTVarInt.encode(typeof n === 'bigint' ? n : BigInt(n));

describe('parseTrackProperties', () => {
  it('returns undefined for empty or missing input', () => {
    expect(parseTrackProperties(undefined)).toBeUndefined();
    expect(parseTrackProperties(new Map())).toBeUndefined();
  });

  it('decodes all draft-18 §12 properties in a single map', () => {
    const raw = new Map<number, Uint8Array>([
      [TrackPropertyDraft18.SUBGROUP_DELIVERY_TIMEOUT, enc(2500)],
      [TrackPropertyDraft18.OBJECT_DELIVERY_TIMEOUT, enc(1200)],
      [TrackPropertyDraft18.MAX_CACHE_DURATION, enc(60_000)],
      [TrackPropertyDraft18.DEFAULT_PUBLISHER_PRIORITY, enc(200)],
      [TrackPropertyDraft18.DEFAULT_PUBLISHER_GROUP_ORDER, enc(GroupOrder.DESCENDING)],
      [TrackPropertyDraft18.DYNAMIC_GROUPS, enc(1)],
      [TrackPropertyDraft18.IMMUTABLE_PROPERTIES, enc(0b1010n)],
    ]);

    const props = parseTrackProperties(raw);
    expect(props).toBeDefined();
    expect(props?.subgroupDeliveryTimeoutMs).toBe(2500);
    expect(props?.objectDeliveryTimeoutMs).toBe(1200);
    expect(props?.maxCacheDurationMs).toBe(60_000);
    expect(props?.defaultPublisherPriority).toBe(200);
    expect(props?.defaultPublisherGroupOrder).toBe(GroupOrder.DESCENDING);
    expect(props?.dynamicGroups).toBe(true);
    expect(props?.immutablePropertiesBitmap).toBe(0b1010n);
  });

  it('treats a zero DYNAMIC_GROUPS varint as false', () => {
    const raw = new Map([[TrackPropertyDraft18.DYNAMIC_GROUPS, enc(0)]]);
    expect(parseTrackProperties(raw)?.dynamicGroups).toBe(false);
  });

  it('accepts ASCENDING for DEFAULT_PUBLISHER_GROUP_ORDER', () => {
    const raw = new Map([
      [TrackPropertyDraft18.DEFAULT_PUBLISHER_GROUP_ORDER, enc(GroupOrder.ASCENDING)],
    ]);
    expect(parseTrackProperties(raw)?.defaultPublisherGroupOrder).toBe(GroupOrder.ASCENDING);
  });

  it('drops out-of-range DEFAULT_PUBLISHER_GROUP_ORDER silently', () => {
    const raw = new Map([[TrackPropertyDraft18.DEFAULT_PUBLISHER_GROUP_ORDER, enc(99)]]);
    expect(parseTrackProperties(raw)).toBeUndefined();
  });

  it('ignores unknown keys per §15.8', () => {
    const raw = new Map([
      [0x99, enc(42)],
      [TrackPropertyDraft18.MAX_CACHE_DURATION, enc(15_000)],
    ]);
    const props = parseTrackProperties(raw);
    expect(props?.maxCacheDurationMs).toBe(15_000);
    expect(Object.keys(props ?? {})).toEqual(['maxCacheDurationMs']);
  });

  it('returns undefined when only unknown keys are present', () => {
    const raw = new Map([[0x99, enc(42)]]);
    expect(parseTrackProperties(raw)).toBeUndefined();
  });

  it('preserves large immutable-properties bitmaps as bigint', () => {
    const large = (1n << 40n) | 0xdeadbeefn;
    const raw = new Map([[TrackPropertyDraft18.IMMUTABLE_PROPERTIES, enc(large)]]);
    expect(parseTrackProperties(raw)?.immutablePropertiesBitmap).toBe(large);
  });
});
