// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview MOQT Track Management
 *
 * Provides track naming, alias management, and pub/sub coordination.
 * Handles the mapping between track names and aliases, and manages
 * the lifecycle of published and subscribed tracks.
 *
 * @example
 * ```typescript
 * import { TrackManager } from 'moqt-core';
 *
 * const manager = new TrackManager();
 *
 * // Publishing
 * const pubTrack = manager.createPublishedTrack({
 *   namespace: ['conference', 'room1', 'media'],
 *   trackName: 'user123/video',
 * });
 *
 * // Subscribing
 * const subTrack = manager.createSubscription({
 *   namespace: ['conference', 'room1', 'media'],
 *   trackName: 'user456/video',
 * });
 * ```
 */

import { Logger } from '../utils/logger.js';
import {
  FullTrackName,
  TrackNamespace,
  GroupOrder,
  FilterType,
  DeliveryMode,
} from '../messages/types.js';
import {
  SubscriptionStateMachine,
  AnnouncementStateMachine,
} from '../connection/state-machine.js';

const log = Logger.create('moqt:core:track');

/**
 * Convert a full track name to a string key for Map storage
 *
 * @param fullTrackName - The track name to convert
 * @returns String representation suitable for use as a Map key
 */
export function trackNameToKey(fullTrackName: FullTrackName): string {
  return `${fullTrackName.namespace.join('/')}:${fullTrackName.trackName}`;
}

/**
 * Convert a namespace to a string key for Map storage
 *
 * @param namespace - The namespace to convert
 * @returns String representation suitable for use as a Map key
 */
export function namespaceToKey(namespace: TrackNamespace): string {
  return namespace.join('/');
}

/**
 * Parse a track name key back to a FullTrackName
 *
 * @param key - The string key to parse
 * @returns Parsed FullTrackName
 */
export function keyToTrackName(key: string): FullTrackName {
  const colonIndex = key.lastIndexOf(':');
  if (colonIndex === -1) {
    throw new Error(`Invalid track name key: ${key}`);
  }
  return {
    namespace: key.slice(0, colonIndex).split('/'),
    trackName: key.slice(colonIndex + 1),
  };
}

/**
 * Check if a namespace matches a prefix
 *
 * @param namespace - Full namespace to check
 * @param prefix - Prefix to match against
 * @returns True if the namespace starts with the prefix
 */
