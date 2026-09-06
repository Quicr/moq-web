// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview MSF §5/§6 irreversibility rules.
 *
 * Some catalog and track fields are one-way latches: once observed with a
 * committed value, they MUST NOT flip back. These helpers cross-check a
 * "previous" and "next" snapshot and throw when a rule is violated. Callers
 * are expected to wire these at their republish / delta-apply boundary
 * (schemas alone can't remember state across calls).
 *
 * The rules encoded here:
 *  - `isComplete = true` MUST NOT be removed once added (§5.6).
 *  - `isComplete = true` MUST NOT flip back to `false` or `absent` (§5.6).
 *  - Per-track `isLive` MUST NOT flip `false → true`. The spec makes the
 *    live→VOD transition observable (a live track ends) but the reverse is
 *    disallowed because it would retroactively invalidate `trackDuration`
 *    guarantees (§6 `isLive`, §6 `trackDuration`).
 */

import type { FullCatalog, Track } from './index.js';

/**
 * Error thrown when an immutability guard trips.
 */
export class CatalogImmutabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogImmutabilityError';
  }
}

/**
 * Assert that `next` doesn't violate MSF irreversibility rules relative to
 * `previous`. Callers should invoke this before committing a republished /
 * delta-applied catalog into their local state.
 */
export function assertCatalogImmutability(
  previous: FullCatalog,
  next: FullCatalog
): void {
  // §5.6: isComplete is a one-way latch.
  if (previous.isComplete === true && next.isComplete !== true) {
    throw new CatalogImmutabilityError(
      'MSF §5.6: `isComplete: true` MUST NOT be removed once added'
    );
  }

  // §6: isLive is a one-way latch (true → false is allowed; false → true is not).
  const prevByName = new Map<string, Track>(
    previous.tracks.map((t) => [trackKey(t), t])
  );
  for (const nextTrack of next.tracks) {
    const prev = prevByName.get(trackKey(nextTrack));
    if (prev === undefined) continue;
    if (prev.isLive === false && nextTrack.isLive === true) {
      throw new CatalogImmutabilityError(
        `MSF §6: track '${nextTrack.name}' cannot flip \`isLive\` from false → true`
      );
    }
  }
}

function trackKey(t: Track): string {
  const ns = (t.namespace ?? []).join('/');
  return `${ns}::${t.name}`;
}
