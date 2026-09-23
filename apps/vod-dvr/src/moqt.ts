// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { connectMoqtSession, type ConnectedSession } from '@moq-web/app-kit/moqt';
import type { TransportConfig } from '@moq-web/app-kit/transport';

const CHUNK_TRACK = 'chunks';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface VodChunk {
  index: number;
  totalChunks: number;
  chunkMs: number;
  assetId: string;
  payloadBytes: number;
}

export interface VodPublishHandle {
  namespace: string[];
  connected: ConnectedSession;
  publishAsset: (asset: { assetId: string; durationMs: number; sizeBytes: number }) => Promise<void>;
  close: () => Promise<void>;
}

/**
 * Publish a VOD asset as N chunks (~1s each) on a well-known namespace, and
 * subscribe to the same namespace so a viewer (potentially another tab) can
 * consume the chunks as they arrive.
 */
export async function openVodBroadcast(opts: {
  transport: TransportConfig;
  channel: string;
  onProgress: (pct: number) => void;
  onChunk: (chunk: VodChunk, receivedAtMs: number) => void;
  onError: (err: Error) => void;
  signal?: AbortSignal;
}): Promise<VodPublishHandle> {
  const connected = await connectMoqtSession({ transport: opts.transport, signal: opts.signal });
  const session = connected.session;

  const namespace = ['vod', opts.channel];

  session.on('session-terminated', (evt) =>
    opts.onError(new Error(`Session terminated: ${evt.reason ?? evt.code}`)),
  );

  await session.announceNamespace(namespace, { deliveryMode: 'stream' });

  const trackAlias = await session.publish(namespace, CHUNK_TRACK, {
    deliveryMode: 'stream',
    deliveryTimeout: 0,
    skipForwardWait: true,
    priority: opts.transport.publisher.publisherPriority,
    maxCacheDuration: 3_600_000,
  });

  try {
    await session.subscribe(namespace, CHUNK_TRACK, {
      priority: opts.transport.subscriber.subscriberPriority,
    }, (data) => {
      try {
        const chunk = JSON.parse(decoder.decode(data)) as VodChunk;
        opts.onChunk(chunk, Date.now());
      } catch (err) {
        opts.onError(err instanceof Error ? err : new Error(String(err)));
      }
    });
  } catch (err) {
    opts.onError(err instanceof Error ? err : new Error(String(err)));
  }

  return {
    namespace,
    connected,
    publishAsset: async ({ assetId, durationMs, sizeBytes }) => {
      const CHUNK_MS = 1000;
      const totalChunks = Math.max(1, Math.ceil(durationMs / CHUNK_MS));
      const bytesPerChunk = Math.max(1, Math.floor(sizeBytes / totalChunks));
      for (let i = 0; i < totalChunks; i++) {
        const chunk: VodChunk = {
          index: i,
          totalChunks,
          chunkMs: CHUNK_MS,
          assetId,
          payloadBytes: bytesPerChunk,
        };
        await session.sendObject(trackAlias, encoder.encode(JSON.stringify(chunk)), {
          groupId: i,
          objectId: 0,
          maxCacheDuration: 3_600_000,
        });
        opts.onProgress(Math.round(((i + 1) / totalChunks) * 100));
        // Pace publishing at ~50ms per chunk so the UI shows progress; the relay
        // won't cache-throttle because chunks are tiny JSON metadata blobs.
        await new Promise((r) => setTimeout(r, 50));
      }
    },
    close: async () => {
      try { await session.close(); } catch { /* noop */ }
    },
  };
}
