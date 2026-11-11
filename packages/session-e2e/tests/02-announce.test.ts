// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * PUBLISH_NAMESPACE (announce) round-trip against a live relay.
 *
 * A publisher-side session issues `announceNamespace()` and expects the
 * relay to reply with REQUEST_OK. `announceNamespace()` only resolves once
 * the ack arrives, so a successful await proves the exchange happened.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { record } from '../lib/record.js';
import { makeSession, type SessionHandle } from '../lib/session-factory.js';
import { resolveProfile, makeNamespace, type Profile } from '../lib/profile.js';
import chatStream from '../profiles/chat-stream.json';
import chatDatagram from '../profiles/chat-datagram.json';

describe.each([
  ['chat-stream', chatStream as Profile],
  ['chat-datagram', chatDatagram as Profile],
])('PUBLISH_NAMESPACE round-trip [%s]', (label, raw) => {
  let handle: SessionHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  it('relay acknowledges announced namespace', async ({ task }) => {
    const profile = resolveProfile(raw);
    const namespace = makeNamespace(profile, `announce-${label}`);

    record(task, {
      expected: 'The relay answers PUBLISH_NAMESPACE with REQUEST_OK, so announceNamespace() resolves',
      inputs: { namespace: namespace.join('/') },
    });

    handle = await makeSession(profile);
    const announced = handle.session.announceNamespace(namespace);
    announced.then(
      () => record(task, { observed: { outcome: 'REQUEST_OK' } }),
      (err: unknown) => record(task, { observed: { outcome: 'rejected', error: err } }),
    );
    await expect(announced).resolves.toBeUndefined();
  });
});