export function namespaceMatchesPrefix(
  namespace: TrackNamespace,
  prefix: TrackNamespace
): boolean {
  if (prefix.length > namespace.length) {
    return false;
  }
  for (let i = 0; i < prefix.length; i++) {
    if (namespace[i] !== prefix[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Configuration for a published track
 */
export interface PublishedTrackConfig {
  /** Full track name */
  fullTrackName: FullTrackName;
  /** Delivery mode (stream or datagram) */
  deliveryMode?: DeliveryMode;
  /** Publisher priority (0-255) */
  priority?: number;
  /** Whether to announce the track namespace */
  announce?: boolean;
}

/**
 * Configuration for a track subscription
 */
export interface SubscriptionConfig {
  /** Full track name to subscribe to */
  fullTrackName: FullTrackName;
  /** Subscriber priority (0-255) */
  priority?: number;
  /** Group ordering preference */
  groupOrder?: GroupOrder;
  /** Filter type for object selection */
  filterType?: FilterType;
  /** Start group for ABSOLUTE_START/ABSOLUTE_RANGE */
  startGroup?: number;
  /** Start object for ABSOLUTE_START/ABSOLUTE_RANGE */
  startObject?: number;
  /** End group for ABSOLUTE_RANGE */
  endGroup?: number;
  /** End object for ABSOLUTE_RANGE */
  endObject?: number;
}

/**
 * A published track's runtime state
 */
export interface PublishedTrack {
  /** Unique track key */
  key: string;
  /** Full track name */
  fullTrackName: FullTrackName;
  /** Track alias (assigned by publisher) */
  trackAlias: number;
  /** Delivery mode */
  deliveryMode: DeliveryMode;
  /** Publisher priority */
  priority: number;
  /** Current group ID */
  currentGroupId: number;
  /** Current object ID within group */
  currentObjectId: number;
  /** Total objects published */
  totalObjects: number;
  /** Announcement state machine */
  announcement?: AnnouncementStateMachine;
  /** Active subscriber IDs */
  subscribers: Set<number>;
  /** Track creation timestamp */
  createdAt: number;
}

/**
 * A subscribed track's runtime state
 */
export interface SubscribedTrack {
  /** Unique track key */
  key: string;
  /** Full track name */
  fullTrackName: FullTrackName;
  /** Subscribe ID (unique per subscriber) */
  subscribeId: number;
  /** Track alias (assigned by publisher) */
  trackAlias?: number;
  /** Subscription configuration */
  config: SubscriptionConfig;
  /** Subscription state machine */
  state: SubscriptionStateMachine;
  /** Last received group ID */
  lastGroupId: number;
  /** Last received object ID */
  lastObjectId: number;
  /** Total objects received */
  totalObjects: number;
  /** Subscription creation timestamp */
  createdAt: number;
}

/**
 * Event types emitted by TrackManager
 */
export type TrackManagerEvent =
  | { type: 'track-published'; track: PublishedTrack }
  | { type: 'track-unpublished'; track: PublishedTrack }
  | { type: 'subscription-created'; track: SubscribedTrack }
  | { type: 'subscription-active'; track: SubscribedTrack }
  | { type: 'subscription-ended'; track: SubscribedTrack; reason?: string }
  | { type: 'subscription-error'; track: SubscribedTrack; error: string }
  | { type: 'announcement-active'; namespace: TrackNamespace }
  | { type: 'announcement-error'; namespace: TrackNamespace; error: string }
  | { type: 'subscriber-added'; track: PublishedTrack; subscribeId: number }
  | { type: 'subscriber-removed'; track: PublishedTrack; subscribeId: number };

/**
 * Event handler type
 */
export type TrackManagerEventHandler = (event: TrackManagerEvent) => void;

/**
 * MOQT Track Manager
 *
 * @remarks
 * Manages the lifecycle and state of published and subscribed tracks.
 * Provides alias management, namespace handling, and coordinates
 * between publishers and subscribers.
 *
 * @example
 * ```typescript
 * const manager = new TrackManager();
 *
 * // Listen for events
 * manager.on((event) => {
 *   switch (event.type) {
 *     case 'subscription-active':
 *       console.log('Subscription active:', event.track.fullTrackName);
 *       break;
 *     case 'track-published':
 *       console.log('Publishing:', event.track.fullTrackName);
 *       break;
 *   }
 * });
 *
 * // Create a published track
 * const track = manager.createPublishedTrack({
 *   fullTrackName: {
 *     namespace: ['conference', 'room1', 'media'],
 *     trackName: 'user123/video',
 *   },
 *   deliveryMode: DeliveryMode.STREAM,
 *   priority: Priority.HIGH,
 * });
 *
 * // Record published objects
 * manager.recordPublishedObject(track.key, true);  // keyframe
 * manager.recordPublishedObject(track.key, false); // delta frame
 * ```
 */
export class TrackManager {
  /** Published tracks by key */
  private publishedTracks = new Map<string, PublishedTrack>();
  /** Published tracks by alias */
  private publishedTracksByAlias = new Map<number, PublishedTrack>();
  /** Subscribed tracks by key */
  private subscribedTracks = new Map<string, SubscribedTrack>();
  /** Subscribed tracks by subscribe ID */
  private subscribedTracksBySubscribeId = new Map<number, SubscribedTrack>();
  /** Subscribed tracks by track alias */
  private subscribedTracksByAlias = new Map<number, SubscribedTrack>();
  /** Announcements by namespace key */
  private announcements = new Map<string, AnnouncementStateMachine>();
  /** Event handlers */
  private handlers: TrackManagerEventHandler[] = [];
  /** Next subscribe ID */
  private nextSubscribeId = 1;
  /** Next track alias for publishing */
  private nextTrackAlias = 1;

  /**
   * Create a new TrackManager
   */
  constructor() {
    log.debug('TrackManager created');
  }

  /**
   * Register an event handler
   *
   * @param handler - Function to call on events
   * @returns Unsubscribe function
   */
  on(handler: TrackManagerEventHandler): () => void {
    this.handlers.push(handler);
    return () => {
      const index = this.handlers.indexOf(handler);
      if (index >= 0) {
        this.handlers.splice(index, 1);
      }
    };
  }

  /**
   * Emit an event to all handlers
   */
  private emit(event: TrackManagerEvent): void {
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch (err) {
        log.error('Event handler error', err as Error);
      }
    }
  }

  // ============================================================================
  // Publishing
  // ============================================================================

  /**
   * Create a new published track
   *
   * @param config - Track configuration
   * @returns The created track
   */
  createPublishedTrack(config: PublishedTrackConfig): PublishedTrack {
    const key = trackNameToKey(config.fullTrackName);

    if (this.publishedTracks.has(key)) {
      throw new Error(`Track already exists: ${key}`);
    }

    const trackAlias = this.nextTrackAlias++;

    const track: PublishedTrack = {
      key,
      fullTrackName: config.fullTrackName,
      trackAlias,
      deliveryMode: config.deliveryMode ?? DeliveryMode.STREAM,
      priority: config.priority ?? 128,
      currentGroupId: 0,
      currentObjectId: 0,
      totalObjects: 0,
      subscribers: new Set(),
      createdAt: Date.now(),
    };

    this.publishedTracks.set(key, track);
    this.publishedTracksByAlias.set(trackAlias, track);

    log.info('Created published track', {
      key,
      alias: trackAlias,
      mode: track.deliveryMode,
    });

    this.emit({ type: 'track-published', track });

    return track;
  }

  /**
   * Get a published track by key
   *
   * @param key - Track key
   * @returns Track or undefined
   */
  getPublishedTrack(key: string): PublishedTrack | undefined {
    return this.publishedTracks.get(key);
  }

  /**
   * Get a published track by alias
   *
   * @param alias - Track alias
   * @returns Track or undefined
   */
  getPublishedTrackByAlias(alias: number): PublishedTrack | undefined {
    return this.publishedTracksByAlias.get(alias);
  }

  /**
   * Get all published tracks
   *
   * @returns Array of published tracks
   */
  getAllPublishedTracks(): PublishedTrack[] {
    return Array.from(this.publishedTracks.values());
  }

  /**
   * Remove a published track
   *
   * @param key - Track key
   * @returns True if track was removed
   */
  removePublishedTrack(key: string): boolean {
    const track = this.publishedTracks.get(key);
    if (!track) {
      return false;
    }

    this.publishedTracks.delete(key);
    this.publishedTracksByAlias.delete(track.trackAlias);

    log.info('Removed published track', { key });

    this.emit({ type: 'track-unpublished', track });

    return true;
  }

  /**
   * Record a published object (increments counters)
   *
   * @param key - Track key
   * @param isKeyframe - Whether this object starts a new group
   * @returns Current group and object IDs
   */
  recordPublishedObject(
    key: string,
    isKeyframe: boolean
  ): { groupId: number; objectId: number } {
    const track = this.publishedTracks.get(key);
    if (!track) {
      throw new Error(`Track not found: ${key}`);
    }

    if (isKeyframe) {
      track.currentGroupId++;
      track.currentObjectId = 0;
    } else {
      track.currentObjectId++;
    }
    track.totalObjects++;

    log.trace('Published object', {
      key,
      groupId: track.currentGroupId,
      objectId: track.currentObjectId,
    });

    return {
      groupId: track.currentGroupId,
      objectId: track.currentObjectId,
    };
  }

  /**
   * Add a subscriber to a published track
   *
   * @param key - Track key
   * @param subscribeId - Subscriber's subscribe ID
   */
  addSubscriber(key: string, subscribeId: number): void {
    const track = this.publishedTracks.get(key);
    if (!track) {
      throw new Error(`Track not found: ${key}`);
    }

    track.subscribers.add(subscribeId);
    log.debug('Added subscriber', { track: key, subscribeId });

    this.emit({ type: 'subscriber-added', track, subscribeId });
  }

  /**
   * Remove a subscriber from a published track
   *
   * @param key - Track key
   * @param subscribeId - Subscriber's subscribe ID
   */
  removeSubscriber(key: string, subscribeId: number): void {
    const track = this.publishedTracks.get(key);
    if (!track) {
      return;
    }

    track.subscribers.delete(subscribeId);
    log.debug('Removed subscriber', { track: key, subscribeId });

    this.emit({ type: 'subscriber-removed', track, subscribeId });
  }

  // ============================================================================
  // Subscribing
  // ============================================================================

  /**
   * Create a new track subscription
   *
   * @param config - Subscription configuration
   * @returns The created subscription
   */
  createSubscription(config: SubscriptionConfig): SubscribedTrack {
    const key = trackNameToKey(config.fullTrackName);

    if (this.subscribedTracks.has(key)) {
      throw new Error(`Already subscribed to: ${key}`);
    }

    const subscribeId = this.nextSubscribeId++;
    const state = new SubscriptionStateMachine(subscribeId);

    const track: SubscribedTrack = {
      key,
      fullTrackName: config.fullTrackName,
      subscribeId,
      config: {
        ...config,
        priority: config.priority ?? 128,
        groupOrder: config.groupOrder ?? GroupOrder.ASCENDING,
        filterType: config.filterType ?? FilterType.LATEST_GROUP,
      },
      state,
      lastGroupId: 0,
      lastObjectId: 0,
      totalObjects: 0,
      createdAt: Date.now(),
    };

    // Set up state change handlers
    state.on((newState, _oldState, reason) => {
      switch (newState) {
        case 'active':
          this.emit({ type: 'subscription-active', track });
          break;
        case 'ended':
          this.emit({ type: 'subscription-ended', track, reason });
          break;
        case 'error':
          this.emit({ type: 'subscription-error', track, error: reason ?? 'Unknown error' });
          break;
      }
    });

    this.subscribedTracks.set(key, track);
    this.subscribedTracksBySubscribeId.set(subscribeId, track);

    log.info('Created subscription', {
      key,
      subscribeId,
      filter: FilterType[config.filterType ?? FilterType.LATEST_GROUP],
    });

    this.emit({ type: 'subscription-created', track });

    return track;
  }

  /**
   * Get a subscribed track by key
   *
   * @param key - Track key
   * @returns Subscription or undefined
   */
  getSubscription(key: string): SubscribedTrack | undefined {
    return this.subscribedTracks.get(key);
  }

  /**
   * Get a subscribed track by subscribe ID
   *
   * @param subscribeId - Subscribe ID
   * @returns Subscription or undefined
   */
  getSubscriptionById(subscribeId: number): SubscribedTrack | undefined {
    return this.subscribedTracksBySubscribeId.get(subscribeId);
  }

  /**
   * Get a subscribed track by track alias
   *
   * @param trackAlias - Track alias
   * @returns Subscription or undefined
   */
  getSubscriptionByAlias(trackAlias: number): SubscribedTrack | undefined {
    return this.subscribedTracksByAlias.get(trackAlias);
  }

  /**
   * Get all subscribed tracks
   *
   * @returns Array of subscriptions
   */
  getAllSubscriptions(): SubscribedTrack[] {
    return Array.from(this.subscribedTracks.values());
  }

  /**
   * Set a subscription as active (after SUBSCRIBE_OK)
   *
   * @param subscribeId - Subscribe ID
   * @param trackAlias - Assigned track alias
   * @param groupOrder - Confirmed group order
   */
  setSubscriptionActive(
    subscribeId: number,
    trackAlias: number,
    groupOrder: GroupOrder
  ): void {
    const track = this.subscribedTracksBySubscribeId.get(subscribeId);
    if (!track) {
      log.warn('Subscription not found for activation', { subscribeId });
      return;
    }

    track.trackAlias = trackAlias;
    track.state.setActive(trackAlias, groupOrder);
    this.subscribedTracksByAlias.set(trackAlias, track);

    log.info('Subscription activated', {
      key: track.key,
      subscribeId,
      trackAlias,
    });
  }

  /**
   * Set a subscription as errored (after SUBSCRIBE_ERROR)
   *
   * @param subscribeId - Subscribe ID
   * @param errorCode - Error code
   * @param reason - Error reason
   */
  setSubscriptionError(
    subscribeId: number,
    errorCode: number,
    reason: string
  ): void {
    const track = this.subscribedTracksBySubscribeId.get(subscribeId);
    if (!track) {
      log.warn('Subscription not found for error', { subscribeId });
      return;
    }

    track.state.setError(errorCode, reason);

    log.warn('Subscription error', {
      key: track.key,
      subscribeId,
      errorCode,
      reason,
    });
  }

  /**
   * Set a subscription as ended (after SUBSCRIBE_DONE or UNSUBSCRIBE)
   *
   * @param subscribeId - Subscribe ID
   * @param reason - Optional reason
   */
  setSubscriptionEnded(subscribeId: number, reason?: string): void {
    const track = this.subscribedTracksBySubscribeId.get(subscribeId);
    if (!track) {
      return;
    }

    track.state.setEnded(reason);

    log.info('Subscription ended', {
      key: track.key,
      subscribeId,
      reason,
    });
  }

  /**
   * Remove a subscription
   *
   * @param key - Track key
   * @returns True if subscription was removed
   */
  removeSubscription(key: string): boolean {
    const track = this.subscribedTracks.get(key);
    if (!track) {
      return false;
    }

    this.subscribedTracks.delete(key);
    this.subscribedTracksBySubscribeId.delete(track.subscribeId);
    if (track.trackAlias !== undefined) {
      this.subscribedTracksByAlias.delete(track.trackAlias);
    }

    log.info('Removed subscription', { key });

    return true;
  }

  /**
   * Record a received object (updates counters)
   *
   * @param subscribeId - Subscribe ID
   * @param groupId - Received group ID
   * @param objectId - Received object ID
   */
  recordReceivedObject(
    subscribeId: number,
    groupId: number,
    objectId: number
  ): void {
    const track = this.subscribedTracksBySubscribeId.get(subscribeId);
    if (!track) {
      return;
    }

    track.lastGroupId = groupId;
    track.lastObjectId = objectId;
    track.totalObjects++;

    log.trace('Received object', {
      key: track.key,
      groupId,
      objectId,
    });
  }

  // ============================================================================
  // Announcements
  // ============================================================================

  /**
   * Create an announcement for a namespace
   *
   * @param namespace - Namespace to announce
   * @returns Announcement state machine
   */
  createAnnouncement(namespace: TrackNamespace): AnnouncementStateMachine {
    const key = namespaceToKey(namespace);

    if (this.announcements.has(key)) {
      return this.announcements.get(key)!;
    }

    const announcement = new AnnouncementStateMachine(namespace);

    announcement.on((newState, _oldState, reason) => {
      switch (newState) {
        case 'active':
          this.emit({ type: 'announcement-active', namespace });
          break;
        case 'error':
          this.emit({
            type: 'announcement-error',
            namespace,
            error: reason ?? 'Unknown error',
          });
          break;
      }
    });

    this.announcements.set(key, announcement);

    log.info('Created announcement', { namespace: key });

    return announcement;
  }

  /**
   * Get an announcement by namespace
   *
   * @param namespace - Namespace
   * @returns Announcement or undefined
   */
  getAnnouncement(namespace: TrackNamespace): AnnouncementStateMachine | undefined {
    return this.announcements.get(namespaceToKey(namespace));
  }

  /**
   * Remove an announcement
   *
   * @param namespace - Namespace
   * @returns True if announcement was removed
   */
  removeAnnouncement(namespace: TrackNamespace): boolean {
    const key = namespaceToKey(namespace);
    const removed = this.announcements.delete(key);
    if (removed) {
      log.info('Removed announcement', { namespace: key });
    }
    return removed;
  }

  // ============================================================================
  // Utilities
  // ============================================================================

  /**
   * Get tracks in a namespace
   *
   * @param namespace - Namespace prefix to match
   * @returns Array of published tracks in the namespace
   */
  getTracksInNamespace(namespace: TrackNamespace): PublishedTrack[] {
    return this.getAllPublishedTracks().filter(track =>
      namespaceMatchesPrefix(track.fullTrackName.namespace, namespace)
    );
  }

  /**
   * Get subscriptions in a namespace
   *
   * @param namespace - Namespace prefix to match
   * @returns Array of subscriptions in the namespace
   */
  getSubscriptionsInNamespace(namespace: TrackNamespace): SubscribedTrack[] {
    return this.getAllSubscriptions().filter(track =>
      namespaceMatchesPrefix(track.fullTrackName.namespace, namespace)
    );
  }

  /**
   * Clear all tracks and subscriptions
   */
  clear(): void {
    this.publishedTracks.clear();
    this.publishedTracksByAlias.clear();
    this.subscribedTracks.clear();
    this.subscribedTracksBySubscribeId.clear();
    this.subscribedTracksByAlias.clear();
    this.announcements.clear();
    this.nextSubscribeId = 1;
    this.nextTrackAlias = 1;

    log.info('TrackManager cleared');
  }

  /**
   * Get statistics about managed tracks
   *
   * @returns Track manager statistics
   */
  getStats(): {
    publishedCount: number;
    subscribedCount: number;
    activeSubscriptions: number;
    announcementCount: number;
    totalPublishedObjects: number;
    totalReceivedObjects: number;
  } {
    const published = this.getAllPublishedTracks();
    const subscribed = this.getAllSubscriptions();

    return {
      publishedCount: published.length,
      subscribedCount: subscribed.length,
      activeSubscriptions: subscribed.filter(t => t.state.isActive).length,
      announcementCount: this.announcements.size,
      totalPublishedObjects: published.reduce((sum, t) => sum + t.totalObjects, 0),
      totalReceivedObjects: subscribed.reduce((sum, t) => sum + t.totalObjects, 0),
    };
  }
}
