// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import {
  EXPERIENCE_PROFILES,
  type ExperienceProfileName,
  type ExperienceProfile,
} from '@moq-web/media';

export type DeliveryMode = 'stream' | 'datagram';
export type GroupOrder = 'ascending' | 'descending';
export type FilterType = 'latest-object' | 'latest-group' | 'absolute-start' | 'absolute-range';

export interface PublisherTransportConfig {
  deliveryMode: DeliveryMode;
  /** MoQT publisher priority (0..255) */
  publisherPriority: number;
  /** Per-object delivery timeout in ms, undefined = no deadline */
  objectDeliveryTimeoutMs?: number;
  /** MoQT publisher group order */
  groupOrder: GroupOrder;
  /** Forwarding preference: stream-per-group vs stream-per-track (relay-dependent) */
  streamPerGroup: boolean;
  /** Max cache duration in ms the publisher advertises */
  maxCacheDurationMs?: number;
}

export interface SubscriberTransportConfig {
  /** MoQT subscriber priority (0..255) */
  subscriberPriority: number;
  /** MoQT subscriber group order */
  groupOrder: GroupOrder;
  filterType: FilterType;
  /** Draft-18: whether relay should forward objects (forward=1) or pause */
  forward: boolean;
  /** Draft-18 §10.2.13 NEW_GROUP_REQUEST auto-request on join */
  requestNewGroupOnJoin: boolean;
}

export interface RelayConfig {
  /** Ordered list of relay URLs. First = primary, rest = failover. */
  relays: string[];
  /** Preferred draft version. */
  draft: 'draft-16' | 'draft-18';
  /** Additional QUIC/WebTransport hints. */
  keepAliveMs: number;
  /** Reconnect strategy. */
  autoReconnect: boolean;
}

export interface LatencyProfile extends ExperienceProfile {
  publisher: PublisherTransportConfig;
  subscriber: SubscriberTransportConfig;
}

const asName = (name: ExperienceProfileName): Exclude<ExperienceProfileName, 'custom'> =>
  name as Exclude<ExperienceProfileName, 'custom'>;

/**
 * Latency profiles bundle playback (from @moq-web/media) with transport-layer
 * publisher/subscriber knobs. Each profile is a full recipe you can hand to
 * both the publish and subscribe pipelines.
 */
export const LATENCY_PROFILES: Record<Exclude<ExperienceProfileName, 'custom'>, LatencyProfile> = {
  'ultra-low': {
    ...EXPERIENCE_PROFILES[asName('ultra-low')],
    publisher: {
      deliveryMode: 'datagram',
      publisherPriority: 32,
      objectDeliveryTimeoutMs: 50,
      groupOrder: 'ascending',
      streamPerGroup: false,
      maxCacheDurationMs: 500,
    },
    subscriber: {
      subscriberPriority: 32,
      groupOrder: 'ascending',
      filterType: 'latest-object',
      forward: true,
      requestNewGroupOnJoin: true,
    },
  },

  'interactive': {
    ...EXPERIENCE_PROFILES[asName('interactive')],
    publisher: {
      deliveryMode: 'datagram',
      publisherPriority: 64,
      objectDeliveryTimeoutMs: 150,
      groupOrder: 'ascending',
      streamPerGroup: false,
      maxCacheDurationMs: 2000,
    },
    subscriber: {
      subscriberPriority: 64,
      groupOrder: 'ascending',
      filterType: 'latest-object',
      forward: true,
      requestNewGroupOnJoin: true,
    },
  },

  'low-latency-live': {
    ...EXPERIENCE_PROFILES[asName('low-latency-live')],
    publisher: {
      deliveryMode: 'stream',
      publisherPriority: 96,
      objectDeliveryTimeoutMs: 500,
      groupOrder: 'ascending',
      streamPerGroup: true,
      maxCacheDurationMs: 5000,
    },
    subscriber: {
      subscriberPriority: 96,
      groupOrder: 'ascending',
      filterType: 'latest-group',
      forward: true,
      requestNewGroupOnJoin: true,
    },
  },

  'live-streaming': {
    ...EXPERIENCE_PROFILES[asName('live-streaming')],
    publisher: {
      deliveryMode: 'stream',
      publisherPriority: 128,
      objectDeliveryTimeoutMs: 2000,
      groupOrder: 'ascending',
      streamPerGroup: true,
      maxCacheDurationMs: 30_000,
    },
    subscriber: {
      subscriberPriority: 128,
      groupOrder: 'ascending',
      filterType: 'latest-group',
      forward: true,
      requestNewGroupOnJoin: false,
    },
  },

  'broadcast': {
    ...EXPERIENCE_PROFILES[asName('broadcast')],
    publisher: {
      deliveryMode: 'stream',
      publisherPriority: 160,
      objectDeliveryTimeoutMs: 5000,
      groupOrder: 'ascending',
      streamPerGroup: true,
      maxCacheDurationMs: 300_000,
    },
    subscriber: {
      subscriberPriority: 160,
      groupOrder: 'ascending',
      filterType: 'latest-group',
      forward: true,
      requestNewGroupOnJoin: false,
    },
  },

  'vod': {
    ...EXPERIENCE_PROFILES[asName('vod')],
    publisher: {
      deliveryMode: 'stream',
      publisherPriority: 200,
      objectDeliveryTimeoutMs: undefined,
      groupOrder: 'ascending',
      streamPerGroup: true,
      maxCacheDurationMs: 3_600_000,
    },
    subscriber: {
      subscriberPriority: 200,
      groupOrder: 'ascending',
      filterType: 'absolute-start',
      forward: true,
      requestNewGroupOnJoin: false,
    },
  },
};

export const LATENCY_PROFILE_ORDER: Exclude<ExperienceProfileName, 'custom'>[] = [
  'ultra-low',
  'interactive',
  'low-latency-live',
  'live-streaming',
  'broadcast',
  'vod',
];

export type LatencyProfileName = ExperienceProfileName;

export function getLatencyProfile(name: LatencyProfileName): LatencyProfile | undefined {
  if (name === 'custom') return undefined;
  return LATENCY_PROFILES[asName(name)];
}
