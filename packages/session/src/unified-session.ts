// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Unified Session API
 *
 * Provides a clean, version-agnostic session interface that wraps the
 * existing MOQTSession implementation. Application code should use this
 * interface for new development.
 */

import {
  type SubscribeRequest,
  type SubscribeResponse,
  type SubscribeUpdateOptions,
  type Subscription,
  type PublishRequest,
  type PublishResponse,
  type OutgoingObject,
  type Publication,
  type FetchRequest,
  type Fetch,
  type SubscribeNamespaceRequest,
  type AnnouncedNamespace,
  type TrackObject,
  type NamespaceSubscription,
  type PublishNamespaceRequest,
  type NamespacePublication,
  type UnifiedMOQTObject,
  type RequestError,
  type CodecCapabilities,
  type ISession,
  type SessionState,
  ApiVersion as Version,
  ApiGroupOrder as GroupOrder,
  ApiObjectStatus as ObjectStatus,
  NamespaceSubscribeMode,
  capabilities,
  currentVersion,
  GroupOrder as LegacyGroupOrder,
  MOQTransport,
} from '@web-moq/core';
import { MOQTSession } from './session.js';
import type { SubscribeOptions, PublishOptions, ObjectMetadata } from './types.js';

export type { ISession, SessionState };

type SessionErrorHandler = (error: RequestError) => void;
type SessionGoAwayHandler = (newUri?: string) => void;
type SessionCloseHandler = () => void;

/**
 * Convert unified GroupOrder to legacy
 */
function groupOrderToLegacy(order?: GroupOrder): LegacyGroupOrder | undefined {
  switch (order) {
    case GroupOrder.ASCENDING:
      return LegacyGroupOrder.ASCENDING;
    case GroupOrder.DESCENDING:
      return LegacyGroupOrder.DESCENDING;
    default:
      return undefined; // Let session use its default
  }
}

/**
 * Convert legacy GroupOrder to unified
 */
function groupOrderFromLegacy(order?: LegacyGroupOrder): GroupOrder {
  switch (order) {
    case LegacyGroupOrder.ASCENDING:
      return GroupOrder.ASCENDING;
    case LegacyGroupOrder.DESCENDING:
      return GroupOrder.DESCENDING;
    default:
      return GroupOrder.DEFAULT;
  }
}

/**
 * Unified MOQT Session
 *
 * Clean, version-agnostic session interface.
 */
export class UnifiedSession implements ISession {
  private session: MOQTSession;
  private errorHandlers: Set<SessionErrorHandler> = new Set();
  private goAwayHandlers: Set<SessionGoAwayHandler> = new Set();
  private closeHandlers: Set<SessionCloseHandler> = new Set();
  private objectQueues: Map<number, UnifiedMOQTObject[]> = new Map();
  private objectResolvers: Map<number, ((obj: UnifiedMOQTObject) => void) | null> = new Map();

  constructor(session: MOQTSession) {
    this.session = session;
  }

  /**
   * Create and connect a new unified session
   */
  static async connect(url: string): Promise<UnifiedSession> {
    const transport = new MOQTransport();
    await transport.connect(url);

    const session = new MOQTSession(transport);
    await session.setup();

    return new UnifiedSession(session);
  }

  /**
   * Create unified session from existing MOQTSession
   */
  static fromLegacy(session: MOQTSession): UnifiedSession {
    return new UnifiedSession(session);
  }

  get state(): SessionState {
    const legacyState = this.session.state;
    switch (legacyState) {
      case 'none':
      case 'setup':
        return 'connecting';
      case 'ready':
        return 'connected';
      case 'error':
        return 'closed';
      default:
        return 'closed';
    }
  }

  get version(): Version {
    return currentVersion;
  }

  get capabilities(): CodecCapabilities {
    return capabilities;
  }

  // =========================================================================
  // Subscribe
  // =========================================================================

