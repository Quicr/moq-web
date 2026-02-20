// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Track Manager Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  TrackManager,
  trackNameToKey,
  namespaceToKey,
  keyToTrackName,
  namespaceMatchesPrefix,
  type TrackManagerEvent,
} from './track-manager';
import { GroupOrder, FilterType, DeliveryMode } from '../messages/types';

describe('Utility Functions', () => {
  describe('trackNameToKey', () => {
    it('converts full track name to key', () => {
      const key = trackNameToKey({
        namespace: ['app', 'room1', 'media'],
        trackName: 'user123/video',
      });
      expect(key).toBe('app/room1/media:user123/video');
    });

    it('handles empty namespace', () => {
      const key = trackNameToKey({
        namespace: [],
        trackName: 'track1',
      });
      expect(key).toBe(':track1');
    });

    it('handles single element namespace', () => {
      const key = trackNameToKey({
        namespace: ['root'],
        trackName: 'track',
      });
      expect(key).toBe('root:track');
    });
  });

  describe('namespaceToKey', () => {
    it('converts namespace array to key', () => {
      const key = namespaceToKey(['app', 'room1', 'media']);
      expect(key).toBe('app/room1/media');
    });

    it('handles empty namespace', () => {
      expect(namespaceToKey([])).toBe('');
    });
  });

  describe('keyToTrackName', () => {
    it('parses key back to full track name', () => {
      const trackName = keyToTrackName('app/room1/media:user123/video');
      expect(trackName).toEqual({
        namespace: ['app', 'room1', 'media'],
        trackName: 'user123/video',
      });
    });

    it('handles empty namespace', () => {
      const trackName = keyToTrackName(':track1');
      expect(trackName).toEqual({
        namespace: [''],
        trackName: 'track1',
      });
    });

    it('throws for invalid key without colon', () => {
      expect(() => keyToTrackName('invalidkey')).toThrow('Invalid track name key');
    });

    it('handles track name with colons by using last colon as separator', () => {
      // keyToTrackName uses lastIndexOf(':'), so only the part after the last colon is the trackName
      const trackName = keyToTrackName('ns:track:with:colons');
      expect(trackName.namespace).toEqual(['ns:track:with']);
      expect(trackName.trackName).toBe('colons');
    });
  });

  describe('namespaceMatchesPrefix', () => {
    it('returns true for exact match', () => {
      expect(namespaceMatchesPrefix(
        ['app', 'room1'],
        ['app', 'room1']
      )).toBe(true);
    });

    it('returns true when namespace extends prefix', () => {
      expect(namespaceMatchesPrefix(
        ['app', 'room1', 'media'],
        ['app', 'room1']
      )).toBe(true);
    });

    it('returns false when prefix is longer', () => {
      expect(namespaceMatchesPrefix(
        ['app'],
        ['app', 'room1']
      )).toBe(false);
    });

    it('returns false when elements differ', () => {
      expect(namespaceMatchesPrefix(
        ['app', 'room2'],
        ['app', 'room1']
      )).toBe(false);
    });

    it('returns true for empty prefix', () => {
      expect(namespaceMatchesPrefix(
        ['app', 'room1'],
        []
      )).toBe(true);
    });
  });
});

