// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Publication Manager
 *
 * Manages publications and their associated state for MOQT sessions.
 */

import { Logger } from '@web-moq/core';
import type { PublicationInfo } from './types.js';

const log = Logger.create('moqt:session:publication-manager');

/**
 * Internal publication state (extends public info)
 */
export interface InternalPublication extends PublicationInfo {
  /** Request ID used for PUBLISH message */
  requestId: number;
  /** Cleanup handlers for event subscriptions */
  cleanupHandlers: Array<() => void>;
}

/**
 * Pending PUBLISH_OK callback
 */
export interface PendingPublishOk {
  resolve: (result: { forward: number; trackAlias?: number }) => void;
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
 * Manages publications and pending publish operations
 */
export class PublicationManager {
  /** Active publications by track alias (as string for bigint compatibility) */
  private publications = new Map<string, InternalPublication>();
  /** Publications by request ID */
  private publicationsByRequestId = new Map<number, InternalPublication>();
  /** Pending PUBLISH_OK callbacks */
  private pendingPublishOk = new Map<number, PendingPublishOk>();
  /** Pending forward callbacks */
  private pendingForward = new Map<number, PendingForward>();

  /**
   * Add a new publication
   */
  add(publication: InternalPublication): void {
    const key = publication.trackAlias.toString();
    this.publications.set(key, publication);
    this.publicationsByRequestId.set(publication.requestId, publication);

    log.debug('Added publication', {
      trackAlias: key,
      requestId: publication.requestId,
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
   * Get publication by request ID
   */
  getByRequestId(requestId: number): InternalPublication | undefined {
    return this.publicationsByRequestId.get(requestId);
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
    this.publicationsByRequestId.delete(pub.requestId);

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
  waitForPublishOk(requestId: number, timeout = 10000): Promise<{ forward: number; trackAlias?: number }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingPublishOk.delete(requestId);
        reject(new Error('Timeout waiting for PUBLISH_OK'));
      }, timeout);

      this.pendingPublishOk.set(requestId, {
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
  resolvePublishOk(requestId: number, result: { forward: number; trackAlias?: number }): boolean {
    const pending = this.pendingPublishOk.get(requestId);
    if (pending) {
      this.pendingPublishOk.delete(requestId);
      pending.resolve(result);
      return true;
    }
    return false;
  }

  /**
   * Reject pending PUBLISH_OK
   */
  rejectPublishOk(requestId: number, error: Error): boolean {
    const pending = this.pendingPublishOk.get(requestId);
    if (pending) {
      this.pendingPublishOk.delete(requestId);
      pending.reject(error);
      return true;
    }
    return false;
  }

  /**
   * Wait for forward=1 (SUBSCRIBE_UPDATE)
   */
  waitForForward(requestId: number, timeout = 30000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingForward.delete(requestId);
        reject(new Error('Timeout waiting for SUBSCRIBE_UPDATE with forward=1'));
      }, timeout);

      this.pendingForward.set(requestId, {
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
   * Resolve all pending forward callbacks
   */
  resolveAllForward(): void {
    for (const [, pending] of this.pendingForward) {
      pending.resolve();
    }
    this.pendingForward.clear();
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
