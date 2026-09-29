// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { connectMoqtSession, type ConnectedSession } from '@moq-web/app-kit/moqt';
import type { TransportConfig } from '@moq-web/app-kit/transport';
import { MediaSession, type MediaConfig } from '@moq-web/media';
import {
  MSFSession,
  createCatalog,
  parseCatalogFromBytes,
  isFullCatalog,
  CATALOG_TRACK_NAME,
  type FullCatalog,
} from '@moq-web/msf';
import type { IncomingPublishEvent } from '@moq-web/session';

const EVENT_TRACK = 'timeline';
const VIDEO_TRACK = 'video';
const AUDIO_TRACK = 'audio';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

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

export interface TimelineEvent {
  t: number;
  label: string;
  kind: 'meta' | 'join' | 'delta';
}

export interface StudioBroadcast {
  namespace: string[];
  connected: ConnectedSession;
  emitEvent: (evt: TimelineEvent) => Promise<void>;
  getLocalStream: () => MediaStream | undefined;
  setLocalMuted: (muted: boolean) => void;
  setLocalVideoOff: (off: boolean) => void;
  close: () => Promise<void>;
}

export interface OpenStudioOptions {
  transport: TransportConfig;
  roomId: string;
  selfId: string;
  displayName?: string;
  publishMedia: boolean;
  onEvent: (peerId: string, evt: TimelineEvent) => void;
  onPeerJoined: (peerId: string) => void;
  onPeerLeft: (peerId: string) => void;
  onPeerVideoFrame: (peerId: string, frame: VideoFrame) => void;
  onPeerAudioData: (peerId: string, audio: AudioData) => void;
  onPeerCatalog: (peerId: string, catalog: FullCatalog) => void;
  onError: (err: Error) => void;
  signal?: AbortSignal;
}

interface PeerState {
  namespace: string[];
  tracksSubId?: number;
}

/**
 * Draft-18 peer discovery + track routing:
 *   1. `mediaSession.subscribeNamespace(studio/<room>, MEDIA_CONFIG)` — one
 *      long-lived SUBSCRIBE_NAMESPACE that both surfaces peer NAMESPACE events
 *      and registers a media config so `MediaSession.handleIncomingPublish`
 *      auto-builds a decode pipeline for each PUBLISHed video/audio track.
 *   2. On NAMESPACE announce for a peer, send SUBSCRIBE_TRACKS(peerNs) so the
 *      relay fans PUBLISHes for that peer's tracks back to us.
 *   3. When a PUBLISH lands, `session.on('incoming-publish')` fires with a new
 *      subscriptionId whose object-callback is not yet attached. For non-media
 *      tracks (timeline, catalog) we bind the callback via
 *      `setSubscriptionCallback`; video/audio are handled by MediaSession.
 *      Any pre-callback objects are flushed automatically (pendingObjects).
 */
