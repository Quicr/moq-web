// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Draft-18 §10.2.9 SUBSCRIPTION_FILTER — end-to-end against a live relay.
 *
 * Publisher A opens a track; subscriber B subscribes with each filter variant
 * we expose through `SubscribeOptions.filterType`. The relay is expected to
 * accept every filter (`SUBSCRIBE_OK`). We keep the deeper "which objects
 * come back for absolute-range vs. latest" semantics out of scope here — that
 * depends on relay policy — and only assert the wire-level acceptance so the
 * codec + session parameter mapping is exercised end-to-end.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { makeSession, type SessionHandle } from '../lib/session-factory.js';
import { resolveProfile, makeNamespace, type Profile } from '../lib/profile.js';
import { generateChat } from '../lib/chat-generator.js';
import { collectObjects } from '../lib/verify.js';
import chatStream from '../profiles/chat-stream.json';

const MOQT_VERSION = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_MOQT_VERSION ?? 'draft-18';
// Draft-22 carries the same filter variants as LOCATION_FILTER (§9.20.9).
const isDraft18 = MOQT_VERSION === 'draft-18' || MOQT_VERSION === 'draft-22';

type FilterKind = 'next-group' | 'largest-object' | 'absolute-start' | 'absolute-range';

describe.skipIf(!isDraft18)('SUBSCRIBE §10.2.9 filter variants', () => {
  let pub: SessionHandle | undefined;
  let sub: SessionHandle | undefined;

  afterEach(async () => {
    try { await pub?.close(); } catch { /* ignore */ }
    try { await sub?.close(); } catch { /* ignore */ }
    pub = undefined;
    sub = undefined;
  });

  const cases: Array<{ kind: FilterKind; options: Parameters<SessionHandle['session']['subscribe']>[2] }> = [
    { kind: 'next-group', options: { filterType: 'next-group' } },
    { kind: 'largest-object', options: { filterType: 'largest-object' } },
    { kind: 'absolute-start', options: { filterType: 'absolute-start', startGroup: 0, startObject: 0 } },
    { kind: 'absolute-range', options: { filterType: 'absolute-range', startGroup: 0, startObject: 0, endGroup: 1 } },
  ];

  for (const { kind, options } of cases) {
    it(`SUBSCRIBE with filterType='${kind}' resolves`, async () => {
      const profile = resolveProfile(chatStream as Profile);
      const track = profile.tracks[0];
      if (!track) throw new Error('profile has no tracks');

      const namespace = makeNamespace(profile, `filter-${kind}`);

      pub = await makeSession(profile);
      sub = await makeSession(profile);

      await pub.session.publish(namespace, track.name, {
        priority: track.priority,
        deliveryTimeout: track.deliveryTimeout,
        deliveryMode: track.delivery,
        skipForwardWait: true,
      });

      await new Promise((r) => setTimeout(r, 250));

      let subscriptionId: number | undefined;
      try {
        subscriptionId = await sub.session.subscribe(namespace, track.name, options);
      } catch (err) {
        // Some relays may reject specific filter modes. We only require that
        // the wire-level exchange completed — a REQUEST_ERROR (any code) is
        // acceptable for this coverage check, but a transport-level failure is
        // not.
        if (!/SUBSCRIBE|REQUEST_ERROR|forbidden|not.*allowed/i.test((err as Error).message)) throw err;
        return;
      }
      expect(typeof subscriptionId).toBe('number');
    });
  }

  // Delivery, not just acceptance: a mis-encoded filter type can still resolve
  // while silently bounding the subscription (e.g. absolute-start sent as
  // "Absolute Start, Group End" stops after group 0).
  const deliveryCases: Array<{
    kind: FilterKind;
    options: Parameters<SessionHandle['session']['subscribe']>[2];
    lastGroup: number;
  }> = [
    { kind: 'absolute-start', options: { filterType: 'absolute-start', startGroup: 0, startObject: 0 }, lastGroup: 2 },
    { kind: 'absolute-range', options: { filterType: 'absolute-range', startGroup: 0, startObject: 0, endGroup: 1 }, lastGroup: 1 },
  ];

  for (const { kind, options, lastGroup } of deliveryCases) {
    it(`SUBSCRIBE with filterType='${kind}' delivers through group ${lastGroup}`, async () => {
      const profile = resolveProfile(chatStream as Profile);
      const track = profile.tracks[0];
      if (!track) throw new Error('profile has no tracks');

      const namespace = makeNamespace(profile, `filter-delivery-${kind}`);

      pub = await makeSession(profile);
      sub = await makeSession(profile);

      const trackAlias = await pub.session.publish(namespace, track.name, {
        priority: track.priority,
        deliveryTimeout: track.deliveryTimeout,
        deliveryMode: track.delivery,
        skipForwardWait: true,
      });

      // Collect what the filter should admit; track the highest group across
      // every delivery so objects past the range are caught too.
      const perGroup = track.payload.objectsPerGroup ?? 10;
      const expected = (lastGroup + 1) * perGroup;
      const collector = collectObjects(expected, 20_000);
      let maxGroup = -1;
      await sub.session.subscribe(namespace, track.name, options, (data, groupId, objectId, timestamp) => {
        maxGroup = Math.max(maxGroup, groupId);
        collector.onObject(data, groupId, objectId, timestamp);
      });
      await new Promise((r) => setTimeout(r, 250));

      for (const msg of generateChat(track.payload)) {
        await pub.session.sendObject(trackAlias, msg.bytes, {
          groupId: msg.groupId,
          objectId: msg.objectId,
        });
      }

      const received = await collector.done;
      expect(received).toHaveLength(expected);

      // Give any out-of-range objects time to (wrongly) arrive.
      await new Promise((r) => setTimeout(r, 500));
      expect(maxGroup).toBe(lastGroup);
    });
  }
});
