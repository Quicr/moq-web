// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Publication Manager
 *
 * Manages publications and their associated state for MOQT sessions.
 */

import { Logger, GroupOrder } from '@moq-web/core';
import type { PublicationInfo } from './types.js';

const log = Logger.create('moqt:session:publication-manager');

/**
 * Internal publication state (extends public info)
 */
export interface InternalPublication extends PublicationInfo {
  /** 62-bit varint request ID used for PUBLISH message */
  requestId: bigint;
  /** Cleanup handlers for event subscriptions */
  cleanupHandlers: Array<() => void>;
  /** Current forward state (0 = paused/no subscribers, 1 = active/can send) */
  forward: number;
  /**
   * Draft-18 §10.14 largest (group, object) tuple this publisher has produced
   * on this track. Updated on every `sendObject()`. `undefined` until the
   * first object is sent.
   */
  latestGroup?: bigint;
  latestObject?: bigint;
  /**
   * Draft-18 §7 / §10.2 subscriber-side scheduling hints, cached from the
   * SUBSCRIBE parameters (SUBSCRIBER_PRIORITY, GROUP_ORDER) and updated by
   * REQUEST_UPDATE (§10.9.1). Used to derive WebTransport `sendOrder` for
   * outgoing subgroup streams. Missing values fall back to (128, ASCENDING).
   */
  subscriberPriority?: number;
  subscriberGroupOrder?: GroupOrder;
}

/**
 * Pending PUBLISH_OK callback
 */
export interface PendingPublishOk {
  resolve: (result: { forward: number; trackAlias?: bigint }) => void;
  reject: (err: Error) => void;
}

/**
 * Pending forward callback (waiting for SUBSCRIBE_UPDATE)
 */
export interface PendingForward {
  resolve: (trackAlias?: bigint) => void;
  reject: (err: Error) => void;
}

/**
 * Forward state change listener
 */
export type ForwardStateChangeListener = (trackAlias: bigint, forward: number) => void;

/**
 * Manages publications and pending publish operations
 */
export class PublicationManager {
  /** Active publications by track alias (as string for bigint compatibility) */
  private publications = new Map<string, InternalPublication>();
  /** Publications by request ID (keyed as string to accommodate bigint varints). */
  private publicationsByRequestId = new Map<string, InternalPublication>();
  /** Pending PUBLISH_OK callbacks (keyed as string, requestId is 62-bit varint). */
  private pendingPublishOk = new Map<string, PendingPublishOk>();
  /** Pending forward callbacks (keyed as string, requestId is 62-bit varint). */
  private pendingForward = new Map<string, PendingForward>();
  /** Forward state change listeners */
  private forwardStateListeners = new Set<ForwardStateChangeListener>();

  /**
   * Add a new publication
   */
  add(publication: InternalPublication): void {
    const key = publication.trackAlias.toString();
    this.publications.set(key, publication);
    this.publicationsByRequestId.set(publication.requestId.toString(), publication);

    log.debug('Added publication', {
      trackAlias: key,
      requestId: publication.requestId.toString(),
      namespace: publication.namespace.join('/'),
      trackName: publication.trackName,
    });
  }

  /**
   * Get publication by track alias
   */
  get(trackAlias: bigint | string): InternalPublication | undefined {
    return this.publications.get(trackAlias.toString());
  }

  /**
   * Get publication by request ID (accepts bigint or number).
   */
  getByRequestId(requestId: bigint | number): InternalPublication | undefined {
    return this.publicationsByRequestId.get(requestId.toString());
  }

  /**
   * Remove a publication
   */
  remove(trackAlias: bigint | string): InternalPublication | undefined {
    const key = trackAlias.toString();
    const pub = this.publications.get(key);
    if (!pub) {
      return undefined;
    }

    this.publications.delete(key);
    this.publicationsByRequestId.delete(pub.requestId.toString());

    // Run cleanup handlers
    for (const cleanup of pub.cleanupHandlers) {
      cleanup();
    }

    log.debug('Removed publication', { trackAlias: key });
    return pub;
  }

  /**
   * Get all publications
   */
  getAll(): InternalPublication[] {
    return Array.from(this.publications.values());
  }

  /**
   * Look up a publication by (namespace, trackName). Used by the draft-18
   * §10.14 TRACK_STATUS handler to answer status queries against tracks this
   * session publishes.
   */
  getByTrackName(namespace: string[], trackName: string): InternalPublication | undefined {
    const nsKey = namespace.join('/');
    for (const pub of this.publications.values()) {
      if (pub.trackName === trackName && pub.namespace.join('/') === nsKey) {
        return pub;
      }
    }
    return undefined;
  }

