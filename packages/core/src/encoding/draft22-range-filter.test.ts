// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Draft-22 Range Filter parameters (§3.3.2, §8.6, §9.20.10-9.20.14)
 */

import { describe, it, expect } from 'vitest';
import { Draft22MessageCodec } from './draft22-message-codec';
import { Draft18BufferReader, Draft18BufferWriter } from './protocol-codec';
import { decodeParameters, encodeParameters, ParameterScopeDraft22 } from './draft22-parameters';
import { countRanges, validateRangeFilters } from './draft22-range-filter';
import {
  GroupOrder,
  MessageTypeDraft22,
  RequestParameterDraft22,
  type FetchMessageDraft22,
  type RangeFilterDraft22,
  type RequestUpdateMessageDraft22,
  type SubscribeMessageDraft22,
} from '../messages/types';

const P = RequestParameterDraft22;
const S = ParameterScopeDraft22;

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);

function encodeBlock(scope: ParameterScopeDraft22, rangeFilters: RangeFilterDraft22[]): Uint8Array {
  const writer = new Draft18BufferWriter();
  encodeParameters(writer, scope, { rangeFilters });

  return writer.toUint8Array();
}

function decodeBlock(scope: ParameterScopeDraft22, wire: Uint8Array): RangeFilterDraft22[] | undefined {
  return decodeParameters(new Draft18BufferReader(wire), scope).rangeFilters;
}

