// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { describe, it, expect } from 'vitest';
import {
  EpochGroupNumbering,
  SequentialGroupNumbering,
  createGroupNumbering,
} from './group-numbering.js';
import {
  GroupIdGapTracker,
  PRIOR_GROUP_ID_GAP_EXTENSION_ID,
  encodePriorGroupIdGap,
  decodePriorGroupIdGap,
} from './group-gap.js';

describe('GroupNumbering', () => {
  describe('EpochGroupNumbering', () => {
    it('should start with epoch-based group ID', () => {
      const numbering = new EpochGroupNumbering();
      const before = Math.floor(Date.now() / 1000);
      const [groupId] = numbering.nextFull();
      const after = Math.floor(Date.now() / 1000);

      expect(groupId).toBeGreaterThanOrEqual(before);
      expect(groupId).toBeLessThanOrEqual(after);
    });

    it('should start full catalog at object 0', () => {
      const numbering = new EpochGroupNumbering();
      const [, objectId] = numbering.nextFull();
      expect(objectId).toBe(0);
    });

    it('should increment object ID for deltas', () => {
      const numbering = new EpochGroupNumbering();
      numbering.nextFull();

      const [, obj1] = numbering.nextDelta();
      const [, obj2] = numbering.nextDelta();
      const [, obj3] = numbering.nextDelta();

      expect(obj1).toBe(1);
      expect(obj2).toBe(2);
      expect(obj3).toBe(3);
    });

    it('should keep same group for deltas', () => {
      const numbering = new EpochGroupNumbering();
      const [fullGroup] = numbering.nextFull();
      const [deltaGroup] = numbering.nextDelta();

      expect(deltaGroup).toBe(fullGroup);
    });

    it('should start new group for next full catalog', () => {
      const numbering = new EpochGroupNumbering(1000);
      numbering.nextFull();
      numbering.nextDelta();
      numbering.nextDelta();

      // Wait a bit to ensure new epoch
      const [newGroup, newObject] = numbering.nextFull();

      expect(newObject).toBe(0);
      // New group should be current epoch (not 1000)
      expect(newGroup).toBeGreaterThan(1000);
    });

    it('should identify full catalogs by object ID', () => {
      const numbering = new EpochGroupNumbering();
      expect(numbering.isFullCatalog(0)).toBe(true);
      expect(numbering.isFullCatalog(1)).toBe(false);
      expect(numbering.isFullCatalog(100)).toBe(false);
    });

    it('should allow custom start epoch', () => {
      const customEpoch = 12345;
      const numbering = new EpochGroupNumbering(customEpoch);

      expect(numbering.getGroup()).toBe(customEpoch);
    });
  });

  describe('SequentialGroupNumbering', () => {
    it('should start at group 0 by default', () => {
      const numbering = new SequentialGroupNumbering();
      expect(numbering.getGroup()).toBe(0);
    });

    it('should increment group on nextFull', () => {
      const numbering = new SequentialGroupNumbering();

      const [group1] = numbering.nextFull();
      const [group2] = numbering.nextFull();
      const [group3] = numbering.nextFull();

      expect(group1).toBe(1);
      expect(group2).toBe(2);
      expect(group3).toBe(3);
    });

    it('should reset object ID on nextFull', () => {
      const numbering = new SequentialGroupNumbering();
      numbering.nextFull();
      numbering.nextDelta();
      numbering.nextDelta();

      const [, objectId] = numbering.nextFull();
      expect(objectId).toBe(0);
    });

    it('should increment object ID on nextDelta', () => {
      const numbering = new SequentialGroupNumbering();
      numbering.nextFull();

      const [, obj1] = numbering.nextDelta();
      const [, obj2] = numbering.nextDelta();

      expect(obj1).toBe(1);
      expect(obj2).toBe(2);
    });

    it('should allow custom start group', () => {
      const numbering = new SequentialGroupNumbering(100);
      const [group] = numbering.nextFull();
      expect(group).toBe(101);
    });
  });

  describe('createGroupNumbering', () => {
    it('should create epoch numbering by default', () => {
      const numbering = createGroupNumbering();
      expect(numbering).toBeInstanceOf(EpochGroupNumbering);
    });

    it('should create epoch numbering explicitly', () => {
      const numbering = createGroupNumbering('epoch');
      expect(numbering).toBeInstanceOf(EpochGroupNumbering);
    });

    it('should create sequential numbering', () => {
      const numbering = createGroupNumbering('sequential');
      expect(numbering).toBeInstanceOf(SequentialGroupNumbering);
    });

    it('should pass start value to epoch numbering', () => {
      const numbering = createGroupNumbering('epoch', 5000);
      expect(numbering.getGroup()).toBe(5000);
    });

    it('should pass start value to sequential numbering', () => {
      const numbering = createGroupNumbering('sequential', 50);
      expect(numbering.getGroup()).toBe(50);
    });
  });
});