describe('TrackManager', () => {
  let manager: TrackManager;

  beforeEach(() => {
    manager = new TrackManager();
  });

  describe('Published Tracks', () => {
    describe('createPublishedTrack', () => {
      it('creates a published track', () => {
        const track = manager.createPublishedTrack({
          fullTrackName: {
            namespace: ['app', 'room1'],
            trackName: 'video',
          },
        });

        expect(track.key).toBe('app/room1:video');
        expect(track.trackAlias).toBe(1);
        expect(track.deliveryMode).toBe(DeliveryMode.STREAM);
        expect(track.priority).toBe(128);
        expect(track.currentGroupId).toBe(0);
        expect(track.currentObjectId).toBe(0);
        expect(track.totalObjects).toBe(0);
        expect(track.createdAt).toBeDefined();
      });

      it('assigns unique track aliases', () => {
        const track1 = manager.createPublishedTrack({
          fullTrackName: { namespace: ['ns'], trackName: 'track1' },
        });
        const track2 = manager.createPublishedTrack({
          fullTrackName: { namespace: ['ns'], trackName: 'track2' },
        });

        expect(track1.trackAlias).toBe(1);
        expect(track2.trackAlias).toBe(2);
      });

      it('throws for duplicate track', () => {
        manager.createPublishedTrack({
          fullTrackName: { namespace: ['ns'], trackName: 'track' },
        });

        expect(() => manager.createPublishedTrack({
          fullTrackName: { namespace: ['ns'], trackName: 'track' },
        })).toThrow('Track already exists');
      });

      it('respects custom config', () => {
        const track = manager.createPublishedTrack({
          fullTrackName: { namespace: ['ns'], trackName: 'track' },
          deliveryMode: DeliveryMode.DATAGRAM,
          priority: 64,
        });

        expect(track.deliveryMode).toBe(DeliveryMode.DATAGRAM);
        expect(track.priority).toBe(64);
      });

      it('emits track-published event', () => {
        const handler = vi.fn();
        manager.on(handler);

        const track = manager.createPublishedTrack({
          fullTrackName: { namespace: ['ns'], trackName: 'track' },
        });

        expect(handler).toHaveBeenCalledWith({
          type: 'track-published',
          track,
        });
      });
    });

    describe('getPublishedTrack', () => {
      it('returns track by key', () => {
        const created = manager.createPublishedTrack({
          fullTrackName: { namespace: ['ns'], trackName: 'track' },
        });

        const found = manager.getPublishedTrack('ns:track');
        expect(found).toBe(created);
      });

      it('returns undefined for unknown key', () => {
        expect(manager.getPublishedTrack('unknown:track')).toBeUndefined();
      });
    });

    describe('getPublishedTrackByAlias', () => {
      it('returns track by alias', () => {
        const created = manager.createPublishedTrack({
          fullTrackName: { namespace: ['ns'], trackName: 'track' },
        });

        const found = manager.getPublishedTrackByAlias(1);
        expect(found).toBe(created);
      });

      it('returns undefined for unknown alias', () => {
        expect(manager.getPublishedTrackByAlias(999)).toBeUndefined();
      });
    });

    describe('getAllPublishedTracks', () => {
      it('returns all published tracks', () => {
        manager.createPublishedTrack({
          fullTrackName: { namespace: ['ns'], trackName: 'track1' },
        });
        manager.createPublishedTrack({
          fullTrackName: { namespace: ['ns'], trackName: 'track2' },
        });

        const tracks = manager.getAllPublishedTracks();
        expect(tracks.length).toBe(2);
      });

      it('returns empty array when no tracks', () => {
        expect(manager.getAllPublishedTracks()).toEqual([]);
      });
    });

    describe('removePublishedTrack', () => {
      it('removes a track', () => {
        manager.createPublishedTrack({
          fullTrackName: { namespace: ['ns'], trackName: 'track' },
        });

        expect(manager.removePublishedTrack('ns:track')).toBe(true);
        expect(manager.getPublishedTrack('ns:track')).toBeUndefined();
      });

      it('returns false for unknown track', () => {
        expect(manager.removePublishedTrack('unknown')).toBe(false);
      });

      it('emits track-unpublished event', () => {
        const track = manager.createPublishedTrack({
          fullTrackName: { namespace: ['ns'], trackName: 'track' },
        });

        const handler = vi.fn();
        manager.on(handler);

        manager.removePublishedTrack('ns:track');

        expect(handler).toHaveBeenCalledWith({
          type: 'track-unpublished',
          track,
        });
      });
    });

    describe('recordPublishedObject', () => {
      it('increments object ID for non-keyframe', () => {
        manager.createPublishedTrack({
          fullTrackName: { namespace: ['ns'], trackName: 'track' },
        });

        const result = manager.recordPublishedObject('ns:track', false);
        expect(result.groupId).toBe(0);
        expect(result.objectId).toBe(1);
      });

      it('increments group ID and resets object ID for keyframe', () => {
        manager.createPublishedTrack({
          fullTrackName: { namespace: ['ns'], trackName: 'track' },
        });

        // Simulate some objects
        manager.recordPublishedObject('ns:track', false);
        manager.recordPublishedObject('ns:track', false);

        // Keyframe
        const result = manager.recordPublishedObject('ns:track', true);
        expect(result.groupId).toBe(1);
        expect(result.objectId).toBe(0);
      });

      it('increments totalObjects', () => {
        manager.createPublishedTrack({
          fullTrackName: { namespace: ['ns'], trackName: 'track' },
        });

        manager.recordPublishedObject('ns:track', true);
        manager.recordPublishedObject('ns:track', false);
        manager.recordPublishedObject('ns:track', false);

        const track = manager.getPublishedTrack('ns:track');
        expect(track?.totalObjects).toBe(3);
      });

      it('throws for unknown track', () => {
        expect(() => manager.recordPublishedObject('unknown', false))
          .toThrow('Track not found');
      });
    });

    describe('subscribers', () => {
      it('adds subscriber to track', () => {
        manager.createPublishedTrack({
          fullTrackName: { namespace: ['ns'], trackName: 'track' },
        });

        manager.addSubscriber('ns:track', 42);

        const track = manager.getPublishedTrack('ns:track');
        expect(track?.subscribers.has(42)).toBe(true);
      });

      it('emits subscriber-added event', () => {
        const track = manager.createPublishedTrack({
          fullTrackName: { namespace: ['ns'], trackName: 'track' },
        });

        const handler = vi.fn();
        manager.on(handler);

        manager.addSubscriber('ns:track', 42);

        expect(handler).toHaveBeenCalledWith({
          type: 'subscriber-added',
          track,
          subscribeId: 42,
        });
      });

      it('removes subscriber from track', () => {
        manager.createPublishedTrack({
          fullTrackName: { namespace: ['ns'], trackName: 'track' },
        });

        manager.addSubscriber('ns:track', 42);
        manager.removeSubscriber('ns:track', 42);

        const track = manager.getPublishedTrack('ns:track');
        expect(track?.subscribers.has(42)).toBe(false);
      });

      it('throws for adding to unknown track', () => {
        expect(() => manager.addSubscriber('unknown', 1))
          .toThrow('Track not found');
      });
    });
  });

  describe('Subscribed Tracks', () => {
    describe('createSubscription', () => {
      it('creates a subscription', () => {
        const sub = manager.createSubscription({
          fullTrackName: {
            namespace: ['app', 'room1'],
            trackName: 'video',
          },
        });

        expect(sub.key).toBe('app/room1:video');
        expect(sub.subscribeId).toBe(1);
        expect(sub.state.state).toBe('pending');
        expect(sub.config.priority).toBe(128);
        expect(sub.config.groupOrder).toBe(GroupOrder.ASCENDING);
        expect(sub.config.filterType).toBe(FilterType.LATEST_GROUP);
      });

      it('assigns unique subscribe IDs', () => {
        const sub1 = manager.createSubscription({
          fullTrackName: { namespace: ['ns'], trackName: 'track1' },
        });
        const sub2 = manager.createSubscription({
          fullTrackName: { namespace: ['ns'], trackName: 'track2' },
        });

        expect(sub1.subscribeId).toBe(1);
        expect(sub2.subscribeId).toBe(2);
      });

      it('throws for duplicate subscription', () => {
        manager.createSubscription({
          fullTrackName: { namespace: ['ns'], trackName: 'track' },
        });

        expect(() => manager.createSubscription({
          fullTrackName: { namespace: ['ns'], trackName: 'track' },
        })).toThrow('Already subscribed to');
      });

      it('emits subscription-created event', () => {
        const handler = vi.fn();
        manager.on(handler);

        const sub = manager.createSubscription({
          fullTrackName: { namespace: ['ns'], trackName: 'track' },
        });

        expect(handler).toHaveBeenCalledWith({
          type: 'subscription-created',
          track: sub,
        });
      });
    });

    describe('getSubscription', () => {
      it('returns subscription by key', () => {
        const created = manager.createSubscription({
          fullTrackName: { namespace: ['ns'], trackName: 'track' },
        });

        const found = manager.getSubscription('ns:track');
        expect(found).toBe(created);
      });
    });

    describe('getSubscriptionById', () => {
      it('returns subscription by ID', () => {
        const created = manager.createSubscription({
          fullTrackName: { namespace: ['ns'], trackName: 'track' },
        });

        const found = manager.getSubscriptionById(1);
        expect(found).toBe(created);
      });
    });

    describe('setSubscriptionActive', () => {
      it('activates a subscription', () => {
        const sub = manager.createSubscription({
          fullTrackName: { namespace: ['ns'], trackName: 'track' },
        });

        manager.setSubscriptionActive(1, 100, GroupOrder.DESCENDING);

        expect(sub.state.state).toBe('active');
        expect(sub.trackAlias).toBe(100);
      });

      it('enables lookup by alias', () => {
        manager.createSubscription({
          fullTrackName: { namespace: ['ns'], trackName: 'track' },
        });

        manager.setSubscriptionActive(1, 100, GroupOrder.ASCENDING);

        const found = manager.getSubscriptionByAlias(100);
        expect(found?.subscribeId).toBe(1);
      });

      it('emits subscription-active event', () => {
        manager.createSubscription({
          fullTrackName: { namespace: ['ns'], trackName: 'track' },
        });

        const handler = vi.fn();
        manager.on(handler);

        manager.setSubscriptionActive(1, 100, GroupOrder.ASCENDING);

        const call = handler.mock.calls.find(
          c => (c[0] as TrackManagerEvent).type === 'subscription-active'
        );
        expect(call).toBeDefined();
      });
    });

    describe('setSubscriptionError', () => {
      it('sets subscription to error state', () => {
        const sub = manager.createSubscription({
          fullTrackName: { namespace: ['ns'], trackName: 'track' },
        });

        manager.setSubscriptionError(1, 404, 'Track not found');

        expect(sub.state.state).toBe('error');
        expect(sub.state.errorCode).toBe(404);
        expect(sub.state.errorReason).toBe('Track not found');
      });

      it('emits subscription-error event', () => {
        manager.createSubscription({
          fullTrackName: { namespace: ['ns'], trackName: 'track' },
        });

        const handler = vi.fn();
        manager.on(handler);

        manager.setSubscriptionError(1, 500, 'Internal error');

        const call = handler.mock.calls.find(
          c => (c[0] as TrackManagerEvent).type === 'subscription-error'
        );
        expect(call).toBeDefined();
      });
    });

    describe('setSubscriptionEnded', () => {
      it('sets subscription to ended state', () => {
        const sub = manager.createSubscription({
          fullTrackName: { namespace: ['ns'], trackName: 'track' },
        });
        manager.setSubscriptionActive(1, 100, GroupOrder.ASCENDING);

        manager.setSubscriptionEnded(1, 'Track finished');

        expect(sub.state.state).toBe('ended');
      });
    });

    describe('removeSubscription', () => {
      it('removes subscription', () => {
        manager.createSubscription({
          fullTrackName: { namespace: ['ns'], trackName: 'track' },
        });

        expect(manager.removeSubscription('ns:track')).toBe(true);
        expect(manager.getSubscription('ns:track')).toBeUndefined();
      });

      it('removes from all indexes', () => {
        manager.createSubscription({
          fullTrackName: { namespace: ['ns'], trackName: 'track' },
        });
        manager.setSubscriptionActive(1, 100, GroupOrder.ASCENDING);

        manager.removeSubscription('ns:track');

        expect(manager.getSubscriptionById(1)).toBeUndefined();
        expect(manager.getSubscriptionByAlias(100)).toBeUndefined();
      });
    });

    describe('recordReceivedObject', () => {
      it('updates counters', () => {
        manager.createSubscription({
          fullTrackName: { namespace: ['ns'], trackName: 'track' },
        });

        manager.recordReceivedObject(1, 5, 10);

        const sub = manager.getSubscriptionById(1);
        expect(sub?.lastGroupId).toBe(5);
        expect(sub?.lastObjectId).toBe(10);
        expect(sub?.totalObjects).toBe(1);
      });
    });
  });

  describe('Announcements', () => {
    describe('createAnnouncement', () => {
      it('creates an announcement', () => {
        const announcement = manager.createAnnouncement(['app', 'room1']);

        expect(announcement.namespace).toEqual(['app', 'room1']);
        expect(announcement.state).toBe('pending');
      });

      it('returns existing announcement if already exists', () => {
        const ann1 = manager.createAnnouncement(['ns']);
        const ann2 = manager.createAnnouncement(['ns']);

        expect(ann1).toBe(ann2);
      });

      it('emits announcement-active event on activation', () => {
        const handler = vi.fn();
        manager.on(handler);

        const announcement = manager.createAnnouncement(['ns']);
        announcement.setActive();

        expect(handler).toHaveBeenCalledWith({
          type: 'announcement-active',
          namespace: ['ns'],
        });
      });
    });

    describe('getAnnouncement', () => {
      it('returns announcement by namespace', () => {
        const created = manager.createAnnouncement(['ns']);
        const found = manager.getAnnouncement(['ns']);
        expect(found).toBe(created);
      });

      it('returns undefined for unknown namespace', () => {
        expect(manager.getAnnouncement(['unknown'])).toBeUndefined();
      });
    });

    describe('removeAnnouncement', () => {
      it('removes announcement', () => {
        manager.createAnnouncement(['ns']);
        expect(manager.removeAnnouncement(['ns'])).toBe(true);
        expect(manager.getAnnouncement(['ns'])).toBeUndefined();
      });

      it('returns false for unknown', () => {
        expect(manager.removeAnnouncement(['unknown'])).toBe(false);
      });
    });
  });

  describe('Namespace Queries', () => {
    it('getTracksInNamespace returns matching tracks', () => {
      manager.createPublishedTrack({
        fullTrackName: { namespace: ['app', 'room1'], trackName: 'video' },
      });
      manager.createPublishedTrack({
        fullTrackName: { namespace: ['app', 'room1'], trackName: 'audio' },
      });
      manager.createPublishedTrack({
        fullTrackName: { namespace: ['app', 'room2'], trackName: 'video' },
      });

      const tracks = manager.getTracksInNamespace(['app', 'room1']);
      expect(tracks.length).toBe(2);
    });

    it('getSubscriptionsInNamespace returns matching subscriptions', () => {
      manager.createSubscription({
        fullTrackName: { namespace: ['app', 'room1'], trackName: 'video' },
      });
      manager.createSubscription({
        fullTrackName: { namespace: ['app', 'room1'], trackName: 'audio' },
      });
      manager.createSubscription({
        fullTrackName: { namespace: ['other'], trackName: 'track' },
      });

      const subs = manager.getSubscriptionsInNamespace(['app', 'room1']);
      expect(subs.length).toBe(2);
    });
  });

  describe('clear', () => {
    it('clears all data', () => {
      manager.createPublishedTrack({
        fullTrackName: { namespace: ['ns'], trackName: 'track1' },
      });
      manager.createSubscription({
        fullTrackName: { namespace: ['ns'], trackName: 'track2' },
      });
      manager.createAnnouncement(['ns']);

      manager.clear();

      expect(manager.getAllPublishedTracks()).toEqual([]);
      expect(manager.getAllSubscriptions()).toEqual([]);
      expect(manager.getAnnouncement(['ns'])).toBeUndefined();
    });

    it('resets ID counters', () => {
      manager.createPublishedTrack({
        fullTrackName: { namespace: ['ns'], trackName: 'track' },
      });
      manager.createSubscription({
        fullTrackName: { namespace: ['ns'], trackName: 'sub' },
      });

      manager.clear();

      const newTrack = manager.createPublishedTrack({
        fullTrackName: { namespace: ['ns'], trackName: 'new' },
      });
      const newSub = manager.createSubscription({
        fullTrackName: { namespace: ['ns'], trackName: 'newsub' },
      });

      expect(newTrack.trackAlias).toBe(1);
      expect(newSub.subscribeId).toBe(1);
    });
  });

  describe('getStats', () => {
    it('returns accurate statistics', () => {
      manager.createPublishedTrack({
        fullTrackName: { namespace: ['ns'], trackName: 'track1' },
      });
      manager.createPublishedTrack({
        fullTrackName: { namespace: ['ns'], trackName: 'track2' },
      });

      manager.recordPublishedObject('ns:track1', true);
      manager.recordPublishedObject('ns:track1', false);
      manager.recordPublishedObject('ns:track2', true);

      const sub = manager.createSubscription({
        fullTrackName: { namespace: ['ns'], trackName: 'sub1' },
      });
      manager.setSubscriptionActive(sub.subscribeId, 100, GroupOrder.ASCENDING);

      manager.recordReceivedObject(sub.subscribeId, 1, 1);
      manager.recordReceivedObject(sub.subscribeId, 1, 2);

      manager.createAnnouncement(['ns']);

      const stats = manager.getStats();

      expect(stats.publishedCount).toBe(2);
      expect(stats.subscribedCount).toBe(1);
      expect(stats.activeSubscriptions).toBe(1);
      expect(stats.announcementCount).toBe(1);
      expect(stats.totalPublishedObjects).toBe(3);
      expect(stats.totalReceivedObjects).toBe(2);
    });
  });

  describe('Event Handling', () => {
    it('allows unsubscribing from events', () => {
      const handler = vi.fn();
      const unsubscribe = manager.on(handler);

      manager.createPublishedTrack({
        fullTrackName: { namespace: ['ns'], trackName: 'track1' },
      });

      expect(handler).toHaveBeenCalledTimes(1);

      unsubscribe();

      manager.createPublishedTrack({
        fullTrackName: { namespace: ['ns'], trackName: 'track2' },
      });

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('handles exceptions in event handlers', () => {
      const badHandler = vi.fn(() => {
        throw new Error('Handler error');
      });
      const goodHandler = vi.fn();

      manager.on(badHandler);
      manager.on(goodHandler);

      // Should not throw
      manager.createPublishedTrack({
        fullTrackName: { namespace: ['ns'], trackName: 'track' },
      });

      expect(badHandler).toHaveBeenCalled();
      expect(goodHandler).toHaveBeenCalled();
    });
  });
});
