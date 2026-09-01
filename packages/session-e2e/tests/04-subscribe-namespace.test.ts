// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * SUBSCRIBE_NAMESPACE bidirectional flow.
 *
 * Session B subscribes to a namespace prefix. Session A then announces a
 * track under that prefix; the relay must fan the announcement out to B,
 * which raises the `incoming-publish` event. That event is the signal that
 * subscribe-namespace matched. Covers the incoming-subscribe / incoming-
 * publish surface without requiring a live media flow.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { makeSession, type SessionHandle } from '../lib/session-factory.js';
import { resolveProfile, makeNamespace, type Profile } from '../lib/profile.js';
import chatStream from '../profiles/chat-stream.json';
import chatDatagram from '../profiles/chat-datagram.json';

describe.each([
  ['chat-stream', chatStream as Profile],
  ['chat-datagram', chatDatagram as Profile],
])('SUBSCRIBE_NAMESPACE fan-out [%s]', (label, raw) => {
  let pub: SessionHandle | undefined;
  let sub: SessionHandle | undefined;

  afterEach(async () => {
    await pub?.close();
    await sub?.close();
    pub = undefined;
    sub = undefined;
  });

  it('subscriber sees incoming-publish when publisher announces under the prefix', async () => {
    const profile = resolveProfile(raw);
    const track = profile.tracks[0];
    if (!track) throw new Error('profile has no tracks');

    const namespace = makeNamespace(profile, `nssub-${label}`);
    const prefix = namespace.slice(0, -1);

    pub = await makeSession(profile);
    sub = await makeSession(profile);

    const incoming = new Promise<{ namespace: string[]; trackName: string }>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('timed out waiting for incoming-publish')),
        10_000,
      );
      sub!.session.on('incoming-publish', (evt) => {
        clearTimeout(timer);
        resolve({ namespace: evt.namespace, trackName: evt.trackName });
      });
    });

    await sub.session.subscribeNamespace(prefix);
    // Small settle before the publisher announces, so the relay has the
    // subscription in its table.
    await new Promise((r) => setTimeout(r, 200));

    await pub.session.publish(namespace, track.name, {
      priority: track.priority,
      deliveryTimeout: track.deliveryTimeout,
      deliveryMode: track.delivery,
    });

    const evt = await incoming;
    expect(evt.trackName).toBe(track.name);
    expect(evt.namespace.join('/')).toBe(namespace.join('/'));
  });
});
