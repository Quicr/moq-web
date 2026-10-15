// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Draft-22 Message Parameters (§9.20)
 *
 * One table says how each parameter is framed and which messages may carry
 * it; one encoder and one decoder for a parameter block use that table.
 * Nothing is framed by guessing from the parameter type's parity.
 *
 * Parameter values cross this module in two shapes:
 * - typed: FORWARD, LARGEST_OBJECT, LOCATION_FILTER, FILL_PARAMETERS, the
 *   Range Filters (0x25-0x29), which may repeat (§3.3.2), and Authorization
 *   Tokens (`authTokens`), which may repeat (§8.9)
 * - raw: everything else, in `parameters`, keyed by type. A raw value is
 *   uint8 as one byte, varint/Location as their encodings, length-prefixed as
 *   its payload, and Track Namespace as its encoding.
 */

import { MOQTVarInt, MOQT_VARINT_MAX } from './moqt-varint.js';
import { Draft18BufferWriter, Draft18BufferReader } from './protocol-codec.js';
import { Draft18CodecError } from './draft18-message-codec.js';
import {
  assertBound,
  encodeTrackNamespace,
  decodeTrackNamespace,
  decodeDraft18AuthToken,
  MAX_CONTROL_MESSAGE_LENGTH,
  MAX_AUTH_TOKEN_LENGTH,
} from './codec-helpers.js';
import { decodeRangeFilter, encodeRangeFilter, validateRangeFilters } from './draft22-range-filter.js';
import {
  GroupOrder,
  LocationFilterTypeDraft22,
  RequestParameterDraft22,
  type FillParametersDraft22,
  type Location,
  type LocationFilterDraft22,
  type RangeFilterDraft22,
  type RangeFilterTypeDraft22,
} from '../messages/types.js';

const P = RequestParameterDraft22;

/** §9.20: a control message is limited to 2^16-1 bytes, which bounds any value */
const MAX_VALUE_LENGTH = 0xffff;

/** §9.20.7: SUBSCRIBER_PRIORITY is a uint8 */
const UINT8_MAX = 0xff;

/** Message (or parameter scope) that carries a parameter block */
export enum ParameterScopeDraft22 {
  SUBSCRIBE = 'SUBSCRIBE',
  FETCH = 'FETCH',
  PUBLISH = 'PUBLISH',
  PUBLISH_STATE_NOTIFY = 'PUBLISH_STATE_NOTIFY',
  /**
   * §9.5: allowed parameters depend on the kind of request being updated,
   * which the message does not carry. This scope is the union.
   */
  REQUEST_UPDATE = 'REQUEST_UPDATE',
  TRACK_STATUS = 'TRACK_STATUS',
  SUBSCRIBE_TRACKS = 'SUBSCRIBE_TRACKS',
  SUBSCRIBE_OK = 'SUBSCRIBE_OK',
  /**
   * §9.3: allowed parameters depend on the request being answered (PUBLISH_OK,
   * REQUEST_UPDATE_OK, TRACK_STATUS_OK, ...). This scope is the union.
   */
  REQUEST_OK = 'REQUEST_OK',
  /** §9.12: no parameters are currently defined */
  FETCH_OK = 'FETCH_OK',
  PUBLISH_NAMESPACE = 'PUBLISH_NAMESPACE',
  SUBSCRIBE_NAMESPACE = 'SUBSCRIBE_NAMESPACE',
  /** §9.20.15: a separate parameter scope inside FILL_PARAMETERS */
  FILL_PARAMETERS = 'FILL_PARAMETERS',
}

const S = ParameterScopeDraft22;

/** §9.20: the value encodings */
enum ValueKind {
  UINT8,
  VARINT,
  LOCATION,
  LENGTH_PREFIXED,
  NAMESPACE,
  LOCATION_FILTER,
  FILL_PARAMETERS,
  /** §9.20.10-9.20.14: length-prefixed, and may repeat */
  RANGE_FILTER,
  /** §9.20.2: length-prefixed, and may repeat (§8.9) */
  AUTH_TOKEN,
}

interface ParameterSpec {
  kind: ValueKind;
  scopes: ReadonlySet<ParameterScopeDraft22>;
  /** uint8 parameters that only allow certain values */
  allowedValues?: readonly number[];
  maxLength?: number;
}

