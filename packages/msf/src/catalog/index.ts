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
  parseCompressedCatalog,
} from './parser.js';

export {
  serializeCatalog,
  serializeCatalogToBytes,
  serializeCompressedCatalog,
  type SerializeOptions,
  type CompressedSerializeOptions,
} from './serializer.js';

export {
  DeltaError,
  generateDelta,
  applyDelta,
  DeltaBuilder,
  createDelta,
  type DeltaOptions,
} from './delta.js';

export {
  compressBytes,
  decompressBytes,
  CompressionError,
  COMPRESSION_ALGORITHMS,
  isCompressionAlgorithm,
} from './compression.js';
