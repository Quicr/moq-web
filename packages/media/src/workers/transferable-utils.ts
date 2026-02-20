// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Transferable Object Utilities
 *
 * Utilities for efficiently transferring data between main thread and workers
 * using transferable objects (zero-copy).
 */

/**
 * Extract the underlying ArrayBuffer from a Uint8Array for transfer
 * Returns a new Uint8Array that owns its buffer (for safe transfer)
 */
export function prepareForTransfer(data: Uint8Array): { data: Uint8Array; transfer: ArrayBuffer[] } {
  // If the Uint8Array is a view into a larger buffer, we need to copy it
  // to get a buffer we can safely transfer
  if (data.byteOffset !== 0 || data.byteLength !== data.buffer.byteLength) {
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    return { data: copy, transfer: [copy.buffer as ArrayBuffer] };
  }

  return { data, transfer: [data.buffer as ArrayBuffer] };
}

/**
 * Prepare multiple buffers for transfer
 */
export function prepareMultipleForTransfer(buffers: Uint8Array[]): { data: Uint8Array[]; transfer: ArrayBuffer[] } {
  const prepared = buffers.map(prepareForTransfer);
  return {
    data: prepared.map(p => p.data),
    transfer: prepared.flatMap(p => p.transfer),
  };
}

/**
 * Check if an object can be transferred
 */
export function isTransferable(obj: unknown): obj is ArrayBuffer | MessagePort | ImageBitmap {
  return (
    obj instanceof ArrayBuffer ||
    (typeof MessagePort !== 'undefined' && obj instanceof MessagePort) ||
    (typeof ImageBitmap !== 'undefined' && obj instanceof ImageBitmap)
  );
}
