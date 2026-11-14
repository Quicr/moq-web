// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Object Properties travel with each Object through the relay.
 *
 * Every Object the publisher sends carries two Object Properties of types
 * the relay does not know: 0x40 (even, a varint: group × 100 + object) and
 * 0x41 (odd, bytes: "p<group>/<object>"). Both are below the Mandatory range,
 * so a relay must forward them unchanged (draft-22 §11.1). The subscriber
 * checks both on every Object it receives. Draft-22 and later.
 */

import { MOQTVarInt } from '@moq-web/core';
import type { ObjectProperties } from '@moq-web/session';
import { afterEach, describe, expect, it } from 'vitest';

import { isDraft22, publishGroups, sleep, waitUntil, within } from '../lib/flow.js';
import { record } from '../lib/record.js';
import { makeSession, type SessionHandle } from '../lib/session-factory.js';
import { resolveProfile, makeNamespace, type Profile } from '../lib/profile.js';
import chatStream from '../profiles/chat-stream.json';

const EVEN = 0x40;
const ODD = 0x41;
const GROUPS = 3;
const PER_GROUP = 4;

const sentProperties = (g: number, o: number) => new Map<number, number | Uint8Array>([
  [EVEN, g * 100 + o],
  [ODD, new TextEncoder().encode(`p${g}/${o}`)],
]);

describe.skipIf(!isDraft22)('Object Properties', () => {
  let handles: SessionHandle[] = [];

  afterEach(async () => {
    for (const h of handles) await h.close();
    handles = [];
  });

  it('two unknown Object Properties arrive unchanged on every Object', async ({ task }) => {
    const profile = resolveProfile(chatStream as Profile);
    const namespace = makeNamespace(profile, 'object-props');
    record(task, {
      expected: `All ${GROUPS * PER_GROUP} Objects arrive, each with property 0x40 = group×100+object and 0x41 = "p<group>/<object>"`,
      inputs: { track: `${namespace.join('/')}/t`, groups: GROUPS, objectsPerGroup: PER_GROUP, properties: { '0x40': 'varint g*100+o', '0x41': 'bytes "p<g>/<o>"' } },
    });
    const pub = await makeSession(profile);
    const sub = await makeSession(profile);
    handles.push(pub, sub);
    const alias = await pub.session.publish(namespace, 't', { deliveryMode: 'stream', skipForwardWait: true });

    const seen = new Map<string, { even?: string; odd?: string }>();
    const onObject = (_d: Uint8Array, g: number, o: number, _ts: number, props?: ObjectProperties) => {
      const even = props?.get(EVEN);
      const odd = props?.get(ODD);
      seen.set(`${g}/${o}`, {
        even: even ? String(MOQTVarInt.decode(even, 0)[0]) : undefined,
        odd: odd ? new TextDecoder().decode(odd) : undefined,
      });
    };
    await within(sub.session.subscribe(namespace, 't', { filterType: 'latest' }, onObject), 5_000, 'SUBSCRIBE');
    await sleep(200);
    const sent = await publishGroups(pub.session, alias, { groups: GROUPS, perGroup: PER_GROUP, properties: sentProperties });
    await waitUntil(() => seen.size >= sent.keys.length, 5_000);

    const wrong = sent.keys.flatMap((k) => {
      const [g, o] = k.split('/').map(Number) as [number, number];
      const got = seen.get(k);
      const want = { even: String(g * 100 + o), odd: `p${g}/${o}` };
      if (!got) return [`${k}: not received`];
      return got.even === want.even && got.odd === want.odd ? [] : [`${k}: 0x40=${got.even ?? 'missing'} 0x41=${got.odd ?? 'missing'}`];
    });
    record(task, { observed: { received: seen.size, sample: Object.fromEntries([...seen].slice(0, 4)), wrong: wrong.slice(0, 10) } });

    expect(wrong, 'Objects whose properties were missing or changed').toEqual([]);
  });
});
