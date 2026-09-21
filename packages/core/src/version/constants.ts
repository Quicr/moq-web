// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview MOQT Version Constants
 *
 * Build-time version selection for MOQT draft support.
 * Version is determined at build time via MOQT_VERSION environment variable.
 *
 * Supported: draft-16 (default), draft-17, draft-18.
 *
 * @example
 * ```bash
 * # Build for draft-16 (default)
 * bun run build
 *
 * # Build for draft-18
 * MOQT_VERSION=draft-18 bun run build
 * ```
 */

// Global declaration for build-time define
declare const __MOQT_VERSION__: string | undefined;

/**
 * Draft version selector for runtime configuration.
 *
 * Callers pass one of these strings to MOQTransport / MOQTSession to
 * choose which MOQT draft the codec+wire path will use for the session.
 */
export type DraftVersion = 'draft-16' | 'draft-17' | 'draft-18';

/**
 * Default draft used when a caller does not specify one.
 *
 * Kept at draft-16 to preserve the historical default. Consumers building
 * against mixed relay fleets should always pass an explicit `draft`.
 */
export const DEFAULT_DRAFT: DraftVersion =
  typeof __MOQT_VERSION__ !== 'undefined' ? (__MOQT_VERSION__ as DraftVersion) : 'draft-16';

/**
 * Version number constants for wire format
 */
export const VERSION_NUMBER = {
  DRAFT_16: 0xff000010,
  DRAFT_17: 0xff000011,
  DRAFT_18: 0xff000012,
} as const;

/**
 * ALPN protocol strings for WebTransport negotiation
 */
export const ALPN_PROTOCOL = {
  DRAFT_16: 'moqt-16',
  DRAFT_17: 'moqt-17',
  DRAFT_18: 'moqt-18',
} as const;

/**
 * Convert a draft selector to its numeric wire version. The result is
 * safe to compare against the `Version` enum (identical values).
 */
export function versionEnumFor(draft: DraftVersion): number {
  return versionNumberFor(draft);
}

/**
 * Version number for the given draft, used on the wire.
 */
export function versionNumberFor(draft: DraftVersion): number {
  switch (draft) {
    case 'draft-18':
      return VERSION_NUMBER.DRAFT_18;
    case 'draft-17':
      return VERSION_NUMBER.DRAFT_17;
    case 'draft-16':
    default:
      return VERSION_NUMBER.DRAFT_16;
  }
}

/**
 * ALPN protocol string for the given draft, used during WebTransport
 * negotiation.
 */
export function alpnProtocolFor(draft: DraftVersion): string {
  switch (draft) {
    case 'draft-18':
      return ALPN_PROTOCOL.DRAFT_18;
    case 'draft-17':
      return ALPN_PROTOCOL.DRAFT_17;
    case 'draft-16':
    default:
      return ALPN_PROTOCOL.DRAFT_16;
  }
}
