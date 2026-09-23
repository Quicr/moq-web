// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { connectMoqtSession, type ConnectedSession } from '@moq-web/app-kit/moqt';
import type { TransportConfig } from '@moq-web/app-kit/transport';

const TRACK = 'catalog';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface CatalogRoundTrip {
  namespace: string[];
  publish: (payload: object | string) => Promise<void>;
  close: () => Promise<void>;
}

/**
 * Establish two loopback flows over the same session:
 *   - announce our namespace and publish() the catalog track
 *   - subscribe() to that same track and hand received JSON blobs to `onReceived`
 *
 * The relay bounces each object back, so any subscriber (this page or another
 * tab) sees the same catalog the publisher just wrote.
 */
export async function openCatalogRoundTrip(opts: {
  transport: TransportConfig;
  namespace: string[];
  onPublished: (json: unknown, groupId: number, objectId: number) => void;
  onReceived: (json: unknown, groupId: number, objectId: number) => void;
  onError: (err: Error) => void;
  signal?: AbortSignal;
}): Promise<CatalogRoundTrip & { connected: ConnectedSession }> {
  const connected = await connectMoqtSession({ transport: opts.transport, signal: opts.signal });
  const session = connected.session;

  session.on('session-terminated', (evt) => opts.onError(new Error(`Session terminated: ${evt.reason ?? evt.code}`)));

  // Announce so a peer subscriber (or ourselves) can discover the namespace.
  await session.announceNamespace(opts.namespace, { deliveryMode: 'stream' });

  const trackAlias = await session.publish(opts.namespace, TRACK, {
    deliveryMode: 'stream',
    deliveryTimeout: 0,
    skipForwardWait: true,
    priority: opts.transport.publisher.publisherPriority,
  });

  await session.subscribe(opts.namespace, TRACK, {
    priority: opts.transport.subscriber.subscriberPriority,
  }, (data, groupId, objectId) => {
    try {
      const parsed = JSON.parse(decoder.decode(data)) as unknown;
      opts.onReceived(parsed, groupId, objectId);
    } catch (err) {
      opts.onError(err instanceof Error ? err : new Error(String(err)));
    }
  });

  let seq = 0;
  return {
    namespace: opts.namespace,
    connected,
    publish: async (payload) => {
      const groupId = seq;
      const objectId = 0;
      seq += 1;
      const json = typeof payload === 'string' ? payload : JSON.stringify(payload);
      const bytes = encoder.encode(json);
      await session.sendObject(trackAlias, bytes, { groupId, objectId });
      const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
      opts.onPublished(parsed, groupId, objectId);
    },
    close: async () => {
      try { await session.close(); } catch { /* noop */ }
    },
  };
}