export async function openStudioBroadcast(opts: OpenStudioOptions): Promise<StudioBroadcast> {
  const connected = await connectMoqtSession({ transport: opts.transport, signal: opts.signal });
  const session = connected.session;

  const roomPrefix = ['studio', opts.roomId];
  const selfNamespace = [...roomPrefix, opts.selfId];
  const selfNamespaceStr = selfNamespace.join('/');

  session.on('session-terminated', (evt) =>
    opts.onError(new Error(`Session terminated: ${evt.reason ?? evt.code}`)),
  );

  const mediaSession = new MediaSession({ session });
  mediaSession.setOwnNamespacePrefix(selfNamespaceStr);
  // Republish the catalog every 2s so late joiners pick it up. Draft-18
  // subscriptions deliver from the current object forward and the relay does
  // not replay history — without this heartbeat, a peer subscribing after our
  // one-shot publishCatalog() never receives the catalog and their tile is
  // filtered out by App.tsx's peerHasVideo gate.
  const msfSession = new MSFSession(session, selfNamespace, {
    catalogPublishOptions: { republishIntervalMs: 2000 },
  });

  const peers = new Map<string, PeerState>();
  const subIdToPeer = new Map<number, string>();

  mediaSession.on('video-frame', ({ subscriptionId, frame }) => {
    const peerId = subIdToPeer.get(subscriptionId);
    if (!peerId) { frame.close(); return; }
    opts.onPeerVideoFrame(peerId, frame);
  });

  mediaSession.on('audio-data', ({ subscriptionId, audioData }) => {
    const peerId = subIdToPeer.get(subscriptionId);
    if (!peerId) { audioData.close(); return; }
    opts.onPeerAudioData(peerId, audioData);
  });

  const peerIdFromNs = (ns: string[]): string | undefined => {
    if (ns.length < roomPrefix.length + 1) return undefined;
    for (let i = 0; i < roomPrefix.length; i++) {
      if (ns[i] !== roomPrefix[i]) return undefined;
    }
    const pid = ns[roomPrefix.length]!;
    if (pid === opts.selfId) return undefined;
    return pid;
  };

  session.on('incoming-publish', (evt: IncomingPublishEvent) => {
    if (evt.namespace.join('/') === selfNamespaceStr) return;
    const peerId = peerIdFromNs(evt.namespace);
    if (!peerId) return;
    subIdToPeer.set(evt.subscriptionId, peerId);

    const trackName = evt.trackName;
    const lower = trackName.toLowerCase();

    if (trackName === CATALOG_TRACK_NAME) {
      session.setSubscriptionCallback(evt.subscriptionId, (data) => {
        try {
          const cat = parseCatalogFromBytes(data);
          if (isFullCatalog(cat)) opts.onPeerCatalog(peerId, cat);
        } catch (err) {
          opts.onError(
            new Error(
              `Failed to parse catalog from ${peerId}: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
        }
      });
      return;
    }

    if (lower === EVENT_TRACK || lower.includes('timeline')) {
      session.setSubscriptionCallback(evt.subscriptionId, (data) => {
        try {
          const timelineEvt = JSON.parse(decoder.decode(data)) as TimelineEvent;
          opts.onEvent(peerId, timelineEvt);
        } catch (err) {
          opts.onError(err instanceof Error ? err : new Error(String(err)));
        }
      });
      return;
    }
    // video/audio: MediaSession.handleIncomingPublish attaches the pipeline
    // callback for us; nothing to do here.
  });

  session.on('namespace-announced', (evt) => {
    const ns = evt.namespace;
    if (ns.length !== roomPrefix.length + 1) return;
    const peerId = peerIdFromNs(ns);
    if (!peerId) return;
    if (peers.has(peerId)) return;
    peers.set(peerId, { namespace: ns });
    opts.onPeerJoined(peerId);
    // SUBSCRIBE_TRACKS(peerNs) — asks the relay to send us a PUBLISH for every
    // track this peer has under their namespace.
    void session.subscribeTracks(ns)
      .then((subId) => {
        const state = peers.get(peerId);
        if (state) state.tracksSubId = subId;
      })
      .catch((err) => opts.onError(err instanceof Error ? err : new Error(String(err))));
  });

  session.on('namespace-done', (evt) => {
    const ns = evt.namespace;
    if (ns.length !== roomPrefix.length + 1) return;
    const peerId = ns[ns.length - 1]!;
    const state = peers.get(peerId);
    if (!state) return;
    peers.delete(peerId);
    if (state.tracksSubId !== undefined) {
      void session.unsubscribeNamespace(state.tracksSubId);
    }
    opts.onPeerLeft(peerId);
  });

  // MediaSession-aware subscribe so incoming PUBLISHes auto-attach a decode
  // pipeline (see MediaSession.handleIncomingPublish).
  await mediaSession.subscribeNamespace(roomPrefix, MEDIA_CONFIG).catch((err) => { void err; });

  // Publish all our tracks BEFORE announcing our namespace. Otherwise a peer
  // that sees our announce can race ahead and subscribe to a track we haven't
  // registered yet, and the relay rejects our subsequent PUBLISH with
  // DUPLICATE_SUBSCRIPTION (draft-18 error code 0x19).
  const trackAlias = await session.publish(selfNamespace, EVENT_TRACK, {
    deliveryMode: 'stream',
    deliveryTimeout: 0,
    skipForwardWait: true,
    priority: opts.transport.publisher.publisherPriority,
  });

  let localStream: MediaStream | undefined;
  if (opts.publishMedia) {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        video: { width: 1280, height: 720 },
        audio: true,
      });
      await mediaSession.publish(selfNamespace, VIDEO_TRACK, localStream, {
        ...MEDIA_CONFIG,
        audioEnabled: false,
      });
      await mediaSession.publish(selfNamespace, AUDIO_TRACK, localStream, {
        ...MEDIA_CONFIG,
        videoEnabled: false,
      });
    } catch (err) {
      opts.onError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  try {
    await msfSession.startCatalogPublishing();
    const builder = createCatalog().generatedAt();
    if (opts.publishMedia && localStream) {
      builder.addVideoTrack({
        name: VIDEO_TRACK,
        codec: 'avc1.42E01E',
        width: 1280,
        height: 720,
        framerate: 30,
        bitrate: MEDIA_CONFIG.videoBitrate,
        isLive: true,
      });
      builder.addAudioTrack({
        name: AUDIO_TRACK,
        codec: 'opus',
        samplerate: 48000,
        channelConfig: 'stereo',
        bitrate: MEDIA_CONFIG.audioBitrate,
        isLive: true,
      });
    }
    const catalog = builder.build() as FullCatalog;
    (catalog as unknown as { tracks: unknown[] }).tracks.push({
      name: EVENT_TRACK,
      packaging: 'eventtimeline',
      isLive: true,
      eventType: 'studio-timeline',
    });
    await msfSession.publishCatalog(catalog);
  } catch (err) {
    void err;
  }

  await session.announceNamespace(selfNamespace, { deliveryMode: 'stream' });

  let seq = 0;
  return {
    namespace: selfNamespace,
    connected,
    emitEvent: async (evt) => {
      const groupId = seq;
      const objectId = 0;
      seq += 1;
      await session.sendObject(trackAlias, encoder.encode(JSON.stringify(evt)), { groupId, objectId });
      opts.onEvent(opts.selfId, evt);
    },
    getLocalStream: () => localStream,
    setLocalMuted: (muted) => {
      localStream?.getAudioTracks().forEach((t) => { t.enabled = !muted; });
    },
    setLocalVideoOff: (off) => {
      localStream?.getVideoTracks().forEach((t) => { t.enabled = !off; });
    },
    close: async () => {
      for (const state of peers.values()) {
        if (state.tracksSubId !== undefined) {
          try { await session.unsubscribeNamespace(state.tracksSubId); } catch { /* noop */ }
        }
      }
      peers.clear();
      subIdToPeer.clear();
      try { await msfSession.stopCatalogPublishing(); } catch { /* noop */ }
      try { await mediaSession.close(); } catch { /* noop */ }
      for (const track of localStream?.getTracks() ?? []) track.stop();
      try { await session.close(); } catch { /* noop */ }
    },
  };
}
