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

import { isDraftAtLeast, type DraftVersion } from '@moq-web/core';
import { afterEach, describe, expect, it } from 'vitest';

import { record } from '../lib/record.js';
import { makeSession, type SessionHandle } from '../lib/session-factory.js';
import { resolveProfile, type Profile } from '../lib/profile.js';
import chatStream from '../profiles/chat-stream.json';

const MOQT_VERSION = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_MOQT_VERSION ?? 'draft-18';
/** Draft-18 and later share these messages; draft-22 and draft-23 inherit them */
const isDraft18 = isDraftAtLeast(MOQT_VERSION as DraftVersion, 18);

describe.skipIf(!isDraft18)('reserved namespace: leading \'.\' (§3.2.1)', () => {
  let handle: SessionHandle | undefined;

  afterEach(async () => {
    try { await handle?.close(); } catch { /* ignore */ }
    handle = undefined;
  });

  it('rejects publish() to a reserved namespace after a live session is up', async ({ task }) => {
    const profile = resolveProfile(chatStream as Profile);
    const track = profile.tracks[0];
    if (!track) throw new Error('profile has no tracks');

    record(task, {
      flow: [
        'Client: CLIENT_SETUP / SERVER_SETUP, session ready',
        `Client: publish() .session/${track.name}, a namespace starting with '.' (§3.2.1)`,
        'Check: publish() rejects locally citing §3.2.1; no PUBLISH is sent',
      ],
      expected: 'publish() under a namespace starting with "." rejects locally, citing §3.2.1, before anything is sent',
      inputs: { namespace: '.session', track: track.name },
    });
    handle = await makeSession(profile);

    const published = handle.session.publish(['.session'], track.name, {
      priority: track.priority,
      deliveryTimeout: track.deliveryTimeout,
      deliveryMode: track.delivery,
      skipForwardWait: true,
    });
    published.then(
      () => record(task, { observed: { outcome: 'resolved' } }),
      (err: unknown) => record(task, { observed: { outcome: 'rejected', error: err } }),
    );
    await expect(published).rejects.toThrow(/§3.2.1/);
  });

  it('rejects subscribe() to a reserved namespace', async ({ task }) => {
    const profile = resolveProfile(chatStream as Profile);
    const track = profile.tracks[0];
    if (!track) throw new Error('profile has no tracks');

    record(task, {
      flow: [
        'Client: CLIENT_SETUP / SERVER_SETUP, session ready',
        `Client: subscribe() .reserved/${track.name}, a namespace starting with '.' (§3.2.1)`,
        'Check: subscribe() rejects locally citing §3.2.1; no SUBSCRIBE is sent',
      ],
      expected: 'subscribe() under a namespace starting with "." rejects locally, citing §3.2.1',
      inputs: { namespace: '.reserved', track: track.name },
    });
    handle = await makeSession(profile);

    const subscribed = handle.session.subscribe(['.reserved'], track.name);
    subscribed.then(
      () => record(task, { observed: { outcome: 'resolved' } }),
      (err: unknown) => record(task, { observed: { outcome: 'rejected', error: err } }),
    );
    await expect(subscribed).rejects.toThrow(/§3.2.1/);
  });
});
