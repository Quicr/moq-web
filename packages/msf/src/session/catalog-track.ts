// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Catalog track subscription and publication
 *
 * Provides high-level APIs for subscribing to and publishing MSF catalogs.
 */

import type { MOQTSession } from '@web-moq/session';
import { CATALOG_TRACK_NAME } from '../version.js';
import { parseCatalogFromBytes, serializeCatalogToBytes } from '../catalog/index.js';
import { applyDelta } from '../catalog/delta.js';
import { isDeltaCatalog, isFullCatalog, type Catalog, type FullCatalog } from '../schemas/index.js';
import {
  EpochGroupNumbering,
  SequentialGroupNumbering,
  createGroupNumbering,
  type GroupNumberingStrategy,
} from './group-numbering.js';

/**
 * Error thrown when catalog operations fail
 */
export class CatalogTrackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogTrackError';
  }
}

/**
 * Callback for receiving catalog updates
 */
export type CatalogCallback = (catalog: FullCatalog, isIndependent: boolean) => void;

/**
 * Options for catalog subscription
 */
export interface CatalogSubscribeOptions {
  /** Callback for catalog updates */
  onCatalog: CatalogCallback;
  /** Callback for errors */
  onError?: (error: Error) => void;
}

/**
 * Options for catalog publication
 */
export interface CatalogPublishOptions {
  /** Group numbering strategy */
  groupNumbering?: GroupNumberingStrategy;
  /** Republish interval in ms (0 = disabled). Republishes catalog periodically with new groupId */
  republishIntervalMs?: number;
}

/**
 * Catalog subscriber
 *
 * Subscribes to a catalog track and maintains the current catalog state
 * by applying delta updates as they arrive.
 */
export class CatalogSubscriber {
  private session: MOQTSession;
  private namespace: string[];
  private subscriptionId: number | null = null;
  private currentCatalog: FullCatalog | null = null;
  private callback: CatalogCallback;
  private errorCallback?: (error: Error) => void;
  private subscribeOkCleanup?: () => void;

  constructor(
    session: MOQTSession,
    namespace: string[],
    options: CatalogSubscribeOptions
  ) {
    this.session = session;
    this.namespace = namespace;
    this.callback = options.onCatalog;
    this.errorCallback = options.onError;
  }

  /**
   * Start subscribing to the catalog
   *
   * Uses SUBSCRIBE to establish the subscription, then FETCHes from
   * largestGroupId to retrieve the current catalog (for late subscribers).
   */
  async subscribe(): Promise<void> {
    if (this.subscriptionId !== null) {
      throw new CatalogTrackError('Already subscribed');
    }

    // Set up listener for SUBSCRIBE_OK to get largestGroupId and FETCH
    this.subscribeOkCleanup = this.session.on('subscribe-ok', (event) => {
      if (event.subscriptionId === this.subscriptionId) {
        this.handleSubscribeOk(event);
      }
    });

    this.subscriptionId = await this.session.subscribe(
      this.namespace,
      CATALOG_TRACK_NAME,
      {},
      this.handleObject.bind(this)
    );
  }

  /**
   * Handle SUBSCRIBE_OK - FETCH from largestGroupId to get current catalog
   */
  private async handleSubscribeOk(event: {
    largestGroupId?: number;
    largestObjectId?: number;
  }): Promise<void> {
    // Clean up listener - we only need it once
    if (this.subscribeOkCleanup) {
      this.subscribeOkCleanup();
      this.subscribeOkCleanup = undefined;
    }

    // If largestGroupId is available, FETCH from beginning of that group
    // This ensures late subscribers get the catalog even if it was already published
    if (event.largestGroupId !== undefined) {
      try {
        await this.session.fetch(
          this.namespace,
          CATALOG_TRACK_NAME,
          {
            startGroup: event.largestGroupId,
            startObject: 0,
            endGroup: event.largestGroupId,
            endObject: event.largestObjectId ?? 0,
          },
          {},
          (data, groupId, objectId) => {
            this.handleObject(data, groupId, objectId, 0);
          }
        );
      } catch (err) {
        if (this.errorCallback) {
          this.errorCallback(
            err instanceof Error ? err : new Error(String(err))
          );
        }
      }
    }
  }

  /**
   * Stop subscribing to the catalog
   */
  async unsubscribe(): Promise<void> {
    // Clean up subscribe-ok listener if still active
    if (this.subscribeOkCleanup) {
      this.subscribeOkCleanup();
      this.subscribeOkCleanup = undefined;
    }

    if (this.subscriptionId === null) {
      return;
    }

    await this.session.unsubscribe(this.subscriptionId);
    this.subscriptionId = null;
  }

  /**
   * Get the current catalog state
   */
  getCatalog(): FullCatalog | null {
    return this.currentCatalog;
  }

