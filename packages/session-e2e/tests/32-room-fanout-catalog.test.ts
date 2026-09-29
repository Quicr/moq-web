// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Third-order studio room reproducer: replays the EXACT apps/studio/src/moqt.ts
 * peer wiring — MediaSession.subscribeNamespace + MSFSession.publishCatalog +
 * mediaSession-managed video/audio publishes + subscribeTracks + catalog
 * callback via session.setSubscriptionCallback.
 *
 * The bug this exists to catch: the studio UI gates a peer's <canvas> tile on
 * `peerCatalogs[peerId]` being present and having a track named 'video'. If
 * MSF catalog delivery fails silently for any peer, that peer's video decodes
 * fine but is never rendered.
 *
 * Assertion: every peer's onPeerCatalog callback fires for every OTHER peer,
 * with a FullCatalog containing 'video' and 'audio' track entries.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  MSFSession,
  createCatalog,
  parseCatalogFromBytes,
  isFullCatalog,
  CATALOG_TRACK_NAME,
  type FullCatalog,
} from '@moq-web/msf';
import { MediaSession, type MediaConfig } from '@moq-web/media';
import type { IncomingPublishEvent } from '@moq-web/session';

import { makeSession, type SessionHandle } from '../lib/session-factory.js';
import { resolveProfile, type Profile } from '../lib/profile.js';
import chatStream from '../profiles/chat-stream.json';

const PEER_COUNT = 4;
const SETTLE_MS = 400;

const MEDIA_CONFIG: MediaConfig = {
  videoBitrate: 1_200_000,
  audioBitrate: 64_000,
  videoResolution: '720p',
  videoEnabled: true,
  audioEnabled: true,
  deliveryMode: 'stream',
  audioDeliveryMode: 'datagram',
  keyframeInterval: 1,
  isLive: true,
  catalogFramerate: 30,
  filterType: 'latest',
};

interface PeerCtx {
  handle: SessionHandle;
  id: string;
  ns: string[];
  mediaSession: MediaSession;
  msfSession: MSFSession;
  /** peerId -> FullCatalog observed via onPeerCatalog */
  peerCatalogs: Map<string, FullCatalog>;
  /** subscriptionId -> peerId, from subscribeTracks fan-out */
  subIdToPeer: Map<number, string>;
  /** peers we have already fired subscribeTracks for (namespace-announced dedup) */
  discoveredPeers: Set<string>;
}

