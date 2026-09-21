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
  type FetchResponse,
  type SubscribeNamespaceRequest,
  type AnnouncedNamespace,
  type TrackObject,
  type NamespaceSubscription,
  type PublishNamespaceRequest,
  type NamespacePublication,
  type UnifiedMOQTObject,
  type CodecCapabilities,
  type ISession,
  type SessionState,
  type SessionErrorHandler,
  type SessionGoAwayHandler,
  type SessionCloseHandler,
  ApiVersion as Version,
  ApiGroupOrder as GroupOrder,
  ApiObjectStatus as ObjectStatus,
  NamespaceSubscribeMode,
  MoqAbortError,
  MoqSessionError,
  capabilitiesFor,
  currentVersionFor,
  GroupOrder as LegacyGroupOrder,
  MOQTransport,
  NoopMetricsSink,
  type MetricsSink,
} from '@moq-web/core';
import { MOQTSession } from './session.js';
import type {
  SubscribeOptions,
  PublishOptions,
  ObjectMetadata,
  FetchRange,
  FetchCompleteEvent,
  FetchErrorEvent,
  NamespaceAnnouncedEvent,
  NamespaceDoneEvent,
} from './types.js';

export type { ISession, SessionState };

/**
 * Maximum number of objects buffered per subscription while waiting for the
 * async iterator to be obtained (or between iterator pulls). Drop-oldest on
 * overflow to bound memory. See B7 fix.
 */
const OBJECT_BUFFER_CAP = 256;

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
 * Bounded FIFO buffer of received objects with a resolver slot for a
 * pending async iterator pull. Used both while SUBSCRIBE is in flight
 * (before the caller can obtain `.objects`) and between iterator pulls.
 */
interface ObjectBuffer {
  queue: UnifiedMOQTObject[];
  /** Set when an iterator is awaiting `next()`. */
  resolver: ((obj: IteratorResult<UnifiedMOQTObject>) => void) | null;
  /** Set once the caller signals iteration is done (unsubscribe/return). */
  closed: boolean;
}

interface NamespaceBuffer {
  queue: AnnouncedNamespace[];
  resolver: ((res: IteratorResult<AnnouncedNamespace>) => void) | null;
  closed: boolean;
}

/**
 * Race `promise` against `signal.aborted`, rejecting with `MoqAbortError`
 * if the signal fires first. Returns the promise result otherwise.
 */
