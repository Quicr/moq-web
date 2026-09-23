// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { connectMoqtSession, type ConnectedSession } from '@moq-web/app-kit/moqt';
import type { TransportConfig } from '@moq-web/app-kit/transport';
import { MediaSession, type MediaConfig } from '@moq-web/media';
import {
  MSFSession,
  createCatalog,
  type FullCatalog,
} from '@moq-web/msf';

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
  timelineSubscribed: boolean;
  mediaSubscribed: boolean;
}

/**
 * Publish `timeline` + optional `video`/`audio` tracks and an MSF catalog
 * under `studio/<room>/<selfId>`, and subscribe to the same track set on any
 * peer that announces under the shared room prefix.
 */
export async function openStudioBroadcast(opts: OpenStudioOptions): Promise<StudioBroadcast> {
  const connected = await connectMoqtSession({ transport: opts.transport, signal: opts.signal });
  const session = connected.session;

  const roomPrefix = ['studio', opts.roomId];
  const selfNamespace = [...roomPrefix, opts.selfId];

  session.on('session-terminated', (evt) =>
    opts.onError(new Error(`Session terminated: ${evt.reason ?? evt.code}`)),
  );

  const mediaSession = new MediaSession({ session });
  const msfSession = new MSFSession(session, selfNamespace);

  const peers = new Map<string, PeerState>();
  const mediaSubIdToPeer = new Map<number, string>();
  const peerCatalogSubs = new Map<string, MSFSession>();

  mediaSession.on('video-frame', ({ subscriptionId, frame }) => {
    const peerId = mediaSubIdToPeer.get(subscriptionId);
    if (!peerId) {
      frame.close();
      return;
    }
    opts.onPeerVideoFrame(peerId, frame);
  });

  mediaSession.on('audio-data', ({ subscriptionId, audioData }) => {
    const peerId = mediaSubIdToPeer.get(subscriptionId);
    if (!peerId) {
      audioData.close();
      return;
    }
    opts.onPeerAudioData(peerId, audioData);
  });

  const subscribeToPeerTimeline = async (peerId: string, ns: string[]) => {
    const state = peers.get(peerId);
    if (!state || state.timelineSubscribed) return;
    state.timelineSubscribed = true;
    try {
      await session.subscribe(ns, EVENT_TRACK, {
        priority: opts.transport.subscriber.subscriberPriority,
      }, (data) => {
        try {
          const evt = JSON.parse(decoder.decode(data)) as TimelineEvent;
          opts.onEvent(peerId, evt);
        } catch (err) {
          opts.onError(err instanceof Error ? err : new Error(String(err)));
        }
      });
    } catch (err) {
      state.timelineSubscribed = false;
      opts.onError(err instanceof Error ? err : new Error(String(err)));
    }
  };

  const subscribeToPeerMedia = async (peerId: string, ns: string[]) => {
    const state = peers.get(peerId);
    if (!state || state.mediaSubscribed) return;
    state.mediaSubscribed = true;
    try {
      const videoSubId = await mediaSession.subscribe(ns, VIDEO_TRACK, MEDIA_CONFIG, 'video');
      mediaSubIdToPeer.set(videoSubId, peerId);
    } catch (err) {
      opts.onError(err instanceof Error ? err : new Error(String(err)));
    }
    try {
      const audioSubId = await mediaSession.subscribe(ns, AUDIO_TRACK, MEDIA_CONFIG, 'audio');
      mediaSubIdToPeer.set(audioSubId, peerId);
    } catch (err) {
      opts.onError(err instanceof Error ? err : new Error(String(err)));
    }
  };

  const subscribeToPeerCatalog = async (peerId: string, ns: string[]) => {
    if (peerCatalogSubs.has(peerId)) return;
    const peerMsf = new MSFSession(session, ns);
    peerCatalogSubs.set(peerId, peerMsf);
    try {
      await peerMsf.subscribeCatalog((catalog) => opts.onPeerCatalog(peerId, catalog));
    } catch (err) {
      peerCatalogSubs.delete(peerId);
      // Catalog subscription is best-effort; older peers may not publish one.
      void err;
    }
  };

  session.on('namespace-announced', (evt) => {
    const ns = evt.namespace;
    if (ns.length !== roomPrefix.length + 1) return;
    for (let i = 0; i < roomPrefix.length; i++) {
      if (ns[i] !== roomPrefix[i]) return;
    }
    const peerId = ns[ns.length - 1]!;
    if (peerId === opts.selfId) return;
    if (!peers.has(peerId)) {
      peers.set(peerId, { timelineSubscribed: false, mediaSubscribed: false });
      opts.onPeerJoined(peerId);
    }
    void subscribeToPeerTimeline(peerId, ns);
    void subscribeToPeerMedia(peerId, ns);
    void subscribeToPeerCatalog(peerId, ns);
  });

  session.on('namespace-done', (evt) => {
    const ns = evt.namespace;
    if (ns.length !== roomPrefix.length + 1) return;
    const peerId = ns[ns.length - 1]!;
    if (peers.delete(peerId)) {
      const sub = peerCatalogSubs.get(peerId);
      if (sub) {
        void sub.unsubscribeCatalog();
        peerCatalogSubs.delete(peerId);
      }
      opts.onPeerLeft(peerId);
    }
  });

  try { await session.subscribeNamespace(roomPrefix); }
  catch (err) { void err; }

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

  // Publish MSF catalog describing our tracks.
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
      eventtimeline: { eventType: 'studio-timeline' },
    });
    await msfSession.publishCatalog(catalog);
  } catch (err) {
    // Catalog publish is best-effort; some relays may not support it.
    void err;
  }

  // Now that every track is registered, announce ourselves so peers subscribe.
  await session.announceNamespace(selfNamespace, { deliveryMode: 'stream' });

  // Loopback subscribe so the operator sees their own events.
  try {
    await session.subscribe(selfNamespace, EVENT_TRACK, {
      priority: opts.transport.subscriber.subscriberPriority,
    }, (data) => {
      try {
        const evt = JSON.parse(decoder.decode(data)) as TimelineEvent;
        opts.onEvent(opts.selfId, evt);
      } catch (err) {
        opts.onError(err instanceof Error ? err : new Error(String(err)));
      }
    });
  } catch (err) { void err; }

  let seq = 0;
  return {
    namespace: selfNamespace,
    connected,
    emitEvent: async (evt) => {
      const groupId = seq;
      const objectId = 0;
      seq += 1;
      await session.sendObject(trackAlias, encoder.encode(JSON.stringify(evt)), { groupId, objectId });
    },
    getLocalStream: () => localStream,
    setLocalMuted: (muted) => {
      localStream?.getAudioTracks().forEach((t) => { t.enabled = !muted; });
    },
    setLocalVideoOff: (off) => {
      localStream?.getVideoTracks().forEach((t) => { t.enabled = !off; });
    },
    close: async () => {
      for (const sub of peerCatalogSubs.values()) {
        try { await sub.unsubscribeCatalog(); } catch { /* noop */ }
      }
      peerCatalogSubs.clear();
      try { await msfSession.stopCatalogPublishing(); } catch { /* noop */ }
      try { await mediaSession.close(); } catch { /* noop */ }
      for (const track of localStream?.getTracks() ?? []) track.stop();
      try { await session.close(); } catch { /* noop */ }
    },
  };
}
