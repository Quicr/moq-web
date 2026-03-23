// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Catalog serialization
 *
 * Provides functions for serializing MSF catalogs to JSON.
 */

import type { Catalog } from '../schemas/index.js';

/**
 * Options for catalog serialization
 */
export interface SerializeOptions {
  /** Pretty-print JSON with indentation */
  pretty?: boolean;
  /** Number of spaces for indentation (default: 2) */
  indent?: number;
}

/**
 * Serialize a catalog to JSON string
 *
 * @param catalog - Catalog to serialize
 * @param options - Serialization options
 * @returns JSON string
 */
export function serializeCatalog(
  catalog: Catalog,
  options: SerializeOptions = {}
): string {
  const { pretty = false, indent = 2 } = options;
  return pretty
    ? JSON.stringify(catalog, null, indent)
    : JSON.stringify(catalog);
}

/**
 * Serialize a catalog to binary data (Uint8Array)
 *
 * @param catalog - Catalog to serialize
 * @param options - Serialization options
 * @returns UTF-8 encoded binary data
 */
export function serializeCatalogToBytes(
  catalog: Catalog,
  options: SerializeOptions = {}
): Uint8Array {
  const json = serializeCatalog(catalog, options);
  const encoder = new TextEncoder();
  return encoder.encode(json);
}
