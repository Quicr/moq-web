// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Ingest an MP4 asset from disk/URL, republish it as a MoQ live-appearing
 * VOD asset alongside an MSF catalog + media timeline. The relay's own
 * cache (moqx `maxCacheDuration`) is what makes it addressable to a viewer
 * via FETCH after publish is done.
 *
 * We publish two tracks:
 *   1. `video`      — `packaging: 'loc'`, one MoQ group per keyframe
 *                     (GOP boundary), samples are LOC-packaged so the
 *                     existing SubscribePipeline can decode without change.
 *   2. `mediatimeline` — `packaging: 'mediatimeline'`, one entry per GOP
 *                     boundary mapping mediaPTS_ms → (groupId, 0). Lets the
 *                     viewer resolve "scrub to 30 s" to a specific fetch
 *                     range without arithmetic.
 */

import { connectMoqtSession, type ConnectedSession } from '@moq-web/app-kit/moqt';
import type { TransportConfig } from '@moq-web/app-kit/transport';
import { LOCPackager } from '@moq-web/media';
import {
  MSFSession,
  createCatalog,
  encodeMediaTimelineEntry,
  type FullCatalog,
  type MediaTimelinePoint,
} from '@moq-web/msf';
import { openMp4Source, type Mp4Source } from './mp4-source.js';

const VIDEO_TRACK = 'video';
const MEDIA_TIMELINE_TRACK = 'mediatimeline';

const encoder = new TextEncoder();

export interface VodPublishStats {
  bytesPublished: number;
  keyframes: number;
  samples: number;
  currentPtsMs: number;
  durationMs: number;
}

export interface VodPublishOptions {
  transport: TransportConfig;
  channel: string;
  /** Input: file from disk OR remote URL. */
  input: File | { url: string };
  /** Optional AbortSignal to stop the publish loop. */
  signal?: AbortSignal;
  onStats?: (stats: VodPublishStats) => void;
  onReady?: (info: { durationMs: number; codec: string; width: number; height: number }) => void;
  onError?: (err: Error) => void;
}

export interface VodPublishHandle {
  namespace: string[];
  connected: ConnectedSession;
  /** Resolves once the entire asset has been published (or aborted). */
  finished: Promise<void>;
  close: () => Promise<void>;
}

/**
 * Publish an MP4 asset once. The relay caches it (per catalog maxCacheDuration),
 * so subscribers that arrive later can FETCH ranges from the relay directly.
 */