function spec(
  kind: ValueKind,
  scopes: ParameterScopeDraft22[],
  extra: Pick<ParameterSpec, 'allowedValues' | 'maxLength'> = {},
): ParameterSpec {
  return { kind, scopes: new Set(scopes), ...extra };
}

const RANGE_FILTER_SCOPES = [S.SUBSCRIBE, S.REQUEST_UPDATE, S.FETCH, S.SUBSCRIBE_TRACKS, S.FILL_PARAMETERS];

/**
 * §9.20.2-9.20.21 plus each message's parameter list in §9.
 */
const PARAMETER_SPECS: Record<RequestParameterDraft22, ParameterSpec> = {
  [P.OBJECT_DELIVERY_TIMEOUT]: spec(ValueKind.VARINT, [S.SUBSCRIBE, S.PUBLISH, S.REQUEST_UPDATE]),
  [P.AUTHORIZATION_TOKEN]: spec(
    ValueKind.AUTH_TOKEN,
    [
      S.PUBLISH, S.SUBSCRIBE, S.REQUEST_UPDATE, S.SUBSCRIBE_NAMESPACE,
      S.SUBSCRIBE_TRACKS, S.PUBLISH_NAMESPACE, S.TRACK_STATUS, S.FETCH,
    ],
    { maxLength: MAX_AUTH_TOKEN_LENGTH },
  ),
  [P.RENDEZVOUS_TIMEOUT]: spec(ValueKind.VARINT, [S.SUBSCRIBE]),
  [P.SUBGROUP_DELIVERY_TIMEOUT]: spec(ValueKind.VARINT, [S.SUBSCRIBE, S.PUBLISH, S.REQUEST_UPDATE]),
  [P.EXPIRES]: spec(ValueKind.VARINT, [S.PUBLISH, S.SUBSCRIBE_OK, S.REQUEST_OK]),
  [P.LARGEST_OBJECT]: spec(ValueKind.LOCATION, [S.PUBLISH, S.PUBLISH_STATE_NOTIFY, S.SUBSCRIBE_OK, S.REQUEST_OK]),
  [P.FILL_TIMEOUT]: spec(ValueKind.VARINT, [S.FETCH, S.FILL_PARAMETERS]),
  [P.FORWARD]: spec(
    ValueKind.UINT8,
    [S.SUBSCRIBE, S.REQUEST_UPDATE, S.PUBLISH, S.SUBSCRIBE_TRACKS, S.PUBLISH_STATE_NOTIFY],
    { allowedValues: [0, 1] },
  ),
  [P.SUBSCRIBER_PRIORITY]: spec(ValueKind.UINT8, [S.SUBSCRIBE, S.PUBLISH, S.FETCH, S.REQUEST_UPDATE, S.FILL_PARAMETERS]),
  [P.LOCATION_FILTER]: spec(
    ValueKind.LOCATION_FILTER,
    [S.FETCH, S.SUBSCRIBE, S.PUBLISH, S.REQUEST_UPDATE, S.PUBLISH_STATE_NOTIFY, S.FILL_PARAMETERS],
  ),
  [P.GROUP_ORDER]: spec(
    ValueKind.UINT8,
    [S.SUBSCRIBE, S.PUBLISH, S.SUBSCRIBE_TRACKS, S.FETCH, S.FILL_PARAMETERS],
    { allowedValues: [GroupOrder.ASCENDING, GroupOrder.DESCENDING] },
  ),
  [P.FILL_PARAMETERS]: spec(ValueKind.FILL_PARAMETERS, [S.SUBSCRIBE, S.REQUEST_UPDATE]),
  [P.SUBGROUP_FILTER]: spec(ValueKind.RANGE_FILTER, RANGE_FILTER_SCOPES),
  [P.OBJECTID_FILTER]: spec(ValueKind.RANGE_FILTER, RANGE_FILTER_SCOPES),
  [P.PRIORITY_FILTER]: spec(ValueKind.RANGE_FILTER, RANGE_FILTER_SCOPES),
  [P.OBJECT_PROPERTY_FILTER]: spec(ValueKind.RANGE_FILTER, RANGE_FILTER_SCOPES),
  [P.TRACK_PROPERTY_FILTER]: spec(ValueKind.RANGE_FILTER, [S.REQUEST_UPDATE, S.SUBSCRIBE_TRACKS]),
  [P.NEW_GROUP_REQUEST]: spec(ValueKind.VARINT, [S.SUBSCRIBE, S.REQUEST_UPDATE]),
  [P.TRACK_NAMESPACE_PREFIX]: spec(ValueKind.NAMESPACE, [S.REQUEST_UPDATE]),
  [P.INCLUDE_PROPERTIES]: spec(
    ValueKind.UINT8,
    [S.SUBSCRIBE, S.TRACK_STATUS, S.FETCH, S.SUBSCRIBE_TRACKS],
    { allowedValues: [0, 1] },
  ),
};

