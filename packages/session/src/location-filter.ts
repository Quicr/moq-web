// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Location filters as a publisher applies them (draft-22
 * §3.3.1, §9.20.9; draft-18 §5.1.2).
 *
 * A filter is resolved against the Largest Object when the message carrying
 * it is processed, so a relative filter becomes an absolute range.
 */

import { LocationFilterTypeDraft22, SubscriptionFilterDraft18, type Location, type LocationFilterDraft22 } from '@moq-web/core';

/** An inclusive range of Locations; `end` is absent for an open-ended range. */
export interface LocationRange {
  start: Location;
  end?: { group: bigint; object?: bigint };
}

const FIRST_LOCATION: Location = { group: 0n, object: 0n };

/** The whole track: no filter (draft-22 §3.3.1). */
export const WHOLE_TRACK: LocationRange = { start: FIRST_LOCATION };

/** Order of two Locations: negative, zero or positive as `a` is before, equal to or after `b`. */
export function compareLocations(a: Location, b: Location): number {
  if (a.group !== b.group) {
    return a.group < b.group ? -1 : 1;
  }
  if (a.object !== b.object) {
    return a.object < b.object ? -1 : 1;
  }

  return 0;
}

/** The Next Group: first Location after the Largest Object's group (draft-22 §3.1.4) */
function nextGroup(largest: Location | undefined): Location {
  return { group: largest === undefined ? 0n : largest.group + 1n, object: 0n };
}

/** The Next Object: the Location after the Largest Object, {0, 0} before any (draft-22 §3.1.4) */
function nextObject(largest: Location | undefined): Location {
  return largest === undefined ? FIRST_LOCATION : { group: largest.group, object: largest.object + 1n };
}

/** Resolve a draft-22 Location filter against the Largest Object (Table 6). Absent or NONE is no filter. */
export function resolveLocationFilter(filter: LocationFilterDraft22 | undefined, largest: Location | undefined): LocationRange {
  if (filter === undefined) {
    return WHOLE_TRACK;
  }

  const start = filter.startLocation ?? FIRST_LOCATION;
  const endGroup = start.group + (filter.endGroupDelta ?? 0n);
  switch (filter.type) {
    case LocationFilterTypeDraft22.RELATIVE_START: {
      const group = nextGroup(largest).group - start.group;

      return { start: { group: group < 0n ? 0n : group, object: 0n } };
    }
    case LocationFilterTypeDraft22.ABSOLUTE_START:
      return { start };
    case LocationFilterTypeDraft22.ABSOLUTE_START_GROUP_END:
      return { start, end: { group: endGroup } };
    case LocationFilterTypeDraft22.ABSOLUTE_RANGE:
      return { start, end: { group: endGroup, object: filter.endObject } };
    case LocationFilterTypeDraft22.NEXT_OBJECT:
      return { start: nextObject(largest) };
    default:
      return WHOLE_TRACK;
  }
}

/** Resolve a draft-18 SUBSCRIPTION_FILTER against the Largest Object (§5.1.2). */
export function resolveSubscriptionFilter(
  filter: SubscriptionFilterDraft18,
  startLocation: Location | undefined,
  endGroupDelta: bigint | undefined,
  largest: Location | undefined,
): LocationRange {
  const start = startLocation ?? FIRST_LOCATION;
  switch (filter) {
    case SubscriptionFilterDraft18.NEXT_GROUP_START:
      return { start: nextGroup(largest) };
    case SubscriptionFilterDraft18.LARGEST_OBJECT:
      return { start: nextObject(largest) };
    case SubscriptionFilterDraft18.ABSOLUTE_START:
      return { start };
    case SubscriptionFilterDraft18.ABSOLUTE_RANGE:
      return { start, end: { group: start.group + (endGroupDelta ?? 0n) } };
    default:
      return WHOLE_TRACK;
  }
}

/** Whether the Object at `group`, `object` is inside `range` */
export function admits(range: LocationRange, group: bigint, object: bigint): boolean {
  const location = { group, object };
  if (compareLocations(location, range.start) < 0) {
    return false;
  }
  if (range.end === undefined || group < range.end.group) {
    return true;
  }

  return group === range.end.group && (range.end.object === undefined || object <= range.end.object);
}

/** Whether the End Group of `range` is already completely published, so nothing is left to deliver (d18 §5.1.2) */
export function endsBefore(range: LocationRange, largest: Location | undefined): boolean {
  return range.end !== undefined && largest !== undefined && largest.group > range.end.group;
}
