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

  it('subscriber sees namespace-announced when publisher announces under the prefix', async () => {
    const profile = resolveProfile(raw);
    const track = profile.tracks[0];
    if (!track) throw new Error('profile has no tracks');

    const namespace = makeNamespace(profile, `nssub-${label}`);
    const prefix = namespace.slice(0, -1);

    pub = await makeSession(profile);
    sub = await makeSession(profile);

    // Filter on the exact namespace we're about to announce. The relay's
    // NAMESPACE fan-out can also replay announcements from earlier CI runs
    // that used the same profile prefix + test name — those show up with a
    // different random suffix and would race ahead of ours if we resolved
    // on the first event.
    const expectedNs = namespace.join('/');
    const announced = new Promise<{ namespace: string[] }>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('timed out waiting for namespace-announced')),
        10_000,
      );
      sub!.session.on('namespace-announced', (evt) => {
        if (evt.namespace.join('/') !== expectedNs) return;
        clearTimeout(timer);
        resolve({ namespace: evt.namespace });
      });
    });

    await sub.session.subscribeNamespace(prefix);
    // Small settle before the publisher announces, so the relay has the
    // subscription in its table.
    await new Promise((r) => setTimeout(r, 200));

    // ANNOUNCE_NAMESPACE triggers the NAMESPACE fan-out on the
    // SUBSCRIBE_NAMESPACE response stream (draft-18 §7.4). Individual tracks
    // under the namespace are still resolved via SUBSCRIBE or PUBLISH bidis.
    await pub.session.announceNamespace(namespace, {
      priority: track.priority,
      deliveryTimeout: track.deliveryTimeout,
      deliveryMode: track.delivery,
    });

    const evt = await announced;
    expect(evt.namespace.join('/')).toBe(namespace.join('/'));
  });
});
