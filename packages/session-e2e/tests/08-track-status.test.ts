// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * TRACK_STATUS round-trip (draft-18 only).
 *
 * A publisher advertises a track, and a second session queries its status.
 * `trackStatus()` resolves when the relay returns REQUEST_OK; it throws on
 * REQUEST_ERROR. Both outcomes prove the exchange is wire-correct — the
 * strict requirement is just that the promise settles without a timeout.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { makeSession, type SessionHandle } from '../lib/session-factory.js';
import { resolveProfile, makeNamespace, type Profile } from '../lib/profile.js';
import chatStream from '../profiles/chat-stream.json';
import chatDatagram from '../profiles/chat-datagram.json';

const MOQT_VERSION = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_MOQT_VERSION ?? 'draft-18';
const isDraft18 = MOQT_VERSION === 'draft-18';

describe.skipIf(!isDraft18).each([
  ['chat-stream', chatStream as Profile],
  ['chat-datagram', chatDatagram as Profile],
])('TRACK_STATUS round-trip [%s]', (label, raw) => {
  let pub: SessionHandle | undefined;
  let requester: SessionHandle | undefined;

  afterEach(async () => {
    await pub?.close();
    await requester?.close();
    pub = undefined;
    requester = undefined;
  });

  it('requester gets a REQUEST_OK or REQUEST_ERROR for the queried track', async () => {
    const profile = resolveProfile(raw);
    const track = profile.tracks[0];
    if (!track) throw new Error('profile has no tracks');

    const namespace = makeNamespace(profile, `status-${label}`);

    pub = await makeSession(profile);
    requester = await makeSession(profile);

    await pub.session.publish(namespace, track.name, {
      priority: track.priority,
      deliveryTimeout: track.deliveryTimeout,
      deliveryMode: track.delivery,
    });

    // Give the relay a moment to register the publication before the
    // status query.
    await new Promise((r) => setTimeout(r, 250));

    // Either resolution or a REQUEST_ERROR rejection counts as a
    // successful wire exchange (the relay parsed our request and replied).
    // We only fail if it hangs past the vitest timeout.
    let settled: 'ok' | 'error' | undefined;
    let result: Awaited<ReturnType<typeof requester.session.trackStatus>> | undefined;
    try {
      result = await requester.session.trackStatus(namespace, track.name);
      settled = 'ok';
    } catch (err) {
      if (/TRACK_STATUS failed/.test((err as Error).message)) settled = 'error';
      else throw err;
    }
    expect(settled).toBeDefined();

    // If the relay accepted the request, the result must at minimum carry a
    // numeric requestId; `latestGroup`/`latestObject` may or may not be
    // present depending on relay behavior — we only check the shape.
    if (settled === 'ok') {
      expect(result).toBeDefined();
      expect(typeof result!.requestId).toBe('number');
      if (result!.latestGroup !== undefined) {
        expect(typeof result!.latestGroup).toBe('bigint');
        expect(typeof result!.latestObject).toBe('bigint');
      }
    }
  });
});