export async function publishVodAsset(opts: VodPublishOptions): Promise<VodPublishHandle> {
  const connected = await connectMoqtSession({ transport: opts.transport, signal: opts.signal });
  const session = connected.session;
  const namespace = ['vod', opts.channel];

  session.on('session-terminated', (evt) => {
    opts.onError?.(new Error(`Session terminated: ${evt.reason ?? evt.code}`));
  });

  const source: Mp4Source = await openMp4Source(
    opts.input instanceof File ? opts.input : { url: opts.input.url, signal: opts.signal },
  );

  opts.onReady?.({
    durationMs: source.info.durationMs,
    codec: source.info.codec,
    width: source.info.width,
    height: source.info.height,
  });

  await session.announceNamespace(namespace, { deliveryMode: 'stream' });

  // Priority high enough that live viewers still see us if the relay is busy.
  const priority = opts.transport.publisher.publisherPriority;

  const videoAlias = await session.publish(namespace, VIDEO_TRACK, {
    deliveryMode: 'stream',
    deliveryTimeout: 0,
    skipForwardWait: true,
    priority,
    // Retain the entire asset on the relay for the DVR window.
    maxCacheDuration: 3_600_000,
  });

  const mediaTimelineAlias = await session.publish(namespace, MEDIA_TIMELINE_TRACK, {
    deliveryMode: 'stream',
    deliveryTimeout: 0,
    skipForwardWait: true,
    priority,
    maxCacheDuration: 3_600_000,
  });

  // MSF catalog: declare the two tracks with codec info + init data so the
  // viewer's decoder can be configured without probing samples.
  // Republish the catalog every 2s so subscribers that arrive after publish
  // completes still get it (draft-18 subscriptions don't replay history).
  const msf = new MSFSession(session, namespace, {
    catalogPublishOptions: { republishIntervalMs: 2000 },
  });
  await msf.startCatalogPublishing();
  const catalog = createCatalog()
    .generatedAt()
    .addVideoTrack({
      name: VIDEO_TRACK,
      codec: source.info.codec,
      width: source.info.width,
      height: source.info.height,
      framerate: 30,
      bitrate: 2_000_000,
      isLive: false,
    })
    .build() as FullCatalog;
  // Append the mediatimeline track (builder has no addMediaTimeline helper).
  (catalog as unknown as { tracks: unknown[] }).tracks.push({
    name: MEDIA_TIMELINE_TRACK,
    packaging: 'mediatimeline',
    isLive: false,
    depends: [VIDEO_TRACK],
  });
  // Encode the AVCDecoderConfigurationRecord as base64 for the viewer to feed
  // the WebCodecs VideoDecoder as `description`. MSF §5 stores init blobs in
  // top-level `initDataList` with `id`; tracks reference them via `initRef`.
  const initDataB64 = base64Encode(source.info.description);
  const INIT_ID = `${VIDEO_TRACK}-init`;
  (catalog as unknown as { initDataList?: unknown[] }).initDataList = [
    { id: INIT_ID, data: initDataB64, mimeType: 'video/avc' },
  ];
  const videoTrack = catalog.tracks.find(
    (t) => (t as { name?: string }).name === VIDEO_TRACK,
  ) as { initRef?: string } | undefined;
  if (videoTrack) videoTrack.initRef = INIT_ID;
  await msf.publishCatalog(catalog);

  const packager = new LOCPackager();
  const stats: VodPublishStats = {
    bytesPublished: 0,
    keyframes: 0,
    samples: 0,
    currentPtsMs: 0,
    durationMs: source.info.durationMs,
  };

  let groupId = -1;
  let objectIdInGroup = 0;

  const publish = async () => {
    try {
      for await (const sample of source.samples()) {
        if (opts.signal?.aborted) return;
        if (sample.isKeyframe) {
          groupId += 1;
          objectIdInGroup = 0;
          stats.keyframes += 1;
          const point: MediaTimelinePoint = {
            mediaPTS: sample.ptsMs,
            groupId,
            objectId: 0,
            wallclockTime: Date.now(),
          };
          const entry = encodeMediaTimelineEntry(point);
          const payload = encoder.encode(JSON.stringify(entry));
          await session.sendObject(mediaTimelineAlias, payload, {
            groupId: stats.keyframes - 1,
            objectId: 0,
            maxCacheDuration: 3_600_000,
          });
        }
        if (groupId < 0) {
          // No keyframe seen yet — skip leading B/P (shouldn't happen for
          // valid MP4 but defend against it).
          continue;
        }
        const packet = packager.packageVideo(sample.data, {
          isKeyframe: sample.isKeyframe,
          captureTimestamp: sample.ptsMs,
        });
        await session.sendObject(videoAlias, packet, {
          groupId,
          objectId: objectIdInGroup,
          newGroup: sample.isKeyframe && objectIdInGroup === 0,
          isKeyframe: sample.isKeyframe,
          type: 'video',
          maxCacheDuration: 3_600_000,
        });
        stats.bytesPublished += packet.byteLength;
        stats.samples += 1;
        stats.currentPtsMs = sample.ptsMs;
        objectIdInGroup += 1;
        opts.onStats?.({ ...stats });
      }
    } catch (err) {
      opts.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  };

  const finished = publish();

  return {
    namespace,
    connected,
    finished,
    close: async () => {
      source.close();
      try { await msf.stopCatalogPublishing(); } catch { /* noop */ }
      try { await session.close(); } catch { /* noop */ }
    },
  };
}

function base64Encode(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
