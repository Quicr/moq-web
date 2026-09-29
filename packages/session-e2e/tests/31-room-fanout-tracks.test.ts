// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Second-order studio room reproducer: each peer performs the FULL studio
 * join sequence (subscribe-namespace → publish tracks → announce → and on
 * namespace-announced from another peer, SUBSCRIBE_TRACKS to it).
 *
 * The bug report says peers 3+ never see peers 1/2's video. Studio's peer
 * discovery goes:
 *   1. mediaSession.subscribeNamespace(roomPrefix)
 *   2. session.publish() for {event, catalog, video, audio} tracks
 *   3. session.announceNamespace(selfNamespace)
 *   4. on 'namespace-announced' -> session.subscribeTracks(peerNamespace)
 *   5. that triggers 'incoming-publish' from the relay for each peer track
 *
 * This test replays that exact sequence for N peers and asserts each peer
 * gets an 'incoming-publish' for every OTHER peer's tracks.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { makeSession, type SessionHandle } from '../lib/session-factory.js';
import { resolveProfile, type Profile } from '../lib/profile.js';
import chatStream from '../profiles/chat-stream.json';

const PEER_COUNT = 6;
const TRACK_NAMES = ['timeline', 'catalog', 'video', 'audio'];
const SETTLE_MS = 300;

interface PeerCtx {
  handle: SessionHandle;
  id: string;
  ns: string[];
  /** Namespaces we saw announced */
  seenAnnounces: Set<string>;
  /** subscriptionId -> peer namespace, from subscribeTracks */
  tracksSubIds: Map<number, string>;
  /** peerNs -> Set of trackNames seen via incoming-publish */
  incomingByPeer: Map<string, Set<string>>;
}

describe('Room fan-out with full studio sequence (subscribe + publish + announce + subscribe-tracks)', () => {
  let ctxs: PeerCtx[] = [];

  afterEach(async () => {
    for (const c of ctxs) {
      try { await c.handle.close(); } catch { /* ignore */ }
    }
    ctxs = [];
  });

  it(`${PEER_COUNT} peers each receive incoming-publish for every other peer's tracks`, async () => {
    const profile = resolveProfile(chatStream as Profile);
    const room = `room-${crypto.randomUUID().slice(0, 8)}`;
    const roomPrefix = [...profile.namespacePrefix, room];

    const track = profile.tracks[0];
    if (!track) throw new Error('profile has no tracks');

    // Phase 1: open all sessions and wire handlers.
    for (let i = 0; i < PEER_COUNT; i++) {
      const handle = await makeSession(profile);
      const id = `peer${i + 1}`;
      const ctx: PeerCtx = {
        handle,
        id,
        ns: [...roomPrefix, id],
        seenAnnounces: new Set(),
        tracksSubIds: new Map(),
        incomingByPeer: new Map(),
      };
      ctxs.push(ctx);

      handle.session.on('namespace-announced', (evt) => {
        const ns = evt.namespace.join('/');
        // ignore our own announcement echo
        if (ns === ctx.ns.join('/')) return;
        // ignore anything outside our room
        if (!ns.startsWith(roomPrefix.join('/') + '/')) return;
        ctx.seenAnnounces.add(ns);
        // fire subscribe-tracks like studio does
        void handle.session.subscribeTracks(evt.namespace)
          .then((subId) => { ctx.tracksSubIds.set(subId, ns); })
          .catch(() => { /* ignore */ });
      });

      handle.session.on('incoming-publish', (evt) => {
        const nsStr = evt.namespace.join('/');
        if (!nsStr.startsWith(roomPrefix.join('/') + '/')) return;
        if (nsStr === ctx.ns.join('/')) return;
        let set = ctx.incomingByPeer.get(nsStr);
        if (!set) { set = new Set(); ctx.incomingByPeer.set(nsStr, set); }
        set.add(evt.trackName);
      });
    }

    // Phase 2: subscribe every peer to the room prefix.
    for (const c of ctxs) {
      await c.handle.session.subscribeNamespace(roomPrefix);
    }

    await new Promise((r) => setTimeout(r, SETTLE_MS));

    // Phase 3: sequential join — each peer publishes its tracks then announces.
    for (const c of ctxs) {
      for (const tn of TRACK_NAMES) {
        await c.handle.session.publish(c.ns, tn, {
          priority: track.priority,
          deliveryTimeout: track.deliveryTimeout,
          deliveryMode: track.delivery,
        });
      }
      await c.handle.session.announceNamespace(c.ns);
      // small gap so the next peer joins after this one's ANNOUNCE is fanned out
      await new Promise((r) => setTimeout(r, SETTLE_MS));
    }

    // Phase 4: let subscribe-tracks fan-out settle.
    await new Promise((r) => setTimeout(r, SETTLE_MS * 4));

    // Phase 5: assertion. Every peer must have seen every OTHER peer's
    // full track set via incoming-publish.
    const failures: string[] = [];
    for (const c of ctxs) {
      for (const other of ctxs) {
        if (other === c) continue;
        const otherNs = other.ns.join('/');
        const seenAnnounce = c.seenAnnounces.has(otherNs);
        const tracks = c.incomingByPeer.get(otherNs);
        const missing = TRACK_NAMES.filter((t) => !tracks?.has(t));
        if (!seenAnnounce || missing.length > 0) {
          failures.push(
            `${c.id} -> ${other.id}: seenAnnounce=${seenAnnounce} ` +
            `missingTracks=[${missing.join(',')}] gotTracks=[${[...(tracks ?? [])].join(',')}]`,
          );
        }
      }
    }

    if (failures.length > 0) {
      const summary = ctxs.map((c) =>
        `  ${c.id}:\n` +
        `    announces=[${[...c.seenAnnounces].join(', ')}]\n` +
        `    incoming=${[...c.incomingByPeer].map(([k, v]) => `${k}=>[${[...v].join(',')}]`).join(' | ')}`
      ).join('\n');
      throw new Error(
        `Studio fan-out failures (${failures.length}):\n${failures.join('\n')}\n\nObserved:\n${summary}`,
      );
    }

    expect(failures.length).toBe(0);
  }, 90_000);
});
