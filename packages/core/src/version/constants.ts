// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview MOQT Version Constants
 *
 * Build-time version selection for MOQT draft support.
 * Version is determined at build time via MOQT_VERSION environment variable.
 *
 * @example
 * ```bash
 * # Build for draft-14 (default)
 * bun run build
 *
 * # Build for draft-16 (includes draft-15 changes)
 * MOQT_VERSION=draft-16 bun run build
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
 * True when building for draft-16 (includes draft-15 changes)
 */
export const IS_DRAFT_16: boolean = MOQT_VERSION === 'draft-16';

/**
 * True when building for draft-14 (default)
 */
export const IS_DRAFT_14: boolean = !IS_DRAFT_16;

/**
 * Version number constants for wire format
 */
export const VERSION_NUMBER = {
  DRAFT_14: 0xff00000e,
  DRAFT_15: 0xff00000f,
  DRAFT_16: 0xff000010,
} as const;

/**
 * ALPN protocol strings for WebTransport negotiation
 * Used in WT-Available-Protocols header (draft-15+)
 */
export const ALPN_PROTOCOL = {
  DRAFT_14: 'moq-00',
  DRAFT_15: 'moqt-15',
  DRAFT_16: 'moqt-16',
} as const;

/**
 * Get the current version number for wire format
 */
export function getCurrentVersionNumber(): number {
  return IS_DRAFT_16 ? VERSION_NUMBER.DRAFT_16 : VERSION_NUMBER.DRAFT_14;
}

/**
 * Get the ALPN protocol string for the current version
 */
export function getCurrentALPNProtocol(): string {
  return IS_DRAFT_16 ? ALPN_PROTOCOL.DRAFT_16 : ALPN_PROTOCOL.DRAFT_14;
}
