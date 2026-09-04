// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Unit tests for the draft-18 §10.14 TRACK_STATUS handler wiring.
 *
 * The tests exercise `handleIncomingTrackStatusDraft18()` directly with a
 * synthetic writable stream and verify:
 *   1. status queries for a track this session publishes reply with
 *      REQUEST_OK carrying the last-sent (group, object) as LARGEST_OBJECT
 *      (§10.2.9);
 *   2. queries for an unknown track reply with REQUEST_ERROR DOES_NOT_EXIST;
 *   3. queries against a publication that has not yet sent any objects reply
 *      with REQUEST_OK and no LARGEST_OBJECT parameter.
 *
 * The `PublicationManager.updateLatest()` monotonicity check has its own
 * dedicated test since it's the source of truth for what LARGEST_OBJECT
 * reports.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  Draft18MessageCodec,
  IS_DRAFT_18,
  MOQTransport,
  MessageTypeDraft18,
  RequestErrorCodeDraft18,
  type ControlMessageDraft18,
  type RequestErrorMessageDraft18,
  type RequestOkMessageDraft18,
  type TrackStatusMessageDraft18,
} from '@moq-web/core';

import { MOQTSession } from './session.js';
import { PublicationManager, type InternalPublication } from './publication-manager.js';

function makeSession(): MOQTSession {
  const transport = new MOQTransport();
  (transport as unknown as { close: typeof transport.close }).close = vi.fn().mockResolvedValue(undefined);
  return new MOQTSession(transport);
}

/**
 * Build a WritableStream that captures every write into a byte array so we
 * can decode the response the session sent back on the request stream.
 */
function captureStream(): { writable: WritableStream<Uint8Array>; getBytes(): Uint8Array } {
  const chunks: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk);
    },
  });
  return {
    writable,
    getBytes() {
      let total = 0;
      for (const c of chunks) total += c.byteLength;
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        out.set(c, off);
        off += c.byteLength;
      }
      return out;
    },
  };
}

function decodeResponse(bytes: Uint8Array): ControlMessageDraft18 {
  const [msg] = Draft18MessageCodec.decode(bytes);
  return msg as ControlMessageDraft18;
}

describe.skipIf(!IS_DRAFT_18)('draft-18 §10.14 handleIncomingTrackStatusDraft18', () => {
  it('replies REQUEST_OK with LARGEST_OBJECT when the track has published objects', async () => {
    const session = makeSession();
    const pm = (session as unknown as { publicationManager: PublicationManager }).publicationManager;

    const publication: InternalPublication = {
      trackAlias: 42n,
      namespace: ['status', 'test'],
      trackName: 'stream',
      priority: 128,
      deliveryMode: 'stream',
      requestId: 1,
      cleanupHandlers: [],
      forward: 1,
    };
    pm.add(publication);
    pm.updateLatest(42n, 7n, 3n);

    const request: TrackStatusMessageDraft18 = {
      type: MessageTypeDraft18.TRACK_STATUS,
      requestId: 99n,
      trackNamespace: ['status', 'test'],
      trackName: 'stream',
    };

    const { writable, getBytes } = captureStream();
    await (session as unknown as {
      handleIncomingTrackStatusDraft18(m: TrackStatusMessageDraft18, w: WritableStream<Uint8Array>): Promise<void>;
    }).handleIncomingTrackStatusDraft18(request, writable);

    const response = decodeResponse(getBytes()) as RequestOkMessageDraft18;
    expect(response.type).toBe(MessageTypeDraft18.REQUEST_OK);
    expect(response.largestLocation).toEqual({ group: 7n, object: 3n });
  });

  it('replies REQUEST_ERROR DOES_NOT_EXIST for a track this session does not publish', async () => {
    const session = makeSession();

    const request: TrackStatusMessageDraft18 = {
      type: MessageTypeDraft18.TRACK_STATUS,
      requestId: 5n,
      trackNamespace: ['nope'],
      trackName: 'ghost',
    };

    const { writable, getBytes } = captureStream();
    await (session as unknown as {
      handleIncomingTrackStatusDraft18(m: TrackStatusMessageDraft18, w: WritableStream<Uint8Array>): Promise<void>;
    }).handleIncomingTrackStatusDraft18(request, writable);

    const response = decodeResponse(getBytes()) as RequestErrorMessageDraft18;
    expect(response.type).toBe(MessageTypeDraft18.REQUEST_ERROR);
    expect(response.errorCode).toBe(RequestErrorCodeDraft18.DOES_NOT_EXIST);
  });

  it('omits LARGEST_OBJECT when the publication has not sent any objects yet', async () => {
    const session = makeSession();
    const pm = (session as unknown as { publicationManager: PublicationManager }).publicationManager;

    pm.add({
      trackAlias: 1n,
      namespace: ['empty', 'ns'],
      trackName: 'no-objects',
      priority: 128,
      deliveryMode: 'stream',
      requestId: 1,
      cleanupHandlers: [],
      forward: 1,
    });

    const request: TrackStatusMessageDraft18 = {
      type: MessageTypeDraft18.TRACK_STATUS,
      requestId: 2n,
      trackNamespace: ['empty', 'ns'],
      trackName: 'no-objects',
    };

    const { writable, getBytes } = captureStream();
    await (session as unknown as {
      handleIncomingTrackStatusDraft18(m: TrackStatusMessageDraft18, w: WritableStream<Uint8Array>): Promise<void>;
    }).handleIncomingTrackStatusDraft18(request, writable);

    const response = decodeResponse(getBytes()) as RequestOkMessageDraft18;
    expect(response.type).toBe(MessageTypeDraft18.REQUEST_OK);
    expect(response.largestLocation).toBeUndefined();
  });
});

