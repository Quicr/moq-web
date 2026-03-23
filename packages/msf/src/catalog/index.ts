// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Catalog module exports
 */

export { CatalogBuilder, createCatalog } from './builder.js';

export {
  CatalogParseError,
  parseCatalog,
  validateCatalog,
  parseFullCatalog,
  parseDeltaCatalog,
  tryParseCatalog,
  parseCatalogFromBytes,
} from './parser.js';

export {
  serializeCatalog,
  serializeCatalogToBytes,
  type SerializeOptions,
} from './serializer.js';

export {
  DeltaError,
  generateDelta,
  applyDelta,
  DeltaBuilder,
  createDelta,
  type DeltaOptions,
} from './delta.js';