/** A parameter block, in the shapes described at the top of this file */
export interface ParameterSetDraft22 {
  forwardState?: boolean;
  largestLocation?: Location;
  locationFilter?: LocationFilterDraft22;
  fill?: FillParametersDraft22;
  rangeFilters?: RangeFilterDraft22[];
  /** Raw Token structures (§8.9), in wire order */
  authTokens?: Uint8Array[];
  parameters?: Map<number, Uint8Array>;
}

interface Entry {
  type: number;
  write: (writer: Draft18BufferWriter) => void;
}

function violation(message: string): Draft18CodecError {
  return new Draft18CodecError(`${message} (PROTOCOL_VIOLATION)`);
}

function parameterName(type: number): string {
  return RequestParameterDraft22[type] ?? `0x${type.toString(16)}`;
}

/** §9.20 / §9.20.1: parameter must be defined, and allowed in this message */
function lookupSpec(type: number, scope: ParameterScopeDraft22): ParameterSpec {
  const found = PARAMETER_SPECS[type as RequestParameterDraft22];
  if (!found) {
    throw violation(`Unknown parameter 0x${type.toString(16)} in ${scope}`);
  }
  if (!found.scopes.has(scope)) {
    throw violation(`Parameter ${parameterName(type)} not allowed in ${scope}`);
  }

  return found;
}

// ============================================================================
// Decode
// ============================================================================

/** Decode `Number of Parameters | Parameters` for a message */
export function decodeParameters(reader: Draft18BufferReader, scope: ParameterScopeDraft22): ParameterSetDraft22 {
  // §9.20: the count is not limited; the 2^16-1 byte message bounds it (each parameter takes 2+ bytes)
  const count = reader.readVarIntNumber();
  assertBound(count, MAX_CONTROL_MESSAGE_LENGTH, `${scope} numParams`);

  return readEntries(reader, scope, count);
}

function readEntries(reader: Draft18BufferReader, scope: ParameterScopeDraft22, count: number): ParameterSetDraft22 {
  const result: ParameterSetDraft22 = {};
  const parameters = new Map<number, Uint8Array>();

  let previousType = 0;
  for (let read = 0; read < count; read++) {
    const type = previousType + reader.readVarIntNumber();

    const found = lookupSpec(type, scope);

    // Types ascend, so a repeated type always has a delta of 0. Only Range
    // Filters (§3.3.2) and Authorization Tokens (§8.9) may repeat.
    if (read > 0 && type === previousType && found.kind !== ValueKind.RANGE_FILTER && found.kind !== ValueKind.AUTH_TOKEN) {
      throw violation(`Duplicate parameter ${parameterName(type)} in ${scope}`);
    }
    previousType = type;

    switch (found.kind) {
      case ValueKind.LOCATION_FILTER:
        result.locationFilter = decodeLocationFilter(reader);
        break;
      case ValueKind.FILL_PARAMETERS:
        result.fill = decodeFill(reader);
        break;
      case ValueKind.RANGE_FILTER: {
        const filter = decodeRangeFilter(type as RangeFilterTypeDraft22, readRaw(reader, type, found));
        (result.rangeFilters ??= []).push(filter);
        break;
      }
      case ValueKind.AUTH_TOKEN: {
        const token = readRaw(reader, type, found);
        decodeDraft18AuthToken(token);
        (result.authTokens ??= []).push(token);
        break;
      }
      default:
        storeRaw(result, parameters, type, readRaw(reader, type, found));
    }
  }

  if (parameters.size > 0) {
    result.parameters = parameters;
  }

  return result;
}

