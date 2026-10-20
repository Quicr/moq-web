// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * PUBLISH_DONE on the PUBLISH request stream (draft-18 / draft-22 §9.9).
 *
 * `unpublish()` sends PUBLISH_DONE as the final message on the PUBLISH
 * request's bidi stream and then closes it. Sending it on the control
 * stream instead makes the relay terminate the session, so a follow-up
 * `publish()` on the same session proves the session survived.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { makeSession, type SessionHandle } from '../lib/session-factory.js';
import { resolveProfile, makeNamespace, type Profile } from '../lib/profile.js';
import chatStream from '../profiles/chat-stream.json';

const MOQT_VERSION = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_MOQT_VERSION ?? 'draft-18';
const isDraft18Family = MOQT_VERSION === 'draft-18' || MOQT_VERSION === 'draft-22';
const OBJECT_COUNT = 3;

describe.skipIf(!isDraft18Family)('PUBLISH_DONE delivery (§9.9)', () => {
  let pub: SessionHandle | undefined;

  afterEach(async () => {
    await pub?.close();
    pub = undefined;
  });

  it('session stays usable after unpublish()', async () => {
    const profile = resolveProfile(chatStream as Profile);
    const track = profile.tracks[0];
    if (!track) throw new Error('profile has no tracks');

    const namespace = makeNamespace(profile, 'publish-done');
    pub = await makeSession(profile);

    const trackAlias = await pub.session.publish(namespace, track.name, {
      priority: track.priority,
      deliveryTimeout: track.deliveryTimeout,
      deliveryMode: track.delivery,
      skipForwardWait: true,
    });

    for (let i = 0; i < OBJECT_COUNT; i++) {
      await pub.session.sendObject(trackAlias, new Uint8Array([i]), { groupId: i, objectId: 0 });
    }

    await pub.session.unpublish(trackAlias);

    const secondAlias = await pub.session.publish(namespace, `${track.name}-2`, {
      priority: track.priority,
      deliveryTimeout: track.deliveryTimeout,
      deliveryMode: track.delivery,
      skipForwardWait: true,
    });

    expect(typeof secondAlias).toBe('bigint');
  });
});
