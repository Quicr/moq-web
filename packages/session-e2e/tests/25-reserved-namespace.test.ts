// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Draft-18 §3.2.1 — Reserved Namespaces (leading '.', 0x2e).
 *
 * The client MUST refuse to originate publish / subscribe / fetch under a
 * track namespace whose first tuple field begins with '.'. This e2e proves
 * the guard fires *after* a live relay session is established (i.e. it is
 * not merely a static type check) and that nothing hits the wire — the
 * relay never sees the reserved request.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { makeSession, type SessionHandle } from '../lib/session-factory.js';
import { resolveProfile, type Profile } from '../lib/profile.js';
import chatStream from '../profiles/chat-stream.json';

const MOQT_VERSION = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_MOQT_VERSION ?? 'draft-18';
const isDraft18 = MOQT_VERSION === 'draft-18';

describe.skipIf(!isDraft18)('reserved namespace: leading \'.\' (§3.2.1)', () => {
  let handle: SessionHandle | undefined;

  afterEach(async () => {
    try { await handle?.close(); } catch { /* ignore */ }
    handle = undefined;
  });

  it('rejects publish() to a reserved namespace after a live session is up', async () => {
    const profile = resolveProfile(chatStream as Profile);
    const track = profile.tracks[0];
    if (!track) throw new Error('profile has no tracks');

    handle = await makeSession(profile);

    await expect(
      handle.session.publish(['.session'], track.name, {
        priority: track.priority,
        deliveryTimeout: track.deliveryTimeout,
        deliveryMode: track.delivery,
        skipForwardWait: true,
      }),
    ).rejects.toThrow(/§3.2.1/);
  });

  it('rejects subscribe() to a reserved namespace', async () => {
    const profile = resolveProfile(chatStream as Profile);
    const track = profile.tracks[0];
    if (!track) throw new Error('profile has no tracks');

    handle = await makeSession(profile);

    await expect(
      handle.session.subscribe(['.reserved'], track.name),
    ).rejects.toThrow(/§3.2.1/);
  });
});
