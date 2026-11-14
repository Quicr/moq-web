// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Setup Options the relay advertises, and one of them honoured in a flow.
 *
 * SERVER_SETUP carries the relay's Setup Options. Each even option must
 * hold a varint and each odd one bytes. MAX_REQUEST_UPDATES (draft-22
 * §9.1.7) bounds the REQUEST_UPDATEs outstanding on one request stream: the
 * subscriber sends that many at once (at most 4, and 4 when the relay sets
 * no limit) and every one must get its REQUEST_UPDATE_OK, in order.
 * Draft-22 and later.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { isDraft22, sleep, within } from '../lib/flow.js';
import { record } from '../lib/record.js';
import { makeSession, type SessionHandle } from '../lib/session-factory.js';
import { resolveProfile, makeNamespace, type Profile } from '../lib/profile.js';
import chatStream from '../profiles/chat-stream.json';

describe.skipIf(!isDraft22)('Setup Options', () => {
  let handles: SessionHandle[] = [];

  afterEach(async () => {
    for (const h of handles) await h.close();
    handles = [];
  });

  it('advertised options are well formed, and MAX_REQUEST_UPDATES outstanding updates are all answered', async ({ task }) => {
    const profile = resolveProfile(chatStream as Profile);
    const namespace = makeNamespace(profile, 'setup-options');
    const pub = await makeSession(profile);
    const sub = await makeSession(profile);
    handles.push(pub, sub);

    const options = [...(sub.session.peerExtensions ?? new Map())].map(([key, value]) => ({
      key: `0x${key.toString(16)}`,
      kind: 'varint' in value ? 'varint' : 'bytes',
      wellFormed: (key % 2 === 0) === ('varint' in value),
    }));
    const limit = (sub.session as unknown as { peerMaxRequestUpdates: number }).peerMaxRequestUpdates;
    const updates = limit > 0 ? Math.min(limit, 4) : 4;
    record(task, {
      expected: `Every advertised Setup Option has a varint for an even key and bytes for an odd one; ${updates} REQUEST_UPDATEs sent at once on one subscription each get a REQUEST_UPDATE_OK`,
      inputs: { track: `${namespace.join('/')}/t`, relayMaxRequestUpdates: limit || 'no limit', updatesSentAtOnce: updates },
    });

    await pub.session.publish(namespace, 't', { deliveryMode: 'stream', skipForwardWait: true });
    const ok = new Promise<bigint>((resolve) => sub.session.on('subscribe-ok', (evt) => resolve(evt.requestId)));
    await within(sub.session.subscribe(namespace, 't', { filterType: 'latest' }, () => undefined), 5_000, 'SUBSCRIBE');
    const requestId = await within(ok, 2_000, 'SUBSCRIBE_OK');
    await sleep(200);

    // Alternate pause and resume, so each update changes something
    const answered: number[] = [];
    const results = await Promise.allSettled(Array.from({ length: updates }, (_, i) =>
      within(sub.session.sendRequestUpdate(requestId, i % 2 === 1), 5_000, `REQUEST_UPDATE ${i}`).then(() => answered.push(i))));
    const failed = results.flatMap((r, i) => (r.status === 'rejected' ? [`#${i}: ${(r.reason as Error).message}`] : []));
    record(task, { observed: { options, answeredInOrder: answered, failed } });

    expect(options.filter((o) => !o.wellFormed), 'Setup Options with the wrong value kind for their key').toEqual([]);
    expect(failed, 'REQUEST_UPDATEs not answered').toEqual([]);
    expect(answered, 'REQUEST_UPDATE_OK order').toEqual(Array.from({ length: updates }, (_, i) => i));
  });
});
