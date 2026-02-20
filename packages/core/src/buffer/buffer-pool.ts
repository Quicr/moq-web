// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Buffer Pool
 *
 * Reusable Uint8Array pool to reduce allocations and GC pressure.
 * Uses size buckets for efficient buffer reuse.
 */

/**
 * Size buckets for buffer pool (powers of 2)
 */
const BUCKET_SIZES = [
  256,      // 256 bytes - small headers
  1024,     // 1 KB - audio frames
  4096,     // 4 KB - small video frames
  16384,    // 16 KB - medium video frames
  65536,    // 64 KB - large video frames
  262144,   // 256 KB - keyframes
  1048576,  // 1 MB - large keyframes
];

/**
 * Maximum buffers per bucket
 */
const MAX_BUFFERS_PER_BUCKET = 8;

/**
 * Buffer pool for reusing Uint8Array allocations
 */
export class BufferPool {
  private static instance: BufferPool | null = null;
  private buckets: Map<number, Uint8Array[]> = new Map();
  private stats = {
    allocations: 0,
    reuses: 0,
    releases: 0,
    misses: 0,
  };

  private constructor() {
    for (const size of BUCKET_SIZES) {
      this.buckets.set(size, []);
    }
  }

  /**
   * Get the singleton instance
   */
  static getInstance(): BufferPool {
    if (!BufferPool.instance) {
      BufferPool.instance = new BufferPool();
    }
    return BufferPool.instance;
  }

  /**
   * Reset the singleton instance (for testing)
   * @internal
   */
  static resetInstance(): void {
    if (BufferPool.instance) {
      BufferPool.instance.clear();
      BufferPool.instance = null;
    }
  }

  /**
   * Get a buffer of at least the requested size
   *
   * @param minSize - Minimum size needed
   * @returns A Uint8Array of at least minSize bytes
   */
  acquire(minSize: number): Uint8Array {
    const bucketSize = this.findBucketSize(minSize);

    if (bucketSize !== null) {
      const bucket = this.buckets.get(bucketSize)!;
      if (bucket.length > 0) {
        this.stats.reuses++;
        return bucket.pop()!;
      }
    }

    // No pooled buffer available, allocate new one
    this.stats.allocations++;
    const allocSize = bucketSize ?? minSize;
    return new Uint8Array(allocSize);
  }

  /**
   * Return a buffer to the pool for reuse
   *
   * @param buffer - Buffer to release
   */
  release(buffer: Uint8Array): void {
    const bucketSize = this.findBucketSize(buffer.byteLength);

    if (bucketSize !== null && buffer.byteLength === bucketSize) {
      const bucket = this.buckets.get(bucketSize)!;
      if (bucket.length < MAX_BUFFERS_PER_BUCKET) {
        this.stats.releases++;
        bucket.push(buffer);
        return;
      }
    }

    // Buffer doesn't fit any bucket or bucket is full - let GC collect it
    this.stats.misses++;
  }

  /**
   * Acquire a buffer and copy data into it
   *
   * @param data - Data to copy
   * @returns A pooled buffer containing the data
   */
  acquireWithCopy(data: Uint8Array): Uint8Array {
    const buffer = this.acquire(data.byteLength);
    buffer.set(data);
    return buffer.subarray(0, data.byteLength);
  }

  /**
   * Acquire a buffer for an EncodedVideoChunk or EncodedAudioChunk
   *
   * @param chunk - WebCodecs chunk to copy from
   * @returns A pooled buffer containing the chunk data
   */
  acquireForChunk(chunk: { byteLength: number; copyTo: (dest: Uint8Array) => void }): Uint8Array {
    const buffer = this.acquire(chunk.byteLength);
    chunk.copyTo(buffer);
    return buffer.subarray(0, chunk.byteLength);
  }

  /**
   * Find the appropriate bucket size for a given size
   */
  private findBucketSize(size: number): number | null {
    for (const bucketSize of BUCKET_SIZES) {
      if (size <= bucketSize) {
        return bucketSize;
      }
    }
    return null;
  }

  /**
   * Get pool statistics
   */
  getStats(): {
    allocations: number;
    reuses: number;
    releases: number;
    misses: number;
    hitRate: number;
    pooledBuffers: number;
  } {
    let pooledBuffers = 0;
    for (const bucket of this.buckets.values()) {
      pooledBuffers += bucket.length;
    }

    const totalRequests = this.stats.allocations + this.stats.reuses;
    const hitRate = totalRequests > 0 ? this.stats.reuses / totalRequests : 0;

    return {
      ...this.stats,
      hitRate,
      pooledBuffers,
    };
  }

  /**
   * Clear all pooled buffers
   */
  clear(): void {
    for (const bucket of this.buckets.values()) {
      bucket.length = 0;
    }
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    this.stats.allocations = 0;
    this.stats.reuses = 0;
    this.stats.releases = 0;
    this.stats.misses = 0;
  }
}

/**
 * Convenience function to get a buffer from the global pool
 */
export function acquireBuffer(minSize: number): Uint8Array {
  return BufferPool.getInstance().acquire(minSize);
}

/**
 * Convenience function to release a buffer to the global pool
 */
export function releaseBuffer(buffer: Uint8Array): void {
  BufferPool.getInstance().release(buffer);
}

/**
 * Convenience function to acquire a buffer and copy chunk data
 */
export function acquireBufferForChunk(chunk: { byteLength: number; copyTo: (dest: Uint8Array) => void }): Uint8Array {
  return BufferPool.getInstance().acquireForChunk(chunk);
}
