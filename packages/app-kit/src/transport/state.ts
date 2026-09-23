// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { useCallback, useMemo, useSyncExternalStore } from 'react';
import {
  LATENCY_PROFILES,
  type LatencyProfile,
  type LatencyProfileName,
  type PublisherTransportConfig,
  type SubscriberTransportConfig,
  type RelayConfig,
} from '../latency/profiles.js';

export interface TransportConfig {
  profile: LatencyProfileName;
  relay: RelayConfig;
  publisher: PublisherTransportConfig;
  subscriber: SubscriberTransportConfig;
  /** Non-transport playback tweaks bundled into the same store for convenience. */
  playback: LatencyProfile['settings'];
  /** Target end-to-end latency in ms (from the profile, but user-editable). */
  targetLatencyMs: number;
}

const DEFAULT_RELAY: RelayConfig = {
  relays: [
    'https://moqx-main.ci.openmoq.org:4433/moq-relay',
  ],
  draft: 'draft-18',
  keepAliveMs: 20_000,
  autoReconnect: true,
};

function fromProfile(name: LatencyProfileName): TransportConfig {
  const effective = name === 'custom' ? 'interactive' : name;
  const p = LATENCY_PROFILES[effective as Exclude<LatencyProfileName, 'custom'>];
  return {
    profile: name,
    relay: DEFAULT_RELAY,
    publisher: { ...p.publisher },
    subscriber: { ...p.subscriber },
    playback: { ...p.settings },
    targetLatencyMs: p.targetLatency,
  };
}

const STORAGE_KEY = 'ak.transport.v1';

function loadInitial(): TransportConfig {
  if (typeof window === 'undefined') return fromProfile('interactive');
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return fromProfile('interactive');
    const parsed = JSON.parse(raw) as Partial<TransportConfig>;
    const base = fromProfile((parsed.profile as LatencyProfileName) ?? 'interactive');
    return {
      ...base,
      ...parsed,
      relay: { ...base.relay, ...(parsed.relay ?? {}) },
      publisher: { ...base.publisher, ...(parsed.publisher ?? {}) },
      subscriber: { ...base.subscriber, ...(parsed.subscriber ?? {}) },
      playback: { ...base.playback, ...(parsed.playback ?? {}) },
    };
  } catch {
    return fromProfile('interactive');
  }
}

type Listener = () => void;

class TransportStore {
  private state: TransportConfig = loadInitial();
  private listeners = new Set<Listener>();

  get(): TransportConfig {
    return this.state;
  }

  private commit(next: TransportConfig) {
    this.state = next;
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* quota — ignore */
      }
    }
    for (const l of this.listeners) l();
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  applyProfile(name: LatencyProfileName) {
    this.commit({ ...fromProfile(name), relay: this.state.relay });
  }

  setRelay(relay: Partial<RelayConfig>) {
    this.commit({ ...this.state, relay: { ...this.state.relay, ...relay } });
  }

  setPublisher(patch: Partial<PublisherTransportConfig>) {
    this.commit({
      ...this.state,
      publisher: { ...this.state.publisher, ...patch },
      profile: 'custom',
    });
  }

  setSubscriber(patch: Partial<SubscriberTransportConfig>) {
    this.commit({
      ...this.state,
      subscriber: { ...this.state.subscriber, ...patch },
      profile: 'custom',
    });
  }

  setPlayback(patch: Partial<LatencyProfile['settings']>) {
    this.commit({
      ...this.state,
      playback: { ...this.state.playback, ...patch },
      profile: 'custom',
    });
  }

  setTargetLatency(ms: number) {
    this.commit({ ...this.state, targetLatencyMs: ms });
  }

  reset() {
    this.commit(fromProfile('interactive'));
  }
}

const store = new TransportStore();

export function getTransportConfig(): TransportConfig {
  return store.get();
}

export function useTransportConfig(): TransportConfig {
  return useSyncExternalStore(
    (l) => store.subscribe(l),
    () => store.get(),
    () => store.get(),
  );
}

export interface TransportActions {
  applyProfile: (name: LatencyProfileName) => void;
  setRelay: (relay: Partial<RelayConfig>) => void;
  addRelay: (url: string) => void;
  removeRelay: (idx: number) => void;
  reorderRelay: (from: number, to: number) => void;
  setPublisher: (patch: Partial<PublisherTransportConfig>) => void;
  setSubscriber: (patch: Partial<SubscriberTransportConfig>) => void;
  setPlayback: (patch: Partial<LatencyProfile['settings']>) => void;
  setTargetLatency: (ms: number) => void;
  reset: () => void;
}

export function useTransportActions(): TransportActions {
  const applyProfile = useCallback((n: LatencyProfileName) => store.applyProfile(n), []);
  const setRelay = useCallback((r: Partial<RelayConfig>) => store.setRelay(r), []);
  const addRelay = useCallback((url: string) => {
    const cur = store.get().relay.relays;
    store.setRelay({ relays: [...cur, url] });
  }, []);
  const removeRelay = useCallback((idx: number) => {
    const cur = store.get().relay.relays;
    store.setRelay({ relays: cur.filter((_, i) => i !== idx) });
  }, []);
  const reorderRelay = useCallback((from: number, to: number) => {
    const cur = [...store.get().relay.relays];
    const [item] = cur.splice(from, 1);
    cur.splice(to, 0, item);
    store.setRelay({ relays: cur });
  }, []);
  const setPublisher = useCallback((p: Partial<PublisherTransportConfig>) => store.setPublisher(p), []);
  const setSubscriber = useCallback((p: Partial<SubscriberTransportConfig>) => store.setSubscriber(p), []);
  const setPlayback = useCallback((p: Partial<LatencyProfile['settings']>) => store.setPlayback(p), []);
  const setTargetLatency = useCallback((ms: number) => store.setTargetLatency(ms), []);
  const reset = useCallback(() => store.reset(), []);

  return useMemo(
    () => ({
      applyProfile,
      setRelay,
      addRelay,
      removeRelay,
      reorderRelay,
      setPublisher,
      setSubscriber,
      setPlayback,
      setTargetLatency,
      reset,
    }),
    [
      applyProfile,
      setRelay,
      addRelay,
      removeRelay,
      reorderRelay,
      setPublisher,
      setSubscriber,
      setPlayback,
      setTargetLatency,
      reset,
    ],
  );
}
