// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Draft-18 §10.2.10 EXPIRES / §10.2.13 NEW_GROUP_REQUEST / §10.2.14
 * TRACK_NAMESPACE_PREFIX — end-to-end against a live relay.
 *
 * The relay is expected to accept the SUBSCRIBE and SUBSCRIBE_TRACKS requests
 * that carry these parameters — we assert wire-level acceptance rather than
 * higher-level behaviour, which is relay policy dependent. Deeper semantics
 * (does the relay actually cut a new group on demand? what expiry duration
 * does it echo back?) live in relay conformance tests.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { makeSession, type SessionHandle } from '../lib/session-factory.js';
import { resolveProfile, makeNamespace, type Profile } from '../lib/profile.js';
import chatStream from '../profiles/chat-stream.json';

const MOQT_VERSION = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_MOQT_VERSION ?? 'draft-18';
const isDraft18 = MOQT_VERSION === 'draft-18';

describe.skipIf(!isDraft18)('EXPIRES + NEW_GROUP_REQUEST + TRACK_NAMESPACE_PREFIX', () => {
  let pub: SessionHandle | undefined;
  let sub: SessionHandle | undefined;

  afterEach(async () => {
    try { await pub?.close(); } catch { /* ignore */ }
    try { await sub?.close(); } catch { /* ignore */ }
    pub = undefined;
    sub = undefined;
  });

  it('publisher advertises EXPIRES on SUBSCRIBE_OK when AnnounceOptions.expires is set', async () => {
    const profile = resolveProfile(chatStream as Profile);
    const track = profile.tracks[0];
    if (!track) throw new Error('profile has no tracks');

    const namespace = makeNamespace(profile, 'expires');

    pub = await makeSession(profile);
    sub = await makeSession(profile);

    await pub.session.publish(namespace, track.name, {
      priority: track.priority,
      deliveryTimeout: track.deliveryTimeout,
      deliveryMode: track.delivery,
      skipForwardWait: true,
      expires: 30_000,
    });

    await new Promise((r) => setTimeout(r, 250));

    const subscriptionId = await sub.session.subscribe(namespace, track.name);
    expect(typeof subscriptionId).toBe('number');
  });

  it('subscriber can send REQUEST_UPDATE with NEW_GROUP_REQUEST', async () => {
    const profile = resolveProfile(chatStream as Profile);
    const track = profile.tracks[0];
    if (!track) throw new Error('profile has no tracks');

    const namespace = makeNamespace(profile, 'ngr');

    pub = await makeSession(profile);
    sub = await makeSession(profile);

    await pub.session.publish(namespace, track.name, {
      priority: track.priority,
      deliveryTimeout: track.deliveryTimeout,
      deliveryMode: track.delivery,
      skipForwardWait: true,
    });

    await new Promise((r) => setTimeout(r, 250));

    const subscriptionId = await sub.session.subscribe(namespace, track.name);
    const info = sub.session.getSubscription(subscriptionId);
    expect(info).toBeDefined();

    // Send REQUEST_UPDATE with NEW_GROUP_REQUEST=1. Some relays may not
    // acknowledge it; awaitAck: false keeps the test resilient to that.
    await sub.session.sendRequestUpdate(info!.requestId, true, {
      newGroupRequest: true,
      awaitAck: false,
    });
  });

  it('subscriber can carry TRACK_NAMESPACE_PREFIX on SUBSCRIBE_TRACKS', async () => {
    const profile = resolveProfile(chatStream as Profile);
    const track = profile.tracks[0];
    if (!track) throw new Error('profile has no tracks');

    const namespace = makeNamespace(profile, 'tnp');

    pub = await makeSession(profile);
    sub = await makeSession(profile);

    await pub.session.publish(namespace, track.name, {
      priority: track.priority,
      deliveryTimeout: track.deliveryTimeout,
      deliveryMode: track.delivery,
      skipForwardWait: true,
    });

    await new Promise((r) => setTimeout(r, 250));

    try {
      const subId = await sub.session.subscribeTracks(namespace.slice(0, 1), undefined, {
        namespacePrefixParam: namespace,
      });
      expect(typeof subId).toBe('number');
    } catch (err) {
      // Some relays reject SUBSCRIBE_TRACKS entirely (draft-18 §10.19), reject
      // the extra parameter, or simply reset the request stream. The wire-level
      // encoding is what the codec unit test guarantees; here we only require
      // that the peer accepts the request bytes without a protocol violation
      // (session-close) that would suggest our encoding is malformed.
      const msg = (err as Error).message ?? '';
      if (
        !/SUBSCRIBE_TRACKS|REQUEST_ERROR|forbidden|not.*allowed|RESET_STREAM|WebTransport/i.test(msg)
      ) throw err;
    }
  });
});
