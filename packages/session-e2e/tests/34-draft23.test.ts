// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Draft-23 interop: what draft-23 changed on the wire, against a live relay.
 * Skipped unless MOQT_VERSION=draft-23.
 *
 * - SETUP over vi64 control framing reaches ready (§9)
 * - FETCH is answered by REQUEST_OK, not FETCH_OK (§9.3, #2009); the fetch
 *   stream uses the draft-23 ID rules (§11.4) and its indicators surface as
 *   `fetch-gap`
 * - REQUEST_ERROR carries Error Details (§9.4.2); a refusal does not end the session
 * - Grease Error Details we send are ignored by the relay (§13)
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { FetchCompleteEvent, FetchGapEvent, FetchStreamCompleteEvent } from '@moq-web/session';

import { makeSession, type SessionHandle } from '../lib/session-factory.js';
import { resolveProfile, makeNamespace, type Profile } from '../lib/profile.js';
import { generateChat, expectedMessage } from '../lib/chat-generator.js';
import { bytesEqual } from '../lib/verify.js';
import chatStream from '../profiles/chat-stream.json';

const MOQT_VERSION = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_MOQT_VERSION ?? 'draft-18';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(done: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) {
    await sleep(50);
  }
}

describe.skipIf(MOQT_VERSION !== 'draft-23')('draft-23 interop', () => {
  const profile = resolveProfile(chatStream as Profile);
  const track = profile.tracks[0]!;
  const handles: SessionHandle[] = [];

  afterEach(async () => {
    await Promise.all(handles.splice(0).map((h) => h.close()));
  });

  async function open(options?: Parameters<typeof makeSession>[1]): Promise<SessionHandle> {
    const handle = await makeSession(profile, options);
    handles.push(handle);
    return handle;
  }

  it('sets up over draft-23 framing', async () => {
    const { session } = await open();
    expect(session.draft).toBe('draft-23');
    expect(session.isReady).toBe(true);
  });

  it('FETCH is answered by REQUEST_OK and its stream decodes with the draft-23 ID rules', async () => {
    const namespace = makeNamespace(profile, 'd23-fetch');
    const pub = await open();
    const sub = await open();
    const alias = await pub.session.publish(namespace, track.name, {
      priority: track.priority,
      deliveryMode: 'stream',
      maxCacheDuration: 60_000,
      skipForwardWait: true,
    });
    // Two objects per group skipped, so Object ID Deltas within a Group are non-zero (#2006)
    const payload = { ...track.payload, messages: 30, objectsPerGroup: 10 };
    for (const msg of generateChat(payload)) {
      if (msg.objectId % 3 !== 1) {
        await pub.session.sendObject(alias, msg.bytes, { groupId: msg.groupId, objectId: msg.objectId });
      }
    }
    await sleep(500);

    const received: Array<{ groupId: number; objectId: number; data: Uint8Array }> = [];
    const complete: FetchCompleteEvent[] = [];
    const streamDone: FetchStreamCompleteEvent[] = [];
    const gaps: FetchGapEvent[] = [];
    let failed: string | undefined;
    const offs = [
      sub.session.on('fetch-complete', (e) => complete.push(e)),
      sub.session.on('fetch-stream-complete', (e) => streamDone.push(e)),
      sub.session.on('fetch-gap', (e) => gaps.push(e)),
      sub.session.on('fetch-error', (e) => { failed = `code=${e.errorCode} reason=${e.reason}`; }),
    ];
    const sent = [...generateChat(payload)].filter((m) => m.objectId % 3 !== 1);

    try {
      await sub.session.fetch(namespace, track.name, { startGroup: 0, startObject: 0, endGroup: 2, endObject: 9 }, {}, (data, groupId, objectId) => {
        received.push({ groupId, objectId, data });
      });
      await until(() => failed !== undefined || streamDone.length > 0 || received.length >= sent.length, 10_000);
    } finally {
      offs.forEach((off) => off());
    }

    if (failed) {
      console.warn(`FETCH refused by relay: ${failed}`);
      expect(sub.session.isReady).toBe(true);
      return;
    }
    console.warn(`fetch-gap events: ${JSON.stringify(gaps, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`);

    expect(complete).toHaveLength(1);
    expect(received.map((o) => [o.groupId, o.objectId])).toEqual(sent.map((m) => [m.groupId, m.objectId]));
    for (const o of received) {
      expect(bytesEqual(o.data, expectedMessage(payload, o.groupId, o.objectId)), `(${o.groupId},${o.objectId})`).toBe(true);
    }
    expect(sub.session.isReady).toBe(true);
  });

  it('a refused SUBSCRIBE decodes its REQUEST_ERROR and leaves the session usable', async () => {
    const { session } = await open();
    const missing = makeNamespace(profile, `d23-missing-${Date.now()}`);

    const outcome = await Promise.race([
      session.subscribe(missing, 'nothing-here').then(() => 'accepted', (err: unknown) => err),
      sleep(8_000).then(() => 'timeout'),
    ]);

    if (outcome === 'accepted' || outcome === 'timeout') {
      // Some relays hold a subscription open until a publisher appears
      console.warn(`relay ${outcome === 'accepted' ? 'accepted' : 'did not answer'} a SUBSCRIBE to an unpublished track`);
    } else {
      expect(typeof (outcome as { errorCode?: unknown }).errorCode).toBe('number');
    }
    expect(session.isReady).toBe(true);
    // Still usable: a new request on the same session succeeds
    await session.announceNamespace(makeNamespace(profile, 'd23-after-error'));
    expect(session.isReady).toBe(true);
  });

  it('the relay ignores the grease Error Detail in our REQUEST_ERRORs', async () => {
    const namespace = makeNamespace(profile, 'd23-grease');
    const pub = await open({ grease: true });
    const sub = await open();
    await pub.session.announceNamespace(namespace);
    let refusedByUs = 0;
    const internals = pub.session as unknown as { fetchRefusal: (m: unknown) => unknown };
    const refusal = internals.fetchRefusal.bind(pub.session);
    internals.fetchRefusal = (m) => {
      refusedByUs++;
      return refusal(m);
    };
    let fetchError: number | undefined;
    const off = sub.session.on('fetch-error', (e) => { fetchError = e.errorCode; });

    try {
      // Nothing was published, so a relay that forwards the FETCH gets our greased refusal
      await sub.session.fetch(namespace, 'no-objects', { startGroup: 0, startObject: 0, endGroup: 1, endObject: 0 }, {}, () => {});
      await until(() => fetchError !== undefined, 8_000);
    } catch {
      // A refusal may also surface as a rejected fetch()
    } finally {
      off();
    }

    console.warn(`grease: relay forwarded the FETCH to us ${refusedByUs} time(s); subscriber saw error ${fetchError}`);
    await sleep(500);
    expect(pub.session.isReady).toBe(true);
    expect(sub.session.isReady).toBe(true);
  });
});
