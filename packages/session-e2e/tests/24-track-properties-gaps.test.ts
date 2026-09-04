// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Draft-18 §12.8 / §12.9 — Prior Group/Object ID Gap track properties.
 *
 * The publisher advertises `priorGroupIdGap` and `priorObjectIdGap` on
 * PUBLISH. The relay parses the trackProperties KVP map and either forwards
 * it or ignores unknown keys — either way the request MUST succeed. This
 * test proves the encode path lands on the wire cleanly by confirming
 * `session.publish()` resolves with a valid track alias.
 *
 * We don't assert that the relay forwards these to subscribers — draft-18
 * relays vary in whether they mirror publisher-advertised track properties
 * downstream. The wire-round-trip is covered by the unit test in
 * `packages/session/src/track-properties.test.ts`.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { makeSession, type SessionHandle } from '../lib/session-factory.js';
import { resolveProfile, makeNamespace, type Profile } from '../lib/profile.js';
import chatStream from '../profiles/chat-stream.json';

const MOQT_VERSION = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_MOQT_VERSION ?? 'draft-18';
const isDraft18 = MOQT_VERSION === 'draft-18';

describe.skipIf(!isDraft18)('track properties: prior group/object gap (§12.8/§12.9)', () => {
  let handle: SessionHandle | undefined;

  afterEach(async () => {
    try { await handle?.close(); } catch { /* ignore */ }
    handle = undefined;
  });

  it('relay accepts PUBLISH advertising priorGroupIdGap + priorObjectIdGap', async () => {
    const profile = resolveProfile(chatStream as Profile);
    const track = profile.tracks[0];
    if (!track) throw new Error('profile has no tracks');

    const namespace = makeNamespace(profile, 'prior-gap');
    handle = await makeSession(profile);

    const trackAlias = await handle.session.publish(namespace, track.name, {
      priority: track.priority,
      deliveryTimeout: track.deliveryTimeout,
      deliveryMode: track.delivery,
      priorGroupIdGap: 1,
      priorObjectIdGap: 4,
      skipForwardWait: true,
    });

    expect(typeof trackAlias).toBe('bigint');
    expect(trackAlias >= 0n).toBe(true);
  });
});
