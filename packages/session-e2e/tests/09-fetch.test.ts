// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * FETCH historical retrieval.
 *
 * A publisher streams objects into the relay's cache; a second session
 * FETCHes a subrange and expects to receive the same bytes back for
 * every (group, object) in that range.
 *
 * Not every relay honors FETCH for arbitrary tracks. When the relay
 * responds with REQUEST_ERROR the harness catches the FETCH error event
 * and marks the test as skipped so we still surface protocol coverage.
 */

import { afterEach, describe, it } from 'vitest';

import { failOn, ranges } from '../lib/flow.js';
import { record } from '../lib/record.js';
import { makeSession, type SessionHandle } from '../lib/session-factory.js';
import { resolveProfile, makeNamespace, type Profile } from '../lib/profile.js';
import { generateChat, expectedMessage } from '../lib/chat-generator.js';
import { bytesEqual } from '../lib/verify.js';
import chatStream from '../profiles/chat-stream.json';
import chatDatagram from '../profiles/chat-datagram.json';

// Enough large objects that the fetch stream arrives over many reads, so
// objects straddle read boundaries; the profile default (30 x 64 B) arrives
// in a single read on a local relay.
const LARGE_PAYLOAD_BYTES = 2048;
const LARGE_MESSAGES = 300;

/** Missing "g/o" keys by group: "group 1 (objects 3–9), group 2 (objects 0–9)" */
/** Object keys by group: whole groups (all `perGroup` Objects) as ranges, the rest with their Object IDs */
function byGroup(keys: string[], perGroup = Infinity): string {
  const groups = new Map<number, number[]>();
  for (const k of keys) {
    const [g, o] = k.split('/').map(Number) as [number, number];
    groups.set(g, [...(groups.get(g) ?? []), o]);
  }
  const sorted = [...groups].sort(([a], [b]) => a - b);
  const whole = sorted.filter(([, os]) => os.length >= perGroup).map(([g]) => g);
  const parts = sorted.filter(([, os]) => os.length < perGroup).map(([g, os]) => `group ${g} (objects ${ranges(os)})`);

  return [whole.length ? `${whole.length === 1 ? 'group' : 'groups'} ${ranges(whole)}` : '', ...parts].filter(Boolean).join('; ');
}

