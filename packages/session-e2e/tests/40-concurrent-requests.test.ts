// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Stream-credit flow control, which replaced MAX_REQUEST_ID.
 *
 * Draft-17 removed MAX_REQUEST_ID: each request now holds a bidirectional
 * stream, and each subgroup a unidirectional one, so the limits are the QUIC
 * stream credits the peer grants. Two flows:
 *
 * - Open requests: one session subscribes to 150 tracks at once. Those over
 *   the relay's limit must fail quickly and leave the session usable; after
 *   20 are unsubscribed, 20 new requests must succeed (credit comes back as
 *   streams close).
 * - Short-lived streams: 150 groups on one track, one stream each, more than
 *   a typical initial limit of 100. All must arrive, which needs both sides to
 *   keep granting unidirectional stream credit.
 *
 * Draft-22 and later.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { isDraft22, payloadOf, Received, sleep, waitUntil, within } from '../lib/flow.js';
import { record } from '../lib/record.js';
import { makeSession, type SessionHandle } from '../lib/session-factory.js';
import { resolveProfile, makeNamespace, type Profile } from '../lib/profile.js';
import chatStream from '../profiles/chat-stream.json';

const TRACKS = 150;
const FREED = 20;
const GROUPS = 150;
/** Tracks per publisher session, well under any stream limit */
const PER_PUBLISHER = 50;

