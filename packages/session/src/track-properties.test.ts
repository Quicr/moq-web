// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { describe, it, expect } from 'vitest';
import {
  Draft18BufferWriter,
  MOQTVarInt,
  GroupOrder,
  TrackPropertyDraft18,
  encodeKeyValuePairs,
} from '@moq-web/core';

import { parseTrackProperties, trackPropertyFault, TrackPropertyFault } from './track-properties.js';

const enc = (n: bigint | number): Uint8Array => MOQTVarInt.encode(typeof n === 'bigint' ? n : BigInt(n));

/** The value of Immutable Properties: the Key-Value-Pairs it holds (draft-22 §10.7) */
function immutable(properties: Array<[number, Uint8Array]>): Uint8Array {
  const writer = new Draft18BufferWriter();
  encodeKeyValuePairs(writer, new Map(properties));

  return writer.toUint8Array();
}

const MANDATORY_FIRST = 0x4000;
const MANDATORY_LAST = 0x7fff;

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
    ]);

    const props = parseTrackProperties(raw);
    expect(props).toBeDefined();
    expect(props?.subgroupDeliveryTimeoutMs).toBe(2500);
    expect(props?.objectDeliveryTimeoutMs).toBe(1200);
    expect(props?.maxCacheDurationMs).toBe(60_000);
    expect(props?.defaultPublisherPriority).toBe(200);
    expect(props?.defaultPublisherGroupOrder).toBe(GroupOrder.DESCENDING);
    expect(props?.dynamicGroups).toBe(true);
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

  it('reads the properties inside Immutable Properties as Track Properties (d22 §10.7)', () => {
    const raw = new Map([
      [TrackPropertyDraft18.MAX_CACHE_DURATION, enc(15_000)],
      [
        TrackPropertyDraft18.IMMUTABLE_PROPERTIES,
        immutable([
          [TrackPropertyDraft18.DEFAULT_PUBLISHER_PRIORITY, enc(40)],
          [TrackPropertyDraft18.DEFAULT_PUBLISHER_GROUP_ORDER, enc(GroupOrder.DESCENDING)],
          [TrackPropertyDraft18.DYNAMIC_GROUPS, enc(1)],
        ]),
      ],
    ]);

    expect(parseTrackProperties(raw)).toEqual({
      maxCacheDurationMs: 15_000,
      defaultPublisherPriority: 40,
      defaultPublisherGroupOrder: GroupOrder.DESCENDING,
      dynamicGroups: true,
    });
  });

  it('ignores Prior Group and Object ID Gap, which only apply to Objects (d22 §10.8, §10.9)', () => {
    const raw = new Map([
      [TrackPropertyDraft18.PRIOR_GROUP_ID_GAP, enc(3)],
      [TrackPropertyDraft18.PRIOR_OBJECT_ID_GAP, enc(7)],
    ]);

    expect(parseTrackProperties(raw)).toBeUndefined();
  });
});

describe('trackPropertyFault', () => {
  it('finds nothing wrong with understood properties', () => {
    const raw = new Map([
      [TrackPropertyDraft18.DYNAMIC_GROUPS, enc(1)],
      [TrackPropertyDraft18.DEFAULT_PUBLISHER_GROUP_ORDER, enc(GroupOrder.ASCENDING)],
      [0x99, enc(42)],
    ]);

    expect(trackPropertyFault(raw)).toBeUndefined();
    expect(trackPropertyFault(undefined)).toBeUndefined();
  });

  it.each([MANDATORY_FIRST, 0x5001, MANDATORY_LAST])(
    'reports Mandatory Track Property 0x%s as unsupported, as we understand none',
    (key) => {
      expect(trackPropertyFault(new Map([[key, enc(1)]]))).toBe(TrackPropertyFault.UNSUPPORTED);
    },
  );

  it('does not take the neighbours of the Mandatory range for it', () => {
    expect(trackPropertyFault(new Map([[MANDATORY_FIRST - 2, enc(1)], [MANDATORY_LAST + 1, enc(1)]]))).toBeUndefined();
  });

  it('finds a Mandatory Track Property inside Immutable Properties', () => {
    const raw = new Map([[TrackPropertyDraft18.IMMUTABLE_PROPERTIES, immutable([[MANDATORY_FIRST, enc(1)]])]]);

    expect(trackPropertyFault(raw)).toBe(TrackPropertyFault.UNSUPPORTED);
  });

  it('reports a group order outside 1 and 2 as invalid', () => {
    const raw = new Map([[TrackPropertyDraft18.DEFAULT_PUBLISHER_GROUP_ORDER, enc(3)]]);

    expect(trackPropertyFault(raw)).toBe(TrackPropertyFault.INVALID);
  });

  it('reports DYNAMIC_GROUPS above 1 as invalid, and inside Immutable Properties too', () => {
    const nested = new Map([[TrackPropertyDraft18.IMMUTABLE_PROPERTIES, immutable([[TrackPropertyDraft18.DYNAMIC_GROUPS, enc(2)]])]]);

    expect(trackPropertyFault(new Map([[TrackPropertyDraft18.DYNAMIC_GROUPS, enc(2)]]))).toBe(TrackPropertyFault.INVALID);
    expect(trackPropertyFault(nested)).toBe(TrackPropertyFault.INVALID);
  });

  it('reports Immutable Properties that do not parse as invalid', () => {
    const raw = new Map([[TrackPropertyDraft18.IMMUTABLE_PROPERTIES, new Uint8Array([0x0f, 0xff])]]);

    expect(trackPropertyFault(raw)).toBe(TrackPropertyFault.INVALID);
  });
});
