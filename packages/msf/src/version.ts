// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * MSF (MOQT Streaming Format) specification version
 *
 * @remarks
 * This version number is included in all MSF catalogs and is used
 * for compatibility checking between producers and consumers.
 */
export const MSF_VERSION = 1;

/**
 * Well-known track name for the catalog track
 *
 * @remarks
 * The catalog track uses the namespace of the MSF session with
 * this name appended. The catalog contains track discovery and
 * metadata information.
 */
export const CATALOG_TRACK_NAME = 'catalog';