describe.skipIf(!isDraft22)('Stream-credit flow control', () => {
  let handles: SessionHandle[] = [];

  // Closing sessions with 150 open requests can take a while
  afterEach(async () => {
    await Promise.all(handles.map((h) => h.close()));
    handles = [];
  }, 60_000);

  it(`requests over the open-stream limit fail cleanly, and freeing ${FREED} lets ${FREED} more through`, async ({ task }) => {
    const profile = resolveProfile(chatStream as Profile);
    const namespace = makeNamespace(profile, 'stream-credit');
    record(task, {
      flow: [
        `Pubs: PUBLISH ${TRACKS + FREED} tracks, ${PER_PUBLISHER} per publisher session, each publisher under its own namespace`,
        `Sub: ${TRACKS} SUBSCRIBEs at once on one session, each its own bidi stream (no MAX_REQUEST_ID since draft-17)`,
        'Relay → Sub: each SUBSCRIBE gets SUBSCRIBE_OK or fails (REQUEST_ERROR or stream refused) within 20 s',
        `Sub: UNSUBSCRIBE ${FREED} of the answered ones; waits 1 s for stream credit to come back`,
        `Sub: ${FREED} new SUBSCRIBEs to tracks not yet subscribed`,
        'Check: no SUBSCRIBE went unanswered for 20 s, and the session was still ready after the burst',
        `Check: all ${FREED} new SUBSCRIBEs succeeded`,
      ],
      expected: `Of ${TRACKS} SUBSCRIBEs sent at once, each is answered or fails within 20 s, and the session stays ready; after ${FREED} UNSUBSCRIBEs, ${FREED} new SUBSCRIBEs succeed`,
      inputs: { namespace: namespace.join('/'), tracks: TRACKS, freed: FREED },
    });
    const sub = await makeSession(profile);
    handles.push(sub);
    // A PUBLISH holds a stream too, so the tracks are spread over publishers of PER_PUBLISHER each,
    // each under its own namespace (some relays tie a namespace to one publisher)
    const nsOf = (i: number) => [...namespace, `p${Math.floor(i / PER_PUBLISHER)}`];
    const publishFailed: string[] = [];
    for (let first = 0; first < TRACKS + FREED; first += PER_PUBLISHER) {
      const pub = await makeSession(profile);
      handles.push(pub);
      for (let i = first; i < Math.min(first + PER_PUBLISHER, TRACKS + FREED); i++) {
        await pub.session.publish(nsOf(i), `t${i}`, { deliveryMode: 'stream', skipForwardWait: true })
          .catch((err: unknown) => publishFailed.push(`t${i}: ${(err as Error).message}`));
      }
    }
    expect(publishFailed, 'publishing the tracks under test').toEqual([]);

    const results = await Promise.allSettled(Array.from({ length: TRACKS }, (_, i) =>
      within(sub.session.subscribe(nsOf(i), `t${i}`, { filterType: 'latest' }, () => undefined), 20_000, `SUBSCRIBE t${i}`)));
    const ok = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    const refused = results.flatMap((r) => (r.status === 'rejected' ? [(r.reason as Error).message] : []));
    const hung = refused.filter((m) => /no answer within/.test(m)).length;
    const stateAfterBurst = sub.session.state;

    for (const id of ok.slice(0, FREED)) await sub.session.unsubscribe(id);
    await sleep(1_000);
    const again = await Promise.allSettled(Array.from({ length: FREED }, (_, i) =>
      within(sub.session.subscribe(nsOf(TRACKS + i), `t${TRACKS + i}`, { filterType: 'latest' }, () => undefined), 10_000, `SUBSCRIBE t${TRACKS + i}`)));
    const againFailed = again.flatMap((r) => (r.status === 'rejected' ? [(r.reason as Error).message] : []));
    record(task, {
      observed: {
        answered: ok.length,
        refused: refused.length,
        hung,
        firstRefusal: refused[0] ?? 'none',
        stateAfterBurst,
        afterFreeing: `${FREED - againFailed.length}/${FREED}`,
        afterFreeingErrors: againFailed.slice(0, 5),
      },
    });

    expect(hung, 'SUBSCRIBEs neither answered nor refused within 20 s').toBe(0);
    expect(stateAfterBurst).toBe('ready');
    expect(againFailed, `SUBSCRIBEs after ${FREED} UNSUBSCRIBEs`).toEqual([]);
  }, 90_000);

  it(`${GROUPS} groups, one stream each, all arrive`, async ({ task }) => {
    const profile = resolveProfile(chatStream as Profile);
    const namespace = makeNamespace(profile, 'uni-credit');
    record(task, {
      flow: [
        'Pub: PUBLISH ns/t (stream)',
        'Sub: SUBSCRIBE ns/t, filter Largest Object; waits 300 ms',
        `Pub: ${GROUPS} groups of one Object each, one unidirectional stream per group, sent back to back`,
        'Relay → Sub: forwards each group on its own stream, needing fresh uni stream credit from both sides',
        'Sub: waits up to 20 s for every group',
        'Check: no publisher-side send failed and every group arrived',
      ],
      expected: `All ${GROUPS} single-Object groups arrive within 20 s; each group is its own unidirectional stream, so this passes only if stream credit keeps being granted`,
      inputs: { track: `${namespace.join('/')}/t`, groups: GROUPS },
    });
    const pub = await makeSession(profile);
    const sub = await makeSession(profile);
    handles.push(pub, sub);
    const alias = await pub.session.publish(namespace, 't', { deliveryMode: 'stream', skipForwardWait: true });
    const got = new Received();
    await sub.session.subscribe(namespace, 't', { filterType: 'latest' }, got.onObject);
    await sleep(300);

    const sendErrors: string[] = [];
    for (let g = 0; g < GROUPS; g++) {
      await pub.session.sendObject(alias, payloadOf(g, 0), { groupId: g, objectId: 0 })
        .catch((err: unknown) => sendErrors.push(`g${g}: ${(err as Error).message}`));
    }
    await waitUntil(() => got.keys.length >= GROUPS, 20_000);
    const missing = Array.from({ length: GROUPS }, (_, g) => `${g}/0`).filter((k) => !got.has(k));
    record(task, { observed: { received: got.keys.length, sendErrors: sendErrors.slice(0, 5), missing: missing.slice(0, 20), corrupt: got.corrupt } });

    expect(sendErrors, 'publisher-side send failures').toEqual([]);
    expect(missing, 'groups that never arrived').toEqual([]);
  }, 60_000);
});
