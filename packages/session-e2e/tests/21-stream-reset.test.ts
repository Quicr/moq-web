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

import { afterEach, describe, it } from 'vitest';
import { StreamResetErrorCodeDraft18, isDraftAtLeast, type DraftVersion } from '@moq-web/core';

import { failOn } from '../lib/flow.js';
import { record } from '../lib/record.js';
import { makeSession, type SessionHandle } from '../lib/session-factory.js';
import { resolveProfile, makeNamespace, type Profile } from '../lib/profile.js';
import { generateChat } from '../lib/chat-generator.js';
import chatStream from '../profiles/chat-stream.json';
import type { StreamResetEvent } from '@moq-web/session';

const MOQT_VERSION = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_MOQT_VERSION ?? 'draft-18';
/** Draft-18 and later share these messages; draft-22 and draft-23 inherit them */
const isDraft18 = isDraftAtLeast(MOQT_VERSION as DraftVersion, 18);

describe.skipIf(!isDraft18)('subgroup stream-reset (§11.4.3)', () => {
  let pub: SessionHandle | undefined;
  let sub: SessionHandle | undefined;

  afterEach(async () => {
    try { await pub?.close(); } catch { /* ignore */ }
    try { await sub?.close(); } catch { /* ignore */ }
    pub = undefined;
    sub = undefined;
  });

  it('publisher emits stream-reset with the requested §15.10.4 code', async ({ task }) => {
    const profile = resolveProfile(chatStream as Profile);
    const track = profile.tracks[0];
    if (!track) throw new Error('profile has no tracks');

    const namespace = makeNamespace(profile, 'stream-reset');
    record(task, {
      flow: [
        `Pub: PUBLISH ${namespace.join('/')}/${track.name}`,
        'Sub: SUBSCRIBE the track; wait 250 ms',
        'Pub: 3 objects on one subgroup stream',
        'Wait 100 ms for the stream to open',
        "Pub: reset that stream with TOO_FAR_BEHIND, reason 'e2e-injected too-far-behind' (§11.4.3)",
        'Check: exactly one publisher-side stream-reset event, with that code, reason and track alias',
        "Not checked: whether the relay passes the reset on to the subscriber",
      ],
      expected: 'Resetting the open subgroup stream emits exactly one publisher stream-reset with TOO_FAR_BEHIND and the given reason',
      inputs: { namespace: namespace.join('/'), track: track.name, objectsBeforeReset: 3, code: 'TOO_FAR_BEHIND', reason: 'e2e-injected too-far-behind' },
    });

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

    record(task, {
      observed: {
        events: pubEvents.map((e) => ({ side: e.side, code: e.code, reason: e.reason, trackAlias: e.trackAlias })),
      },
    });
    const evt = pubEvents[0];
    failOn(pubEvents.length !== 1
      ? [`Resetting the subgroup stream gave ${pubEvents.length} publisher stream-reset events, expected exactly 1`]
      : [
        evt!.side !== 'publisher' && `The stream-reset event came from the ${evt!.side} side, expected the publisher`,
        evt!.code !== StreamResetErrorCodeDraft18.TOO_FAR_BEHIND
          && `The stream was reset with code ${evt!.code}, expected TOO_FAR_BEHIND (${StreamResetErrorCodeDraft18.TOO_FAR_BEHIND})`,
        evt!.reason !== 'e2e-injected too-far-behind' && `The stream-reset reason was "${evt!.reason}", expected "e2e-injected too-far-behind"`,
        evt!.trackAlias !== trackAlias && `The stream-reset was for track alias ${evt!.trackAlias}, expected ${trackAlias}`,
      ]);
  });
});