  /**
   * Handle received catalog object
   */
  private handleObject(
    data: Uint8Array,
    _groupId: number,
    objectId: number,
    _timestamp: number
  ): void {
    try {
      const catalog = parseCatalogFromBytes(data);
      const isIndependent = objectId === 0;

      if (isFullCatalog(catalog)) {
        // Full catalog - replace current state
        this.currentCatalog = catalog;
        this.callback(catalog, isIndependent);
      } else if (isDeltaCatalog(catalog)) {
        // Delta update - apply to current state
        if (this.currentCatalog === null) {
          throw new CatalogTrackError(
            'Received delta before full catalog'
          );
        }
        this.currentCatalog = applyDelta(this.currentCatalog, catalog);
        this.callback(this.currentCatalog, false);
      }
    } catch (error) {
      if (this.errorCallback) {
        this.errorCallback(
          error instanceof Error ? error : new Error(String(error))
        );
      }
    }
  }
}

/**
 * Catalog publisher
 *
 * Publishes catalog updates to a catalog track, handling group
 * numbering and delta generation.
 */
export class CatalogPublisher {
  private session: MOQTSession;
  private namespace: string[];
  private trackAlias: bigint | null = null;
  private groupNumbering: EpochGroupNumbering | SequentialGroupNumbering;
  private currentCatalog: FullCatalog | null = null;
  private republishIntervalMs: number;
  private republishTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    session: MOQTSession,
    namespace: string[],
    options: CatalogPublishOptions = {}
  ) {
    this.session = session;
    this.namespace = namespace;
    this.groupNumbering = createGroupNumbering(
      options.groupNumbering ?? 'epoch'
    );
    this.republishIntervalMs = options.republishIntervalMs ?? 0;
  }

  /**
   * Start publishing the catalog track
   */
  async start(): Promise<void> {
    if (this.trackAlias !== null) {
      throw new CatalogTrackError('Already publishing');
    }

    this.trackAlias = await this.session.publish(
      this.namespace,
      CATALOG_TRACK_NAME,
      { deliveryMode: 'stream' }
    );
  }

  /**
   * Stop publishing the catalog track
   */
  async stop(): Promise<void> {
    // Stop periodic republishing
    if (this.republishTimer) {
      clearInterval(this.republishTimer);
      this.republishTimer = null;
    }

    if (this.trackAlias === null) {
      return;
    }

    await this.session.unpublish(this.trackAlias);
    this.trackAlias = null;
  }

  /**
   * Publish a full catalog
   *
   * This starts a new group and sends the catalog as object 0.
   * If republishIntervalMs is set, starts periodic republishing.
   */
  async publishFull(catalog: FullCatalog): Promise<void> {
    if (this.trackAlias === null) {
      throw new CatalogTrackError('Not publishing');
    }

    const [groupId, objectId] = this.groupNumbering.nextFull();
    const data = serializeCatalogToBytes(catalog);

    await this.session.sendObject(this.trackAlias, data, {
      groupId,
      objectId,
      isKeyframe: true,
    });

    this.currentCatalog = catalog;

    // Start periodic republishing if configured and not already running
    if (this.republishIntervalMs > 0 && !this.republishTimer) {
      this.republishTimer = setInterval(() => {
        this.republishCatalog();
      }, this.republishIntervalMs);
    }
  }

  /**
   * Republish the current catalog with a new group ID (timestamp-based)
   */
  private async republishCatalog(): Promise<void> {
    if (this.trackAlias === null || this.currentCatalog === null) {
      return;
    }

    try {
      const [groupId, objectId] = this.groupNumbering.nextFull();
      const data = serializeCatalogToBytes(this.currentCatalog);

      await this.session.sendObject(this.trackAlias, data, {
        groupId,
        objectId,
        isKeyframe: true,
      });
    } catch {
      // Ignore errors during periodic republish - session may be closing
    }
  }

  /**
   * Publish a delta update
   *
   * This sends the delta as the next object in the current group.
   */
  async publishDelta(catalog: Catalog): Promise<void> {
    if (this.trackAlias === null) {
      throw new CatalogTrackError('Not publishing');
    }

    if (this.currentCatalog === null) {
      throw new CatalogTrackError('Must publish full catalog first');
    }

    const [groupId, objectId] = this.groupNumbering.nextDelta();
    const data = serializeCatalogToBytes(catalog);

    await this.session.sendObject(this.trackAlias, data, {
      groupId,
      objectId,
      isKeyframe: false,
    });

    // If it's a delta, apply it to track current state
    if (isDeltaCatalog(catalog)) {
      this.currentCatalog = applyDelta(this.currentCatalog, catalog);
    } else {
      this.currentCatalog = catalog;
    }
  }

  /**
   * Get the current catalog state
   */
  getCatalog(): FullCatalog | null {
    return this.currentCatalog;
  }

  /**
   * Get the current group and object IDs
   */
  getCurrentIds(): [number, number] {
    return [this.groupNumbering.getGroup(), this.groupNumbering.getObject()];
  }
}

/**
 * Create a catalog subscriber
 */
export function createCatalogSubscriber(
  session: MOQTSession,
  namespace: string[],
  options: CatalogSubscribeOptions
): CatalogSubscriber {
  return new CatalogSubscriber(session, namespace, options);
}

/**
 * Create a catalog publisher
 */
export function createCatalogPublisher(
  session: MOQTSession,
  namespace: string[],
  options?: CatalogPublishOptions
): CatalogPublisher {
  return new CatalogPublisher(session, namespace, options);
}
