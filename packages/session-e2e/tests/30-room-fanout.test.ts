// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Reproduces the "studio room" topology reported in
 * localhost-1790576479222.log — N peers each open a session, subscribe to a
 * shared room prefix, and announce their own per-peer namespace under it.
 *
 * The bug report: peer 1 and peer 2 see each other, but peer 3+ never receive
 * announcements from peers 1/2 (and vice versa). This test asserts that every
 * peer joining a room learns about every other peer already in the room.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { makeSession, type SessionHandle } from '../lib/session-factory.js';
import { resolveProfile, type Profile } from '../lib/profile.js';
import chatStream from '../profiles/chat-stream.json';

const PEER_COUNT = 4;
const SETTLE_MS = 500;

describe('Room fan-out (studio-style N-peer topology)', () => {
  let peers: SessionHandle[] = [];

  afterEach(async () => {
    for (const p of peers) {
      try { await p.close(); } catch { /* ignore */ }
    }
    peers = [];
  });

  it(`${PEER_COUNT} peers joining the same room each see every other peer's announcement`, async () => {
    const profile = resolveProfile(chatStream as Profile);
    const room = `room-${crypto.randomUUID().slice(0, 8)}`;
    const roomPrefix = [...profile.namespacePrefix, room];

    const peerIds = Array.from({ length: PEER_COUNT }, (_, i) => `peer${i + 1}`);
    const peerNamespaces = peerIds.map((id) => [...roomPrefix, id]);

    // Track every announcement each peer observes.
    const seen: Set<string>[] = peerIds.map(() => new Set());
    const waiters: Array<Array<{ resolve: () => void; timer: ReturnType<typeof setTimeout> }>> =
      peerIds.map(() => []);

    // Open all N sessions up front.
    for (let i = 0; i < PEER_COUNT; i++) {
      const handle = await makeSession(profile);
      peers.push(handle);
      const idx = i;
      handle.session.on('namespace-announced', (evt) => {
        const ns = evt.namespace.join('/');
        seen[idx].add(ns);
        // Resolve any waiter whose target this matches.
        waiters[idx] = waiters[idx].filter((w) => {
          if (ns === (w as unknown as { target: string }).target) {
            clearTimeout(w.timer);
            w.resolve();
            return false;
          }
          return true;
        });
      });
    }

    // Every peer subscribes to the room prefix (order: 1, 2, 3, ...).
    for (let i = 0; i < PEER_COUNT; i++) {
      await peers[i].session.subscribeNamespace(roomPrefix);
    }

    // Small settle so all subscriptions are registered before announcements.
    await new Promise((r) => setTimeout(r, SETTLE_MS));

    // Each peer announces its own namespace, one at a time with a settle
    // in between — this matches the real UI flow where peers join sequentially.
    for (let i = 0; i < PEER_COUNT; i++) {
      await peers[i].session.announceNamespace(peerNamespaces[i]);
      await new Promise((r) => setTimeout(r, SETTLE_MS));
    }

    // Give the relay a final chance to fan everything out.
    await new Promise((r) => setTimeout(r, SETTLE_MS * 2));

    // Assert: every peer P must have observed every OTHER peer's namespace.
    const failures: string[] = [];
    for (let i = 0; i < PEER_COUNT; i++) {
      for (let j = 0; j < PEER_COUNT; j++) {
        if (i === j) continue;
        const target = peerNamespaces[j].join('/');
        if (!seen[i].has(target)) {
          failures.push(`peer${i + 1} did NOT see peer${j + 1} (${target})`);
        }
      }
    }

    if (failures.length > 0) {
      const summary = peerIds
        .map((_, i) => `  peer${i + 1} saw: [${[...seen[i]].join(', ') || '(nothing)'}]`)
        .join('\n');
      throw new Error(
        `Fan-out failures (${failures.length}):\n${failures.join('\n')}\n\nObserved:\n${summary}`,
      );
    }
  }, 60_000);
});
