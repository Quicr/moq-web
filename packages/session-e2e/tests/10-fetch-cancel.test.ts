// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * FETCH_CANCEL flow.
 *
 * Kick off a fetch that would return many objects, cancel it as soon as
 * we've received at least one, and confirm the count stops climbing.
 * As with 09-fetch, the test tolerates relays that do not support FETCH
 * by skipping when FETCH itself errors out.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { makeSession, type SessionHandle } from '../lib/session-factory.js';
import { resolveProfile, makeNamespace, type Profile } from '../lib/profile.js';
import { generateChat } from '../lib/chat-generator.js';
import chatStream from '../profiles/chat-stream.json';
import chatDatagram from '../profiles/chat-datagram.json';

// Enough data that a local relay can't drain the whole range before the
// cancel lands (the profile's 30 x 64 B arrives in a single burst).
const CANCEL_MESSAGES = 600;
const CANCEL_SIZE_BYTES = 2048;

describe.each([
  ['chat-stream', chatStream as Profile],
  ['chat-datagram', chatDatagram as Profile],
])('FETCH_CANCEL [%s]', (label, raw) => {
  let pub: SessionHandle | undefined;
  let sub: SessionHandle | undefined;

  afterEach(async () => {
    await pub?.close();
    await sub?.close();
    pub = undefined;
    sub = undefined;
  });

  it('cancel halts further fetch deliveries', async () => {
    const profile = resolveProfile(raw);
    const track = profile.tracks[0];
    if (!track) throw new Error('profile has no tracks');

    const namespace = makeNamespace(profile, `fcancel-${label}`);
    const perGroup = track.payload.objectsPerGroup ?? 10;
    const payload = { ...track.payload, messages: CANCEL_MESSAGES, sizeBytes: CANCEL_SIZE_BYTES };
    const messages = Array.from(generateChat(payload));
    const lastGroup = messages[messages.length - 1]?.groupId ?? 0;

    pub = await makeSession(profile);
    sub = await makeSession(profile);

    const trackAlias = await pub.session.publish(namespace, track.name, {
      priority: track.priority,
      deliveryTimeout: track.deliveryTimeout,
      deliveryMode: track.delivery,
      maxCacheDuration: 60_000,
      skipForwardWait: true,
    });

    for (const msg of messages) {
      await pub.session.sendObject(trackAlias, msg.bytes, {
        groupId: msg.groupId,
        objectId: msg.objectId,
      });
    }
    await new Promise((r) => setTimeout(r, 500));

    let received = 0;
    let fetchFailed: string | undefined;
    const errorOff = sub.session.on('fetch-error', (evt) => {
      fetchFailed = `code=${evt.errorCode} reason=${evt.reason}`;
    });

    // Resolve on the first object so the cancel goes out immediately rather
    // than after a polling interval.
    let onFirstObject!: () => void;
    const firstObject = new Promise<void>((r) => { onFirstObject = r; });

    const requestId = await sub.session.fetch(
      namespace,
      track.name,
      { startGroup: 0, startObject: 0, endGroup: lastGroup, endObject: perGroup - 1 },
      {},
      () => {
        received++;
        if (received === 1) {
          onFirstObject();
        }
      },
    );

    await Promise.race([firstObject, new Promise((r) => setTimeout(r, 5_000))]);
    errorOff();

    if (fetchFailed) {
      console.warn(`FETCH not supported by relay: ${fetchFailed}`);
      return;
    }

    expect(received).toBeGreaterThan(0);

    await sub.session.cancelFetch(requestId);

    // Allow any in-flight objects to arrive, then take a settled reading.
    await new Promise((r) => setTimeout(r, 500));
    const settled = received;

    // Wait longer than the largest realistic in-flight window and confirm
    // deliveries have truly stopped.
    await new Promise((r) => setTimeout(r, 1_000));
    expect(received).toBe(settled);
    // And, importantly, we did NOT drain the entire range.
    expect(received).toBeLessThan(messages.length);
  });
});