describe('PublicationManager.updateLatest()', () => {
  it('records the first (group, object) pair sent', () => {
    const pm = new PublicationManager();
    pm.add({
      trackAlias: 1n,
      namespace: ['ns'],
      trackName: 't',
      priority: 128,
      deliveryMode: 'stream',
      requestId: 1,
      cleanupHandlers: [],
      forward: 1,
    });
    pm.updateLatest(1n, 5n, 2n);
    expect(pm.get(1n)?.latestGroup).toBe(5n);
    expect(pm.get(1n)?.latestObject).toBe(2n);
  });

  it('advances the latest tuple when group grows', () => {
    const pm = new PublicationManager();
    pm.add({
      trackAlias: 1n,
      namespace: ['ns'],
      trackName: 't',
      priority: 128,
      deliveryMode: 'stream',
      requestId: 1,
      cleanupHandlers: [],
      forward: 1,
    });
    pm.updateLatest(1n, 5n, 9n);
    pm.updateLatest(1n, 6n, 0n);
    expect(pm.get(1n)?.latestGroup).toBe(6n);
    expect(pm.get(1n)?.latestObject).toBe(0n);
  });

  it('advances within the same group when object grows', () => {
    const pm = new PublicationManager();
    pm.add({
      trackAlias: 1n,
      namespace: ['ns'],
      trackName: 't',
      priority: 128,
      deliveryMode: 'stream',
      requestId: 1,
      cleanupHandlers: [],
      forward: 1,
    });
    pm.updateLatest(1n, 5n, 2n);
    pm.updateLatest(1n, 5n, 3n);
    expect(pm.get(1n)?.latestObject).toBe(3n);
  });

  it('ignores out-of-order updates (older group)', () => {
    const pm = new PublicationManager();
    pm.add({
      trackAlias: 1n,
      namespace: ['ns'],
      trackName: 't',
      priority: 128,
      deliveryMode: 'stream',
      requestId: 1,
      cleanupHandlers: [],
      forward: 1,
    });
    pm.updateLatest(1n, 5n, 2n);
    pm.updateLatest(1n, 4n, 100n);
    expect(pm.get(1n)?.latestGroup).toBe(5n);
    expect(pm.get(1n)?.latestObject).toBe(2n);
  });

  it('is a no-op for unknown track aliases', () => {
    const pm = new PublicationManager();
    // Should not throw
    pm.updateLatest(99n, 1n, 1n);
    expect(pm.get(99n)).toBeUndefined();
  });
});
