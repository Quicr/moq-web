// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * The Request IDs a peer has used, in bounded memory.
 *
 * A receiver need not detect every duplicate Request ID (draft-23 §9.1,
 * #1993), so this keeps a contiguous floor (every ID below it was used) and a
 * sparse set of the IDs above it, which requests on separate streams can
 * leave out of order. When the set reaches its cap, the lower half is
 * forgotten: a duplicate of those is then missed, but an ID never used is
 * never refused.
 */

const DEFAULT_CAP = 1024;

export class PeerRequestIds {
  /** Every ID below this, in steps of `step`, was used */
  private floor: bigint;
  private readonly above = new Set<bigint>();
  private highestSeen = -1n;

  constructor(
    private readonly first: bigint,
    private readonly step = 2n,
    private readonly cap = DEFAULT_CAP,
  ) {
    this.floor = first;
  }

  /** Record `id`; false when it was already used (as far as this remembers) */
  add(id: bigint): boolean {
    if (id < this.floor || this.above.has(id)) {
      return false;
    }

    if (id > this.highestSeen) {
      this.highestSeen = id;
    }
    if (id !== this.floor) {
      this.above.add(id);
      if (this.above.size > this.cap) {
        this.forgetLowerHalf();
      }
      return true;
    }

    this.floor += this.step;
    while (this.above.delete(this.floor)) {
      this.floor += this.step;
    }

    return true;
  }

  /** The largest ID seen, or undefined when none */
  get highest(): bigint | undefined {
    return this.highestSeen < 0n ? undefined : this.highestSeen;
  }

  /** IDs held above the floor (for tests and diagnostics) */
  get sparseSize(): number {
    return this.above.size;
  }

  clear(): void {
    this.floor = this.first;
    this.above.clear();
    this.highestSeen = -1n;
  }

  private forgetLowerHalf(): void {
    const sorted = [...this.above].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const id of sorted.slice(0, sorted.length >> 1)) {
      this.above.delete(id);
    }
  }
}
