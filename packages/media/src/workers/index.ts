// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Worker Module
 *
 * Web Workers for offloading CPU-intensive media processing.
 */

// LOC-only encode worker (existing)
export { EncodeWorkerClient } from './encode-worker-api.js';
export type {
  EncodeWorkerRequest,
  EncodeWorkerResponse,
  EncodeWorkerConfig,
} from './encode-worker-api.js';

// LOC-only decode worker (existing)
export { DecodeWorkerClient } from './decode-worker-api.js';
export type {
  DecodeWorkerRequest,
  DecodeWorkerResponse,
  DecodeWorkerConfig,
} from './decode-worker-api.js';

// Full codec + LOC encode worker (new - WebCodecs in worker)
export { CodecEncodeWorkerClient } from './codec-encode-worker-api.js';
export type {
  CodecEncodeWorkerConfig,
  VideoEncoderWorkerConfig,
  AudioEncoderWorkerConfig,
  VideoEncodedResult,
  AudioEncodedResult,
} from './codec-encode-worker-api.js';

// Full codec + LOC decode worker (new - WebCodecs in worker)
export { CodecDecodeWorkerClient } from './codec-decode-worker-api.js';
export type {
  CodecDecodeWorkerConfig,
  VideoDecoderWorkerConfig,
  AudioDecoderWorkerConfig,
  VideoDecodedResult,
  AudioDecodedResult,
} from './codec-decode-worker-api.js';

// Utilities
export {
  prepareForTransfer,
  prepareMultipleForTransfer,
  isTransferable,
} from './transferable-utils.js';

/**
 * Create an encode worker
 *
 * @example
 * ```typescript
 * const worker = createEncodeWorker();
 * const client = new EncodeWorkerClient(worker);
 * await client.init();
 *
 * // Package video data in worker
 * client.on('video-packaged', (result) => {
 *   session.sendObject(trackAlias, result.data, {
 *     groupId: result.groupId,
 *     objectId: result.objectId,
 *     isKeyframe: result.isKeyframe,
 *   });
 * });
 *
 * client.packageVideo(encodedData, isKeyframe, timestamp);
 * ```
 */
export function createEncodeWorker(): Worker {
  return new Worker(new URL('./encode-worker.js', import.meta.url), { type: 'module' });
}

/**
 * Create a decode worker
 *
 * @example
 * ```typescript
 * const worker = createDecodeWorker();
 * const client = new DecodeWorkerClient(worker);
 * await client.init({ mediaType: 'video', jitterBufferDelay: 100 });
 *
 * // Handle decoded frames
 * client.on('video-frame', (frame) => {
 *   decoder.decode(frame.data, frame.isKeyframe, frame.timestamp);
 * });
 *
 * // Push received data
 * client.push(locData, groupId, objectId, timestamp);
 *
 * // Poll for ready frames
 * setInterval(() => client.poll(), 16);
 * ```
 */
export function createDecodeWorker(): Worker {
  return new Worker(new URL('./decode-worker.js', import.meta.url), { type: 'module' });
}
