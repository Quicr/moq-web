// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Draft-22 Range Filter values (§3.3.2, §8.6, §9.20.10-9.20.14)
 *
 * The five filter parameters (0x25-0x29) are length-prefixed. This module
 * encodes and decodes the bytes after the Length, and validates a set of
 * filters against the spec's rules. The Length prefix is the parameter
 * table's business (draft22-parameters.ts).
 *
 *   [SetID (8)] [Property Type (vi64), property filters only] [Range ...]
 *
 * A Range is Start and an optional End (only the last may omit it), each
 * delta encoded (§8.6). Length 0 has no fields and removes the filter.
 */

import { MOQT_VARINT_MAX } from './moqt-varint.js';
import { Draft18BufferWriter, Draft18BufferReader } from './protocol-codec.js';
import { Draft18CodecError } from './draft18-message-codec.js';
import {
  RequestParameterDraft22,
  type RangeDraft22,
  type RangeFilterDraft22,
  type RangeFilterTypeDraft22,
} from '../messages/types.js';

const P = RequestParameterDraft22;

/** §9.20.12: Publisher Priority is an 8-bit field */
const PRIORITY_MAX = 255n;

/** §3.3.2: SetID is a uint8 */
const SET_ID_MAX = 255;

/** §9.20.13, §9.20.14: Property Types that carry a single integer are even */
const INTEGER_PROPERTY_PARITY = 2n;

/** Machine-readable tag on the error for a value the spec rejects with INVALID_FILTER */
export const INVALID_FILTER_CODE = 'invalid-filter';

function invalid(message: string): Draft18CodecError {
  return new Draft18CodecError(`${message} (INVALID_FILTER)`, undefined, INVALID_FILTER_CODE);
}

function violation(message: string): Draft18CodecError {
  return new Draft18CodecError(`${message} (PROTOCOL_VIOLATION)`);
}

function hasPropertyType(type: RangeFilterTypeDraft22): boolean {
  return type === P.OBJECT_PROPERTY_FILTER || type === P.TRACK_PROPERTY_FILTER;
}

/** §8.6 Length 0: no fields, removes the filter */
function isRemoval(filter: RangeFilterDraft22): boolean {
  return filter.setId === undefined && filter.propertyType === undefined && filter.ranges.length === 0;
}

/** §9.1.6: the number of Ranges (Start/End pairs) over all of `filters` */
export function countRanges(filters: readonly RangeFilterDraft22[]): number {
  return filters.reduce((total, filter) => total + filter.ranges.length, 0);
}

// ============================================================================
// Validate
// ============================================================================

/**
 * Throw an INVALID_FILTER error for the first rule the filters break:
 * §3.3.2 a repeated Parameter Type + SetID + Property Type, §8.6 values past
 * 2^64-1, §9.20.12 a Publisher Priority past 255, §9.20.13-14 an odd or
 * missing Property Type. A Range must also be encodable as non-negative
 * deltas (§8.6): ascending, each End at or after its Start, and only the last
 * Range open-ended.
 */
export function validateRangeFilters(filters: readonly RangeFilterDraft22[]): void {
  const seen = new Set<string>();

  for (const filter of filters) {
    const key = `${filter.type}:${filter.setId}:${filter.propertyType}`;
    if (seen.has(key)) {
      throw invalid(`Repeated range filter ${P[filter.type]} SetID ${filter.setId}`);
    }
    seen.add(key);

    validateRangeFilter(filter);
  }
}

function validateRangeFilter(filter: RangeFilterDraft22): void {
  if (isRemoval(filter)) {
    return;
  }

  const name = P[filter.type];
  if (filter.setId === undefined || !Number.isInteger(filter.setId) || filter.setId < 0 || filter.setId > SET_ID_MAX) {
    throw invalid(`${name} SetID ${filter.setId} is not a uint8`);
  }
  validatePropertyType(filter);

  if (filter.ranges.length === 0) {
    throw invalid(`${name} has a SetID but no Ranges`);
  }

  const valueMax = filter.type === P.PRIORITY_FILTER ? PRIORITY_MAX : MOQT_VARINT_MAX;
  let previousEnd = 0n;
  filter.ranges.forEach((range, index) => {
    const isLast = index === filter.ranges.length - 1;
    validateRange(name, range, previousEnd, valueMax, isLast);
    previousEnd = range.end ?? previousEnd;
  });
}

function validatePropertyType(filter: RangeFilterDraft22): void {
  const name = P[filter.type];

  if (!hasPropertyType(filter.type)) {
    if (filter.propertyType !== undefined) {
      throw invalid(`${name} has no Property Type`);
    }
    return;
  }

  if (filter.propertyType === undefined || filter.propertyType % INTEGER_PROPERTY_PARITY !== 0n) {
    throw invalid(`${name} needs an even Property Type`);
  }
  if (filter.propertyType > MOQT_VARINT_MAX) {
    throw invalid(`${name} Property Type exceeds 2^64-1`);
  }
}

function validateRange(name: string, range: RangeDraft22, previousEnd: bigint, valueMax: bigint, isLast: boolean): void {
  if (range.start < previousEnd) {
    throw invalid(`${name} Range starts at ${range.start}, before the previous End ${previousEnd}`);
  }
  if (range.end === undefined && !isLast) {
    throw invalid(`${name} has an open-ended Range that is not the last`);
  }
  if (range.end !== undefined && range.end < range.start) {
    throw invalid(`${name} Range ends at ${range.end}, before its Start ${range.start}`);
  }
  if (range.start > valueMax || (range.end ?? 0n) > valueMax) {
    throw invalid(`${name} Range exceeds ${valueMax}`);
  }
}

// ============================================================================
// Encode
// ============================================================================

/** The value bytes after the Length, for a filter that passed [[validateRangeFilters]] */
export function encodeRangeFilter(filter: RangeFilterDraft22): Uint8Array {
  if (isRemoval(filter)) {
    return new Uint8Array(0);
  }

  const writer = new Draft18BufferWriter();
  writer.writeByte(filter.setId!);
  if (filter.propertyType !== undefined) {
    writer.writeVarInt(filter.propertyType);
  }

  let previousEnd = 0n;
  for (const range of filter.ranges) {
    writer.writeVarInt(range.start - previousEnd);
    if (range.end === undefined) {
      break;
    }
    writer.writeVarInt(range.end - range.start);
    previousEnd = range.end;
  }

  return writer.toUint8Array();
}

// ============================================================================
// Decode
// ============================================================================

/**
 * Decode the value bytes after the Length. Only the framing is checked here,
 * as PROTOCOL_VIOLATION; call [[validateRangeFilters]] for the INVALID_FILTER
 * rules, which the receiver answers with REQUEST_ERROR instead of closing.
 */
export function decodeRangeFilter(type: RangeFilterTypeDraft22, value: Uint8Array): RangeFilterDraft22 {
  if (value.length === 0) {
    return { type, ranges: [] };
  }

  const reader = new Draft18BufferReader(value);
  const setId = reader.readByte();
  const filter: RangeFilterDraft22 = { type, setId, ranges: [] };
  if (hasPropertyType(type)) {
    if (!reader.hasMore) {
      throw violation(`${P[type]} has no Property Type`);
    }
    filter.propertyType = reader.readVarInt();
  }

  let previousEnd = 0n;
  while (reader.hasMore) {
    const start = previousEnd + reader.readVarInt();
    if (!reader.hasMore) {
      filter.ranges.push({ start });
      break;
    }

    const end = start + reader.readVarInt();
    filter.ranges.push({ start, end });
    previousEnd = end;
  }

  return filter;
}
