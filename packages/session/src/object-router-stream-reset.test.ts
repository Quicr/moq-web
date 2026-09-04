// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * ObjectRouter §11.4.3 peer-initiated stream-reset integration tests.
 *
 * Drives a `ReadableStream` that:
 *   1. Delivers a subgroup header (so the router registers the alias and
 *      knows which subscription the reset belongs to).
 *   2. Rejects the next read() with an error carrying `streamErrorCode` — the
 *      shape WebTransport surfaces for a peer RESET_STREAM.
 *
 * Asserts the router's `setStreamResetCallback` fires with the numeric code
 * and the correct subgroup/subscription context.
 */

import { describe, expect, it, vi } from 'vitest';
import { ObjectCodec, StreamResetErrorCodeDraft18 } from '@moq-web/core';

import { ObjectRouter } from './object-router.js';
import { SubscriptionManager, type InternalSubscription } from './subscription-manager.js';

function makeSub(overrides: Partial<InternalSubscription>): InternalSubscription {
  return {
    subscriptionId: 1,
    requestId: 1,
    namespace: ['ns'],
    trackName: 'track',
    trackAlias: 1n,
    paused: false,
    ...overrides,
  };
}

function encodeSubgroupStream(trackAlias: bigint, groupId: number): Uint8Array {
  const [header] = ObjectCodec.encodeSubgroupHeader(
    { trackAlias, groupId, subgroupId: 0, publisherPriority: 128 },
    false,
  );
  return header;
}

describe('ObjectRouter §11.4.3 peer-initiated stream-reset', () => {
  it('fires onStreamReset with the WebTransport streamErrorCode', async () => {
    const subs = new SubscriptionManager();
    const router = new ObjectRouter(subs);
    subs.add(makeSub({ subscriptionId: 5, trackAlias: 11n }));

    const hits: Array<{
      subId?: number;
      code: number;
      reason: string;
      trackAlias?: bigint;
      groupId?: number;
      subgroupId?: number;
    }> = [];
    router.setStreamResetCallback((sub, code, reason, detail) => {
      hits.push({
        subId: sub?.subscriptionId,
        code,
        reason,
        trackAlias: detail.trackAlias,
        groupId: detail.groupId,
        subgroupId: detail.subgroupId,
      });
    });

    const header = encodeSubgroupStream(11n, 3);
    let delivered = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!delivered) {
          delivered = true;
          controller.enqueue(header);
          return;
        }
        // Simulate WebTransport's peer-RESET_STREAM error surface.
        const err = Object.assign(new Error('Received RESET_STREAM.'), {
          streamErrorCode: StreamResetErrorCodeDraft18.TOO_FAR_BEHIND,
        });
        controller.error(err);
      },
    });

    await router.handleIncomingStream(stream);

    expect(hits).toHaveLength(1);
    expect(hits[0].code).toBe(StreamResetErrorCodeDraft18.TOO_FAR_BEHIND);
    expect(hits[0].reason).toContain('RESET_STREAM');
    expect(hits[0].subId).toBe(5);
    expect(hits[0].trackAlias).toBe(11n);
    expect(hits[0].groupId).toBe(3);
    expect(hits[0].subgroupId).toBe(0);
  });

  it('does not fire onStreamReset for an ordinary disconnect (no streamErrorCode)', async () => {
    const subs = new SubscriptionManager();
    const router = new ObjectRouter(subs);
    subs.add(makeSub({ trackAlias: 12n }));

    const cb = vi.fn();
    router.setStreamResetCallback(cb);

    const header = encodeSubgroupStream(12n, 0);
    let delivered = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!delivered) {
          delivered = true;
          controller.enqueue(header);
          return;
        }
        // Plain error — no streamErrorCode. Represents a session close /
        // transport teardown, not a peer RESET_STREAM.
        controller.error(new Error('session is closed'));
      },
    });

    await router.handleIncomingStream(stream);

    expect(cb).not.toHaveBeenCalled();
  });

  it('still fires when the reset arrives before any subgroup header decoded', async () => {
    const subs = new SubscriptionManager();
    const router = new ObjectRouter(subs);
    // No subscription registered — router hasn't seen an alias yet.

    const hits: Array<{ subId?: number; trackAlias?: bigint }> = [];
    router.setStreamResetCallback((sub, _code, _reason, detail) => {
      hits.push({ subId: sub?.subscriptionId, trackAlias: detail.trackAlias });
    });

    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(Object.assign(new Error('Received RESET_STREAM.'), {
          streamErrorCode: StreamResetErrorCodeDraft18.GOING_AWAY,
        }));
      },
    });

    await router.handleIncomingStream(stream);

    expect(hits).toHaveLength(1);
    expect(hits[0].subId).toBeUndefined();
    expect(hits[0].trackAlias).toBeUndefined();
  });
});
