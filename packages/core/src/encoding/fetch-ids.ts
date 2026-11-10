// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Fetch stream Group and Object IDs (draft-22 §11.4.1, draft-23 §11.4).
 *
 * Fetch Objects and End of Range indicators carry IDs relative to the prior
 * entry. This resolver holds that prior state for one stream and applies one
 * draft's rules, so the wire codec only parses fields and the router only
 * routes. Drafts 18 and 22 share rules; draft-23 changes three:
 *
 * - An Object ID Delta within a Group adds 2, not 0 (#2006)
 * - End of Range IDs are delta-coded after the first entry (#2031)
 * - End of Group / End of Track indicators have no fields and set the prior
 *   Object ID to 2^64-1 (#2013)
 *
 * Every decoded ID is checked against 0 and 2^64-1 (DELTA_ENCODING_OVERFLOW).
 */

import { MOQT_VARINT_MAX } from './moqt-varint.js';
import { Draft18StreamCodecError } from './draft18-stream-codec.js';
import type { Violation } from './violation.js';
import {
  FetchObjectEndOfRange,
  FetchObjectMarker,
  FetchSubgroupMode,
  GroupOrder,
  type FetchObjectDraft18,
  type Location,
} from '../messages/types.js';

/** Which draft's ID rules apply: drafts 18 through 22 share them */
export type FetchIdRules = 'draft-18' | 'draft-23';

/** A resolved Fetch Object */
export interface FetchObjectIds {
  groupId: bigint;
  objectId: bigint;
  subgroupId: bigint;
  priority: number;
}

function fail(message: string, violation: Violation): Draft18StreamCodecError {
  return new Draft18StreamCodecError(message, undefined, violation);
}

function checked(value: bigint, what: string): bigint {
  if (value < 0n || value > MOQT_VARINT_MAX) {
    throw fail(`FETCH ${what} ${value} is outside 0..2^64-1`, 'delta-overflow');
  }

  return value;
}

/** Whether `marker` is defined for these rules */
export function isFetchIndicatorAllowed(marker: number, rules: FetchIdRules, timedOutAllowed: boolean): boolean {
  switch (marker) {
    case FetchObjectEndOfRange.NON_EXISTENT:
    case FetchObjectEndOfRange.UNKNOWN:
      return true;
    case FetchObjectEndOfRange.TIMED_OUT:
      return timedOutAllowed;
    case FetchObjectEndOfRange.GONE:
    case FetchObjectMarker.END_OF_GROUP:
    case FetchObjectMarker.END_OF_TRACK:
      return rules === 'draft-23';
    default:
      return false;
  }
}

export class FetchIdResolver {
  private priorGroup?: bigint;
  private priorObject?: bigint;
  /** From the last actual Object; indicators do not change them */
  private priorSubgroup?: bigint;
  private priorPriority?: number;
  private trackEnded = false;

  constructor(
    private readonly rules: FetchIdRules,
    private readonly order: GroupOrder = GroupOrder.ASCENDING,
  ) {}

  /** True once End of Track was received (draft-23) */
  get endOfTrack(): boolean {
    return this.trackEnded;
  }

  /**
   * Apply an End of Range indicator and return the Location it ends at
   * (inclusive). It becomes the prior Group and Object ID.
   */
  endOfRange(groupIdDelta: bigint, objectIdDelta: bigint): Location {
    this.assertOpen();
    let group: bigint;
    let object: bigint;

    if (this.rules === 'draft-18' || this.priorGroup === undefined) {
      // Absolute: always before draft-23, and for the first entry after it (§11.4.2.1)
      group = groupIdDelta;
      object = objectIdDelta;
    } else {
      group = this.order === GroupOrder.DESCENDING ? this.priorGroup - groupIdDelta : this.priorGroup + groupIdDelta;
      object = groupIdDelta === 0n ? this.priorObject! + objectIdDelta + 1n : objectIdDelta;
    }

    this.priorGroup = checked(group, 'End of Range Group ID');
    this.priorObject = checked(object, 'End of Range Object ID');

    return { group: this.priorGroup, object: this.priorObject };
  }

  /**
   * Draft-23 §11.4.2.2: End of Group / End of Track. The prior Object was the
   * last in its Group (or the Track). Returns the Group that ended.
   */
  marker(marker: FetchObjectMarker): bigint {
    this.assertOpen();
    if (this.priorGroup === undefined) {
      throw fail(`FETCH ${FetchObjectMarker[marker]} before any Object`, 'malformed-object');
    }
    this.priorObject = MOQT_VARINT_MAX;
    if (marker === FetchObjectMarker.END_OF_TRACK) {
      this.trackEnded = true;
    }

    return this.priorGroup;
  }

  /** Resolve a Fetch Object's IDs, subgroup and priority, and make it the prior Object */
  object(decoded: FetchObjectDraft18): FetchObjectIds {
    this.assertOpen();
    const isFirst = this.priorGroup === undefined;

    let groupId: bigint;
    if (decoded.groupIdDelta !== undefined) {
      // Absolute on the first Object, else prior +/- (delta + 1) by Group Order
      groupId = isFirst
        ? decoded.groupIdDelta
        : this.order === GroupOrder.DESCENDING
          ? this.priorGroup! - (decoded.groupIdDelta + 1n)
          : this.priorGroup! + decoded.groupIdDelta + 1n;
    } else {
      if (isFirst) {
        throw fail('FETCH: first Object has no Group ID', 'malformed-object');
      }
      groupId = this.priorGroup!;
    }

    let objectId: bigint;
    if (decoded.objectIdDelta !== undefined) {
      // Absolute beside a Group ID Delta (or first); else relative to the prior Object
      const relative = !isFirst && decoded.groupIdDelta === undefined;
      const gap = this.rules === 'draft-23' ? 2n : 0n;
      objectId = relative ? this.priorObject! + decoded.objectIdDelta + gap : decoded.objectIdDelta;
    } else {
      if (isFirst) {
        throw fail('FETCH: first Object has no Object ID', 'malformed-object');
      }
      objectId = this.priorObject! + 1n;
    }

    const ids: FetchObjectIds = {
      groupId: checked(groupId, 'Group ID'),
      objectId: checked(objectId, 'Object ID'),
      subgroupId: this.subgroupOf(decoded, objectId),
      priority: this.priorityOf(decoded),
    };

    this.priorGroup = ids.groupId;
    this.priorObject = ids.objectId;
    this.priorSubgroup = ids.subgroupId;
    this.priorPriority = ids.priority;

    return ids;
  }

  private subgroupOf(decoded: FetchObjectDraft18, objectId: bigint): bigint {
    // Datagram-mode Objects have no Subgroup; mirror the Object ID like reference implementations
    if (decoded.datagramMode === true) {
      return objectId;
    }

    switch (decoded.subgroupMode) {
      case FetchSubgroupMode.ZERO:
        return 0n;
      case FetchSubgroupMode.PRIOR:
        return this.requirePriorSubgroup();
      case FetchSubgroupMode.PRIOR_PLUS_ONE:
        return this.requirePriorSubgroup() + 1n;
      case FetchSubgroupMode.EXPLICIT:
        if (decoded.subgroupId === undefined) {
          throw fail('FETCH: explicit Subgroup ID mode without a Subgroup ID', 'malformed-object');
        }
        return decoded.subgroupId;
      default:
        throw fail(`FETCH: invalid Subgroup ID mode ${decoded.subgroupMode as number}`, 'malformed-object');
    }
  }

  private requirePriorSubgroup(): bigint {
    if (this.priorSubgroup === undefined) {
      throw fail('FETCH: Subgroup ID references a prior Object that does not exist', 'malformed-object');
    }

    return this.priorSubgroup;
  }

  private priorityOf(decoded: FetchObjectDraft18): number {
    if (decoded.publisherPriority !== undefined) {
      return decoded.publisherPriority;
    }
    if (this.priorPriority === undefined) {
      throw fail('FETCH: Priority references a prior Object that does not exist', 'malformed-object');
    }

    return this.priorPriority;
  }

  /** Nothing may follow End of Track: it marks the last Object in the Track */
  private assertOpen(): void {
    if (this.trackEnded) {
      throw fail('FETCH: entry after End of Track', 'malformed-object');
    }
  }
}
