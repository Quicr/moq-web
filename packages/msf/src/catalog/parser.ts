// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Catalog parsing and validation
 *
 * Provides functions for parsing and validating MSF catalog JSON.
 */

import { ZodError } from 'zod';
import {
  CatalogSchema,
  FullCatalogSchema,
  DeltaCatalogSchema,
  type Catalog,
  type FullCatalog,
  type DeltaCatalog,
} from '../schemas/index.js';

/**
 * Error thrown when catalog parsing fails
 */
export class CatalogParseError extends Error {
  constructor(
    message: string,
    public readonly zodError?: ZodError
  ) {
    super(message);
    this.name = 'CatalogParseError';
  }
}

/**
 * Parse and validate a catalog from JSON string
 *
 * @param json - JSON string to parse
 * @returns Validated catalog object
 * @throws {CatalogParseError} If parsing or validation fails
 */
export function parseCatalog(json: string): Catalog {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (e) {
    throw new CatalogParseError(
      `Invalid JSON: ${e instanceof Error ? e.message : 'Unknown error'}`
    );
  }

  return validateCatalog(data);
}

/**
 * Validate a catalog object against the schema
 *
 * @param data - Object to validate
 * @returns Validated catalog object
 * @throws {CatalogParseError} If validation fails
 */
export function validateCatalog(data: unknown): Catalog {
  const result = CatalogSchema.safeParse(data);
  if (!result.success) {
    throw new CatalogParseError(
      `Invalid catalog: ${result.error.message}`,
      result.error
    );
  }
  return result.data;
}

/**
 * Parse and validate a full catalog
 *
 * @param json - JSON string to parse
 * @returns Validated full catalog object
 * @throws {CatalogParseError} If parsing or validation fails
 */
export function parseFullCatalog(json: string): FullCatalog {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (e) {
    throw new CatalogParseError(
      `Invalid JSON: ${e instanceof Error ? e.message : 'Unknown error'}`
    );
  }

  const result = FullCatalogSchema.safeParse(data);
  if (!result.success) {
    throw new CatalogParseError(
      `Invalid full catalog: ${result.error.message}`,
      result.error
    );
  }
  return result.data;
}

/**
 * Parse and validate a delta catalog
 *
 * @param json - JSON string to parse
 * @returns Validated delta catalog object
 * @throws {CatalogParseError} If parsing or validation fails
 */
export function parseDeltaCatalog(json: string): DeltaCatalog {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (e) {
    throw new CatalogParseError(
      `Invalid JSON: ${e instanceof Error ? e.message : 'Unknown error'}`
    );
  }

  const result = DeltaCatalogSchema.safeParse(data);
  if (!result.success) {
    throw new CatalogParseError(
      `Invalid delta catalog: ${result.error.message}`,
      result.error
    );
  }
  return result.data;
}

/**
 * Try to parse a catalog, returning null on failure
 *
 * @param json - JSON string to parse
 * @returns Validated catalog or null
 */
export function tryParseCatalog(json: string): Catalog | null {
  try {
    return parseCatalog(json);
  } catch {
    return null;
  }
}

/**
 * Parse catalog from binary data (Uint8Array)
 *
 * @param data - Binary data containing UTF-8 encoded JSON
 * @returns Validated catalog object
 * @throws {CatalogParseError} If parsing or validation fails
 */
export function parseCatalogFromBytes(data: Uint8Array): Catalog {
  const decoder = new TextDecoder();
  const json = decoder.decode(data);
  return parseCatalog(json);
}

// ============================================================================
// qdroid interop catalog support
// ============================================================================

/**
 * Decode a qdroid-encoded namespace string into a namespace tuple.
 *
 * qdroid encodes namespaces as: elements joined by `-`, dots encoded as `.2e`,
 * and track name separated by `--`.
 *
 * Example: "cisco.2ewebex.2ecom-nab-v1-avc1-1080-publisher_X" →
 *          ["cisco.webex.com", "nab", "v1", "avc1", "1080", "publisher_X"]
 */
export function decodeQdroidNamespace(encoded: string): string[] {
  // Split on single hyphens (but not double-hyphens which separate namespace from track name)
  // First split on -- to separate namespace from track name
  const parts = encoded.split('--');
  const namespacePart = parts[0];

  // Split namespace part on single hyphens
  const elements = namespacePart.split('-');

  // Decode each element: .2e → ., .2d → -
  return elements.map((elem) =>
    elem.replace(/\.2e/g, '.').replace(/\.2d/g, '-')
  );
}

/**
 * Pre-process qdroid catalog JSON to normalize namespace fields.
 *
 * qdroid catalogs have `namespace` as an encoded string per track.
 * This converts them to arrays that the standard schema expects.
 */
export function normalizeQdroidCatalog(data: unknown): unknown {
  if (typeof data !== 'object' || data === null) return data;
  const catalog = data as Record<string, unknown>;

  if (Array.isArray(catalog.tracks)) {
    catalog.tracks = (catalog.tracks as Record<string, unknown>[]).map(
      (track) => {
        if (typeof track.namespace === 'string') {
          track.namespace = decodeQdroidNamespace(track.namespace);
        }
        return track;
      }
    );
  }

  return catalog;
}

/**
 * Parse a qdroid-format catalog from JSON string.
 * Handles qdroid's encoded namespace strings and missing fields.
 */
export function parseQdroidCatalog(json: string): Catalog {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (e) {
    throw new CatalogParseError(
      `Invalid JSON: ${e instanceof Error ? e.message : 'Unknown error'}`
    );
  }

  // Normalize qdroid-specific format
  data = normalizeQdroidCatalog(data);

  return validateCatalog(data);
}

/**
 * Parse a qdroid-format catalog from binary data.
 */
export function parseQdroidCatalogFromBytes(data: Uint8Array): Catalog {
  const decoder = new TextDecoder();
  const json = decoder.decode(data);
  return parseQdroidCatalog(json);
}
