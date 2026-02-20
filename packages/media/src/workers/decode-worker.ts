// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Decode Worker
 *
 * Web Worker for offloading LOC unpackaging and jitter buffering from the main thread.
 * Receives LOC packets, unpackages them, buffers for reordering, and emits ready frames.
 */

import { LOCUnpackager, MediaType } from '../loc/loc-container.js';
import { JitterBuffer } from '../pipeline/jitter-buffer.js';
import type { DecodeWorkerRequest, DecodeWorkerResponse, DecodeWorkerConfig } from './decode-worker-api.js';

let unpackager: LOCUnpackager;
let videoBuffer: JitterBuffer<{ data: Uint8Array; isKeyframe: boolean; codecDescription?: Uint8Array }> | undefined;
let audioBuffer: JitterBuffer<{ data: Uint8Array }> | undefined;
let debug = false;
let videoSequence = 0;
let audioSequence = 0;

/**
 * Log function that respects debug setting
 */
function log(...args: unknown[]): void {
  if (debug) {
    console.log('[DecodeWorker]', ...args);
  }
}

/**
 * Post a response to the main thread
 */
function respond(msg: DecodeWorkerResponse, transfer?: Transferable[]): void {
  if (transfer && transfer.length > 0) {
    (self as unknown as Worker).postMessage(msg, transfer);
  } else {
    self.postMessage(msg);
  }
}

/**
 * Process ready frames and send to main thread
 */
function processReadyFrames(): { videoCount: number; audioCount: number } {
  let videoCount = 0;
  let audioCount = 0;

  // Process video frames
  if (videoBuffer) {
    const videoFrames = videoBuffer.getReadyFrames();
    for (const frame of videoFrames) {
      videoCount++;

      // Transfer the data back to main thread
      const transfer: Transferable[] = [frame.data.data.buffer];
      if (frame.data.codecDescription) {
        transfer.push(frame.data.codecDescription.buffer);
      }

      respond(
        {
          type: 'video-frame',
          data: frame.data.data,
          groupId: frame.groupId,
          objectId: frame.objectId,
          isKeyframe: frame.data.isKeyframe,
          timestamp: frame.timestamp * 1000, // Convert back to microseconds
          codecDescription: frame.data.codecDescription,
        },
        transfer
      );
    }
  }

  // Process audio frames
  if (audioBuffer) {
    const audioFrames = audioBuffer.getReadyFrames();
    for (const frame of audioFrames) {
      audioCount++;

      respond(
        {
          type: 'audio-frame',
          data: frame.data.data,
          groupId: frame.groupId,
          objectId: frame.objectId,
          timestamp: frame.timestamp * 1000,
        },
        [frame.data.data.buffer]
      );
    }
  }

  return { videoCount, audioCount };
}

/**
 * Handle incoming messages
 */
function handleMessage(event: MessageEvent<DecodeWorkerRequest>): void {
  const msg = event.data;

  switch (msg.type) {
    case 'init': {
      const config = msg.config as DecodeWorkerConfig;
      debug = config.debug ?? false;
      unpackager = new LOCUnpackager();

      const jitterDelay = config.jitterBufferDelay ?? 50; // Reduced for lower latency

      // Create buffers based on media type
      if (config.mediaType !== 'audio') {
        videoBuffer = new JitterBuffer({
          targetDelay: jitterDelay,
          maxDelay: 300,
          maxFramesPerCall: 5, // Allow more frames per cycle
        });
      }

      if (config.mediaType !== 'video') {
        audioBuffer = new JitterBuffer({
          targetDelay: jitterDelay,
          maxDelay: 300,
          maxFramesPerCall: 5, // Allow more frames per cycle
        });
      }

      log('Initialized', { mediaType: config.mediaType, jitterDelay });
      respond({ type: 'ready' });
      break;
    }

    case 'push':
      try {
        // Detect media type from LOC header
        const mediaType = unpackager.getMediaType(msg.data);

        if (mediaType === MediaType.VIDEO && videoBuffer) {
          // Unpackage video
          const frame = unpackager.unpackage(msg.data);
          const isKeyframe = frame.header.isKeyframe;

          videoBuffer.push({
            data: { data: frame.payload, isKeyframe, codecDescription: frame.codecDescription },
            timestamp: msg.timestamp / 1000, // Convert to ms
            sequence: videoSequence++,
            groupId: msg.groupId,
            objectId: msg.objectId,
            isKeyframe,
            receivedAt: performance.now(),
          });

          log('Pushed video', {
            groupId: msg.groupId,
            objectId: msg.objectId,
            isKeyframe,
            bufferSize: videoBuffer.size,
          });
        } else if (mediaType === MediaType.AUDIO && audioBuffer) {
          // Unpackage audio
          const frame = unpackager.unpackage(msg.data);

          audioBuffer.push({
            data: { data: frame.payload },
            timestamp: msg.timestamp / 1000,
            sequence: audioSequence++,
            groupId: msg.groupId,
            objectId: msg.objectId,
            isKeyframe: true, // Opus is always key
            receivedAt: performance.now(),
          });

          log('Pushed audio', {
            groupId: msg.groupId,
            objectId: msg.objectId,
            bufferSize: audioBuffer.size,
          });
        }
      } catch (err) {
        respond({ type: 'error', message: `Unpackaging failed: ${(err as Error).message}` });
      }
      break;

    case 'poll': {
      const { videoCount, audioCount } = processReadyFrames();
      respond({ type: 'poll-result', videoFrames: videoCount, audioFrames: audioCount });
      break;
    }

    case 'reset':
      videoBuffer?.reset();
      audioBuffer?.reset();
      videoSequence = 0;
      audioSequence = 0;
      log('Reset');
      break;

    case 'close':
      log('Closing');
      videoBuffer?.reset();
      audioBuffer?.reset();
      respond({ type: 'closed' });
      self.close();
      break;

    default:
      respond({ type: 'error', message: `Unknown message type: ${(msg as { type: string }).type}` });
  }
}

// Set up message handler
self.onmessage = handleMessage;

// Signal that the worker script has loaded
log('Worker script loaded');
