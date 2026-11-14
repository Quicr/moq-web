// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * REQUEST_UPDATE on a SUBSCRIBE_NAMESPACE changes its prefix.
 *
 * The subscriber watches prefix …/a, then moves it to …/b with
 * TRACK_NAMESPACE_PREFIX (draft-22 §9.20.20). The relay must answer the
 * update, stop matching …/a and start matching …/b: a namespace announced
 * under …/b afterwards arrives, one announced under …/a does not.
 * Draft-22 and later.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { isDraft22, sleep, Trace, waitUntil, within } from '../lib/flow.js';
import { record } from '../lib/record.js';
import { makeSession, type SessionHandle } from '../lib/session-factory.js';
import { resolveProfile, makeNamespace, type Profile } from '../lib/profile.js';
import chatStream from '../profiles/chat-stream.json';

describe.skipIf(!isDraft22)('SUBSCRIBE_NAMESPACE prefix update', () => {
  let handles: SessionHandle[] = [];

  afterEach(async () => {
    for (const h of handles) await h.close();
    handles = [];
  });

  it('after the update, namespaces under the new prefix arrive and ones under the old do not', async ({ task }) => {
    const profile = resolveProfile(chatStream as Profile);
    const base = makeNamespace(profile, 'prefix-update');
    const oldPrefix = [...base, 'a'];
    const newPrefix = [...base, 'b'];
    const trace = new Trace();
    record(task, {
      expected: 'REQUEST_UPDATE with TRACK_NAMESPACE_PREFIX is answered within 5 s; then …/b/late arrives and …/a/late does not',
      inputs: { oldPrefix: oldPrefix.join('/'), newPrefix: newPrefix.join('/'), announcedAfter: ['a/late', 'b/late'] },
    });
    const pub = await makeSession(profile);
    const sub = await makeSession(profile);
    handles.push(pub, sub);
    trace.attach('Pub', pub.session);
    trace.attach('Sub', sub.session);

    const seen: string[] = [];
    sub.session.on('namespace-announced', (evt) => seen.push(evt.namespace.join('/')));
    const subscriptionId = await sub.session.subscribeNamespace(oldPrefix);
    await sleep(300);

    let updated = 'ok';
    try {
      await within(sub.session.updateNamespacePrefix(subscriptionId, newPrefix), 5_000, 'REQUEST_UPDATE');
    } catch (err) {
      updated = (err as Error).message;
    }
    trace.note('Sub', `prefix update: ${updated}`);

    await pub.session.announceNamespace([...oldPrefix, 'late'], { deliveryMode: 'stream' });
    await pub.session.announceNamespace([...newPrefix, 'late'], { deliveryMode: 'stream' });
    const wanted = [...newPrefix, 'late'].join('/');
    await waitUntil(() => seen.includes(wanted), 5_000);
    await sleep(500);

    trace.tearingDown = true;
    trace.print(`updated=${updated} seen=${seen.join(',')}`);
    record(task, { observed: { updated, seen, unexpected: trace.unexpected, trace: trace.lines } });

    expect(updated).toBe('ok');
    expect(seen, 'announced under the new prefix').toContain(wanted);
    expect(seen, 'announced under the old prefix').not.toContain([...oldPrefix, 'late'].join('/'));
    expect(trace.unexpected).toEqual([]);
  });
});
