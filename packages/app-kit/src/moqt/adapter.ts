// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Stable, draft-agnostic MoQT adapter surface.
 *
 * Motivation
 * ----------
 * The moq-web `packages/core` codec is compile-time selected via the
 * `__MOQT_VERSION__` define — draft-16 and draft-18 produce different
 * `MOQTSession` shapes (message types, request-id widths, parameter maps,
 * NEW_GROUP_REQUEST wiring, etc.). To let apps target both drafts without
 * being rewritten each time the spec churns, they consume this adapter
 * instead of importing `@moq-web/session` / `@moq-web/media` directly.
 *
 * The adapter is intentionally minimal: it captures the shape every demo app
 * needs (connect, publish, subscribe, chat over a well-known namespace).
 * Draft-specific features like `sendRequestUpdate({ newGroupRequest })` or
 * `subscribeTracks({ namespacePrefixParam })` live on optional method groups
 * so callers can feature-detect.
 */

import type {
  PublisherTransportConfig,
  SubscriberTransportConfig,
} from '../latency/profiles.js';

export type Draft = 'draft-16' | 'draft-18';

export interface MoqtObject {
  groupId: bigint;
  objectId: bigint;
  payload: Uint8Array;
  /** Wall-clock ms at time of receive. */
  receivedAtMs: number;
}

export interface Namespace {
  parts: string[];
  toString: () => string;
}

export function makeNamespace(...parts: string[]): Namespace {
  return {
    parts,
    toString: () => parts.join('/'),
  };
}

export interface PublishOptions extends Partial<PublisherTransportConfig> {
  trackName: string;
}

export interface PublishHandle {
  /** Send one object on the track. */
  sendObject(payload: Uint8Array, opts?: { groupId?: bigint; objectId?: bigint }): Promise<void>;
  /** Draft-18 only: force a fresh keyframe / group boundary (no-op on d16). */
  forceNewGroup?(): Promise<void>;
  close(): Promise<void>;
}

export interface SubscribeOptions extends Partial<SubscriberTransportConfig> {
  trackName: string;
  onObject: (obj: MoqtObject) => void;
  onEnd?: (reason: string) => void;
}

export interface SubscribeHandle {
  /** Draft-18 only: ask upstream for a fresh keyframe (NEW_GROUP_REQUEST). */
  requestNewGroup?(): Promise<void>;
  unsubscribe(): Promise<void>;
}

export interface ConnectOptions {
  relayUrl: string;
  draft: Draft;
  /** Optional per-app subprotocol / auth token. */
  authToken?: string;
  signal?: AbortSignal;
}

export interface MoqtAdapter {
  readonly draft: Draft;
  connect(opts: ConnectOptions): Promise<void>;
  isReady(): boolean;
  publish(namespace: Namespace, opts: PublishOptions): Promise<PublishHandle>;
  subscribe(namespace: Namespace, opts: SubscribeOptions): Promise<SubscribeHandle>;
  close(): Promise<void>;
}

/**
 * A factory that produces an adapter for the requested draft. Apps call this
 * at connect time; the factory is expected to lazy-import the correct
 * `@moq-web/session` build. In practice, since the repo compiles one draft
 * at a time via `MOQT_VERSION=` at build time, the factory checks that the
 * bundled draft matches the requested one and reloads to the right base URL
 * if it doesn't.
 */
export type MoqtAdapterFactory = (draft: Draft) => Promise<MoqtAdapter>;
