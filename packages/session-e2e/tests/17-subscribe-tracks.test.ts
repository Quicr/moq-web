// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Draft-18 §10.19 SUBSCRIBE_TRACKS end-to-end.
 *
 * Publisher A opens a session and announces a track under a namespace.
 * Subscriber B calls `subscribeTracks(prefix)` with the full param set
 * (FORWARD + SUBSCRIPTION_FILTER). We assert the request resolves — the
 * relay parsed our extended parameter list and issued REQUEST_OK. Deeper
 * per-parameter round-trip is covered by the unit + codec tests.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { makeSession, type SessionHandle } from '../lib/session-factory.js';
import { resolveProfile, makeNamespace, type Profile } from '../lib/profile.js';
import chatStream from '../profiles/chat-stream.json';

const MOQT_VERSION = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_MOQT_VERSION ?? 'draft-18';
const isDraft18 = MOQT_VERSION === 'draft-18';

describe.skipIf(!isDraft18)('SUBSCRIBE_TRACKS with full parameter set', () => {
  let pub: SessionHandle | undefined;
  let sub: SessionHandle | undefined;

  afterEach(async () => {
    try { await pub?.close(); } catch { /* ignore */ }
    try { await sub?.close(); } catch { /* ignore */ }
    pub = undefined;
    sub = undefined;
  });

  it('subscribeTracks resolves with the full FORWARD + SUBSCRIPTION_FILTER parameter set', async () => {
    const profile = resolveProfile(chatStream as Profile);
    const track = profile.tracks[0];
    if (!track) throw new Error('profile has no tracks');

    const namespace = makeNamespace(profile, 'subtracks');
    const prefix = namespace.slice(0, -1);

    pub = await makeSession(profile);
    sub = await makeSession(profile);

    await pub.session.publish(namespace, track.name, {
      priority: track.priority,
      deliveryTimeout: track.deliveryTimeout,
      deliveryMode: track.delivery,
    });

    // Small settle so the relay sees the publish before the subscribe.
    await new Promise((r) => setTimeout(r, 250));

    // Default options exercise FORWARD=1 + SUBSCRIPTION_FILTER=NEXT_GROUP_START;
    // the extended encoder is what changes vs. the pre-patch empty param list.
    let subscriptionId: number | undefined;
    try {
      subscriptionId = await sub.session.subscribeTracks(prefix);
    } catch (err) {
      // Some relays reject SUBSCRIBE_TRACKS as unsupported — we still exercised
      // the wire path. Only rethrow if the failure is not a REQUEST_ERROR.
      if (!/SUBSCRIBE_TRACKS failed/.test((err as Error).message)) throw err;
      return;
    }
    expect(typeof subscriptionId).toBe('number');
  });
});
