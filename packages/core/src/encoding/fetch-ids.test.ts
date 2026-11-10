// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { describe, it, expect } from 'vitest';
import { FetchIdResolver, isFetchIndicatorAllowed } from './fetch-ids';
import { Draft18StreamCodec } from './draft18-stream-codec';
import { MOQT_VARINT_MAX } from './moqt-varint';
import { violationOf } from './violation';
import {
  FetchObjectEndOfRange,
  FetchObjectMarker,
  FetchSubgroupMode,
  GroupOrder,
  type FetchObjectDraft18,
} from '../messages/types';

/** A Fetch Object with explicit fields; omitted ones reference the prior Object */
const obj = (fields: Partial<FetchObjectDraft18> = {}): FetchObjectDraft18 => ({
  subgroupMode: FetchSubgroupMode.ZERO,
  payloadLength: 0n,
  ...fields,
});
const first = (group: bigint, object: bigint): FetchObjectDraft18 =>
  obj({ groupIdDelta: group, objectIdDelta: object, publisherPriority: 1 });

function expectKind(fn: () => unknown, kind: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(violationOf(caught)).toBe(kind);
}

describe('FetchIdResolver (draft-23 rules)', () => {
  it('takes the first Object absolutely, then +1 when no Object ID Delta', () => {
    const r = new FetchIdResolver('draft-23');
    expect(r.object(first(5n, 3n))).toMatchObject({ groupId: 5n, objectId: 3n, priority: 1 });
    expect(r.object(obj())).toMatchObject({ groupId: 5n, objectId: 4n, priority: 1 });
  });

  it('adds Object ID Delta + 2 within a Group (#2006)', () => {
    const r = new FetchIdResolver('draft-23');
    r.object(first(5n, 3n));
    // Delta 0 means a gap of one Object: 3 -> 5
    expect(r.object(obj({ objectIdDelta: 0n })).objectId).toBe(5n);
    expect(r.object(obj({ objectIdDelta: 4n })).objectId).toBe(11n);
  });

  it('moves Groups by delta + 1 in the Group Order, with an absolute Object ID', () => {
    const up = new FetchIdResolver('draft-23', GroupOrder.ASCENDING);
    up.object(first(5n, 3n));
    expect(up.object(obj({ groupIdDelta: 0n, objectIdDelta: 0n }))).toMatchObject({ groupId: 6n, objectId: 0n });

    const down = new FetchIdResolver('draft-23', GroupOrder.DESCENDING);
    down.object(first(5n, 3n));
    expect(down.object(obj({ groupIdDelta: 1n, objectIdDelta: 7n }))).toMatchObject({ groupId: 3n, objectId: 7n });
  });

  it('decodes End of Range absolutely when first, then by delta (#2031)', () => {
    const r = new FetchIdResolver('draft-23');
    expect(r.endOfRange(2n, 9n)).toEqual({ group: 2n, object: 9n });
    // Same Group: Object = prior + delta + 1
    expect(r.endOfRange(0n, 0n)).toEqual({ group: 2n, object: 10n });
    // New Group: Group = prior + delta (no +1), Object absolute
    expect(r.endOfRange(3n, 4n)).toEqual({ group: 5n, object: 4n });
    // An Object after it continues from the indicator's Location
    expect(r.object(obj({ objectIdDelta: 0n, publisherPriority: 2 })).objectId).toBe(6n);
  });

  it('decodes descending End of Range deltas', () => {
    const r = new FetchIdResolver('draft-23', GroupOrder.DESCENDING);
    r.object(first(10n, 0n));
    expect(r.endOfRange(4n, 2n)).toEqual({ group: 6n, object: 2n });
  });

  it('End of Group sets the prior Object ID to 2^64-1, so the next Object must change Group (#2013)', () => {
    const r = new FetchIdResolver('draft-23');
    r.object(first(1n, 0n));
    expect(r.marker(FetchObjectMarker.END_OF_GROUP)).toBe(1n);
    expectKind(() => r.object(obj()), 'delta-overflow');

    const ok = new FetchIdResolver('draft-23');
    ok.object(first(1n, 0n));
    ok.marker(FetchObjectMarker.END_OF_GROUP);
    expect(ok.object(obj({ groupIdDelta: 0n, objectIdDelta: 0n }))).toMatchObject({ groupId: 2n, objectId: 0n });
  });

  it('End of Track ends the stream: nothing may follow', () => {
    const r = new FetchIdResolver('draft-23');
    r.object(first(1n, 0n));
    r.marker(FetchObjectMarker.END_OF_TRACK);
    expect(r.endOfTrack).toBe(true);
    expectKind(() => r.object(obj({ groupIdDelta: 0n, objectIdDelta: 0n })), 'malformed-object');
    expectKind(() => r.endOfRange(1n, 0n), 'malformed-object');
  });

  it('a marker before any entry is malformed', () => {
    expectKind(() => new FetchIdResolver('draft-23').marker(FetchObjectMarker.END_OF_GROUP), 'malformed-object');
  });

  it('rejects IDs past 2^64-1 or below 0 (DELTA_ENCODING_OVERFLOW)', () => {
    const r = new FetchIdResolver('draft-23');
    r.object(first(0n, MOQT_VARINT_MAX - 1n));
    expectKind(() => r.object(obj({ objectIdDelta: 0n })), 'delta-overflow');

    const down = new FetchIdResolver('draft-23', GroupOrder.DESCENDING);
    down.object(first(0n, 0n));
    expectKind(() => down.object(obj({ groupIdDelta: 0n, objectIdDelta: 0n })), 'delta-overflow');

    const range = new FetchIdResolver('draft-23', GroupOrder.DESCENDING);
    range.endOfRange(1n, 0n);
    expectKind(() => range.endOfRange(2n, 0n), 'delta-overflow');
  });

  it('a first Object referencing a prior Object is MALFORMED_OBJECT', () => {
    expectKind(() => new FetchIdResolver('draft-23').object(obj({ objectIdDelta: 0n })), 'malformed-object');
    expectKind(() => new FetchIdResolver('draft-23').object(obj({ groupIdDelta: 0n })), 'malformed-object');
    // After an End of Range the IDs have a prior, but Subgroup and Priority do not
    const r = new FetchIdResolver('draft-23');
    r.endOfRange(1n, 1n);
    expectKind(() => r.object(obj({ subgroupMode: FetchSubgroupMode.PRIOR, publisherPriority: 1 })), 'malformed-object');
    expectKind(() => r.object(obj({ objectIdDelta: 0n })), 'malformed-object');
  });

  it('keeps Subgroup and Priority from the last Object across indicators', () => {
    const r = new FetchIdResolver('draft-23');
    r.object(obj({ groupIdDelta: 1n, objectIdDelta: 0n, publisherPriority: 9, subgroupMode: FetchSubgroupMode.EXPLICIT, subgroupId: 4n }));
    r.endOfRange(0n, 2n);
    expect(r.object(obj({ subgroupMode: FetchSubgroupMode.PRIOR_PLUS_ONE }))).toMatchObject({
      groupId: 1n,
      objectId: 4n,
      subgroupId: 5n,
      priority: 9,
    });
  });
});

