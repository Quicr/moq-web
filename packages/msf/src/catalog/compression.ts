// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Catalog compression (MSF §9 `MSF_COMPRESSION`).
 *
 * Supports the algorithms defined in §9 for catalog transport:
 *   - `identity` (no compression, default)
 *   - `gzip`     (RFC 1952)
 *   - `deflate`  (RFC 1951)
 *
 * Implemented on top of the WHATWG CompressionStream / DecompressionStream
 * API, which is available in modern browsers and Node.js ≥ 18.
 */

/**
 * MSF-defined catalog compression algorithms (§9).
 */
export type CompressionAlgorithm = 'identity' | 'gzip' | 'deflate';

export const COMPRESSION_ALGORITHMS: readonly CompressionAlgorithm[] = [
  'identity',
  'gzip',
  'deflate',
] as const;

export class CompressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompressionError';
  }
}

export function isCompressionAlgorithm(v: unknown): v is CompressionAlgorithm {
  return (
    typeof v === 'string' &&
    (COMPRESSION_ALGORITHMS as readonly string[]).includes(v)
  );
}

/**
 * Compress a UTF-8 byte payload with the requested algorithm.
 */
export async function compressBytes(
  data: Uint8Array,
  algorithm: CompressionAlgorithm
): Promise<Uint8Array> {
  if (algorithm === 'identity') return data;
  return runStream(data, new CompressionStream(streamFormat(algorithm)));
}

/**
 * Decompress a byte payload with the requested algorithm.
 */
export async function decompressBytes(
  data: Uint8Array,
  algorithm: CompressionAlgorithm
): Promise<Uint8Array> {
  if (algorithm === 'identity') return data;
  return runStream(data, new DecompressionStream(streamFormat(algorithm)));
}

function streamFormat(algorithm: CompressionAlgorithm): 'gzip' | 'deflate' {
  if (algorithm === 'gzip') return 'gzip';
  if (algorithm === 'deflate') return 'deflate';
  throw new CompressionError(`Unsupported algorithm: ${algorithm}`);
}

async function runStream(
  input: Uint8Array,
  stream: CompressionStream | DecompressionStream
): Promise<Uint8Array> {
  if (typeof CompressionStream === 'undefined') {
    throw new CompressionError(
      'CompressionStream not available in this runtime; catalog compression requires Node ≥ 18 or a modern browser'
    );
  }
  const writer = stream.writable.getWriter();
  // Cast: CompressionStream's writable accepts BufferSource; Uint8Array is
  // valid at runtime but TS's newer lib.dom disagrees on the buffer variance.
  await writer.write(input as unknown as BufferSource);
  await writer.close();

  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) chunks.push(value as Uint8Array);
  }
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