describe('Room fan-out with full studio flow (MediaSession + MSFSession catalog)', () => {
  let ctxs: PeerCtx[] = [];

  afterEach(async () => {
    for (const c of ctxs) {
      try { await c.msfSession.stopCatalogPublishing(); } catch { /* ignore */ }
      try { await c.mediaSession.close(); } catch { /* ignore */ }
      try { await c.handle.close(); } catch { /* ignore */ }
    }
    ctxs = [];
  });

  it(`${PEER_COUNT} peers each receive parseable FullCatalog from every other peer`, async () => {
    const profile = resolveProfile(chatStream as Profile);
    const room = `room-${crypto.randomUUID().slice(0, 8)}`;
    const roomPrefix = [...profile.namespacePrefix, room];

    const peerIdFromNs = (ns: string[]): string | undefined => {
      if (ns.length < roomPrefix.length + 1) return undefined;
      for (let i = 0; i < roomPrefix.length; i++) {
        if (ns[i] !== roomPrefix[i]) return undefined;
      }
      return ns[roomPrefix.length];
    };

    // Phase 1: open sessions, build MediaSession + MSFSession, wire handlers.
    for (let i = 0; i < PEER_COUNT; i++) {
      const handle = await makeSession(profile);
      const id = `peer${i + 1}`;
      const ns = [...roomPrefix, id];
      const mediaSession = new MediaSession({ session: handle.session });
      mediaSession.setOwnNamespacePrefix(ns.join('/'));
      const msfSession = new MSFSession(handle.session, ns);

      const ctx: PeerCtx = {
        handle,
        id,
        ns,
        mediaSession,
        msfSession,
        peerCatalogs: new Map(),
        subIdToPeer: new Map(),
        discoveredPeers: new Set(),
      };
      ctxs.push(ctx);

      handle.session.on('incoming-publish', (evt: IncomingPublishEvent) => {
        if (evt.namespace.join('/') === ns.join('/')) return;
        const peerId = peerIdFromNs(evt.namespace);
        if (!peerId || peerId === id) return;
        ctx.subIdToPeer.set(evt.subscriptionId, peerId);

        if (evt.trackName === CATALOG_TRACK_NAME) {
          handle.session.setSubscriptionCallback(evt.subscriptionId, (data) => {
            try {
              const cat = parseCatalogFromBytes(data);
              if (isFullCatalog(cat)) {
                ctx.peerCatalogs.set(peerId, cat);
              }
            } catch (err) {
              // Surface parse failures via a marker catalog so the assertion
              // reports them instead of hiding them.
              ctx.peerCatalogs.set(peerId, {
                version: -1,
                tracks: [{ name: `PARSE_ERROR:${(err as Error).message}` }],
              } as unknown as FullCatalog);
            }
          });
        }
        // video/audio handled by MediaSession.handleIncomingPublish;
        // catalog handled above; other tracks (timeline) ignored here.
      });

      handle.session.on('namespace-announced', (evt) => {
        const peerId = peerIdFromNs(evt.namespace);
        if (!peerId || peerId === id) return;
        if (ctx.discoveredPeers.has(peerId)) return;
        ctx.discoveredPeers.add(peerId);
        void handle.session.subscribeTracks(evt.namespace).catch(() => { /* ignore */ });
      });
    }

    // Phase 2: every peer subscribes to the room prefix via MediaSession
    // (registers auto-pipeline config, same as studio).
    for (const c of ctxs) {
      await c.mediaSession.subscribeNamespace(roomPrefix, MEDIA_CONFIG);
    }
    await new Promise((r) => setTimeout(r, SETTLE_MS));

    // Phase 3: sequential join, mirroring studio's ordering:
    //   publish timeline → publish video (plain, no encode) → publish audio
    //   (plain) → startCatalogPublishing → publishCatalog(full) → announceNamespace
    // We use session.publish (not mediaSession.publish) for video/audio because
    // this test cares about fan-out + catalog delivery, not real encode. The
    // relay-visible PUBLISH frames are identical.
    for (const c of ctxs) {
      await c.handle.session.publish(c.ns, 'timeline', { deliveryMode: 'stream' });
      await c.handle.session.publish(c.ns, 'video', { deliveryMode: 'stream' });
      await c.handle.session.publish(c.ns, 'audio', { deliveryMode: 'datagram' });

      await c.msfSession.startCatalogPublishing();
      const catalog = createCatalog()
        .generatedAt()
        .addVideoTrack({
          name: 'video',
          codec: 'avc1.42E01E',
          width: 1280,
          height: 720,
          framerate: 30,
          bitrate: MEDIA_CONFIG.videoBitrate,
          isLive: true,
        })
        .addAudioTrack({
          name: 'audio',
          codec: 'opus',
          samplerate: 48000,
          channelConfig: 'stereo',
          bitrate: MEDIA_CONFIG.audioBitrate,
          isLive: true,
        })
        .build() as FullCatalog;
      await c.msfSession.publishCatalog(catalog);

      await c.handle.session.announceNamespace(c.ns, { deliveryMode: 'stream' });
      await new Promise((r) => setTimeout(r, SETTLE_MS));
    }

    // Phase 4: let subscribeTracks + catalog objects settle.
    await new Promise((r) => setTimeout(r, SETTLE_MS * 4));

    // Phase 5: assertion. Every peer must have received a parseable FullCatalog
    // with 'video' + 'audio' tracks from every OTHER peer.
    const failures: string[] = [];
    for (const c of ctxs) {
      for (const other of ctxs) {
        if (other === c) continue;
        const cat = c.peerCatalogs.get(other.id);
        if (!cat) {
          failures.push(`${c.id} <- ${other.id}: no catalog received`);
          continue;
        }
        const trackNames = new Set(cat.tracks.map((t) => t.name));
        const missing = ['video', 'audio'].filter((n) => !trackNames.has(n));
        if (missing.length > 0) {
          failures.push(
            `${c.id} <- ${other.id}: catalog missing tracks [${missing.join(',')}] ` +
            `got=[${[...trackNames].join(',')}]`,
          );
        }
      }
    }

    if (failures.length > 0) {
      const summary = ctxs.map((c) =>
        `  ${c.id}: catalogsFrom=[${[...c.peerCatalogs.keys()].join(', ')}] ` +
        `discovered=[${[...c.discoveredPeers].join(', ')}]`,
      ).join('\n');
      throw new Error(
        `Studio catalog fan-out failures (${failures.length}):\n` +
        failures.join('\n') + '\n\nObserved:\n' + summary,
      );
    }

    expect(failures.length).toBe(0);
  }, 90_000);
});
