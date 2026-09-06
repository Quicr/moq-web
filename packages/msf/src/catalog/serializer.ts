// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Catalog serialization
 *
 * Provides functions for serializing MSF catalogs to JSON.
 */

import type { Catalog } from '../schemas/index.js';
import {
  compressBytes,
  type CompressionAlgorithm,
} from './compression.js';

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
 * Options for compressed catalog serialization (§9 MSF_COMPRESSION).
 */
export interface CompressedSerializeOptions extends SerializeOptions {
  /** Compression algorithm to apply. Defaults to the catalog's own
   *  `MSF_COMPRESSION`; use `identity` to disable. */
  compression?: CompressionAlgorithm;
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

/**
 * Serialize a catalog and apply MSF §9 compression.
 *
 * If `options.compression` is not provided, the catalog's own
 * `MSF_COMPRESSION` field is used; if that is also missing, the payload is
 * returned uncompressed (`identity`).
 */
export async function serializeCompressedCatalog(
  catalog: Catalog,
  options: CompressedSerializeOptions = {}
): Promise<{ bytes: Uint8Array; algorithm: CompressionAlgorithm }> {
  const algorithm =
    options.compression ?? catalog.MSF_COMPRESSION ?? 'identity';
  const raw = serializeCatalogToBytes(catalog, options);
  const bytes = await compressBytes(raw, algorithm);
  return { bytes, algorithm };
}
