// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Profile schema for e2e tests.
 *
 * Profiles are JSON files loaded at test start; env vars override `relayUrl`
 * and supply the auth token (never hardcoded).
 */

export type DeliveryMode = 'stream' | 'datagram';

export interface ChatPayload {
  kind: 'chat-text';
  /** Number of objects to publish (spread across groups). */
  messages: number;
  /** Target byte size per message; generator pads to this size. */
  sizeBytes: number;
  /** Objects per group; new group started after this many. */
  objectsPerGroup?: number;
}

export interface TrackProfile {
  /** Track name suffix (namespace is generated per-test). */
  name: string;
  delivery: DeliveryMode;
  priority?: number;
  deliveryTimeout?: number;
  payload: ChatPayload;
}

export interface AuthProfile {
  /** Env var name that holds the token value. Empty string => no auth. */
  tokenEnv: string;
  /** Token type identifier; defaults to C4M when omitted. */
  tokenType?: 'c4m' | number;
  /** Where to attach the token: session setup, per-request, or both. */
  scope?: 'setup' | 'per-request' | 'both';
}

export interface Profile {
  relayUrl: string;
  auth?: AuthProfile;
  /** Prefix prepended to every test's unique namespace. */
  namespacePrefix: string[];
  tracks: TrackProfile[];
}

export interface ResolvedProfile extends Profile {
  /** Concrete token bytes (empty if none configured). */
  authToken: string;
}

function getEnv(name: string): string | undefined {
  // Vitest browser injects VITE_-prefixed env vars via import.meta.env
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
    // MOQ_AUTH_TOKEN is the canonical variable; also accept it directly.
    if (!authToken) {
      authToken = getEnv('VITE_MOQ_AUTH_TOKEN') ?? '';
    }
  }

  return { ...raw, relayUrl, authToken };
}

/**
 * Generate a unique namespace for a single test invocation. Combines the
 * profile prefix + test name + a short random suffix, so parallel tests
 * against the same relay do not collide.
 */
export function makeNamespace(profile: ResolvedProfile, testName: string): string[] {
  const runId = crypto.randomUUID().slice(0, 8);
  return [...profile.namespacePrefix, testName, runId];
}
