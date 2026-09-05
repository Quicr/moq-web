// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Creates a `SecureObjectsContext` for an MSF track.
 *
 * MSF §3 says publishers and subscribers integrating encryption MUST use the
 * `moq-secure-objects` scheme (unless a track opts in to a reverse-DNS
 * custom scheme). This module is the boundary at which we combine the
 * catalog-level metadata (`encryptionScheme`, `cipherSuite`, `keyId`,
 * `trackBaseKey`) with a caller-supplied key resolver to produce a runtime
 * encryption context.
 */

import {
  SecureObjectsContext,
  type EncryptionConfig,
  type TrackIdentifier,
} from '@moq-web/secure-objects';
import type { Track } from '../schemas/index.js';
import { RECOMMENDED_ENCRYPTION_SCHEME } from '../schemas/index.js';
import { toSoCipherSuite } from './cipher-suite-map.js';

/**
 * Error thrown by security-bridge helpers.
 */
export class TrackSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrackSecurityError';
  }
}

/**
 * Return true when a track advertises the moq-secure-objects scheme in a way
 * that requires runtime crypto.
 */
export function isSecureObjectsTrack(track: Track): boolean {
  return track.encryptionScheme === RECOMMENDED_ENCRYPTION_SCHEME;
}

/**
 * Options for building a secure-objects context from a track.
 */
export interface CreateTrackContextOptions {
  /**
   * Namespace override. Defaults to `track.namespace` on the catalog entry.
   * The catalog schema treats `namespace` as optional at the track level, so
   * many deployments carry the session-level namespace here.
   */
  namespace?: string[];
  /**
   * Resolves the raw key material for a given key id. `keyId` is the
   * base64-encoded value from the catalog (or `undefined` if the catalog
   * omitted it). The resolver MUST return the 16- or 32-byte track base key.
   */
  keyResolver: (keyId: string | undefined) => Promise<Uint8Array> | Uint8Array;
}

/**
 * Decode a standard base64 (RFC 4648) string into bytes. Works in both
 * browsers (via `atob`) and Node without pulling in a Buffer dependency.
 */
function base64Decode(s: string): Uint8Array {
  const clean = s.replace(/\s+/g, '');
  // In Node, atob exists on globalThis since v18.
  const binary =
    typeof atob === 'function'
      ? atob(clean)
      : // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (globalThis as any).Buffer.from(clean, 'base64').toString('binary');
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Parse a base64 keyId string into a 64-bit unsigned bigint.
 *
 * MSF encodes keyId as base64 for JSON compatibility; secure-objects expects
 * a bigint (the low bytes of the identifier).
 */
export function parseKeyIdToBigInt(keyId: string | undefined): bigint {
  if (!keyId) return 0n;
  const bytes = base64Decode(keyId);
  let v = 0n;
  const take = Math.min(bytes.length, 8);
  for (let i = 0; i < take; i++) {
    v = (v << 8n) | BigInt(bytes[i]);
  }
  return v;
}

/**
 * Build a {@link SecureObjectsContext} for a catalog track.
 *
 * @throws {@link TrackSecurityError} when the track does not carry the
 *   required moq-secure-objects metadata (scheme, cipher suite).
 */
export async function createTrackContext(
  track: Track,
  opts: CreateTrackContextOptions
): Promise<SecureObjectsContext> {
  if (!isSecureObjectsTrack(track)) {
    throw new TrackSecurityError(
      `track '${track.name}' does not use moq-secure-objects (scheme=${
        track.encryptionScheme ?? 'unset'
      })`
    );
  }
  if (track.cipherSuite === undefined) {
    throw new TrackSecurityError(
      `track '${track.name}' declares moq-secure-objects but omits \`cipherSuite\` (MSF §6/§15)`
    );
  }

  const cipherSuite = toSoCipherSuite(track.cipherSuite);
  const namespace = opts.namespace ?? track.namespace ?? [];
  if (namespace.length === 0) {
    throw new TrackSecurityError(
      `track '${track.name}' has no namespace to bind the secure-objects context to`
    );
  }

  const rawKey = await opts.keyResolver(track.keyId);
  if (!(rawKey instanceof Uint8Array) || rawKey.length === 0) {
    throw new TrackSecurityError(
      `keyResolver returned invalid key material for track '${track.name}'`
    );
  }

  const trackId: TrackIdentifier = {
    namespace,
    trackName: track.name,
  };

  const config: EncryptionConfig = {
    trackBaseKey: rawKey,
    keyId: parseKeyIdToBigInt(track.keyId),
    cipherSuite,
    track: trackId,
  };

  return SecureObjectsContext.create(config);
}