describe('FetchIdResolver (draft-18/22 rules)', () => {
  it('adds the bare Object ID Delta within a Group', () => {
    const r = new FetchIdResolver('draft-18');
    r.object(first(5n, 3n));
    expect(r.object(obj({ objectIdDelta: 4n })).objectId).toBe(7n);
  });

  it('takes End of Range IDs absolutely', () => {
    const r = new FetchIdResolver('draft-18');
    r.object(first(5n, 3n));
    expect(r.endOfRange(7n, 1n)).toEqual({ group: 7n, object: 1n });
  });
});

describe('isFetchIndicatorAllowed', () => {
  it('allows Gone and End of Group/Track only under draft-23', () => {
    for (const marker of [FetchObjectEndOfRange.GONE, FetchObjectMarker.END_OF_GROUP, FetchObjectMarker.END_OF_TRACK]) {
      expect(isFetchIndicatorAllowed(marker, 'draft-23', true)).toBe(true);
      expect(isFetchIndicatorAllowed(marker, 'draft-18', true)).toBe(false);
    }
    expect(isFetchIndicatorAllowed(FetchObjectEndOfRange.TIMED_OUT, 'draft-18', false)).toBe(false);
    expect(isFetchIndicatorAllowed(FetchObjectEndOfRange.NON_EXISTENT, 'draft-18', false)).toBe(true);
  });
});

describe('Draft18StreamCodec fetch indicators', () => {
  it('round-trips End of Group, End of Track and End of Gone Range', () => {
    for (const marker of [FetchObjectMarker.END_OF_GROUP, FetchObjectMarker.END_OF_TRACK]) {
      const bytes = Draft18StreamCodec.encodeFetchObject({ subgroupMode: FetchSubgroupMode.ZERO, marker });
      expect(bytes.length).toBe(2);
      const [decoded, length] = Draft18StreamCodec.decodeFetchObject(bytes);
      expect(decoded.marker).toBe(marker);
      expect(length).toBe(2);
    }
    const gone = Draft18StreamCodec.encodeFetchObject({
      subgroupMode: FetchSubgroupMode.ZERO,
      endOfRange: FetchObjectEndOfRange.GONE,
      groupIdDelta: 1n,
      objectIdDelta: 2n,
    });
    expect(Draft18StreamCodec.decodeFetchObject(gone)[0]).toMatchObject({ endOfRange: 0x40c, groupIdDelta: 1n, objectIdDelta: 2n });
  });

  it('an undefined indicator is MALFORMED_OBJECT', () => {
    // 0x82 as a 2-byte MOQT varint
    expectKind(() => Draft18StreamCodec.decodeFetchObject(new Uint8Array([0x80, 0x82])), 'malformed-object');
  });
});
