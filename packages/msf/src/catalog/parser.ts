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
