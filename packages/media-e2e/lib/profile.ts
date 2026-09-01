// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Profile schema for media-e2e tests. Analogous to session-e2e/lib/profile.ts
 * but the payload spec describes an encoded video/audio track instead of chat.
 */

export type DeliveryMode = 'stream' | 'datagram';

export interface VideoTrackSpec {
  kind: 'video';
  width: number;
  height: number;
  bitrate: number;
  framerate: number;
  /** Publish this many seconds of video before asserting delivery. */
  durationSeconds: number;
  /** Keyframe cadence (in seconds); 1 means every-second keyframe. */
  keyframeIntervalSeconds?: number;
}

export interface TrackProfile {
  name: string;
  delivery: DeliveryMode;
  priority?: number;
  deliveryTimeout?: number;
  spec: VideoTrackSpec;
}

export interface AuthProfile {
  tokenEnv: string;
  tokenType?: 'c4m' | number;
  scope?: 'setup' | 'per-request' | 'both';
}

export interface Profile {
  relayUrl: string;
  auth?: AuthProfile;
  namespacePrefix: string[];
  tracks: TrackProfile[];
}

export interface ResolvedProfile extends Profile {
  authToken: string;
}

function getEnv(name: string): string | undefined {
  const viteEnv = (import.meta as unknown as { env?: Record<string, string> })
    .env;
  return viteEnv?.[name];
}

export function resolveProfile(raw: Profile): ResolvedProfile {
  const relayUrl = getEnv('VITE_RELAY_URL') ?? raw.relayUrl;
  if (!relayUrl) {
    throw new Error('RELAY_URL not set (env VITE_RELAY_URL or profile.relayUrl)');
  }

  let authToken = '';
  if (raw.auth?.tokenEnv) {
    authToken = getEnv(`VITE_${raw.auth.tokenEnv}`) ?? getEnv(raw.auth.tokenEnv) ?? '';
    if (!authToken) {
      authToken = getEnv('VITE_MOQ_AUTH_TOKEN') ?? '';
    }
  }

  return { ...raw, relayUrl, authToken };
}

export function makeNamespace(profile: ResolvedProfile, testName: string): string[] {
  const runId = crypto.randomUUID().slice(0, 8);
  return [...profile.namespacePrefix, testName, runId];
}
