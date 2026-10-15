// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { describe, it, expect } from 'vitest';
import { LocationFilterTypeDraft22 } from '@moq-web/core';

import { mapLocationFilter } from './session-helpers.js';

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