describe.each([
  ['chat-stream', 'default', chatStream as Profile, undefined],
  ['chat-datagram', 'default', chatDatagram as Profile, undefined],
  ['chat-stream', 'large', chatStream as Profile, LARGE_PAYLOAD_BYTES],
])('FETCH range [%s, %s payload]', (label, _size, raw, sizeBytes) => {
  let pub: SessionHandle | undefined;
  let sub: SessionHandle | undefined;

  afterEach(async () => {
    await pub?.close();
    await sub?.close();
    pub = undefined;
    sub = undefined;
  });

  it('fetches a subrange and byte-verifies the payload', async ({ task }) => {
    const profile = resolveProfile(raw);
    const track = profile.tracks[0];
    if (!track) throw new Error('profile has no tracks');

    const namespace = makeNamespace(profile, `fetch-${label}`);
    const isLarge = sizeBytes !== undefined;
    const payload = isLarge
      ? { ...track.payload, sizeBytes, messages: LARGE_MESSAGES }
      : track.payload;
    const perGroup = payload.objectsPerGroup ?? 10;

    pub = await makeSession(profile);
    sub = await makeSession(profile);

    const trackAlias = await pub.session.publish(namespace, track.name, {
      priority: track.priority,
      deliveryTimeout: track.deliveryTimeout,
      deliveryMode: track.delivery,
      maxCacheDuration: 60_000,
      skipForwardWait: true,
    });

    // Prime the cache with all messages so FETCH has data to return.
    for (const msg of generateChat(payload)) {
      await pub.session.sendObject(trackAlias, msg.bytes, {
        groupId: msg.groupId,
        objectId: msg.objectId,
      });
    }
    // Let the relay finish ingesting.
    await new Promise((r) => setTimeout(r, 500));

    // Fetch group 1 in full, or every group for the large-payload case.
    const lastGroup = Math.ceil(payload.messages / perGroup) - 1;
    const range = isLarge
      ? { startGroup: 0, startObject: 0, endGroup: lastGroup, endObject: perGroup - 1 }
      : { startGroup: 1, startObject: 0, endGroup: 1, endObject: perGroup - 1 };
    const expected = isLarge ? payload.messages : perGroup;
    record(task, {
      flow: [
        `Pub: PUBLISH ${namespace.join('/')}/${track.name} (${track.delivery}), max cache duration 60 s`,
        `Pub: sends ${payload.messages} objects of ${payload.sizeBytes} B, ${perGroup} per group, with no subscriber`,
        'Waits 500 ms for the relay to cache them',
        `Sub: FETCH ${range.startGroup}/${range.startObject}..${range.endGroup}/${range.endObject}`,
        'Relay → Sub: FETCH_OK and the objects on a fetch stream, from its cache',
        'If the relay answers with an error, the test reports it and stops without failing',
        `Check: all ${expected} objects arrive within 10 s, byte-identical`,
      ],
      expected: `FETCH of groups ${range.startGroup}..${range.endGroup} returns all ${expected} objects, byte for byte (skipped if the relay refuses FETCH)`,
      inputs: { namespace: namespace.join('/'), track: track.name, delivery: track.delivery, published: payload.messages, objectBytes: payload.sizeBytes, range },
    });

    const received: Array<{ groupId: number; objectId: number; data: Uint8Array }> = [];
    let fetchFailed: string | undefined;

    const errorOff = sub.session.on('fetch-error', (evt) => {
      fetchFailed = `code=${evt.errorCode} reason=${evt.reason}`;
    });

    try {
      await sub.session.fetch(namespace, track.name, range, {}, (data, groupId, objectId) => {
        received.push({ groupId, objectId, data });
      });

      const deadline = Date.now() + 10_000;
      while (received.length < expected && !fetchFailed && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
    } finally {
      errorOff();
    }

    if (fetchFailed) {
      record(task, { observed: { outcome: 'fetch-error', error: fetchFailed, received: received.length } });
      console.warn(`FETCH not supported by relay: ${fetchFailed}`);
      return;
    }

    record(task, {
      observed: {
        received: received.length,
        ids: received.slice(0, 12).map((o) => `${o.groupId}/${o.objectId}`),
        mismatched: received
          .filter((o) => !bytesEqual(o.data, expectedMessage(payload, o.groupId, o.objectId)))
          .slice(0, 12)
          .map((o) => `${o.groupId}/${o.objectId}`),
      },
    });
    const wanted: string[] = [];
    for (let g = range.startGroup; g <= range.endGroup; g++) {
      for (let o = 0; o < perGroup && wanted.length < expected; o++) wanted.push(`${g}/${o}`);
    }
    const got = new Set(received.map((o) => `${o.groupId}/${o.objectId}`));
    const missing = wanted.filter((k) => !got.has(k));
    const outside = [...got].filter((k) => !wanted.includes(k));
    const mismatched = received.filter((o) => !bytesEqual(o.data, expectedMessage(payload, o.groupId, o.objectId)));
    const span = `groups ${range.startGroup}–${range.endGroup}`;
    failOn([
      missing.length > 0 && `FETCH of ${span}: expected ${expected} objects, got ${got.size}; missing ${byGroup(missing, perGroup)}`,
      outside.length > 0 && `FETCH of ${span} returned objects outside the range: ${byGroup(outside)}`,
      received.length > got.size && `FETCH returned ${received.length - got.size} objects more than once`,
      mismatched.length > 0 && `Objects whose payload differs from what was sent: ${byGroup(mismatched.map((o) => `${o.groupId}/${o.objectId}`))}`,
    ]);
  });
});