/** FORWARD and LARGEST_OBJECT are typed; every other raw value stays raw */
function storeRaw(
  result: ParameterSetDraft22,
  parameters: Map<number, Uint8Array>,
  type: number,
  value: Uint8Array,
): void {
  if (type === P.FORWARD) {
    result.forwardState = value[0] === 1;
    return;
  }
  if (type === P.LARGEST_OBJECT) {
    const [group, groupLength] = MOQTVarInt.decode(value);
    const [object] = MOQTVarInt.decode(value, groupLength);
    result.largestLocation = { group, object };
    return;
  }

  parameters.set(type, value);
}

/** Read one raw (non-structured) value; see the top of this file for the shapes */
function readRaw(reader: Draft18BufferReader, type: number, found: ParameterSpec): Uint8Array {
  switch (found.kind) {
    case ValueKind.UINT8: {
      const value = reader.readByte();
      if (found.allowedValues && !found.allowedValues.includes(value)) {
        throw violation(`Invalid ${parameterName(type)} ${value}`);
      }

      return new Uint8Array([value]);
    }
    case ValueKind.VARINT:
      return MOQTVarInt.encode(reader.readVarInt());
    case ValueKind.LOCATION: {
      const writer = new Draft18BufferWriter();
      writer.writeVarInt(reader.readVarInt());
      writer.writeVarInt(reader.readVarInt());

      return writer.toUint8Array();
    }
    case ValueKind.NAMESPACE: {
      const writer = new Draft18BufferWriter();
      encodeTrackNamespace(writer, decodeTrackNamespace(reader));

      return writer.toUint8Array();
    }
    case ValueKind.LENGTH_PREFIXED:
    case ValueKind.AUTH_TOKEN:
    case ValueKind.RANGE_FILTER: {
      const length = reader.readVarIntNumber();
      assertBound(length, found.maxLength ?? MAX_VALUE_LENGTH, `${parameterName(type)} value length`);

      return reader.readBytes(length);
    }
    default:
      throw violation(`Parameter ${parameterName(type)} has no raw encoding`);
  }
}

/**
 * §9.20.15: length-prefixed, holding parameters "encoded as if they were
 * Parameters for a separate message", i.e. `Number of Parameters | Parameters`
 * (matches moqtail). Nothing may follow the counted parameters.
 */
function decodeFill(reader: Draft18BufferReader): FillParametersDraft22 {
  const length = reader.readVarIntNumber();
  assertBound(length, MAX_VALUE_LENGTH, 'FILL_PARAMETERS value length');

  const inner = new Draft18BufferReader(reader.readBytes(length));
  const set = decodeParameters(inner, S.FILL_PARAMETERS);
  if (inner.hasMore) {
    throw violation('Bytes left after FILL_PARAMETERS parameters');
  }

  return setToFill(set);
}

function setToFill(set: ParameterSetDraft22): FillParametersDraft22 {
  const fill: FillParametersDraft22 = {};
  const raw = set.parameters;

  if (set.locationFilter) {
    fill.locationFilter = set.locationFilter;
  }

  const timeout = raw?.get(P.FILL_TIMEOUT);
  if (timeout) {
    fill.fillTimeoutMs = MOQTVarInt.decode(timeout)[0];
  }

  const priority = raw?.get(P.SUBSCRIBER_PRIORITY);
  if (priority) {
    fill.subscriberPriority = priority[0];
  }

  const order = raw?.get(P.GROUP_ORDER);
  if (order) {
    fill.groupOrder = order[0];
  }

  if (set.rangeFilters) {
    fill.rangeFilters = set.rangeFilters;
  }

  return fill;
}

// ============================================================================
// Encode
// ============================================================================

/** Encode `Number of Parameters | Parameters` for a message */
export function encodeParameters(
  writer: Draft18BufferWriter,
  scope: ParameterScopeDraft22,
  set: ParameterSetDraft22,
): void {
  const entries = collectEntries(scope, set);

  writer.writeVarInt(BigInt(entries.length));
  writeEntries(writer, entries);
}

