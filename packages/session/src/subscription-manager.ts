// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Subscription Manager
 *
 * Manages track aliases and subscription tracking for MOQT sessions.
 * Handles the mapping between different alias representations
 * (server-assigned, client-assigned, request ID) and subscriptions.
 */

import { Logger } from '@web-moq/core';
import type { SubscriptionInfo } from './types.js';

const log = Logger.create('moqt:session:subscription-manager');

/**
 * Internal subscription state (extends public info)
 */
export interface InternalSubscription extends SubscriptionInfo {
  /** Object handler callback */
  onObject?: (data: Uint8Array, groupId: number, objectId: number, timestamp: number) => void;
}

/**
 * Manages subscriptions and track alias mappings
 */
export class SubscriptionManager {
  /** Active subscriptions by subscription ID */
  private subscriptions = new Map<number, InternalSubscription>();
  /** Subscriptions by track alias (as string for bigint compatibility) */
  private subscriptionsByAlias = new Map<string, InternalSubscription>();
  /** Subscriptions by full track name */
  private subscriptionsByTrackName = new Map<string, InternalSubscription>();

  /**
   * Add a new subscription
   */
  add(subscription: InternalSubscription): void {
    this.subscriptions.set(subscription.subscriptionId, subscription);

    // Register by full track name
    const trackNameKey = this.makeTrackNameKey(subscription.namespace, subscription.trackName);
    this.subscriptionsByTrackName.set(trackNameKey, subscription);

    // Pre-register by initial track alias if provided
    if (subscription.trackAlias !== undefined) {
      const aliasKey = subscription.trackAlias.toString();
      this.safeRegisterAlias(aliasKey, subscription);
    }

    // Pre-register by request ID
    this.safeRegisterAlias(subscription.requestId.toString(), subscription);

    log.debug('Added subscription', {
      subscriptionId: subscription.subscriptionId,
      trackName: trackNameKey,
    });
  }

  /**
   * Get subscription by ID
   */
  get(subscriptionId: number): InternalSubscription | undefined {
    return this.subscriptions.get(subscriptionId);
  }

  /**
   * Get subscription by track alias
   */
  getByAlias(trackAlias: bigint | number | string): InternalSubscription | undefined {
    return this.subscriptionsByAlias.get(trackAlias.toString());
  }

  /**
   * Get subscription by track name
   */
  getByTrackName(namespace: string[], trackName: string): InternalSubscription | undefined {
    const key = this.makeTrackNameKey(namespace, trackName);
    return this.subscriptionsByTrackName.get(key);
  }

  /**
   * Find subscription by request ID
   */
  findByRequestId(requestId: number): InternalSubscription | undefined {
    for (const sub of this.subscriptions.values()) {
      if (sub.requestId === requestId) {
        return sub;
      }
    }
    return undefined;
  }

  /**
   * Update subscription with track alias from SUBSCRIBE_OK
   */
  updateTrackAlias(subscriptionId: number, serverAlias: bigint): void {
    const sub = this.subscriptions.get(subscriptionId);
    if (!sub) {
      log.warn('Cannot update track alias: subscription not found', { subscriptionId });
      return;
    }

    // Store original alias for reference
    const originalAlias = sub.trackAlias;

    // Update with server-assigned alias
    sub.trackAlias = serverAlias;

    // Server alias takes priority - always register it
    const serverAliasKey = serverAlias.toString();
    this.subscriptionsByAlias.set(serverAliasKey, sub);

    // Also keep original client alias as fallback (if no collision)
    if (originalAlias !== undefined) {
      const clientAliasKey = originalAlias.toString();
      if (clientAliasKey !== serverAliasKey) {
        this.safeRegisterAlias(clientAliasKey, sub);
      }
    }

    // Keep request ID mapping too
    const requestIdKey = sub.requestId.toString();
    if (requestIdKey !== serverAliasKey) {
      this.safeRegisterAlias(requestIdKey, sub);
    }

    log.info('Updated subscription aliases', {
      subscriptionId,
      serverAlias: serverAliasKey,
      clientAlias: originalAlias?.toString(),
      requestId: sub.requestId,
    });
  }

  /**
   * Remove a subscription
   */
  remove(subscriptionId: number): InternalSubscription | undefined {
    const sub = this.subscriptions.get(subscriptionId);
    if (!sub) {
      return undefined;
    }

    // Remove from main map
    this.subscriptions.delete(subscriptionId);

    // Remove from track name map
    const trackNameKey = this.makeTrackNameKey(sub.namespace, sub.trackName);
    this.subscriptionsByTrackName.delete(trackNameKey);

    // Remove from alias maps - need to be careful not to remove another subscription's alias
    if (sub.trackAlias !== undefined) {
      const aliasKey = sub.trackAlias.toString();
      const aliased = this.subscriptionsByAlias.get(aliasKey);
      if (aliased && aliased.subscriptionId === subscriptionId) {
        this.subscriptionsByAlias.delete(aliasKey);
      }
    }

    // Clean up request ID mapping
    const requestIdKey = sub.requestId.toString();
    const requestIdMapped = this.subscriptionsByAlias.get(requestIdKey);
    if (requestIdMapped && requestIdMapped.subscriptionId === subscriptionId) {
      this.subscriptionsByAlias.delete(requestIdKey);
    }

    log.debug('Removed subscription', { subscriptionId });
    return sub;
  }

  /**
   * Get all subscriptions
   */
  getAll(): InternalSubscription[] {
    return Array.from(this.subscriptions.values());
  }

  /**
   * Get count of active subscriptions
   */
  get size(): number {
    return this.subscriptions.size;
  }

  /**
   * Get all known alias keys (for debugging)
   */
  getKnownAliases(): string[] {
    return Array.from(this.subscriptionsByAlias.keys());
  }

  /**
   * Clear all subscriptions
   */
  clear(): void {
    this.subscriptions.clear();
    this.subscriptionsByAlias.clear();
    this.subscriptionsByTrackName.clear();
  }

  /**
   * Make a track name key from namespace and track name
   */
  private makeTrackNameKey(namespace: string[], trackName: string): string {
    return [...namespace, trackName].join('/');
  }

  /**
   * Safely register an alias without overwriting other subscriptions
   */
  private safeRegisterAlias(aliasKey: string, subscription: InternalSubscription): boolean {
    const existing = this.subscriptionsByAlias.get(aliasKey);
    if (existing && existing.subscriptionId !== subscription.subscriptionId) {
      log.warn('Alias collision detected, not overwriting', {
        aliasKey,
        existingSubscriptionId: existing.subscriptionId,
        newSubscriptionId: subscription.subscriptionId,
      });
      return false;
    }
    this.subscriptionsByAlias.set(aliasKey, subscription);
    return true;
  }
}
