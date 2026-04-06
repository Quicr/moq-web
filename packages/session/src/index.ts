// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview MOQT Session Library
 *
 * Generic MOQT session management - protocol layer without media dependencies.
 * Use MOQTSession directly for non-media use cases, or use MediaSession
 * from moqt-media for media streaming.
 *
 * @packageDocumentation
 *
 * @example
 * ```typescript
 * import { MOQTSession } from '@web-moq/session';
 * import { MOQTransport } from '@web-moq/core';
 *
 * // Option 1: Main thread transport (default)
 * const transport = new MOQTransport();
 * await transport.connect('https://relay.example.com/moq');
 * const session = new MOQTSession(transport);
 *
 * // Option 2: Worker-based transport (application provides worker)
 * const worker = new Worker(
 *   new URL('@web-moq/session/worker', import.meta.url),
 *   { type: 'module' }
 * );
 * const session = new MOQTSession({ worker });
 * await session.connect('https://relay.example.com/moq');
 *
 * // Both modes support the same API
 * await session.setup();
 *
 * // Subscribe to a track
 * const subId = await session.subscribe(['conference', 'room-1'], 'video', {}, (data, groupId, objectId, timestamp) => {
 *   console.log('Received object:', { groupId, objectId, bytes: data.length });
 * });
 *
 * // Publish to a track
 * const trackAlias = await session.publish(['conference', 'room-1'], 'video');
 * await session.sendObject(trackAlias, myData, { groupId: 0, objectId: 0 });
 * ```
 */

// Main session class
export { MOQTSession } from './session.js';
export type { MOQTSessionConfig } from './session.js';

// Managers (for advanced use cases)
export { SubscriptionManager } from './subscription-manager.js';
export type { InternalSubscription } from './subscription-manager.js';

export { PublicationManager } from './publication-manager.js';
export type { InternalPublication, PendingPublishOk, PendingForward } from './publication-manager.js';

export { ObjectRouter } from './object-router.js';
export type { ObjectCallback } from './object-router.js';

// Types
export type {
  SessionState,
  SessionEventType,
  SubscribeOptions,
  PublishOptions,
  AnnounceOptions,
  ObjectMetadata,
  ReceivedObjectEvent,
  SubscriptionInfo,
  PublicationInfo,
  PublishStatsEvent,
  SubscribeStatsEvent,
  AnnouncedNamespaceInfo,
  IncomingSubscriber,
  IncomingSubscribeEvent,
  SubscribeNamespaceOptions,
  NamespaceSubscriptionInfo,
  IncomingPublishInfo,
  IncomingPublishEvent,
  // FETCH / DVR types
  FetchOptions,
  FetchRange,
  FetchInfo,
  FetchObjectEvent,
  FetchCompleteEvent,
  FetchErrorEvent,
  // VOD types
  VODMetadata,
  VODPublishOptions,
  VODTrackInfo,
  IncomingFetchEvent,
} from './types.js';

// Worker API
export { TransportWorkerClient } from './workers/index.js';
export type {
  TransportWorkerConfig,
  TransportState,
  TransportWorkerRequest,
  TransportWorkerResponse,
} from './workers/index.js';