describe('Draft22 Range Filters', () => {
  describe('value encodings (§8.6, §9.20.10-9.20.14)', () => {
    // nparams=1 | type | Length | SetID | Start/End deltas
    const cases: Array<[string, ParameterScopeDraft22, RangeFilterDraft22, Uint8Array]> = [
      [
        // §8.6: ranges 3-5 and 10-15 encode as Start=3, End=2, Start=5, End=5
        'OBJECTID_FILTER, two ranges',
        S.SUBSCRIBE,
        { type: P.OBJECTID_FILTER, setId: 0, ranges: [{ start: 3n, end: 5n }, { start: 10n, end: 15n }] },
        bytes(0x01, 0x26, 0x05, 0x00, 0x03, 0x02, 0x05, 0x05),
      ],
      [
        // §8.6: End is optional in the last Range
        'SUBGROUP_FILTER, open-ended',
        S.SUBSCRIBE,
        { type: P.SUBGROUP_FILTER, setId: 1, ranges: [{ start: 7n }] },
        bytes(0x01, 0x25, 0x02, 0x01, 0x07),
      ],
      [
        // 255 is the 2-byte varint 0x80ff
        'PRIORITY_FILTER, 0-255',
        S.FETCH,
        { type: P.PRIORITY_FILTER, setId: 0, ranges: [{ start: 0n, end: 255n }] },
        bytes(0x01, 0x27, 0x04, 0x00, 0x00, 0x80, 0xff),
      ],
      [
        // §9.20.13: Property Type follows SetID
        'OBJECT_PROPERTY_FILTER',
        S.SUBSCRIBE,
        { type: P.OBJECT_PROPERTY_FILTER, setId: 2, propertyType: 4n, ranges: [{ start: 1n, end: 1n }] },
        bytes(0x01, 0x28, 0x04, 0x02, 0x04, 0x01, 0x00),
      ],
      [
        // §9.20.14
        'TRACK_PROPERTY_FILTER',
        S.SUBSCRIBE_TRACKS,
        { type: P.TRACK_PROPERTY_FILTER, setId: 0, propertyType: 2n, ranges: [{ start: 0n, end: 9n }] },
        bytes(0x01, 0x29, 0x04, 0x00, 0x02, 0x00, 0x09),
      ],
      [
        // §8.6: Length 0 removes the filter
        'Length 0 (remove)',
        S.REQUEST_UPDATE,
        { type: P.SUBGROUP_FILTER, ranges: [] },
        bytes(0x01, 0x25, 0x00),
      ],
    ];

    it.each(cases)('encodes %s to the spec bytes', (_name, scope, filter, wire) => {
      expect(encodeBlock(scope, [filter])).toEqual(wire);
    });

    it.each(cases)('decodes %s from the spec bytes', (_name, scope, filter, wire) => {
      expect(decodeBlock(scope, wire)).toEqual([filter]);
    });

    it('carries a repeated type with distinct SetIDs, in ascending type order', () => {
      const filters: RangeFilterDraft22[] = [
        { type: P.OBJECTID_FILTER, setId: 0, ranges: [{ start: 1n }] },
        { type: P.SUBGROUP_FILTER, setId: 0, ranges: [{ start: 5n }] },
        { type: P.SUBGROUP_FILTER, setId: 1, ranges: [{ start: 6n }] },
      ];
      // nparams=3 | 0x25 [00 05] | +0 [01 06] | +1=0x26 [00 01]
      const wire = bytes(0x03, 0x25, 0x02, 0x00, 0x05, 0x00, 0x02, 0x01, 0x06, 0x01, 0x02, 0x00, 0x01);

      expect(encodeBlock(S.SUBSCRIBE, filters)).toEqual(wire);
      expect(decodeBlock(S.SUBSCRIBE, wire)).toEqual([filters[1], filters[2], filters[0]]);
    });

    it('roundtrips a range reaching 2^64-1', () => {
      const filter: RangeFilterDraft22 = {
        type: P.OBJECTID_FILTER,
        setId: 255,
        ranges: [{ start: 0xffffffffffffff00n, end: 0xffffffffffffffffn }],
      };

      expect(decodeBlock(S.SUBSCRIBE, encodeBlock(S.SUBSCRIBE, [filter]))).toEqual([filter]);
    });
  });

  describe('malformed values', () => {
    it('rejects a Length that cuts a varint short', () => {
      // OBJECTID_FILTER Length=2: SetID | Start=0x80 (2-byte varint, one byte inside Length)
      expect(() => decodeBlock(S.SUBSCRIBE, bytes(0x01, 0x26, 0x02, 0x00, 0x80, 0x05))).toThrow();
    });

    it('rejects a Length past the end of the block', () => {
      expect(() => decodeBlock(S.SUBSCRIBE, bytes(0x01, 0x26, 0x05, 0x00, 0x03))).toThrow();
    });

    it('rejects a property filter without a Property Type', () => {
      expect(() => decodeBlock(S.SUBSCRIBE, bytes(0x01, 0x28, 0x01, 0x00))).toThrow(/PROTOCOL_VIOLATION/);
    });

    it('rejects a range filter in PUBLISH, which does not allow it', () => {
      expect(() => decodeBlock(S.PUBLISH, bytes(0x01, 0x25, 0x00))).toThrow(/PROTOCOL_VIOLATION/);
    });

    it('rejects TRACK_PROPERTY_FILTER in SUBSCRIBE', () => {
      expect(() => decodeBlock(S.SUBSCRIBE, bytes(0x01, 0x29, 0x00))).toThrow(/PROTOCOL_VIOLATION/);
    });

    it('still rejects a repeated non-filter parameter', () => {
      // FORWARD twice
      expect(() => decodeBlock(S.SUBSCRIBE, bytes(0x02, 0x10, 0x01, 0x00, 0x01))).toThrow(/Duplicate/);
    });
  });

  describe('validateRangeFilters (§3.3.2, §8.6, §9.20.12-14)', () => {
    const ok: RangeFilterDraft22 = { type: P.OBJECTID_FILTER, setId: 0, ranges: [{ start: 1n, end: 2n }] };

    it('accepts a valid set', () => {
      expect(() => validateRangeFilters([ok])).not.toThrow();
    });

    it('rejects the same type and SetID twice', () => {
      expect(() => validateRangeFilters([ok, ok])).toThrow(/INVALID_FILTER/);
    });

    it('accepts the same type with another SetID', () => {
      expect(() => validateRangeFilters([ok, { ...ok, setId: 1 }])).not.toThrow();
    });

    it('rejects the same property type and SetID twice, but not different property types', () => {
      const prop: RangeFilterDraft22 = {
        type: P.OBJECT_PROPERTY_FILTER,
        setId: 0,
        propertyType: 2n,
        ranges: [{ start: 0n }],
      };

      expect(() => validateRangeFilters([prop, prop])).toThrow(/INVALID_FILTER/);
      expect(() => validateRangeFilters([prop, { ...prop, propertyType: 4n }])).not.toThrow();
    });

    it('rejects a PRIORITY_FILTER value above 255', () => {
      const filter: RangeFilterDraft22 = { type: P.PRIORITY_FILTER, setId: 0, ranges: [{ start: 0n, end: 256n }] };

      expect(() => validateRangeFilters([filter])).toThrow(/INVALID_FILTER/);
    });

    it('rejects an odd Property Type', () => {
      const filter: RangeFilterDraft22 = {
        type: P.OBJECT_PROPERTY_FILTER,
        setId: 0,
        propertyType: 3n,
        ranges: [{ start: 0n }],
      };

      expect(() => validateRangeFilters([filter])).toThrow(/INVALID_FILTER/);
    });

    it('rejects a property filter without a Property Type', () => {
      const filter: RangeFilterDraft22 = { type: P.TRACK_PROPERTY_FILTER, setId: 0, ranges: [{ start: 0n }] };

      expect(() => validateRangeFilters([filter])).toThrow(/INVALID_FILTER/);
    });

    it('rejects a Property Type on a non-property filter', () => {
      expect(() => validateRangeFilters([{ ...ok, propertyType: 2n }])).toThrow(/INVALID_FILTER/);
    });

    it('rejects a value above 2^64-1', () => {
      const filter: RangeFilterDraft22 = { ...ok, ranges: [{ start: 1n << 64n }] };

      expect(() => validateRangeFilters([filter])).toThrow(/INVALID_FILTER/);
    });

    it('rejects an end before its start', () => {
      expect(() => validateRangeFilters([{ ...ok, ranges: [{ start: 5n, end: 4n }] }])).toThrow(/INVALID_FILTER/);
    });

    it('rejects a start before the previous end', () => {
      const ranges = [{ start: 1n, end: 5n }, { start: 4n, end: 9n }];

      expect(() => validateRangeFilters([{ ...ok, ranges }])).toThrow(/INVALID_FILTER/);
    });

    it('accepts a start equal to the previous end (delta 0)', () => {
      const ranges = [{ start: 1n, end: 5n }, { start: 5n, end: 9n }];

      expect(() => validateRangeFilters([{ ...ok, ranges }])).not.toThrow();
    });

    it('rejects an open-ended range that is not last', () => {
      const ranges = [{ start: 1n }, { start: 5n, end: 9n }];

      expect(() => validateRangeFilters([{ ...ok, ranges }])).toThrow(/INVALID_FILTER/);
    });

    it('rejects a SetID with no ranges', () => {
      expect(() => validateRangeFilters([{ ...ok, ranges: [] }])).toThrow(/INVALID_FILTER/);
    });

    it('rejects a SetID above 255', () => {
      expect(() => validateRangeFilters([{ ...ok, setId: 256 }])).toThrow(/INVALID_FILTER/);
    });

    it('accepts the remove form: no SetID and no ranges', () => {
      expect(() => validateRangeFilters([{ type: P.OBJECTID_FILTER, ranges: [] }])).not.toThrow();
    });

    it('is enforced on encode', () => {
      const filter: RangeFilterDraft22 = { type: P.PRIORITY_FILTER, setId: 0, ranges: [{ start: 300n }] };

      expect(() => encodeBlock(S.SUBSCRIBE, [filter])).toThrow(/INVALID_FILTER/);
    });
  });

  describe('countRanges (§9.1.6)', () => {
    it('sums Ranges over every filter', () => {
      const filters: RangeFilterDraft22[] = [
        { type: P.OBJECTID_FILTER, setId: 0, ranges: [{ start: 1n }] },
        { type: P.SUBGROUP_FILTER, setId: 0, ranges: [{ start: 1n, end: 2n }, { start: 4n }] },
        { type: P.SUBGROUP_FILTER, ranges: [] },
      ];

      expect(countRanges(filters)).toBe(3);
    });
  });

  describe('in messages', () => {
    const filters: RangeFilterDraft22[] = [
      { type: P.OBJECTID_FILTER, setId: 0, ranges: [{ start: 0n, end: 9n }] },
    ];

    it('roundtrips in SUBSCRIBE and FILL_PARAMETERS', () => {
      const message: SubscribeMessageDraft22 = {
        type: MessageTypeDraft22.SUBSCRIBE,
        requestId: 2n,
        trackNamespace: ['a'],
        trackName: 't',
        forwardState: true,
        rangeFilters: filters,
        fill: { rangeFilters: [{ type: P.SUBGROUP_FILTER, setId: 0, ranges: [{ start: 1n }] }] },
      };

      const [decoded] = Draft22MessageCodec.decode(Draft22MessageCodec.encode(message));

      expect(decoded).toEqual(message);
    });

    it('roundtrips in FETCH', () => {
      const message: FetchMessageDraft22 = {
        type: MessageTypeDraft22.FETCH,
        requestId: 4n,
        trackNamespace: ['a'],
        trackName: 't',
        subscriberPriority: 128,
        groupOrder: GroupOrder.ASCENDING,
        rangeFilters: filters,
      };

      const [decoded] = Draft22MessageCodec.decode(Draft22MessageCodec.encode(message));

      expect(decoded).toEqual(message);
    });

    it('roundtrips a removal in REQUEST_UPDATE', () => {
      const message: RequestUpdateMessageDraft22 = {
        type: MessageTypeDraft22.REQUEST_UPDATE,
        requestId: 6n,
        rangeFilters: [{ type: P.OBJECTID_FILTER, ranges: [] }],
      };

      const [decoded] = Draft22MessageCodec.decode(Draft22MessageCodec.encode(message));

      expect(decoded).toEqual(message);
    });
  });
});
