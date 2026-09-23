// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { connectMoqtSession, type ConnectedSession } from '@moq-web/app-kit/moqt';
import type { TransportConfig } from '@moq-web/app-kit/transport';

const EVENT_TRACK = 'timeline';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface TimelineEvent {
  t: number;
  label: string;
  kind: 'meta' | 'join' | 'delta';
}

export interface StudioBroadcast {
  namespace: string[];
  connected: ConnectedSession;
  emitEvent: (evt: TimelineEvent) => Promise<void>;
  close: () => Promise<void>;
}

/**
 * Publish a `timeline` track under `studio/<room>/<selfId>` and subscribe to
 * the corresponding track under `studio/<room>/<peerId>` for any peer that
 * announces via the shared prefix.
 *
 * Draft-18 handles namespace subscription cleanly; on draft-16 relays we still
 * publish our track but only receive our own bounced-back events.
 */
export async function openStudioBroadcast(opts: {
  transport: TransportConfig;
  roomId: string;
  selfId: string;
  onEvent: (peerId: string, evt: TimelineEvent) => void;
  onPeerJoined: (peerId: string) => void;
  onPeerLeft: (peerId: string) => void;
  onError: (err: Error) => void;
  signal?: AbortSignal;
}): Promise<StudioBroadcast> {
  const connected = await connectMoqtSession({ transport: opts.transport, signal: opts.signal });
  const session = connected.session;

  const roomPrefix = ['studio', opts.roomId];
  const selfNamespace = [...roomPrefix, opts.selfId];

  session.on('session-terminated', (evt) =>
    opts.onError(new Error(`Session terminated: ${evt.reason ?? evt.code}`)),
  );

  const subscribedPeers = new Set<string>();
  const subscribeToPeer = async (peerId: string, ns: string[]) => {
    if (subscribedPeers.has(peerId)) return;
    subscribedPeers.add(peerId);
    opts.onPeerJoined(peerId);
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
      subscribedPeers.delete(peerId);
      opts.onError(err instanceof Error ? err : new Error(String(err)));
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
    void subscribeToPeer(peerId, ns);
  });

  session.on('namespace-done', (evt) => {
    const ns = evt.namespace;
    if (ns.length !== roomPrefix.length + 1) return;
    const peerId = ns[ns.length - 1]!;
    if (subscribedPeers.delete(peerId)) opts.onPeerLeft(peerId);
  });

  try { await session.subscribeNamespace(roomPrefix); }
  catch (err) { /* subscribeNamespace unsupported on some relays; ignore */ void err; }

  await session.announceNamespace(selfNamespace, { deliveryMode: 'stream' });

  const trackAlias = await session.publish(selfNamespace, EVENT_TRACK, {
    deliveryMode: 'stream',
    deliveryTimeout: 0,
    skipForwardWait: true,
    priority: opts.transport.publisher.publisherPriority,
  });

  // Loopback subscribe so the operator sees their own events land.
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
    close: async () => {
      try { await session.close(); } catch { /* noop */ }
    },
  };
}