// Note: CatalogSubscriber and CatalogPublisher tests would require
// mocking MOQTSession, which is more complex. These are integration
// tests that should be run with a real or mocked session.

describe('Prior Group ID Gap extension (§10)', () => {
  it('reserves extension id 0x20', () => {
    expect(PRIOR_GROUP_ID_GAP_EXTENSION_ID).toBe(0x20);
  });

  describe('varint codec', () => {
    it('roundtrips 1-byte values', () => {
      for (const v of [0n, 1n, 42n, 63n]) {
        const bytes = encodePriorGroupIdGap(v);
        expect(bytes).toHaveLength(1);
        expect(decodePriorGroupIdGap(bytes).value).toBe(v);
      }
    });

    it('roundtrips 2-byte values', () => {
      for (const v of [64n, 0x3fffn]) {
        const bytes = encodePriorGroupIdGap(v);
        expect(bytes).toHaveLength(2);
        expect(decodePriorGroupIdGap(bytes).value).toBe(v);
      }
    });

    it('roundtrips 4-byte values', () => {
      for (const v of [0x4000n, 0x3fff_ffffn]) {
        const bytes = encodePriorGroupIdGap(v);
        expect(bytes).toHaveLength(4);
        expect(decodePriorGroupIdGap(bytes).value).toBe(v);
      }
    });

    it('roundtrips 8-byte values', () => {
      for (const v of [0x4000_0000n, 0x3fff_ffff_ffff_ffffn]) {
        const bytes = encodePriorGroupIdGap(v);
        expect(bytes).toHaveLength(8);
        expect(decodePriorGroupIdGap(bytes).value).toBe(v);
      }
    });

    it('rejects negative values', () => {
      expect(() => encodePriorGroupIdGap(-1)).toThrow(RangeError);
    });

    it('rejects overflow', () => {
      expect(() => encodePriorGroupIdGap(0x4000_0000_0000_0000n)).toThrow(
        RangeError
      );
    });
  });

  describe('GroupIdGapTracker', () => {
    it('emits no extension when there was no prior state', () => {
      const t = new GroupIdGapTracker();
      const { groupId, extension } = t.nextGroupAfterRestart(10);
      expect(groupId).toBe(10n);
      expect(extension).toBeUndefined();
    });

    it('emits Prior Group ID Gap after restart', () => {
      const t = new GroupIdGapTracker(42);
      t.restart();
      const { groupId, extension } = t.nextGroupAfterRestart(100);
      expect(groupId).toBe(100n);
      expect(extension).toBeDefined();
      expect(extension!.id).toBe(PRIOR_GROUP_ID_GAP_EXTENSION_ID);
      expect(decodePriorGroupIdGap(extension!.value).value).toBe(42n);
    });

    it('forces next groupId strictly greater than the prior max', () => {
      const t = new GroupIdGapTracker(50);
      t.restart();
      // Publisher tried to reuse 30 by mistake; tracker bumps to 51.
      const { groupId } = t.nextGroupAfterRestart(30);
      expect(groupId).toBe(51n);
    });

    it('records groups so a later restart uses the highest observed id', () => {
      const t = new GroupIdGapTracker();
      t.recordGroup(1);
      t.recordGroup(5);
      t.recordGroup(3);
      t.restart();
      const { extension } = t.nextGroupAfterRestart(10);
      expect(decodePriorGroupIdGap(extension!.value).value).toBe(5n);
    });

    it('emits the extension only on the first group after each restart', () => {
      const t = new GroupIdGapTracker(1);
      t.restart();
      const first = t.nextGroupAfterRestart(2);
      const second = t.nextGroupAfterRestart(3);
      expect(first.extension).toBeDefined();
      expect(second.extension).toBeUndefined();
    });
  });
});
