// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { connectMoqtSession, type ConnectedSession } from '@moq-web/app-kit/moqt';
import type { TransportConfig } from '@moq-web/app-kit/transport';
import { MediaSession, type MediaConfig } from '@moq-web/media';
import {
  MSFSession,
  createCatalog,
  createDelta,
  parseCatalogFromBytes,
  isFullCatalog,
  CATALOG_TRACK_NAME,
  encodeEventTimelineEntry,
  decodeEventTimelineEntry,
  encodeMediaTimelineEntry,
  decodeMediaTimelineEntry,
  type EventTimelineEntry,
  type MediaTimelineEntry,
  type MediaTimelinePoint,
  type FullCatalog,
} from '@moq-web/msf';
import type { IncomingPublishEvent } from '@moq-web/session';

const EVENT_TRACK = 'timeline';
const MEDIA_TIMELINE_TRACK = 'mediatimeline';
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

// Accept either an MSF EventTimelineEntry `{ t, data: { kind, label } }` or the
// legacy JSON shape `{ t, kind, label }` we shipped before the codec migration.
// Kept until every deployed peer publishes the MSF form.
function parseTimelineEvent(raw: unknown): TimelineEvent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.data === 'object' && obj.data !== null) {
    const point = decodeEventTimelineEntry(obj as EventTimelineEntry);
    const data = point.data ?? {};
    const kind = (data as { kind?: unknown }).kind;
    const label = (data as { label?: unknown }).label;
    if (typeof label !== 'string' || (kind !== 'meta' && kind !== 'join' && kind !== 'delta')) return null;
    return { t: point.wallclockTime ?? Date.now(), kind, label };
  }
  const kind = obj.kind;
  const label = obj.label;
  const t = obj.t;
  if (typeof label !== 'string' || typeof t !== 'number') return null;
  if (kind !== 'meta' && kind !== 'join' && kind !== 'delta') return null;
  return { t, kind, label };
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
  /** Fires when a peer's mediatimeline track lands a new keyframe entry. */
  onPeerMediaTimeline?: (peerId: string, point: MediaTimelinePoint) => void;
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

    if (lower === MEDIA_TIMELINE_TRACK) {
      session.setSubscriptionCallback(evt.subscriptionId, (data) => {
        try {
          const entry = JSON.parse(decoder.decode(data)) as MediaTimelineEntry;
          const point = decodeMediaTimelineEntry(entry);
          opts.onPeerMediaTimeline?.(peerId, point);
        } catch (err) {
          opts.onError(err instanceof Error ? err : new Error(String(err)));
        }
      });
      return;
    }

    if (lower === EVENT_TRACK || lower.includes('timeline')) {
      session.setSubscriptionCallback(evt.subscriptionId, (data) => {
        try {
          const parsed = JSON.parse(decoder.decode(data)) as unknown;
          const timelineEvt = parseTimelineEvent(parsed);
          if (timelineEvt) opts.onEvent(peerId, timelineEvt);
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
  let videoTrackAlias: bigint | undefined;
  let mediaTimelineAlias: bigint | undefined;
  const publishStartMs = performance.now();
  let mediaTimelineSeq = 0;
  if (opts.publishMedia) {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        video: { width: 1280, height: 720 },
        audio: true,
      });
      videoTrackAlias = await mediaSession.publish(selfNamespace, VIDEO_TRACK, localStream, {
        ...MEDIA_CONFIG,
        audioEnabled: false,
      });
      await mediaSession.publish(selfNamespace, AUDIO_TRACK, localStream, {
        ...MEDIA_CONFIG,
        videoEnabled: false,
      });
      mediaTimelineAlias = await session.publish(selfNamespace, MEDIA_TIMELINE_TRACK, {
        deliveryMode: 'stream',
        deliveryTimeout: 0,
        skipForwardWait: true,
        priority: opts.transport.publisher.publisherPriority,
      });
      // Emit a mediatimeline entry each time the video track lands a keyframe
      // (draft-18 marks keyframes as objectId === 0 in a fresh group). PTS is a
      // monotonic offset from `publishStartMs`; wallclock is Date.now().
      mediaSession.on('publish-stats', (stats) => {
        if (stats.type !== 'video' || stats.objectId !== 0) return;
        if (videoTrackAlias === undefined || stats.trackAlias !== videoTrackAlias.toString()) return;
        if (mediaTimelineAlias === undefined) return;
        const mediaPTS = performance.now() - publishStartMs;
        const point: MediaTimelinePoint = {
          mediaPTS,
          groupId: stats.groupId,
          objectId: 0,
          wallclockTime: Date.now(),
        };
        const entry = encodeMediaTimelineEntry(point);
        const seq = mediaTimelineSeq++;
        void session.sendObject(
          mediaTimelineAlias,
          encoder.encode(JSON.stringify(entry)),
          { groupId: seq, objectId: 0 },
        ).catch((err) => opts.onError(err instanceof Error ? err : new Error(String(err))));
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
    if (opts.publishMedia && localStream) {
      (catalog as unknown as { tracks: unknown[] }).tracks.push({
        name: MEDIA_TIMELINE_TRACK,
        packaging: 'mediatimeline',
        isLive: true,
        depends: [VIDEO_TRACK],
      });
    }
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
      const entry = encodeEventTimelineEntry({
        wallclockTime: evt.t,
        data: { kind: evt.kind, label: evt.label },
      });
      await session.sendObject(trackAlias, encoder.encode(JSON.stringify(entry)), { groupId, objectId });
      opts.onEvent(opts.selfId, evt);
    },
    getLocalStream: () => localStream,
    setLocalMuted: (muted) => {
      localStream?.getAudioTracks().forEach((t) => { t.enabled = !muted; });
      // Signal the state change to peers with a catalog delta flipping the
      // audio track's `isLive` flag (MSF §7 update). Peers ignore the flag
      // for rendering but the debug panel surfaces the transition.
      const delta = createDelta()
        .update(AUDIO_TRACK, { isLive: !muted })
        .build();
      void msfSession.publishCatalogDelta(delta).catch((err) =>
        opts.onError(err instanceof Error ? err : new Error(String(err))),
      );
    },
    setLocalVideoOff: (off) => {
      localStream?.getVideoTracks().forEach((t) => { t.enabled = !off; });
      const delta = createDelta()
        .update(VIDEO_TRACK, { isLive: !off })
        .build();
      void msfSession.publishCatalogDelta(delta).catch((err) =>
        opts.onError(err instanceof Error ? err : new Error(String(err))),
      );
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