  /**
   * Record the latest (group, object) tuple sent for a publication. The
   * TRACK_STATUS handler uses this to fill LARGEST_OBJECT (§10.2.9).
   */
  updateLatest(trackAlias: bigint | string, group: bigint, object: bigint): void {
    const pub = this.publications.get(trackAlias.toString());
    if (!pub) return;
    if (pub.latestGroup === undefined ||
        group > pub.latestGroup ||
        (group === pub.latestGroup && (pub.latestObject === undefined || object > pub.latestObject))) {
      pub.latestGroup = group;
      pub.latestObject = object;
    }
  }

  /**
   * Get count of active publications
   */
  get size(): number {
    return this.publications.size;
  }

  /**
   * Clear all publications
   */
  clear(): void {
    // Run all cleanup handlers
    for (const pub of this.publications.values()) {
      for (const cleanup of pub.cleanupHandlers) {
        cleanup();
      }
    }
    this.publications.clear();
    this.publicationsByRequestId.clear();
  }

  /**
   * Wait for PUBLISH_OK message
   */
  waitForPublishOk(requestId: bigint | number, timeout = 10000): Promise<{ forward: number; trackAlias?: bigint }> {
    const key = requestId.toString();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingPublishOk.delete(key);
        reject(new Error('Timeout waiting for PUBLISH_OK'));
      }, timeout);

      this.pendingPublishOk.set(key, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });
  }

  /**
   * Resolve pending PUBLISH_OK
   */
  resolvePublishOk(requestId: bigint | number, result: { forward: number; trackAlias?: bigint }): boolean {
    const key = requestId.toString();
    const pending = this.pendingPublishOk.get(key);
    if (pending) {
      this.pendingPublishOk.delete(key);
      pending.resolve(result);
      return true;
    }
    return false;
  }

  /**
   * Reject pending PUBLISH_OK
   */
  rejectPublishOk(requestId: bigint | number, error: Error): boolean {
    const key = requestId.toString();
    const pending = this.pendingPublishOk.get(key);
    if (pending) {
      this.pendingPublishOk.delete(key);
      pending.reject(error);
      return true;
    }
    return false;
  }

  /**
   * Wait for forward=1 (SUBSCRIBE_UPDATE)
   */
  waitForForward(requestId: bigint | number, timeout = 30000): Promise<void> {
    const key = requestId.toString();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingForward.delete(key);
        reject(new Error('Timeout waiting for SUBSCRIBE_UPDATE with forward=1'));
      }, timeout);

      this.pendingForward.set(key, {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });
  }

  /**
   * Resolve all pending forward callbacks and update forward state
   */
  resolveAllForward(): void {
    for (const [, pending] of this.pendingForward) {
      pending.resolve();
    }
    this.pendingForward.clear();

    // Update forward state for all publications and notify listeners
    for (const [key, pub] of this.publications) {
      if (pub.forward !== 1) {
        pub.forward = 1;
        this.notifyForwardStateChange(BigInt(key), 1);
      }
    }
  }

  /**
   * Set forward state for all publications (e.g., when forward=0 received)
   */
  setAllForward(forward: number): void {
    for (const [key, pub] of this.publications) {
      if (pub.forward !== forward) {
        pub.forward = forward;
        this.notifyForwardStateChange(BigInt(key), forward);
      }
    }
  }

  /**
   * Get forward state for a publication
   */
  getForward(trackAlias: bigint | string): number {
    const pub = this.publications.get(trackAlias.toString());
    return pub?.forward ?? 0;
  }

  /**
   * Add forward state change listener
   */
  onForwardStateChange(listener: ForwardStateChangeListener): () => void {
    this.forwardStateListeners.add(listener);
    return () => this.forwardStateListeners.delete(listener);
  }

  /**
   * Notify all listeners of forward state change
   */
  private notifyForwardStateChange(trackAlias: bigint, forward: number): void {
    log.info('Forward state changed', { trackAlias: trackAlias.toString(), forward });
    for (const listener of this.forwardStateListeners) {
      try {
        listener(trackAlias, forward);
      } catch (err) {
        log.error('Forward state listener error', { error: err });
      }
    }
  }

  /**
   * Get count of pending forward callbacks
   */
  get pendingForwardCount(): number {
    return this.pendingForward.size;
  }

  /**
   * Iterate over all publications
   */
  [Symbol.iterator](): Iterator<[string, InternalPublication]> {
    return this.publications[Symbol.iterator]();
  }
}
