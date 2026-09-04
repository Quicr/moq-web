// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Draft-18 §11.5 padding streams & datagrams — end-to-end against a live relay.
 *
 * Sends padding through the wire and confirms:
 *   • sendPaddingStream() completes without error (relay accepts the reserved
 *     0x132B3E28 stream type and does not echo it as an object).
 *   • sendPaddingDatagram() completes without error (relay accepts the
 *     reserved 0x132B3E29 datagram type). Since datagrams are usually not
 *     forwarded to other subscribers by relays, we only assert the send
 *     side succeeds; if a peer *does* receive it, our datagram-manager
 *     drops it silently — validated in the unit tests.
 *   • Interleaving padding with a real published object still delivers the
 *     real object to a subscriber (padding does not clog the pipeline).
 */

import { afterEach, describe, expect, it } from 'vitest';

import { makeSession, type SessionHandle } from '../lib/session-factory.js';
import { resolveProfile, makeNamespace, type Profile } from '../lib/profile.js';
import { generateChat } from '../lib/chat-generator.js';
import chatStream from '../profiles/chat-stream.json';

const MOQT_VERSION = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_MOQT_VERSION ?? 'draft-18';
const isDraft18 = MOQT_VERSION === 'draft-18';

describe.skipIf(!isDraft18)('padding streams & datagrams (§11.5)', () => {
  let pub: SessionHandle | undefined;
  let sub: SessionHandle | undefined;

  afterEach(async () => {
    try { await pub?.close(); } catch { /* ignore */ }
    try { await sub?.close(); } catch { /* ignore */ }
    pub = undefined;
    sub = undefined;
  });

  it('sendPaddingStream + sendPaddingDatagram do not disrupt normal object delivery', async () => {
    const profile = resolveProfile(chatStream as Profile);
    const track = profile.tracks[0];
    if (!track) throw new Error('profile has no tracks');

    const namespace = makeNamespace(profile, 'padding');

    pub = await makeSession(profile);
    sub = await makeSession(profile);

    const trackAlias = await pub.session.publish(namespace, track.name, {
      priority: track.priority,
      deliveryTimeout: track.deliveryTimeout,
      deliveryMode: track.delivery,
      skipForwardWait: true,
    });

    const received: Uint8Array[] = [];
    await sub.session.subscribe(namespace, track.name, undefined, (data) => {
      received.push(new Uint8Array(data));
    });
    await new Promise((r) => setTimeout(r, 250));

    // Interleave padding with real objects.
    await pub.session.sendPaddingStream(64);
    await pub.session.sendPaddingDatagram(32);

    let sent = 0;
    for (const msg of generateChat(track.payload)) {
      await pub.session.sendObject(trackAlias, msg.bytes, {
        groupId: msg.groupId,
        objectId: msg.objectId,
      });
      if (++sent >= 2) break;
    }

    await pub.session.sendPaddingStream(0);
    await pub.session.sendPaddingDatagram(0);

    // Give the relay a moment to forward the real objects.
    await new Promise((r) => setTimeout(r, 500));

    // We must have received *at least* the two real objects, and nothing
    // extra that looks like padding (padding never surfaces as an object).
    expect(received.length).toBeGreaterThanOrEqual(2);
    for (const buf of received) {
      // Real chat payloads are non-empty and non-zero. Padding would arrive
      // as all-zero bytes if it ever leaked through.
      const allZero = buf.every((b) => b === 0);
      expect(allZero).toBe(false);
    }
  });
});
