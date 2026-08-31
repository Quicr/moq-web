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
 * Current MOQT version string
 * Set at build time via __MOQT_VERSION__ define
 */
export const MOQT_VERSION: string =
  typeof __MOQT_VERSION__ !== 'undefined' ? __MOQT_VERSION__ : 'draft-16';

/**
 * True when building for draft-18
 */
export const IS_DRAFT_18: boolean = MOQT_VERSION === 'draft-18';

/**
 * True when building for draft-16 or draft-17
 */
export const IS_DRAFT_16: boolean = MOQT_VERSION === 'draft-16' || MOQT_VERSION === 'draft-17';

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
 * Get the current version number for wire format
 */
export function getCurrentVersionNumber(): number {
  if (IS_DRAFT_18) return VERSION_NUMBER.DRAFT_18;
  return VERSION_NUMBER.DRAFT_16;
}

/**
 * Get the ALPN protocol string for the current version
 */
export function getCurrentALPNProtocol(): string {
  if (IS_DRAFT_18) return ALPN_PROTOCOL.DRAFT_18;
  return ALPN_PROTOCOL.DRAFT_16;
}
