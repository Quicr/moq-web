// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/// <reference types="vite/client" />

/**
 * Build-time constant for MOQT protocol version.
 * Set via MOQT_VERSION environment variable at build time.
 *
 * @example
 * ```bash
 * # Build with draft-16
 * MOQT_VERSION=draft-16 pnpm build
 * ```
 */
declare const __MOQT_VERSION__: 'draft-14' | 'draft-16';
