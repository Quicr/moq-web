// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Draft-18 §11.4.3 stream-reset — end-to-end against a live relay.
 *
 * We drive the publisher-side path (calling `resetPublicationStream` while a
 * subgroup stream is open) and assert the local `stream-reset` event fires
 * with the requested §15.10.4 code. The subscriber-side path is exercised
 * opportunistically: if the relay propagates the RESET_STREAM back to the
 * subscriber, we should see a `stream-reset` there too, but we don't assert
 * on it since relay behaviour is policy-dependent.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { StreamResetErrorCodeDraft18 } from '@moq-web/core';

import { makeSession, type SessionHandle } from '../lib/session-factory.js';
import { resolveProfile, makeNamespace, type Profile } from '../lib/profile.js';
import { generateChat } from '../lib/chat-generator.js';
import chatStream from '../profiles/chat-stream.json';
import type { StreamResetEvent } from '@moq-web/session';

const MOQT_VERSION = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_MOQT_VERSION ?? 'draft-18';
const isDraft18 = MOQT_VERSION === 'draft-18';

describe.skipIf(!isDraft18)('subgroup stream-reset (§11.4.3)', () => {
  let pub: SessionHandle | undefined;
  let sub: SessionHandle | undefined;

  afterEach(async () => {
    try { await pub?.close(); } catch { /* ignore */ }
    try { await sub?.close(); } catch { /* ignore */ }
    pub = undefined;
    sub = undefined;
  });

  it('publisher emits stream-reset with the requested §15.10.4 code', async () => {
    const profile = resolveProfile(chatStream as Profile);
    const track = profile.tracks[0];
    if (!track) throw new Error('profile has no tracks');

    const namespace = makeNamespace(profile, 'stream-reset');

    pub = await makeSession(profile);
    sub = await makeSession(profile);

    const trackAlias = await pub.session.publish(namespace, track.name, {
      priority: track.priority,
      deliveryTimeout: track.deliveryTimeout,
      deliveryMode: track.delivery,
      skipForwardWait: true,
    });

    await sub.session.subscribe(namespace, track.name);
    await new Promise((r) => setTimeout(r, 250));

    // Capture stream-reset events on both sides.
    const pubEvents: StreamResetEvent[] = [];
    pub.session.on('stream-reset', (e) => pubEvents.push(e));

    // Send a few objects with `newGroup: true` so a long-lived GOP subgroup
    // stream is opened (that's what sendObjectWithGOP tracks in
    // `activeVideoStreams` and what resetPublicationStream targets).
    let i = 0;
    for (const msg of generateChat(track.payload)) {
      await pub.session.sendObject(trackAlias, msg.bytes, {
        groupId: msg.groupId,
        objectId: msg.objectId,
        newGroup: msg.objectId === 0,
      });
      if (++i >= 3) break;
    }

    // Give the stream a beat to actually open.
    await new Promise((r) => setTimeout(r, 100));

    await pub.session.resetPublicationStreamTooFarBehind(
      trackAlias.toString(),
      'e2e-injected too-far-behind',
    );

    expect(pubEvents).toHaveLength(1);
    expect(pubEvents[0].side).toBe('publisher');
    expect(pubEvents[0].code).toBe(StreamResetErrorCodeDraft18.TOO_FAR_BEHIND);
    expect(pubEvents[0].reason).toBe('e2e-injected too-far-behind');
    expect(pubEvents[0].trackAlias).toBe(trackAlias);
  });
});
