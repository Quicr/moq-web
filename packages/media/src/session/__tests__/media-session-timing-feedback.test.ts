// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Regression tests for the `/_timing` runaway on incoming PUBLISH.
 *
 * A subscriber echoes clock timings back to the publisher on
 * `<media>/_timing`. That echo arrives on the publisher as an
 * `incoming-publish` event; before the guard existed, MediaSession would
 * substring-match `video` in the name and spin up a decode pipeline for
 * `<media>/_timing`. That pipeline's `latency-stats` handler in turn
 * published back on `<media>/_timing/_timing`, and the loop grew a suffix
 * per hop until the frame overflowed and the stream was reset.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IncomingPublishEvent, MOQTSession } from '@moq-web/session';
import { MediaSession } from '../media-session';
import type { MediaConfig } from '../types';

type Handler = (data: unknown) => void;

/**
 * Minimal MOQTSession stand-in — MediaSession only touches the surface
 * exercised by `subscribeNamespace` + the `incoming-publish` event, so we
 * fake exactly that. `emit` lets tests drive the event bus directly.
 */
function createMockSession() {
  const handlers = new Map<string, Set<Handler>>();

  const on = (event: string, handler: Handler) => {
    if (!handlers.has(event)) handlers.set(event, new Set());
    handlers.get(event)!.add(handler);
    return () => handlers.get(event)?.delete(handler);
  };

  const emit = (event: string, data: unknown) => {
    const set = handlers.get(event);
    if (!set) return;
    for (const h of set) h(data);
  };

  const mock = {
    on: vi.fn(on),
    emit,
    state: 'ready' as const,
    isReady: true,
    setup: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    subscribeNamespace: vi.fn().mockResolvedValue(1),
    unsubscribeNamespace: vi.fn().mockResolvedValue(undefined),
    removeNamespaceSubscription: vi.fn(),
    setSubscriptionCallback: vi.fn(),
    subscribe: vi.fn().mockResolvedValue(0),
    publish: vi.fn().mockResolvedValue(0n),
    sendObject: vi.fn(),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    unpublish: vi.fn().mockResolvedValue(undefined),
  };

  return mock;
}

const BASE_CONFIG: MediaConfig = {
  videoBitrate: 2_000_000,
  audioBitrate: 128_000,
  videoResolution: '720p',
};

function makeIncomingPublish(trackName: string): IncomingPublishEvent {
  return {
    namespaceSubscriptionId: 1,
    subscriptionId: 42,
    requestId: 7,
    namespace: ['room-1'],
    trackName,
    trackAlias: 100n,
    groupOrder: 0 as never,
  };
}

describe('MediaSession — /_timing incoming publish guard', () => {
  let mockSession: ReturnType<typeof createMockSession>;
  let media: MediaSession;

  beforeEach(async () => {
    mockSession = createMockSession();
    media = new MediaSession({ session: mockSession as unknown as MOQTSession });
    // Register a namespace config so handleIncomingPublish would otherwise
    // proceed to create a pipeline.
    await media.subscribeNamespace(['room-1'], BASE_CONFIG);
  });

  afterEach(async () => {
    await media.close();
  });

  it('does not attach a pipeline for a `<media>/_timing` incoming publish', async () => {
    mockSession.emit('incoming-publish', makeIncomingPublish('video/_timing'));

    // handleIncomingPublish is async; let its microtasks settle.
    await Promise.resolve();
    await Promise.resolve();

    // The guard short-circuits before setSubscriptionCallback is wired up.
    expect(mockSession.setSubscriptionCallback).not.toHaveBeenCalled();
  });

  it('does not attach a pipeline for nested `<media>/_timing/_timing` (defence in depth)', async () => {
    // Even if a stale echo somehow makes it through, we still bail — this
    // is the pathological case that used to grow suffixes until reset.
    mockSession.emit('incoming-publish', makeIncomingPublish('video/_timing/_timing'));

    await Promise.resolve();
    await Promise.resolve();

    expect(mockSession.setSubscriptionCallback).not.toHaveBeenCalled();
  });

  it('still attaches a pipeline for a normal video track', async () => {
    // Sanity check: the guard is scoped to feedback tracks only. If this
    // stops passing, we have over-filtered.
    mockSession.emit('incoming-publish', makeIncomingPublish('video'));

    // Allow the async handler to run through pipeline.start() before we
    // observe the callback wiring.
    for (let i = 0; i < 20; i++) await Promise.resolve();

    expect(mockSession.setSubscriptionCallback).toHaveBeenCalledTimes(1);
    expect(mockSession.setSubscriptionCallback.mock.calls[0][0]).toBe(42);
  });
});
