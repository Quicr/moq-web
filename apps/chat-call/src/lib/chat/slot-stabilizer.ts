/**
 * Stable slot assignment for top-N active speaker display.
 *
 * Prevents visual flickering by keeping existing participants in their
 * slots and only filling vacancies when speakers change.
 *
 * @see quicr-mac/docs/top-n-active-speaker-design.md §4.2
 */

export interface SlotParticipant {
  id: string;
  activityValue: number;
  lastActiveTime: number;
}

export class SlotStabilizer {
  private slotAssignments: (string | null)[];

  constructor(maxSlots: number) {
    this.slotAssignments = new Array(maxSlots).fill(null);
  }

  /**
   * Given a ranked list of participants (highest activity first),
   * returns a stable slot assignment that minimizes visual movement.
   *
   * @param ranked - Participants sorted by activity (desc), then recency (desc), then ID
   * @returns Array of participant IDs in stable slot order (null for empty slots)
   */
  stabilize(ranked: SlotParticipant[]): (string | null)[] {
    const n = this.slotAssignments.length;
    const selected = ranked.slice(0, n);
    const selectedIds = new Set(selected.map((p) => p.id));

    // Clear stale slots (participants no longer in the selected set)
    for (let i = 0; i < n; i++) {
      if (this.slotAssignments[i] !== null && !selectedIds.has(this.slotAssignments[i]!)) {
        this.slotAssignments[i] = null;
      }
    }

    // Fill vacancies with newly selected participants
    const slottedIds = new Set(this.slotAssignments.filter((id) => id !== null));
    for (const p of selected) {
      if (!slottedIds.has(p.id)) {
        const vacancy = this.slotAssignments.indexOf(null);
        if (vacancy !== -1) {
          this.slotAssignments[vacancy] = p.id;
          slottedIds.add(p.id);
        }
      }
    }

    return [...this.slotAssignments];
  }

  /** Resize the slot array (e.g. when user changes N) */
  resize(maxSlots: number): void {
    if (maxSlots > this.slotAssignments.length) {
      this.slotAssignments.push(...new Array(maxSlots - this.slotAssignments.length).fill(null));
    } else {
      this.slotAssignments.length = maxSlots;
    }
  }

  /** Reset all slots */
  reset(): void {
    this.slotAssignments.fill(null);
  }
}

/**
 * Sort participants by activity for the slot stabilizer.
 * Order: activity (desc) → lastActiveTime (desc) → id (asc)
 */
export function rankByActivity(participants: SlotParticipant[]): SlotParticipant[] {
  return [...participants].sort((a, b) => {
    if (b.activityValue !== a.activityValue) return b.activityValue - a.activityValue;
    if (b.lastActiveTime !== a.lastActiveTime) return b.lastActiveTime - a.lastActiveTime;
    return a.id.localeCompare(b.id);
  });
}
