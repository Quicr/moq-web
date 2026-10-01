// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * VOD/DVR subscriber. Subscribes to the catalog and mediatimeline tracks,
 * exposes a FetchDriver so the app can drive sawtooth FETCH windows against
 * the video track.
 */

import { connectMoqtSession, type ConnectedSession } from '@moq-web/app-kit/moqt';
import type { TransportConfig } from '@moq-web/app-kit/transport';
import { SubscribePipeline, type SubscribePipelineConfig } from '@moq-web/media';
import {
  MSFSession,
  decodeMediaTimelineEntry,
  type FullCatalog,
  type MediaTimelinePoint,
  type MediaTimelineEntry,
} from '@moq-web/msf';
import type { GroupPtsPoint } from '@moq-web/app-kit';
import type { FetchOptions } from '@moq-web/session';

const decoder = new TextDecoder();

export interface VodViewerHandle {
  connected: ConnectedSession;
  namespace: string[];
  waitForCatalog: () => Promise<FullCatalog>;
  waitForTimeline: () => Promise<GroupPtsPoint[]>;
  /** Fires whenever the timeline gains a new keyframe entry (publisher still uploading). */
  onTimelineUpdate: (cb: (points: GroupPtsPoint[]) => void) => () => void;
  /** Attach a SubscribePipeline for the video track and return it. */
  attachPipeline: (pipelineConfig: SubscribePipelineConfig) => SubscribePipeline;
  fetchVideo: (opts: {
    startGroup: number;
    endGroup: number;
    onObject: (data: Uint8Array, groupId: number, objectId: number) => void;
    fetchOptions?: FetchOptions;
  }) => Promise<bigint>;
  cancelFetch: (requestId: bigint) => Promise<void>;
  close: () => Promise<void>;
}

export interface VodViewerOptions {
  transport: TransportConfig;
  channel: string;
  onError?: (err: Error) => void;
  signal?: AbortSignal;
}

export async function openVodViewer(opts: VodViewerOptions): Promise<VodViewerHandle> {
  const connected = await connectMoqtSession({ transport: opts.transport, signal: opts.signal });
  const session = connected.session;
  const namespace = ['vod', opts.channel];

  session.on('session-terminated', (evt) => {
    opts.onError?.(new Error(`Session terminated: ${evt.reason ?? evt.code}`));
  });

  const msf = new MSFSession(session, namespace);

  const timelinePoints: GroupPtsPoint[] = [];
  const timelineListeners = new Set<(pts: GroupPtsPoint[]) => void>();
  const emitTimeline = () => {
    const snap = [...timelinePoints];
    for (const l of timelineListeners) l(snap);
  };

  let catalogResolve: ((c: FullCatalog) => void) | null = null;
  let catalogValue: FullCatalog | null = null;
  const catalogP = new Promise<FullCatalog>((resolve) => { catalogResolve = resolve; });

  let timelineSubscribed = false;

  await msf.subscribeCatalog((cat) => {
    catalogValue = cat;
    catalogResolve?.(cat);
    catalogResolve = null;
    console.log('[vod-dvr] catalog received', {
      tracks: cat.tracks.map((t) => ({ name: (t as { name?: string }).name, packaging: (t as { packaging?: string }).packaging })),
      hasInitDataList: Array.isArray((cat as unknown as { initDataList?: unknown[] }).initDataList),
    });
    // Subscribe the media timeline track lazily once we know it exists.
    const mediaTimeline = cat.tracks.find(
      (t) => (t as { packaging?: string }).packaging === 'mediatimeline',
    );
    if (mediaTimeline && !timelineSubscribed) {
      timelineSubscribed = true;
      // Use absolute-start from group 0 so a late subscriber (after publish
      // finished) still replays the whole mediatimeline from the relay cache.
      void session
        .subscribe(namespace, mediaTimeline.name, {
          priority: opts.transport.subscriber.subscriberPriority,
          filterType: 'absolute-start',
          startGroup: 0,
          startObject: 0,
        }, (data) => {
          try {
            const entry = JSON.parse(decoder.decode(data)) as MediaTimelineEntry;
            const point: MediaTimelinePoint = decodeMediaTimelineEntry(entry);
            timelinePoints.push({
              groupId: Number(point.groupId),
              ptsMs: point.mediaPTS,
            });
            emitTimeline();
          } catch (err) {
            opts.onError?.(err instanceof Error ? err : new Error(String(err)));
          }
        })
        .catch((err) => opts.onError?.(err instanceof Error ? err : new Error(String(err))));
    }
  }, (err) => {
    console.error('[vod-dvr] catalog parse error', err);
    opts.onError?.(err);
  });

  let attachedPipeline: SubscribePipeline | null = null;

  return {
    connected,
    namespace,
    waitForCatalog: () => catalogValue ? Promise.resolve(catalogValue) : catalogP,
    waitForTimeline: () => new Promise((resolve) => {
      if (timelinePoints.length > 0) {
        resolve([...timelinePoints]);
        return;
      }
      const unsub = (pts: GroupPtsPoint[]) => {
        if (pts.length === 0) return;
        timelineListeners.delete(unsub);
        resolve(pts);
      };
      timelineListeners.add(unsub);
    }),
    onTimelineUpdate: (cb) => {
      timelineListeners.add(cb);
      return () => timelineListeners.delete(cb);
    },
    attachPipeline: (pipelineConfig) => {
      if (attachedPipeline) return attachedPipeline;
      attachedPipeline = new SubscribePipeline(pipelineConfig);
      return attachedPipeline;
    },
    fetchVideo: async ({ startGroup, endGroup, onObject, fetchOptions }) => {
      // Video track name is fixed to `video` (matches publisher).
      const rid = await session.fetch(
        namespace,
        'video',
        { startGroup, startObject: 0, endGroup, endObject: 0 },
        {
          priority: opts.transport.subscriber.subscriberPriority,
          ...fetchOptions,
        },
        (data, groupId, objectId) => onObject(data, groupId, objectId),
      );
      return rid;
    },
    cancelFetch: (rid) => session.cancelFetch(rid),
    close: async () => {
      try { await msf.unsubscribeCatalog(); } catch { /* noop */ }
      try { attachedPipeline?.stop(); } catch { /* noop */ }
      try { await session.close(); } catch { /* noop */ }
    },
  };
}
