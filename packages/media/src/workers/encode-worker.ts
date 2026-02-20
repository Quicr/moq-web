// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Encode Worker
 *
 * Web Worker for offloading LOC packaging from the main thread.
 * Receives encoded video/audio data and packages it in LOC format.
 */

import { LOCPackager } from '../loc/loc-container.js';
import type { EncodeWorkerRequest, EncodeWorkerResponse } from './encode-worker-api.js';

let packager: LOCPackager;
let debug = false;

// Group/object tracking
let videoGroupId = 0;
let videoObjectId = 0;
let audioGroupId = 0;
let audioObjectId = 0;

/**
 * Log function that respects debug setting
 */
function log(...args: unknown[]): void {
  if (debug) {
    console.log('[EncodeWorker]', ...args);
  }
}

/**
 * Post a response to the main thread
 */
function respond(msg: EncodeWorkerResponse, transfer?: Transferable[]): void {
  if (transfer && transfer.length > 0) {
    (self as unknown as Worker).postMessage(msg, transfer);
  } else {
    self.postMessage(msg);
  }
}

/**
 * Handle incoming messages
 */
function handleMessage(event: MessageEvent<EncodeWorkerRequest>): void {
  const msg = event.data;

  switch (msg.type) {
    case 'init':
      debug = msg.config.debug ?? false;
      packager = new LOCPackager();
      log('Initialized');
      respond({ type: 'ready' });
      break;

    case 'package-video':
      try {
        // Update group/object IDs
        if (msg.isKeyframe) {
          videoGroupId++;
          videoObjectId = 0;
        } else {
          videoObjectId++;
        }

        // Package with LOC
        const videoData = packager.packageVideo(msg.data, {
          isKeyframe: msg.isKeyframe,
          captureTimestamp: msg.timestamp / 1000, // Convert to ms
          codecDescription: msg.codecDescription,
        });

        log('Packaged video', {
          id: msg.id,
          groupId: videoGroupId,
          objectId: videoObjectId,
          isKeyframe: msg.isKeyframe,
          inputSize: msg.data.byteLength,
          outputSize: videoData.byteLength,
        });

        // Transfer the result back (zero-copy)
        respond(
          {
            type: 'video-packaged',
            id: msg.id,
            data: videoData,
            groupId: videoGroupId,
            objectId: videoObjectId,
            isKeyframe: msg.isKeyframe,
          },
          [videoData.buffer]
        );
      } catch (err) {
        respond({ type: 'error', message: `Video packaging failed: ${(err as Error).message}` });
      }
      break;

    case 'package-audio':
      try {
        // Each audio frame = new group, objectId always 0
        audioGroupId++;
        audioObjectId = 0;

        // Package with LOC
        const audioData = packager.packageAudio(msg.data, {
          captureTimestamp: msg.timestamp / 1000,
        });

        log('Packaged audio', {
          id: msg.id,
          groupId: audioGroupId,
          objectId: audioObjectId,
          inputSize: msg.data.byteLength,
          outputSize: audioData.byteLength,
        });

        // Transfer the result back (zero-copy)
        respond(
          {
            type: 'audio-packaged',
            id: msg.id,
            data: audioData,
            groupId: audioGroupId,
            objectId: audioObjectId,
          },
          [audioData.buffer]
        );
      } catch (err) {
        respond({ type: 'error', message: `Audio packaging failed: ${(err as Error).message}` });
      }
      break;

    case 'close':
      log('Closing');
      packager?.reset();
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
