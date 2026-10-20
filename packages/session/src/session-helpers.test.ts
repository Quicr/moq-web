// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { describe, it, expect } from 'vitest';
import { FetchTypeDraft18, GroupOrder, LocationFilterTypeDraft22, TrackPropertyDraft18 } from '@moq-web/core';

import { buildTrackProperties, mapFillParameters, mapJoiningFetch, mapLocationFilter } from './session-helpers.js';

describe('mapLocationFilter (draft-22 §9.20.9)', () => {
  it('maps largest-object to NEXT_OBJECT', () => {
    expect(mapLocationFilter({ filterType: 'largest-object' })).toEqual({
      type: LocationFilterTypeDraft22.NEXT_OBJECT,
    });
  });

  it('maps absolute and absolute-start to ABSOLUTE_START', () => {
    for (const filterType of ['absolute', 'absolute-start'] as const) {
      expect(mapLocationFilter({ filterType, startGroup: 3, startObject: 4 })).toEqual({
        type: LocationFilterTypeDraft22.ABSOLUTE_START,
        startLocation: { group: 3n, object: 4n },
      });
    }
  });

  it('maps absolute-range to ABSOLUTE_START_GROUP_END with a group delta', () => {
    expect(
      mapLocationFilter({ filterType: 'absolute-range', startGroup: 3, startObject: 1, endGroup: 8 }),
    ).toEqual({
      type: LocationFilterTypeDraft22.ABSOLUTE_START_GROUP_END,
      startLocation: { group: 3n, object: 1n },
      endGroupDelta: 5n,
    });
  });

  it('defaults an absent endGroup to startGroup (delta 0)', () => {
    expect(mapLocationFilter({ filterType: 'absolute-range', startGroup: 3 })).toMatchObject({
      endGroupDelta: 0n,
    });
  });

  it('throws when endGroup < startGroup', () => {
    expect(() =>
      mapLocationFilter({ filterType: 'absolute-range', startGroup: 5, endGroup: 4 }),
    ).toThrow(/endGroup/);
  });

  it('maps latest, next-group and undefined to RELATIVE_START 0', () => {
    const expected = {
      type: LocationFilterTypeDraft22.RELATIVE_START,
      startLocation: { group: 0n, object: 0n },
    };

    expect(mapLocationFilter({ filterType: 'latest' })).toEqual(expected);
    expect(mapLocationFilter({ filterType: 'next-group' })).toEqual(expected);
    expect(mapLocationFilter(undefined)).toEqual(expected);
    expect(mapLocationFilter({})).toEqual(expected);
  });
});

describe('mapFillParameters (draft-22 §9.20.15)', () => {
  it('maps lastGroups N to RELATIVE_START N (1 = the current group)', () => {
    expect(mapFillParameters({ lastGroups: 1 })).toEqual({
      locationFilter: {
        type: LocationFilterTypeDraft22.RELATIVE_START,
        startLocation: { group: 1n, object: 0n },
      },
    });
    expect(mapFillParameters({ lastGroups: 3 }).locationFilter?.startLocation?.group).toBe(3n);
  });

  it('maps an absolute start to ABSOLUTE_START', () => {
    expect(mapFillParameters({ startGroup: 4, startObject: 2 }).locationFilter).toEqual({
      type: LocationFilterTypeDraft22.ABSOLUTE_START,
      startLocation: { group: 4n, object: 2n },
    });
  });

  it('maps startGroup + endGroup to ABSOLUTE_START_GROUP_END', () => {
    expect(mapFillParameters({ startGroup: 4, endGroup: 9 }).locationFilter).toEqual({
      type: LocationFilterTypeDraft22.ABSOLUTE_START_GROUP_END,
      startLocation: { group: 4n, object: 0n },
      endGroupDelta: 5n,
    });
  });

  it('carries only the settings that were given, keeping a 0 timeout', () => {
    expect(mapFillParameters({})).toEqual({});
    expect(mapFillParameters({ fillTimeout: 0, priority: 9, groupOrder: GroupOrder.DESCENDING })).toEqual({
      fillTimeoutMs: 0n,
      subscriberPriority: 9,
      groupOrder: GroupOrder.DESCENDING,
    });
  });

  it('rejects ranges that cannot be expressed', () => {
    expect(() => mapFillParameters({ lastGroups: 1, startGroup: 1 })).toThrow(/lastGroups/);
    expect(() => mapFillParameters({ lastGroups: 0 })).toThrow(/lastGroups/);
    expect(() => mapFillParameters({ lastGroups: 1.5 })).toThrow(/lastGroups/);
    expect(() => mapFillParameters({ endGroup: 3 })).toThrow(/endGroup/);
    expect(() => mapFillParameters({ startGroup: 5, endGroup: 4 })).toThrow(/endGroup/);
  });
});

describe('mapJoiningFetch (draft-18 §10.12.2)', () => {
  it('maps lastGroups N to a relative joining fetch of N-1 groups back', () => {
    expect(mapJoiningFetch({ lastGroups: 1 })).toEqual({
      fetchType: FetchTypeDraft18.JOINING_RELATIVE,
      joiningStart: 0n,
    });
    expect(mapJoiningFetch({ lastGroups: 4 }).joiningStart).toBe(3n);
  });

  it('maps startGroup to an absolute joining fetch', () => {
    expect(mapJoiningFetch({ startGroup: 7 })).toEqual({
      fetchType: FetchTypeDraft18.JOINING_ABSOLUTE,
      joiningStart: 7n,
    });
  });

  it('rejects what a joining fetch cannot express', () => {
    expect(() => mapJoiningFetch({})).toThrow(/lastGroups or startGroup/);
    expect(() => mapJoiningFetch({ lastGroups: 0 })).toThrow(/lastGroups/);
    expect(() => mapJoiningFetch({ lastGroups: 1, startGroup: 1 })).toThrow(/lastGroups/);
    expect(() => mapJoiningFetch({ startGroup: 1, startObject: 2 })).toThrow(/startObject/);
    expect(() => mapJoiningFetch({ startGroup: 1, endGroup: 2 })).toThrow(/endGroup/);
    expect(() => mapJoiningFetch({ lastGroups: 1, endGroup: 2 })).toThrow(/endGroup/);
  });
});

describe('buildTrackProperties', () => {
  it('sends no Prior Group or Object ID Gap, which only apply to Objects (d22 §10.8, §10.9)', () => {
    const options = { priorGroupIdGap: 1, priorObjectIdGap: 4 } as Parameters<typeof buildTrackProperties>[0];

    expect(buildTrackProperties(options)).toBeUndefined();
  });

  it('keeps the dynamic groups flag', () => {
    const properties = buildTrackProperties({ dynamicGroups: true });

    expect([...properties!.keys()]).toEqual([TrackPropertyDraft18.DYNAMIC_GROUPS]);
  });
});