  async subscribe(request: SubscribeRequest): Promise<Subscription> {
    const options: SubscribeOptions = {
      priority: request.subscriberPriority,
      groupOrder: groupOrderToLegacy(request.groupOrder),
    };

    // Set up object callback to capture received objects
    const subscriptionId = await new Promise<number>((resolve) => {
      let resolved = false;
      const onObject = (
        data: Uint8Array,
        groupId: number,
        objectId: number,
        _timestamp: number
      ) => {
        if (!resolved) return;

        const obj: UnifiedMOQTObject = {
          trackAlias: 0n,
          groupId: BigInt(groupId),
          subgroupId: 0n,
          objectId: BigInt(objectId),
          publisherPriority: 128,
          status: ObjectStatus.NORMAL,
          payload: data,
        };

        const queue = this.objectQueues.get(subscriptionId);
        const resolver = this.objectResolvers.get(subscriptionId);

        if (resolver) {
          resolver(obj);
          this.objectResolvers.set(subscriptionId, null);
        } else if (queue) {
          queue.push(obj);
        }
      };

      this.session
        .subscribe(request.trackNamespace, request.trackName, options, onObject)
        .then((id) => {
          resolved = true;
          resolve(id);
        });
    });

    // Initialize object queue for this subscription
    this.objectQueues.set(subscriptionId, []);
    this.objectResolvers.set(subscriptionId, null);

    const response: SubscribeResponse = {
      requestId: BigInt(subscriptionId),
      contentExists: false, // Not available from legacy API
      groupOrder: groupOrderFromLegacy(groupOrderToLegacy(request.groupOrder)),
    };

    return this.createSubscriptionHandle(subscriptionId, request, response);
  }

  private createSubscriptionHandle(
    subscriptionId: number,
    request: SubscribeRequest,
    response: SubscribeResponse
  ): Subscription {
    const self = this;

    return {
      requestId: response.requestId,
      track: {
        namespace: request.trackNamespace,
        name: request.trackName,
      },
      response,

      async update(_options: SubscribeUpdateOptions): Promise<void> {
        // Legacy session doesn't support subscription updates
        console.warn('Subscription update not supported in legacy session');
      },

      async unsubscribe(): Promise<void> {
        await self.session.unsubscribe(subscriptionId);
        self.objectQueues.delete(subscriptionId);
        self.objectResolvers.delete(subscriptionId);
      },

      get objects(): AsyncIterable<UnifiedMOQTObject> {
        return self.createObjectIterable(subscriptionId);
      },
    };
  }

  private createObjectIterable(subscriptionId: number): AsyncIterable<UnifiedMOQTObject> {
    const queues = this.objectQueues;
    const resolvers = this.objectResolvers;

    return {
      [Symbol.asyncIterator](): AsyncIterator<UnifiedMOQTObject> {
        return {
          async next(): Promise<IteratorResult<UnifiedMOQTObject>> {
            const queue = queues.get(subscriptionId);
            if (!queue) {
              return { value: undefined, done: true };
            }

            if (queue.length > 0) {
              return { value: queue.shift()!, done: false };
            }

            return new Promise((resolve) => {
              resolvers.set(subscriptionId, (obj) => {
                resolve({ value: obj, done: false });
              });
            });
          },

          async return(): Promise<IteratorResult<UnifiedMOQTObject>> {
            queues.delete(subscriptionId);
            resolvers.delete(subscriptionId);
            return { value: undefined, done: true };
          },
        };
      },
    };
  }

  // =========================================================================
  // Publish
  // =========================================================================

  async publish(request: PublishRequest): Promise<Publication> {
    const options: PublishOptions = {
      groupOrder: groupOrderToLegacy(request.groupOrder),
    };

    const trackAlias = await this.session.publish(
      request.trackNamespace,
      request.trackName,
      options
    );

    const response: PublishResponse = {
      requestId: trackAlias,
      trackAlias,
    };

    return this.createPublicationHandle(trackAlias, request, response);
  }

  private createPublicationHandle(
    trackAlias: bigint,
    request: PublishRequest,
    response: PublishResponse
  ): Publication {
    const self = this;

    return {
      requestId: response.requestId,
      trackAlias: response.trackAlias,
      track: {
        namespace: request.trackNamespace,
        name: request.trackName,
      },
      response,

      async sendObject(object: OutgoingObject): Promise<void> {
        const metadata: ObjectMetadata = {
          groupId: Number(object.groupId),
          objectId: Number(object.objectId),
        };

        await self.session.sendObject(trackAlias, object.payload, metadata);
      },

      async done(_reason?: string): Promise<void> {
        await self.session.unpublish(trackAlias);
      },
    };
  }

