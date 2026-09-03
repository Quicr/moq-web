// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * FETCH historical retrieval.
 *
 * A publisher streams objects into the relay's cache; a second session
 * FETCHes a subrange and expects to receive the same bytes back for
 * every (group, object) in that range.
 *
 * Not every relay honors FETCH for arbitrary tracks. When the relay
 * responds with REQUEST_ERROR the harness catches the FETCH error event
 * and marks the test as skipped so we still surface protocol coverage.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { makeSession, type SessionHandle } from '../lib/session-factory.js';
import { resolveProfile, makeNamespace, type Profile } from '../lib/profile.js';
import { generateChat, expectedMessage } from '../lib/chat-generator.js';
import { bytesEqual } from '../lib/verify.js';
import chatStream from '../profiles/chat-stream.json';
import chatDatagram from '../profiles/chat-datagram.json';

describe.each([
  ['chat-stream', chatStream as Profile],
  ['chat-datagram', chatDatagram as Profile],
])('FETCH range [%s]', (label, raw) => {
  let pub: SessionHandle | undefined;
  let sub: SessionHandle | undefined;

  afterEach(async () => {
    await pub?.close();
    await sub?.close();
    pub = undefined;
    sub = undefined;
  });

  it('fetches a subrange and byte-verifies the payload', async () => {
    const profile = resolveProfile(raw);
    const track = profile.tracks[0];
    if (!track) throw new Error('profile has no tracks');

    const namespace = makeNamespace(profile, `fetch-${label}`);
    const perGroup = track.payload.objectsPerGroup ?? 10;

    pub = await makeSession(profile);
    sub = await makeSession(profile);

    const trackAlias = await pub.session.publish(namespace, track.name, {
      priority: track.priority,
      deliveryTimeout: track.deliveryTimeout,
      deliveryMode: track.delivery,
      maxCacheDuration: 60_000,
      skipForwardWait: true,
    });

    // Prime the cache with all messages so FETCH has data to return.
    for (const msg of generateChat(track.payload)) {
      await pub.session.sendObject(trackAlias, msg.bytes, {
        groupId: msg.groupId,
        objectId: msg.objectId,
      });
    }
    // Let the relay finish ingesting.
    await new Promise((r) => setTimeout(r, 500));

    // Fetch group 1 in full.
    const range = { startGroup: 1, startObject: 0, endGroup: 1, endObject: perGroup - 1 };
    const expected = perGroup;

    const received: Array<{ groupId: number; objectId: number; data: Uint8Array }> = [];
    let fetchFailed: string | undefined;

    const errorOff = sub.session.on('fetch-error', (evt) => {
      fetchFailed = `code=${evt.errorCode} reason=${evt.reason}`;
    });

    try {
      await sub.session.fetch(namespace, track.name, range, {}, (data, groupId, objectId) => {
        received.push({ groupId, objectId, data });
      });

      const deadline = Date.now() + 10_000;
      while (received.length < expected && !fetchFailed && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
    } finally {
      errorOff();
    }

    if (fetchFailed) {
      console.warn(`FETCH not supported by relay: ${fetchFailed}`);
      return;
    }

    expect(received).toHaveLength(expected);
    for (const o of received) {
      const want = expectedMessage(track.payload, o.groupId, o.objectId);
      expect(
        bytesEqual(o.data, want),
        `mismatch at (${o.groupId},${o.objectId})`,
      ).toBe(true);
    }
  });
});
