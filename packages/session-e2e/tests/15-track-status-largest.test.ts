// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Draft-18 §10.14 TRACK_STATUS + §10.2.9 LARGEST_OBJECT — end-to-end shape.
 *
 * We publish a track, send several objects on it, then issue a TRACK_STATUS
 * query from a second session. The relay is not required to forward the
 * query to our publisher session — some relay implementations answer status
 * queries themselves — so this test asserts:
 *   1. `trackStatus()` resolves to a `TrackStatusResult` (or throws a
 *      REQUEST_ERROR that the test tolerates);
 *   2. when `latestGroup`/`latestObject` are present, both are `bigint` and
 *      non-negative, matching the wire semantics.
 *
 * The strict semantics — LARGEST_OBJECT matches the last object we sent —
 * are covered by the unit tests in `session-track-status.test.ts`; here we
 * only prove the request/response mechanism doesn't break end-to-end.
 */

import { isDraftAtLeast, type DraftVersion } from '@moq-web/core';
import { afterEach, describe, expect, it } from 'vitest';

import { record } from '../lib/record.js';
import { makeSession, type SessionHandle } from '../lib/session-factory.js';
import { resolveProfile, makeNamespace, type Profile } from '../lib/profile.js';
import chatStream from '../profiles/chat-stream.json';

const MOQT_VERSION = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_MOQT_VERSION ?? 'draft-18';
/** Draft-18 and later share these messages; draft-22 and draft-23 inherit them */
const isDraft18 = isDraftAtLeast(MOQT_VERSION as DraftVersion, 18);

describe.skipIf(!isDraft18)('TRACK_STATUS LARGEST_OBJECT round-trip', () => {
  let pub: SessionHandle | undefined;
  let requester: SessionHandle | undefined;

  afterEach(async () => {
    try { await pub?.close(); } catch { /* ignore */ }
    try { await requester?.close(); } catch { /* ignore */ }
    pub = undefined;
    requester = undefined;
  });

  it('returns a TrackStatusResult; latestGroup/latestObject shape is valid when present', async ({ task }) => {
    const profile = resolveProfile(chatStream as Profile);
    const track = profile.tracks[0];
    if (!track) throw new Error('profile has no tracks');

    const namespace = makeNamespace(profile, 'largest');

    record(task, {
      flow: [
        `Pub: PUBLISH ${namespace.join('/')}/${track.name}`,
        'Pub: objects 0/0, 1/0, 2/0 (one per group)',
        'Wait 250 ms for the relay to take them in',
        'Requester (second session): TRACK_STATUS for the track (§10.14)',
        'Relay → Requester: REQUEST_OK with LARGEST_OBJECT (§10.2.9), or REQUEST_ERROR (tolerated, test ends)',
        'Check: REQUEST_OK has a Request ID; Largest group and object, when present, are non-negative',
      ],
      expected: 'TRACK_STATUS after 3 objects answers with a Request ID and, if present, a non-negative Largest Location (REQUEST_ERROR tolerated)',
      inputs: { namespace: namespace.join('/'), track: track.name, objectsSent: ['0/0', '1/0', '2/0'] },
    });

    pub = await makeSession(profile);
    requester = await makeSession(profile);

    const trackAlias = await pub.session.publish(namespace, track.name, {
      priority: track.priority,
      deliveryTimeout: track.deliveryTimeout,
      deliveryMode: track.delivery,
    });

    // Send a handful of objects so a well-behaved relay can report a
    // non-trivial LARGEST_OBJECT.
    for (let i = 0; i < 3; i++) {
      await pub.session.sendObject(trackAlias, new TextEncoder().encode(`obj-${i}`), {
        groupId: i,
        objectId: 0,
      });
    }

    // Small delay so the relay ingests the objects before we query.
    await new Promise((r) => setTimeout(r, 250));

    let result: Awaited<ReturnType<typeof requester.session.trackStatus>> | undefined;
    let errored = false;
    try {
      result = await requester.session.trackStatus(namespace, track.name);
    } catch (err) {
      if (!/TRACK_STATUS failed/.test((err as Error).message)) throw err;
      errored = true;
      record(task, { observed: { outcome: 'REQUEST_ERROR', error: err } });
    }

    if (errored) {
      // Relay rejected — still a valid wire outcome (see 08-track-status).
      return;
    }

    record(task, {
      observed: { outcome: 'REQUEST_OK', requestId: result?.requestId, latestGroup: result?.latestGroup, latestObject: result?.latestObject },
    });
    expect(result).toBeDefined();
    expect(typeof result!.requestId).toBe('bigint');

    if (result!.latestGroup !== undefined) {
      expect(typeof result!.latestGroup).toBe('bigint');
      expect(typeof result!.latestObject).toBe('bigint');
      expect(result!.latestGroup >= 0n).toBe(true);
      expect(result!.latestObject! >= 0n).toBe(true);
    }
  });
});
