// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Unit tests for draft-18 §3.2.1 reserved-namespace enforcement.
 *
 * §3.2.1 reserves Track Namespaces whose first tuple field begins with the
 * period byte (0x2e). This client refuses to originate any outbound request
 * under such a namespace — publish, subscribe, fetch, track-status,
 * subscribe-namespace, subscribe-tracks, and announce all reject before
 * touching the wire.
 *
 * The check is bypass-safe: it fires *after* the `isReady` gate, so the
 * error path is deterministic and independent of transport state.
 */

import { describe, it, expect, vi } from 'vitest';
import { IS_DRAFT_18, MOQTransport } from '@moq-web/core';

import { MOQTSession } from './session.js';

function makeReadySession(): MOQTSession {
  const transport = new MOQTransport();
  (transport as unknown as { close: typeof transport.close }).close = vi.fn().mockResolvedValue(undefined);
  const session = new MOQTSession(transport);
  (session as unknown as { _state: string })._state = 'ready';
  return session;
}

describe('draft-18 §3.2.1 reserved namespace enforcement', () => {
  it('refuses PUBLISH under a namespace whose first field starts with "."', async () => {
    const session = makeReadySession();
    await expect(session.publish(['.session'], 'ctl')).rejects.toThrow(/§3.2.1/);
    await expect(session.publish(['.'], 'anything')).rejects.toThrow(/§3.2.1/);
  });

  it('refuses SUBSCRIBE under a reserved namespace', async () => {
    const session = makeReadySession();
    await expect(session.subscribe(['.session'], 'ctl')).rejects.toThrow(/§3.2.1/);
  });

  it.skipIf(!IS_DRAFT_18)('refuses FETCH under a reserved namespace', async () => {
    const session = makeReadySession();
    await expect(
      session.fetch(['.session'], 'ctl', { startGroup: 0, startObject: 0, endGroup: 1, endObject: 0 }),
    ).rejects.toThrow(/§3.2.1/);
  });

  it.skipIf(!IS_DRAFT_18)('refuses TRACK_STATUS under a reserved namespace', async () => {
    const session = makeReadySession();
    await expect(session.trackStatus(['.session'], 'ctl')).rejects.toThrow(/§3.2.1/);
  });

  it('refuses SUBSCRIBE_NAMESPACE under a reserved prefix', async () => {
    const session = makeReadySession();
    await expect(session.subscribeNamespace(['.ext'])).rejects.toThrow(/§3.2.1/);
  });

  it.skipIf(!IS_DRAFT_18)('refuses SUBSCRIBE_TRACKS with a reserved prefix (top-level or namespacePrefixParam)', async () => {
    const session = makeReadySession();
    await expect(session.subscribeTracks(['.session'])).rejects.toThrow(/§3.2.1/);
    await expect(
      session.subscribeTracks(['ok'], undefined, { namespacePrefixParam: ['.reserved'] }),
    ).rejects.toThrow(/§3.2.1/);
  });

  it('refuses ANNOUNCE under a reserved namespace', async () => {
    const session = makeReadySession();
    await expect(session.announceNamespace(['.session'])).rejects.toThrow(/§3.2.1/);
  });

  it('refuses publishVOD under a reserved namespace', async () => {
    const session = makeReadySession();
    await expect(
      session.publishVOD(['.session'], 'ctl', {
        metadata: { totalGroups: 1, totalObjects: 1, duration: 1 } as never,
        objectsPerGroup: 1,
        getObject: async () => new Uint8Array(0),
        isKeyframe: () => true,
      }),
    ).rejects.toThrow(/§3.2.1/);
  });

  it('accepts unreserved namespaces (leading char is not 0x2e)', async () => {
    const session = makeReadySession();
    // These should NOT throw the reserved-namespace error. They may fail
    // later (no transport wired up), but the §3.2.1 gate must let them
    // through.
    await expect(session.publish(['media', 'v0'], 't0')).rejects.not.toThrow(/§3.2.1/);
    await expect(session.publish(['ns-with.dot-inside'], 't0')).rejects.not.toThrow(/§3.2.1/);
    await expect(session.publish(['dot.first', 'more'], 't0')).rejects.not.toThrow(/§3.2.1/);
  });

  it('accepts a namespace whose *later* field starts with "." (only first field is reserved per §3.2.1)', async () => {
    const session = makeReadySession();
    await expect(session.publish(['media', '.tricky'], 't0')).rejects.not.toThrow(/§3.2.1/);
  });

  it('accepts an empty namespace tuple (no first field to check)', async () => {
    const session = makeReadySession();
    // publish() will fail downstream on empty namespace, but the reserved-
    // namespace gate MUST not fire.
    await expect(session.publish([], 't0')).rejects.not.toThrow(/§3.2.1/);
  });
});
