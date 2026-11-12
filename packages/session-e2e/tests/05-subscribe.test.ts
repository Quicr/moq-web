// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * End-to-end pub/sub against a live relay.
 *
 * Session A publishes a chat track under a unique namespace.
 * Session B subscribes to the same track.
 * Every object B receives must byte-match what A sent. On a stream all of
 * them must arrive, in order; datagrams are not retransmitted, so up to 10%
 * may be lost and the report lists which.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { record } from '../lib/record.js';
import { makeSession, type SessionHandle } from '../lib/session-factory.js';
import { resolveProfile, makeNamespace, type Profile } from '../lib/profile.js';
import { generateChat, expectedMessage } from '../lib/chat-generator.js';
import { assertMonotonic, bytesEqual, collectObjects } from '../lib/verify.js';
import chatStream from '../profiles/chat-stream.json';
import chatDatagram from '../profiles/chat-datagram.json';

/** Share of datagrams that may be lost before the datagram case fails */
const DATAGRAM_LOSS_ALLOWED = 0.1;
/** How long the datagram case waits for stragglers */
const DATAGRAM_WAIT_MS = 8_000;

/** Every (group/object) the profile's payload publishes */
function generateChatKeys(payload: Parameters<typeof generateChat>[0]): string[] {
  return [...generateChat(payload)].map((m) => `${m.groupId}/${m.objectId}`);
}

describe.each([
  ['chat-stream', chatStream as Profile],
  ['chat-datagram', chatDatagram as Profile],
])('SUBSCRIBE round-trip [%s]', (label, raw) => {
  let pub: SessionHandle | undefined;
  let sub: SessionHandle | undefined;

  afterEach(async () => {
    await pub?.close();
    await sub?.close();
    pub = undefined;
    sub = undefined;
  });

  it('subscriber receives every published object byte-exactly, in order', async ({ task }) => {
    const profile = resolveProfile(raw);
    const track = profile.tracks[0];
    if (!track) throw new Error('profile has no tracks');

    const namespace = makeNamespace(profile, `subscribe-${label}`);

    pub = await makeSession(profile);
    sub = await makeSession(profile);

    // Publisher announces the track first. Skip the forward wait so draft-16
    // relays don't block on PUBLISH_OK{forward=0} before the subscriber has
    // wired up.
    const trackAlias = await pub.session.publish(namespace, track.name, {
      priority: track.priority,
      deliveryTimeout: track.deliveryTimeout,
      deliveryMode: track.delivery,
      skipForwardWait: true,
    });

    const total = track.payload.messages;
    // Datagrams are not retransmitted, so a long path can lose a few
    const datagram = track.delivery === 'datagram';
    const atLeast = datagram ? Math.ceil(total * (1 - DATAGRAM_LOSS_ALLOWED)) : total;
    record(task, {
      expected: datagram
        ? `The subscriber receives at least ${atLeast} of ${total} objects (datagrams can be lost), each byte for byte`
        : `The subscriber receives all ${total} objects, byte for byte, in order`,
      inputs: { namespace: namespace.join('/'), track: track.name, delivery: track.delivery, objects: total, atLeast, trackAlias },
    });
    const collector = collectObjects(total, datagram ? DATAGRAM_WAIT_MS : 20_000, { partial: datagram });

    await sub.session.subscribe(namespace, track.name, {}, collector.onObject);

    // Give the relay a beat to wire up the subscription before publishing.
    await new Promise((r) => setTimeout(r, 250));

    for (const msg of generateChat(track.payload)) {
      await pub.session.sendObject(trackAlias, msg.bytes, {
        groupId: msg.groupId,
        objectId: msg.objectId,
      });
    }

    const received = await collector.done;
    const arrived = new Set(received.map((o) => `${o.groupId}/${o.objectId}`));
    const lost = generateChatKeys(track.payload).filter((k) => !arrived.has(k));
    const mismatched = received.filter((o) => !bytesEqual(o.bytes, expectedMessage(track.payload, o.groupId, o.objectId)));
    record(task, {
      observed: {
        received: received.length,
        lost,
        first: received[0] ? `${received[0].groupId}/${received[0].objectId}` : 'none',
        last: received.at(-1) ? `${received.at(-1)!.groupId}/${received.at(-1)!.objectId}` : 'none',
        mismatched: mismatched.map((o) => `${o.groupId}/${o.objectId}`),
      },
    });

    if (datagram) {
      expect(received.length, `datagrams lost: ${lost.join(', ')}`).toBeGreaterThanOrEqual(atLeast);
    } else {
      expect(received).toHaveLength(total);
    }
    // Only a stream preserves order; datagrams can legitimately reorder.
    if (track.delivery === 'stream') {
      assertMonotonic(received);
    }

    for (const o of received) {
      const expected = expectedMessage(track.payload, o.groupId, o.objectId);
      expect(
        bytesEqual(o.bytes, expected),
        `mismatch at (${o.groupId},${o.objectId})`,
      ).toBe(true);
    }
  });
});