/** Ascending-type entries, each validated against the table */
function collectEntries(scope: ParameterScopeDraft22, set: ParameterSetDraft22): Entry[] {
  const entries = new Map<number, Entry>();
  const add = (type: number, write: Entry['write']): void => {
    lookupSpec(type, scope);
    if (entries.has(type)) {
      throw violation(`Duplicate parameter ${parameterName(type)} in ${scope}`);
    }
    entries.set(type, { type, write });
  };

  const { forwardState, largestLocation, locationFilter, fill } = set;
  if (forwardState !== undefined) {
    add(P.FORWARD, (w) => w.writeByte(forwardState ? 1 : 0));
  }
  if (largestLocation) {
    add(P.LARGEST_OBJECT, (w) => {
      w.writeVarInt(largestLocation.group);
      w.writeVarInt(largestLocation.object);
    });
  }
  if (locationFilter) {
    add(P.LOCATION_FILTER, (w) => encodeLocationFilter(w, locationFilter));
  }
  if (fill) {
    add(P.FILL_PARAMETERS, (w) => encodeFill(w, fill));
  }
  for (const [type, value] of set.parameters ?? []) {
    add(type, (w) => writeRaw(w, type, scope, value));
  }

  // §3.3.2, §8.9: Range Filters and Authorization Tokens may repeat, so they
  // sit outside the one-per-type map
  const rangeEntries = collectRangeEntries(scope, set.rangeFilters ?? []);
  const tokenEntries = collectTokenEntries(scope, set.authTokens ?? []);

  // The sort is stable, so repeats of a type keep the caller's order
  return [...entries.values(), ...rangeEntries, ...tokenEntries].sort((a, b) => a.type - b.type);
}

function collectTokenEntries(scope: ParameterScopeDraft22, tokens: readonly Uint8Array[]): Entry[] {
  return tokens.map((token) => {
    const found = lookupSpec(P.AUTHORIZATION_TOKEN, scope);

    return {
      type: P.AUTHORIZATION_TOKEN,
      write: (w) => {
        assertBound(token.length, found.maxLength ?? MAX_VALUE_LENGTH, 'AUTHORIZATION_TOKEN value length');
        w.writeVarInt(token.length);
        w.writeBytes(token);
      },
    };
  });
}

function collectRangeEntries(scope: ParameterScopeDraft22, filters: readonly RangeFilterDraft22[]): Entry[] {
  validateRangeFilters(filters);

  return filters.map((filter) => {
    lookupSpec(filter.type, scope);
    const value = encodeRangeFilter(filter);

    return {
      type: filter.type,
      write: (w) => {
        assertBound(value.length, MAX_VALUE_LENGTH, `${parameterName(filter.type)} value length`);
        w.writeVarInt(value.length);
        w.writeBytes(value);
      },
    };
  });
}

function writeEntries(writer: Draft18BufferWriter, entries: Entry[]): void {
  let previousType = 0;
  for (const entry of entries) {
    writer.writeVarInt(BigInt(entry.type - previousType));
    previousType = entry.type;
    entry.write(writer);
  }
}

/** Write one raw value after checking it is well-formed for its kind */
function writeRaw(
  writer: Draft18BufferWriter,
  type: number,
  scope: ParameterScopeDraft22,
  value: Uint8Array,
): void {
  const found = lookupSpec(type, scope);

  if (
    found.kind === ValueKind.LOCATION_FILTER ||
    found.kind === ValueKind.FILL_PARAMETERS ||
    found.kind === ValueKind.RANGE_FILTER ||
    found.kind === ValueKind.AUTH_TOKEN
  ) {
    throw violation(`${parameterName(type)} must be set through its typed field`);
  }

  if (found.kind === ValueKind.LENGTH_PREFIXED) {
    assertBound(value.length, found.maxLength ?? MAX_VALUE_LENGTH, `${parameterName(type)} value length`);
    writer.writeVarInt(value.length);
    writer.writeBytes(value);
    return;
  }

  // A well-formed value reads back whole; anything else is a caller bug
  const probe = new Draft18BufferReader(value);
  try {
    readRaw(probe, type, found);
  } catch (err) {
    if (err instanceof Draft18CodecError) {
      throw err;
    }
    throw violation(`Malformed ${parameterName(type)} value`);
  }
  if (probe.hasMore) {
    throw violation(`Malformed ${parameterName(type)} value`);
  }

  writer.writeBytes(value);
}

function encodeFill(writer: Draft18BufferWriter, fill: FillParametersDraft22): void {
  const inner = new Draft18BufferWriter();
  encodeParameters(inner, S.FILL_PARAMETERS, fillToSet(fill));

  const payload = inner.toUint8Array();
  writer.writeVarInt(payload.length);
  writer.writeBytes(payload);
}

