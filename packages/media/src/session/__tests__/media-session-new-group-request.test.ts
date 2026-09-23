// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * MediaSession wiring for draft-18 §10.2.13 NEW_GROUP_REQUEST.
 *
 * When the session emits `new-group-request`, MediaSession must look up the
 * matching local publication by `trackAlias` and call `forceKeyframe()` on
 * its publish pipeline so the peer can seed its decoder without waiting for
 * the next scheduled IDR. If the event has no trackAlias, or the trackAlias
 * refers to a publication we don't own, MediaSession must do nothing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MOQTSession, NewGroupRequestEvent } from '@moq-web/session';
import { MediaSession } from '../media-session';
import type { PublishPipeline } from '../../pipeline/publish-pipeline';

type Handler = (data: unknown) => void;

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
  return {
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
}

/** Inject a fake publication with a spy-only pipeline so we can observe forceKeyframe. */
function installFakePublication(media: MediaSession, trackAlias: bigint) {
  const forceKeyframe = vi.fn();
  const stop = vi.fn().mockResolvedValue(undefined);
  const fakePipeline = { forceKeyframe, stop } as unknown as PublishPipeline;
  const publications = (media as unknown as {
    publications: Map<string, { pipeline: PublishPipeline; cleanupHandlers: Array<() => void> }>;
  }).publications;
  publications.set(trackAlias.toString(), { pipeline: fakePipeline, cleanupHandlers: [] } as never);
  return forceKeyframe;
}

describe('MediaSession — NEW_GROUP_REQUEST → forceKeyframe', () => {
  let mockSession: ReturnType<typeof createMockSession>;
  let media: MediaSession;

  beforeEach(() => {
    mockSession = createMockSession();
    media = new MediaSession({ session: mockSession as unknown as MOQTSession });
  });

  afterEach(async () => {
    await media.close();
  });

  it('forces a keyframe on the publication matching event.trackAlias', () => {
    const forceKeyframe = installFakePublication(media, 42n);

    const event: NewGroupRequestEvent = {
      requestId: 7n,
      value: 1n,
      forwardState: true,
      trackAlias: 42n,
    };
    mockSession.emit('new-group-request', event);

    expect(forceKeyframe).toHaveBeenCalledTimes(1);
  });

  it('does nothing when event has no trackAlias (targeted subscription unresolved)', () => {
    const forceKeyframe = installFakePublication(media, 42n);

    const event: NewGroupRequestEvent = {
      requestId: 7n,
      value: 1n,
      forwardState: true,
    };
    mockSession.emit('new-group-request', event);

    expect(forceKeyframe).not.toHaveBeenCalled();
  });

  it('does nothing when trackAlias does not match any local publication', () => {
    const forceKeyframe = installFakePublication(media, 42n);

    const event: NewGroupRequestEvent = {
      requestId: 7n,
      value: 1n,
      forwardState: true,
      trackAlias: 99n,
    };
    mockSession.emit('new-group-request', event);

    expect(forceKeyframe).not.toHaveBeenCalled();
  });

  it('fires on the specific publication even when multiple are registered', () => {
    const forceA = installFakePublication(media, 1n);
    const forceB = installFakePublication(media, 2n);
    const forceC = installFakePublication(media, 3n);

    const event: NewGroupRequestEvent = {
      requestId: 11n,
      value: 1n,
      forwardState: false,
      trackAlias: 2n,
    };
    mockSession.emit('new-group-request', event);

    expect(forceA).not.toHaveBeenCalled();
    expect(forceB).toHaveBeenCalledTimes(1);
    expect(forceC).not.toHaveBeenCalled();
  });
});
