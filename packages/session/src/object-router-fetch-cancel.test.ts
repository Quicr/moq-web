// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * FETCH cancellation in the ObjectRouter.
 *
 * Draft-22 / draft-18 §3.2.4: a subscriber cancelling a FETCH MAY send
 * STOP_SENDING on the data stream. The router must stop delivering and cancel
 * the reader (STOP_SENDING), even if the stream keeps producing objects, and
 * must cancel a fetch stream that shows up after its request was cancelled.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  Draft18StreamCodec,
  StreamResetErrorCodeDraft18,
  DataStreamType,
  FetchSubgroupMode,
  MOQTVarInt,
} from '@moq-web/core';

import { ObjectRouter } from './object-router.js';
import { SubscriptionManager } from './subscription-manager.js';

const REQUEST_ID = 3n;
const PRIORITY = 128;
const PAYLOAD_SIZE = 4;
const RUNAWAY_LIMIT = 1000;

function concat(parts: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    bytes.set(p, offset);
    offset += p.length;
  }

  return bytes;
}

function fetchHeader(): Uint8Array {
  return concat([
    MOQTVarInt.encode(BigInt(DataStreamType.FETCH_HEADER)),
    MOQTVarInt.encode(REQUEST_ID),
  ]);
}

function fetchObject(index: number): Uint8Array {
  // First object carries absolute IDs; later ones use "prior + 1"
  const header = index === 0
    ? { subgroupMode: FetchSubgroupMode.ZERO, groupIdDelta: 0n, objectIdDelta: 0n, publisherPriority: PRIORITY }
    : { subgroupMode: FetchSubgroupMode.PRIOR };

  return concat([
    Draft18StreamCodec.encodeFetchObject({ ...header, payloadLength: BigInt(PAYLOAD_SIZE) }),
    new Uint8Array(PAYLOAD_SIZE),
  ]);
}

/** A stream that keeps producing objects until cancelled (or the runaway limit). */
function endlessFetch(onCancel: (reason?: unknown) => void): ReadableStream<Uint8Array> {
  let index = 0;

  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index === 0) {
        controller.enqueue(fetchHeader());
      }
      if (index >= RUNAWAY_LIMIT) {
        controller.close();
        return;
      }
      controller.enqueue(fetchObject(index++));
    },
    cancel: onCancel,
  });
}

describe.each(['draft-18', 'draft-22'] as const)('ObjectRouter FETCH cancel (%s)', (draft) => {
  it('stops delivering and cancels the reader once the fetch is cancelled', async () => {
    const router = new ObjectRouter(new SubscriptionManager(), undefined, draft);
    const onCancel = vi.fn();
    let delivered = 0;
    router.setFetchObjectCallback((requestId) => {
      delivered++;
      router.cancelFetchStream(requestId);
    });

    await router.handleIncomingStream(endlessFetch(onCancel));

    expect(delivered).toBe(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledWith(StreamResetErrorCodeDraft18.CANCELLED);
  });

  it('does not report end-of-group for a cancelled fetch', async () => {
    const router = new ObjectRouter(new SubscriptionManager(), undefined, draft);
    const onEndOfGroup = vi.fn();
    router.setFetchEndOfGroupCallback(onEndOfGroup);
    router.setFetchObjectCallback((requestId) => router.cancelFetchStream(requestId));

    await router.handleIncomingStream(endlessFetch(() => {}));

    expect(onEndOfGroup).not.toHaveBeenCalled();
  });

  it('cancels a fetch stream that arrives after its request was cancelled', async () => {
    const router = new ObjectRouter(new SubscriptionManager(), undefined, draft);
    const onCancel = vi.fn();
    const onObject = vi.fn();
    router.setFetchObjectCallback(onObject);

    router.cancelFetchStream(REQUEST_ID);
    await router.handleIncomingStream(endlessFetch(onCancel));

    expect(onObject).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledWith(StreamResetErrorCodeDraft18.CANCELLED);
  });

  it('only cancels the first late stream for a cancelled request', async () => {
    const router = new ObjectRouter(new SubscriptionManager(), undefined, draft);
    const onObject = vi.fn();
    router.setFetchObjectCallback((requestId) => {
      onObject();
      router.cancelFetchStream(requestId);
    });

    router.cancelFetchStream(REQUEST_ID);
    await router.handleIncomingStream(endlessFetch(() => {}));
    await router.handleIncomingStream(endlessFetch(() => {}));

    // The cancel record is consumed by the first stream, so the second one
    // delivers once before its callback cancels it again.
    expect(onObject).toHaveBeenCalledTimes(1);
  });
});