function fillToSet(fill: FillParametersDraft22): ParameterSetDraft22 {
  const parameters = new Map<number, Uint8Array>();

  if (fill.fillTimeoutMs !== undefined) {
    parameters.set(P.FILL_TIMEOUT, MOQTVarInt.encode(fill.fillTimeoutMs));
  }
  if (fill.subscriberPriority !== undefined) {
    assertUint8(fill.subscriberPriority, 'SUBSCRIBER_PRIORITY');
    parameters.set(P.SUBSCRIBER_PRIORITY, new Uint8Array([fill.subscriberPriority]));
  }
  if (fill.groupOrder !== undefined) {
    parameters.set(P.GROUP_ORDER, new Uint8Array([fill.groupOrder]));
  }

  return { locationFilter: fill.locationFilter, rangeFilters: fill.rangeFilters, parameters };
}

function assertUint8(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > UINT8_MAX) {
    throw violation(`Invalid ${name} ${value}`);
  }
}

// ============================================================================
// LOCATION_FILTER (§9.20.9)
// ============================================================================

/** The value is not length-prefixed; the fields depend on the filter type. */
function encodeLocationFilter(writer: Draft18BufferWriter, filter: LocationFilterDraft22): void {
  writer.writeVarInt(BigInt(filter.type));

  switch (filter.type) {
    case LocationFilterTypeDraft22.NONE:
    case LocationFilterTypeDraft22.NEXT_OBJECT:
      return;
    case LocationFilterTypeDraft22.RELATIVE_START:
      writer.writeVarInt(filter.startLocation?.group ?? 0n);
      return;
    case LocationFilterTypeDraft22.ABSOLUTE_START:
      writer.writeVarInt(filter.startLocation?.group ?? 0n);
      writer.writeVarInt(filter.startLocation?.object ?? 0n);
      return;
    case LocationFilterTypeDraft22.ABSOLUTE_START_GROUP_END:
      writer.writeVarInt(filter.startLocation?.group ?? 0n);
      writer.writeVarInt(filter.startLocation?.object ?? 0n);
      writer.writeVarInt(filter.endGroupDelta ?? 0n);
      return;
    case LocationFilterTypeDraft22.ABSOLUTE_RANGE:
      writer.writeVarInt(filter.startLocation?.group ?? 0n);
      writer.writeVarInt(filter.startLocation?.object ?? 0n);
      writer.writeVarInt(filter.endGroupDelta ?? 0n);
      writer.writeVarInt(filter.endObject ?? 0n);
      return;
    default:
      throw violation(`Unknown LOCATION_FILTER type: ${filter.type}`);
  }
}

/** §9.20.9: a Group ID past 2^64-1 closes the session */
function readEndGroupDelta(reader: Draft18BufferReader, startGroup: bigint): bigint {
  const delta = reader.readVarInt();
  if (startGroup + delta > MOQT_VARINT_MAX) {
    throw violation('LOCATION_FILTER end Group exceeds 2^64-1');
  }

  return delta;
}

function decodeLocationFilter(reader: Draft18BufferReader): LocationFilterDraft22 {
  const type = reader.readVarIntNumber();

  switch (type) {
    case LocationFilterTypeDraft22.NONE:
    case LocationFilterTypeDraft22.NEXT_OBJECT:
      return { type };
    case LocationFilterTypeDraft22.RELATIVE_START:
      return { type, startLocation: { group: reader.readVarInt(), object: 0n } };
    case LocationFilterTypeDraft22.ABSOLUTE_START:
      return { type, startLocation: { group: reader.readVarInt(), object: reader.readVarInt() } };
    case LocationFilterTypeDraft22.ABSOLUTE_START_GROUP_END: {
      const startLocation = { group: reader.readVarInt(), object: reader.readVarInt() };
      return { type, startLocation, endGroupDelta: readEndGroupDelta(reader, startLocation.group) };
    }
    case LocationFilterTypeDraft22.ABSOLUTE_RANGE: {
      const startLocation = { group: reader.readVarInt(), object: reader.readVarInt() };
      const endGroupDelta = readEndGroupDelta(reader, startLocation.group);
      return { type, startLocation, endGroupDelta, endObject: reader.readVarInt() };
    }
    default:
      throw violation(`Unknown LOCATION_FILTER type: ${type}`);
  }
}