function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(new MoqAbortError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(new MoqAbortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      }
    );
  });
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

  /** Per-subscription object buffers, keyed by underlying subscription id. */
  private objectBuffers: Map<number, ObjectBuffer> = new Map();
  /** Per-namespace-subscription announcement buffers. */
  private namespaceBuffers: Map<number, NamespaceBuffer> = new Map();
  /** Unsubscribers for session-level namespace event listeners. */
  private namespaceEventDisposers: Map<number, Array<() => void>> = new Map();

  /**
   * Metrics sink used at the RPC boundary. We piggy-back on the underlying
   * MOQTSession's sink when available so `session.getDiagnostics().metrics`
   * captures both transport-layer and RPC-layer activity in a single
   * snapshot. Falls back to a shared `NoopMetricsSink` when the caller
   * disabled metrics on the wrapped session.
   */
  private readonly metrics: MetricsSink;

  constructor(session: MOQTSession) {
    this.session = session;
    // Reach into the underlying session's diagnostic surface. `getDiagnostics`
    // is always callable; if the wrapped session was constructed with a
    // non-inspectable sink we fall back to Noop so wrapping doesn't throw.
    const wrappedMetrics = (session as unknown as { metrics?: MetricsSink }).metrics;
    this.metrics = wrappedMetrics ?? new NoopMetricsSink();
  }

  /**
   * Wrap a promise with `moq.session.request.duration{op}` histogram and
   * `moq.session.<op>.ok` / `.error{code}` counters at the RPC boundary.
   */
  private async instrumentRequest<T>(op: string, run: () => Promise<T>): Promise<T> {
    this.metrics.counter(`moq.session.${op}.request`, 1);
    const start =
      typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now();
    try {
      const result = await run();
      this.metrics.counter(`moq.session.${op}.ok`, 1);
      return result;
    } catch (err) {
      const code = (err as { code?: string | number })?.code;
      this.metrics.counter(`moq.session.${op}.error`, 1, {
        code: code !== undefined ? String(code) : 'unknown',
      });
      throw err;
    } finally {
      const end =
        typeof performance !== 'undefined' && typeof performance.now === 'function'
          ? performance.now()
          : Date.now();
      this.metrics.histogram('moq.session.request.duration', end - start, { op });
    }
  }

  /**
   * Create and connect a new unified session.
   *
   * @param url    - WebTransport endpoint URL
   * @param signal - Optional abort signal to cancel the connect
   */
  static async connect(url: string, signal?: AbortSignal): Promise<UnifiedSession> {
    const transport = new MOQTransport();

    await withAbort(transport.connect(url), signal);

    const session = new MOQTSession(transport);
    await withAbort(session.setup(), signal);

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
    return currentVersionFor(this.session.draft);
  }

  get capabilities(): CodecCapabilities {
    return capabilitiesFor(this.session.draft);
  }

  // =========================================================================
  // Subscribe
  // =========================================================================

  /**
   * Subscribe to a track.
   *
   * @remarks Objects received on the wire between SUBSCRIBE and SUBSCRIBE_OK
   * are buffered (up to {@link OBJECT_BUFFER_CAP} entries, drop-oldest on
   * overflow) so they can be drained through the returned iterator.
   */
  async subscribe(request: SubscribeRequest, signal?: AbortSignal): Promise<Subscription> {
    if (signal?.aborted) {
      throw new MoqAbortError();
    }
    const options: SubscribeOptions = {
      priority: request.subscriberPriority,
      groupOrder: groupOrderToLegacy(request.groupOrder),
    };

    // Allocate a fresh buffer with a placeholder id. We remap it under the
    // real subscription id as soon as we learn it (below). The onObject
    // callback closes over `bufferRef` so early-arriving objects still land
    // in the correct buffer even if they arrive before we have the id.
    const bufferRef: { buffer: ObjectBuffer } = {
      buffer: { queue: [], resolver: null, closed: false },
    };

    const onObject = (
      data: Uint8Array,
      groupId: number,
      objectId: number,
      _timestamp: number
    ) => {
      const buf = bufferRef.buffer;
      if (buf.closed) return;

      const obj: UnifiedMOQTObject = {
        trackAlias: 0n,
        groupId: BigInt(groupId),
        subgroupId: 0n,
        objectId: BigInt(objectId),
        publisherPriority: 128,
        status: ObjectStatus.NORMAL,
        payload: data,
      };

      if (buf.resolver) {
        const r = buf.resolver;
        buf.resolver = null;
        r({ value: obj, done: false });
        return;
      }

      if (buf.queue.length >= OBJECT_BUFFER_CAP) {
        // Drop-oldest to keep the buffer bounded. Use `debug` so hot paths
        // don't spam logs; callers can observe via metrics if needed.
        buf.queue.shift();
      }
      buf.queue.push(obj);
    };

    // Kick off SUBSCRIBE. The underlying session registers `onObject` on
    // the internal subscription record BEFORE the SUBSCRIBE message hits
    // the wire, so any object that arrives between SUBSCRIBE and
    // SUBSCRIBE_OK is captured by our buffer above.
    const subscribePromise = this.instrumentRequest('subscribe', () =>
      this.session.subscribe(
        request.trackNamespace,
        request.trackName,
        options,
        onObject
      ),
    );

    let subscriptionId: number;
    try {
      subscriptionId = await withAbort(subscribePromise, signal);
    } catch (err) {
      // On abort/error, best-effort mark buffer closed so any late
      // callback invocations are dropped.
      bufferRef.buffer.closed = true;
      throw err;
    }

    this.objectBuffers.set(subscriptionId, bufferRef.buffer);

    const response: SubscribeResponse = {
      requestId: BigInt(subscriptionId),
      contentExists: false, // Not surfaced by legacy API
      groupOrder: groupOrderFromLegacy(groupOrderToLegacy(request.groupOrder)),
    };

    return this.createSubscriptionHandle(subscriptionId, request, response);
  }

  private createSubscriptionHandle(
    subscriptionId: number,
    request: SubscribeRequest,
    response: SubscribeResponse
  ): Subscription {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
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
        const buf = self.objectBuffers.get(subscriptionId);
        if (buf) {
          buf.closed = true;
          if (buf.resolver) {
            const r = buf.resolver;
            buf.resolver = null;
            r({ value: undefined, done: true });
          }
        }
        await self.session.unsubscribe(subscriptionId);
        self.objectBuffers.delete(subscriptionId);
      },

      get objects(): AsyncIterable<UnifiedMOQTObject> {
        return self.createObjectIterable(subscriptionId);
      },
    };
  }

  private createObjectIterable(subscriptionId: number): AsyncIterable<UnifiedMOQTObject> {
    const buffers = this.objectBuffers;

    return {
      [Symbol.asyncIterator](): AsyncIterator<UnifiedMOQTObject> {
        return {
          async next(): Promise<IteratorResult<UnifiedMOQTObject>> {
            const buf = buffers.get(subscriptionId);
            if (!buf || buf.closed) {
              return { value: undefined, done: true };
            }

            if (buf.queue.length > 0) {
              return { value: buf.queue.shift()!, done: false };
            }

            return new Promise((resolve) => {
              buf.resolver = resolve;
            });
          },

          async return(): Promise<IteratorResult<UnifiedMOQTObject>> {
            const buf = buffers.get(subscriptionId);
            if (buf) {
              buf.closed = true;
              if (buf.resolver) {
                const r = buf.resolver;
                buf.resolver = null;
                r({ value: undefined, done: true });
              }
            }
            return { value: undefined, done: true };
          },
        };
      },
    };
  }

  // =========================================================================
  // Publish
  // =========================================================================

  async publish(request: PublishRequest, signal?: AbortSignal): Promise<Publication> {
    if (signal?.aborted) {
      throw new MoqAbortError();
    }
    const options: PublishOptions = {
      priority: request.publisherPriority,
      groupOrder: groupOrderToLegacy(request.groupOrder),
    };

    const trackAlias = await withAbort(
      this.instrumentRequest('publish', () =>
        this.session.publish(request.trackNamespace, request.trackName, options),
      ),
      signal
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
    // eslint-disable-next-line @typescript-eslint/no-this-alias
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

  /**
   * Fetch historical objects from a track.
   *
   * Delegates to {@link MOQTSession.fetch} and translates the event-based
   * completion protocol (`fetch-object` / `fetch-complete` / `fetch-error`)
   * into a promise + async-iterable pair.
   */
  async fetch(request: FetchRequest, signal?: AbortSignal): Promise<Fetch> {
    if (signal?.aborted) {
      throw new MoqAbortError();
    }

    const range: FetchRange = {
      startGroup: Number(request.startLocation.group),
      startObject: Number(request.startLocation.object),
      endGroup: Number(request.endLocation.group),
      endObject: Number(request.endLocation.object),
    };

    const buffer: ObjectBuffer = { queue: [], resolver: null, closed: false };

    const onObject = (data: Uint8Array, groupId: number, objectId: number) => {
      if (buffer.closed) return;
      const obj: UnifiedMOQTObject = {
        trackAlias: 0n,
        groupId: BigInt(groupId),
        subgroupId: 0n,
        objectId: BigInt(objectId),
        publisherPriority: 128,
        status: ObjectStatus.NORMAL,
        payload: data,
      };
      if (buffer.resolver) {
        const r = buffer.resolver;
        buffer.resolver = null;
        r({ value: obj, done: false });
      } else {
        if (buffer.queue.length >= OBJECT_BUFFER_CAP) {
          buffer.queue.shift();
        }
        buffer.queue.push(obj);
      }
    };

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;

    const requestId = await withAbort(
      this.instrumentRequest('fetch', () =>
        this.session.fetch(
          request.trackNamespace,
          request.trackName,
          range,
          {
            priority: request.subscriberPriority,
            groupOrder: groupOrderToLegacy(request.groupOrder),
          },
          onObject
        ),
      ),
      signal
    );

    // Wire completion/error into the buffer close path.
    const disposers: Array<() => void> = [];
    let responseInfo: FetchResponse = {
      requestId: BigInt(requestId),
      endOfTrack: false,
      endLocation: request.endLocation,
    };

    disposers.push(
      this.session.on('fetch-complete', (evt: FetchCompleteEvent) => {
        if (evt.requestId !== requestId) return;
        responseInfo = {
          requestId: BigInt(requestId),
          endOfTrack: !!evt.endOfTrack,
          endLocation: {
            group: BigInt(evt.largestGroupId ?? Number(request.endLocation.group)),
            object: BigInt(evt.largestObjectId ?? Number(request.endLocation.object)),
          },
        };
      })
    );

    disposers.push(
      this.session.on('fetch-stream-complete', (evt) => {
        if (evt.requestId !== requestId) return;
        closeBuffer();
      })
    );

    disposers.push(
      this.session.on('fetch-error', (evt: FetchErrorEvent) => {
        if (evt.requestId !== requestId) return;
        closeBuffer();
      })
    );

    function closeBuffer() {
      buffer.closed = true;
      if (buffer.resolver) {
        const r = buffer.resolver;
        buffer.resolver = null;
        r({ value: undefined, done: true });
      }
      for (const d of disposers) d();
      disposers.length = 0;
    }

    // If the caller aborts after fetch started, cancel the fetch.
    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          void self.session.cancelFetch(requestId).catch(() => {
            /* best-effort */
          });
          closeBuffer();
        },
        { once: true }
      );
    }

    const fetchHandle: Fetch = {
      requestId: BigInt(requestId),
      get response(): FetchResponse {
        return responseInfo;
      },
      async cancel(): Promise<void> {
        await self.session.cancelFetch(requestId);
        closeBuffer();
      },
      get objects(): AsyncIterable<UnifiedMOQTObject> {
        return {
          [Symbol.asyncIterator](): AsyncIterator<UnifiedMOQTObject> {
            return {
              async next(): Promise<IteratorResult<UnifiedMOQTObject>> {
                if (buffer.queue.length > 0) {
                  return { value: buffer.queue.shift()!, done: false };
                }
                if (buffer.closed) {
                  return { value: undefined, done: true };
                }
                return new Promise((resolve) => {
                  buffer.resolver = resolve;
                });
              },
              async return(): Promise<IteratorResult<UnifiedMOQTObject>> {
                closeBuffer();
                return { value: undefined, done: true };
              },
            };
          },
        };
      },
    };

    return fetchHandle;
  }

  // =========================================================================
  // Namespace Operations
  // =========================================================================

  async subscribeNamespace(
    request: SubscribeNamespaceRequest,
    signal?: AbortSignal
  ): Promise<NamespaceSubscription> {
    if (signal?.aborted) {
      throw new MoqAbortError();
    }
    const mode = request.mode ?? NamespaceSubscribeMode.DISCOVER;

    const subscriptionId = await withAbort(
      this.session.subscribeNamespace(request.trackNamespacePrefix, {}),
      signal
    );

    // Wire announcement events for this subscription. Buffer any announces
    // that arrive before the caller obtains `.namespaces`.
    const buffer: NamespaceBuffer = { queue: [], resolver: null, closed: false };
    this.namespaceBuffers.set(subscriptionId, buffer);

    const disposers: Array<() => void> = [];

    disposers.push(
      this.session.on('namespace-announced', (evt: NamespaceAnnouncedEvent) => {
        if (evt.namespaceSubscriptionId !== subscriptionId) return;
        const item: AnnouncedNamespace = { namespace: evt.namespace };
        if (buffer.resolver) {
          const r = buffer.resolver;
          buffer.resolver = null;
          r({ value: item, done: false });
          return;
        }
        if (buffer.queue.length >= OBJECT_BUFFER_CAP) {
          buffer.queue.shift();
        }
        buffer.queue.push(item);
      })
    );

    disposers.push(
      this.session.on('namespace-done', (_evt: NamespaceDoneEvent) => {
        // Draft-18 NAMESPACE_DONE is emitted per-namespace under the same
        // subscription; we don't close the iterable on a single DONE.
        // (Full teardown happens on unsubscribeNamespace.)
      })
    );

    this.namespaceEventDisposers.set(subscriptionId, disposers);

    return this.createNamespaceSubscriptionHandle(subscriptionId, request, mode);
  }

  private createNamespaceSubscriptionHandle(
    subscriptionId: number,
    request: SubscribeNamespaceRequest,
    mode: NamespaceSubscribeMode
  ): NamespaceSubscription {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;

    return {
      requestId: BigInt(subscriptionId),
      prefix: request.trackNamespacePrefix,
      mode,

      async unsubscribe(): Promise<void> {
        const buf = self.namespaceBuffers.get(subscriptionId);
        if (buf) {
          buf.closed = true;
          if (buf.resolver) {
            const r = buf.resolver;
            buf.resolver = null;
            r({ value: undefined, done: true });
          }
        }
        const disposers = self.namespaceEventDisposers.get(subscriptionId);
        if (disposers) {
          for (const d of disposers) d();
        }
        self.namespaceEventDisposers.delete(subscriptionId);
        self.namespaceBuffers.delete(subscriptionId);
        await self.session.unsubscribeNamespace(subscriptionId);
      },

      get namespaces(): AsyncIterable<AnnouncedNamespace> {
        return self.createNamespaceIterable(subscriptionId);
      },

      get objects(): AsyncIterable<TrackObject> | undefined {
        // Auto-subscribe track-object streams aren't wired through the
        // unified surface yet; leave undefined for all modes for now.
        return undefined;
      },
    };
  }

  private createNamespaceIterable(subscriptionId: number): AsyncIterable<AnnouncedNamespace> {
    const buffers = this.namespaceBuffers;

    return {
      [Symbol.asyncIterator](): AsyncIterator<AnnouncedNamespace> {
        return {
          async next(): Promise<IteratorResult<AnnouncedNamespace>> {
            const buf = buffers.get(subscriptionId);
            if (!buf || buf.closed) {
              return { value: undefined, done: true };
            }
            if (buf.queue.length > 0) {
              return { value: buf.queue.shift()!, done: false };
            }
            return new Promise((resolve) => {
              buf.resolver = resolve;
            });
          },
          async return(): Promise<IteratorResult<AnnouncedNamespace>> {
            const buf = buffers.get(subscriptionId);
            if (buf) {
              buf.closed = true;
              if (buf.resolver) {
                const r = buf.resolver;
                buf.resolver = null;
                r({ value: undefined, done: true });
              }
            }
            return { value: undefined, done: true };
          },
        };
      },
    };
  }

  async publishNamespace(
    request: PublishNamespaceRequest,
    signal?: AbortSignal
  ): Promise<NamespacePublication> {
    if (signal?.aborted) {
      throw new MoqAbortError();
    }
    await withAbort(this.session.announceNamespace(request.trackNamespacePrefix), signal);

    return this.createNamespacePublicationHandle(request);
  }

  private createNamespacePublicationHandle(
    request: PublishNamespaceRequest
  ): NamespacePublication {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
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

  async goAway(_newSessionUri?: string, _timeoutMs?: bigint): Promise<void> {
    throw new MoqSessionError('MOQ_UNIMPLEMENTED', 'goAway not implemented');
  }

  async close(signal?: AbortSignal): Promise<void> {
    await withAbort(this.session.close(), signal);
  }

  // =========================================================================
  // Events
  // =========================================================================

  on(event: 'error', handler: SessionErrorHandler): void;
  on(event: 'goaway', handler: SessionGoAwayHandler): void;
  on(event: 'close', handler: SessionCloseHandler): void;
  on(
    event: string,
    handler: SessionErrorHandler | SessionGoAwayHandler | SessionCloseHandler
  ): void {
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
  off(
    event: string,
    handler: SessionErrorHandler | SessionGoAwayHandler | SessionCloseHandler
  ): void {
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