  // =========================================================================
  // Fetch
  // =========================================================================

  async fetch(_request: FetchRequest): Promise<Fetch> {
    throw new Error('Fetch not implemented in current session');
  }

  // =========================================================================
  // Namespace Operations
  // =========================================================================

  async subscribeNamespace(request: SubscribeNamespaceRequest): Promise<NamespaceSubscription> {
    const mode = request.mode ?? NamespaceSubscribeMode.DISCOVER;

    const subscriptionId = await this.session.subscribeNamespace(
      request.trackNamespacePrefix,
      {}
    );

    return this.createNamespaceSubscriptionHandle(subscriptionId, request, mode);
  }

  private createNamespaceSubscriptionHandle(
    subscriptionId: number,
    request: SubscribeNamespaceRequest,
    mode: NamespaceSubscribeMode
  ): NamespaceSubscription {
    const self = this;

    return {
      requestId: BigInt(subscriptionId),
      prefix: request.trackNamespacePrefix,
      mode,

      async unsubscribe(): Promise<void> {
        await self.session.unsubscribeNamespace(subscriptionId);
      },

      get namespaces(): AsyncIterable<AnnouncedNamespace> {
        // Namespace announcements would need event-based iteration
        // This is a placeholder that yields nothing
        return {
          [Symbol.asyncIterator](): AsyncIterator<AnnouncedNamespace> {
            return {
              async next(): Promise<IteratorResult<AnnouncedNamespace>> {
                return { value: undefined, done: true };
              },
            };
          },
        };
      },

      get objects(): AsyncIterable<TrackObject> | undefined {
        if (mode === NamespaceSubscribeMode.DISCOVER) {
          return undefined;
        }
        return undefined;
      },
    };
  }

  async publishNamespace(request: PublishNamespaceRequest): Promise<NamespacePublication> {
    await this.session.announceNamespace(request.trackNamespacePrefix);

    return this.createNamespacePublicationHandle(request);
  }

  private createNamespacePublicationHandle(
    request: PublishNamespaceRequest
  ): NamespacePublication {
    const self = this;

    return {
      requestId: 0n,
      prefix: request.trackNamespacePrefix,

      async announce(
        _namespace: string[],
        _properties?: Map<number, Uint8Array>
      ): Promise<void> {
        console.warn('Individual namespace announcement not supported');
      },

      async done(_finalNamespace: string[]): Promise<void> {
        await self.session.cancelAnnounce(request.trackNamespacePrefix);
      },

      async cancel(): Promise<void> {
        await self.session.cancelAnnounce(request.trackNamespacePrefix);
      },
    };
  }

  // =========================================================================
  // Session Lifecycle
  // =========================================================================

  async goAway(_newSessionUri?: string): Promise<void> {
    console.warn('goAway not implemented');
  }

  async close(): Promise<void> {
    await this.session.close();
  }

  // =========================================================================
  // Events
  // =========================================================================

  on(event: 'error', handler: SessionErrorHandler): void;
  on(event: 'goaway', handler: SessionGoAwayHandler): void;
  on(event: 'close', handler: SessionCloseHandler): void;
  on(event: string, handler: SessionErrorHandler | SessionGoAwayHandler | SessionCloseHandler): void {
    switch (event) {
      case 'error':
        this.errorHandlers.add(handler as SessionErrorHandler);
        break;
      case 'goaway':
        this.goAwayHandlers.add(handler as SessionGoAwayHandler);
        break;
      case 'close':
        this.closeHandlers.add(handler as SessionCloseHandler);
        break;
    }
  }

  off(event: 'error', handler: SessionErrorHandler): void;
  off(event: 'goaway', handler: SessionGoAwayHandler): void;
  off(event: 'close', handler: SessionCloseHandler): void;
  off(event: string, handler: SessionErrorHandler | SessionGoAwayHandler | SessionCloseHandler): void {
    switch (event) {
      case 'error':
        this.errorHandlers.delete(handler as SessionErrorHandler);
        break;
      case 'goaway':
        this.goAwayHandlers.delete(handler as SessionGoAwayHandler);
        break;
      case 'close':
        this.closeHandlers.delete(handler as SessionCloseHandler);
        break;
    }
  }
}
