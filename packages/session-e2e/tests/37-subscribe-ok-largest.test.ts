// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * SUBSCRIBE_OK reports the track's Largest Location.
 *
 * A subscriber that arrives before any Object is published sees no Largest
 * Location; one that arrives after groups 0..2 (3 Objects each) were
 * published sees 2/2, the last Object sent. Draft-22 and later.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { isDraft22, publishGroups, sleep, within } from '../lib/flow.js';
import { record } from '../lib/record.js';
import { makeSession, type SessionHandle } from '../lib/session-factory.js';
import { resolveProfile, makeNamespace, type Profile } from '../lib/profile.js';
import chatStream from '../profiles/chat-stream.json';

interface Ok { contentExists: boolean; largest: string }

/** The next SUBSCRIBE_OK on `handle` */
function nextSubscribeOk(handle: SessionHandle): Promise<Ok> {
  return new Promise((resolve) => {
    const off = handle.session.on('subscribe-ok', (evt) => {
      off();
      resolve({
        contentExists: evt.contentExists,
        largest: evt.largestGroupId !== undefined ? `${evt.largestGroupId}/${evt.largestObjectId ?? '?'}` : 'none',
      });
    });
  });
}

describe.skipIf(!isDraft22)('SUBSCRIBE_OK Largest Location', () => {
  let handles: SessionHandle[] = [];

  afterEach(async () => {
    for (const h of handles) await h.close();
    handles = [];
  });

  it('is absent before any Object and is the last Object sent afterwards', async ({ task }) => {
    const profile = resolveProfile(chatStream as Profile);
    const namespace = makeNamespace(profile, 'largest');
    record(task, {
      flow: [
        `Pub: PUBLISH ${namespace.join('/')}/t, max cache 60 s`,
        'Early Sub: SUBSCRIBE t, filter Largest Object, before any object',
        'Relay → Early Sub: SUBSCRIBE_OK; wait 200 ms',
        'Pub: groups 0–2, 3 objects each; wait 500 ms',
        'Late Sub (another session): SUBSCRIBE t, filter Largest Object',
        'Relay → Late Sub: SUBSCRIBE_OK',
        'Check: the first SUBSCRIBE_OK has no Largest Location',
        'Check: the second has Largest Location 2/2 (the last object sent) and content exists',
      ],
      expected: 'First SUBSCRIBE_OK (nothing published yet): no Largest Location. Second SUBSCRIBE_OK, after groups 0..2 of 3 Objects: Largest Location 2/2',
      inputs: { track: `${namespace.join('/')}/t`, published: 'groups 0..2, 3 objects each' },
    });
    const pub = await makeSession(profile);
    const early = await makeSession(profile);
    const late = await makeSession(profile);
    handles.push(pub, early, late);
    const alias = await pub.session.publish(namespace, 't', { deliveryMode: 'stream', skipForwardWait: true, maxCacheDuration: 60_000 });

    const earlyOk = nextSubscribeOk(early);
    await within(early.session.subscribe(namespace, 't', { filterType: 'latest' }, () => undefined), 5_000, 'first SUBSCRIBE');
    const first = await within(earlyOk, 2_000, 'first SUBSCRIBE_OK');

    await sleep(200);
    const sent = await publishGroups(pub.session, alias, { groups: 3, perGroup: 3 });
    await sleep(500);

    const lateOk = nextSubscribeOk(late);
    await within(late.session.subscribe(namespace, 't', { filterType: 'latest' }, () => undefined), 5_000, 'second SUBSCRIBE');
    const second = await within(lateOk, 2_000, 'second SUBSCRIBE_OK');
    record(task, { observed: { first, second, lastSent: `${sent.largest.group}/${sent.largest.object}` } });

    expect(first.largest, 'Largest Location before any Object').toBe('none');
    expect(second.largest, 'Largest Location after groups 0..2').toBe(`${sent.largest.group}/${sent.largest.object}`);
    expect(second.contentExists).toBe(true);
  });
});
