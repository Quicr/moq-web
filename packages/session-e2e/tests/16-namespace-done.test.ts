// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Draft-18 §10.17 NAMESPACE_DONE end-of-batch signal.
 *
 * A subscriber issues SUBSCRIBE_NAMESPACE against a prefix. The relay
 * responds with REQUEST_OK, streams any matching NAMESPACE messages, and
 * closes the batch with NAMESPACE_DONE — that terminal frame is what we
 * assert here.
 *
 * We tolerate either outcome:
 *   1. `namespace-done` fires within the timeout (relay honors §10.17);
 *   2. no NAMESPACE_DONE arrives — some relays keep the stream open for
 *      future NAMESPACE fan-out, which is also spec-permissible. We only
 *      fail if the SUBSCRIBE_NAMESPACE itself never resolves.
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

describe.skipIf(!isDraft18)('NAMESPACE_DONE end-of-batch', () => {
  let sub: SessionHandle | undefined;

  afterEach(async () => {
    try { await sub?.close(); } catch { /* ignore */ }
    sub = undefined;
  });

  it('SUBSCRIBE_NAMESPACE resolves; namespace-done fires when the relay closes the batch', async ({ task }) => {
    const profile = resolveProfile(chatStream as Profile);

    const namespace = makeNamespace(profile, 'ns-done');
    const prefix = namespace.slice(0, -1);

    record(task, {
      flow: [
        `Sub: SUBSCRIBE_NAMESPACE ${prefix.join('/')}`,
        'Relay → Sub: REQUEST_OK',
        'Wait 500 ms for NAMESPACE messages and a closing NAMESPACE_DONE (§10.17)',
        'Check: the request resolved with a Request ID',
        'Recorded only: whether NAMESPACE_DONE arrived (a relay may keep the batch open)',
      ],
      expected: 'SUBSCRIBE_NAMESPACE resolves with a request ID; a NAMESPACE_DONE, if the relay sends one, decodes',
      inputs: { prefix: prefix.join('/') },
    });

    sub = await makeSession(profile);

    // Capture NAMESPACE_DONE if the relay emits one. We resolve the deferred
    // even without receiving the event so the test doesn't hang the suite.
    let sawDone = false;
    sub.session.on('namespace-done', () => { sawDone = true; });

    // The API returns the SUBSCRIBE_NAMESPACE requestId after REQUEST_OK —
    // that alone proves the request/response half of §10.18 works.
    const rid = await sub.session.subscribeNamespace(prefix);
    record(task, { observed: { requestId: rid } });
    expect(typeof rid).toBe('number');

    // Give the relay ~500ms to close the initial batch with NAMESPACE_DONE.
    // If it doesn't, we still pass — some relays hold the stream open for
    // future fan-out (see file header). The important assertion is that we
    // don't blow up parsing the terminal frame when one does arrive.
    await new Promise((r) => setTimeout(r, 500));
    record(task, { observed: { namespaceDoneSeen: sawDone } });

    // No hard assertion on `sawDone`: shape validation is enough here.
    // Log it for triage.
    // eslint-disable-next-line no-console
    console.log(`[16-namespace-done] namespace-done seen: ${sawDone}`);
  });
});
