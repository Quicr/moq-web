// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview VOD Loader
 *
 * Utility to load video from a URL, decode frames, and prepare for VOD publishing.
 * Stores frames indexed by group/object for serving FETCH requests.
 */

import { Logger } from '@web-moq/core';
import { LOCPackager } from '../loc/loc-container.js';
import type { VODPublishOptions, VODMetadata } from '@web-moq/session';

const log = Logger.create('moqt:media:vod-loader');

/**
 * Frame data stored for VOD playback
 */
interface StoredFrame {
  data: Uint8Array;
  isKeyframe: boolean;
  timestamp: number;
  duration: number;
}

/**
 * VOD loading progress event
 */
export interface VODLoadProgress {
  phase: 'fetching' | 'decoding' | 'complete' | 'error';
  progress: number; // 0-100
  framesDecoded?: number;
  totalFrames?: number;
  error?: string;
}

/**
 * VOD Loader options
 */
export interface VODLoaderOptions {
  /** Frames per group (GOP size), default 30 */
  framesPerGroup?: number;
  /** Target framerate, default 30 */
  framerate?: number;
  /** Video codec to use for encoding, default 'avc1.42E01F' (use 'avc1.640033' for 4K) */
  codec?: string;
  /** Target width (will scale if needed) */
  width?: number;
  /** Target height (will scale if needed) */
  height?: number;
  /** Bitrate for encoding stored frames */
  bitrate?: number;
  /** Loop the video indefinitely (wraps group IDs) */
  loop?: boolean;
  /** Progress callback */
  onProgress?: (progress: VODLoadProgress) => void;
}

/**
 * VOD Loader
 *
 * Loads a video file from URL, decodes all frames, and stores them
 * for serving via FETCH requests in VOD publishing.
 *
 * @example
 * ```typescript
 * const loader = new VODLoader({
 *   framesPerGroup: 30,
 *   framerate: 30,
 *   onProgress: (p) => console.log(`${p.phase}: ${p.progress}%`),
 * });
 *
 * await loader.load('https://example.com/video.mp4');
 *
 * // Use with publishVOD
 * const trackAlias = await session.publishVOD(
 *   ['vod', 'my-video'],
 *   'video',
 *   loader.getPublishOptions()
 * );
 * ```
 */
export class VODLoader {
  private frames = new Map<string, StoredFrame>(); // "groupId:objectId" -> frame
  private metadata: VODMetadata | null = null;
  private options: Required<VODLoaderOptions>;
  private packager: LOCPackager | null = null;
  private loaded = false;

  constructor(options: VODLoaderOptions = {}) {
    this.options = {
      framesPerGroup: options.framesPerGroup ?? 30,
      framerate: options.framerate ?? 30,
      codec: options.codec ?? 'avc1.42E01F',
      width: options.width ?? 1280,
      height: options.height ?? 720,
      bitrate: options.bitrate ?? 2_000_000,
      loop: options.loop ?? false,
      onProgress: options.onProgress ?? (() => {}),
    };
  }

  /** Number of groups in the original video (for loop calculations) */
  private originalTotalGroups = 0;

  /**
   * Load video from URL
   */
  async load(url: string): Promise<void> {
    log.info('Loading VOD from URL', { url });
    this.options.onProgress({ phase: 'fetching', progress: 0 });

    try {
      // Fetch the video file
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to fetch video: ${response.status} ${response.statusText}`);
      }

      const contentLength = response.headers.get('content-length');
      const totalBytes = contentLength ? parseInt(contentLength, 10) : 0;

      // Read the video data with progress tracking
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('Failed to get response reader');
      }

      const chunks: Uint8Array[] = [];
      let receivedBytes = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        chunks.push(value);
        receivedBytes += value.length;

        if (totalBytes > 0) {
          this.options.onProgress({
            phase: 'fetching',
            progress: Math.round((receivedBytes / totalBytes) * 50), // 0-50% for fetching
          });
        }
      }

      // Combine chunks
      const videoData = new Uint8Array(receivedBytes);
      let offset = 0;
      for (const chunk of chunks) {
        videoData.set(chunk, offset);
        offset += chunk.length;
      }

      log.info('Video fetched', { bytes: receivedBytes });
      this.options.onProgress({ phase: 'decoding', progress: 50 });

      // Decode the video
      await this.decodeVideo(videoData);

      this.loaded = true;
      this.options.onProgress({ phase: 'complete', progress: 100 });
      log.info('VOD loaded successfully', {
        totalGroups: this.metadata?.totalGroups,
        duration: this.metadata?.duration,
        totalFrames: this.frames.size,
      });

    } catch (err) {
      const error = err as Error;
      log.error('Failed to load VOD', { error: error.message });
      this.options.onProgress({ phase: 'error', progress: 0, error: error.message });
      throw err;
    }
  }

  /**
   * Decode video data into frames
   */
  private async decodeVideo(videoData: Uint8Array): Promise<void> {
    // Create a blob URL for the video
    // Create a new ArrayBuffer copy to ensure type compatibility with Blob
    const bufferCopy = new ArrayBuffer(videoData.byteLength);
    new Uint8Array(bufferCopy).set(videoData);
    const blob = new Blob([bufferCopy], { type: 'video/mp4' });
    const blobUrl = URL.createObjectURL(blob);

    try {
      // Use HTMLVideoElement to extract frames
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;

      await new Promise<void>((resolve, reject) => {
        video.onloadedmetadata = () => resolve();
        video.onerror = () => reject(new Error('Failed to load video metadata'));
        video.src = blobUrl;
      });

      const duration = video.duration * 1000; // Convert to ms
      const width = video.videoWidth || this.options.width;
      const height = video.videoHeight || this.options.height;

      log.info('Video metadata loaded', { duration, width, height });

      // Calculate total frames and groups
      const frameDuration = 1000 / this.options.framerate;
      const totalFrames = Math.ceil(duration / frameDuration);
      const totalGroups = Math.ceil(totalFrames / this.options.framesPerGroup);
      this.originalTotalGroups = totalGroups;

      this.metadata = {
        duration: this.options.loop ? Number.MAX_SAFE_INTEGER : duration,
        totalGroups: this.options.loop ? Number.MAX_SAFE_INTEGER : totalGroups,
        framerate: this.options.framerate,
        gopDuration: (this.options.framesPerGroup / this.options.framerate) * 1000,
        timescale: 1000,
      };

      log.info('VOD metadata', {
        duration,
        totalGroups,
        loop: this.options.loop,
        effectiveTotalGroups: this.metadata.totalGroups
      });

      // Create canvas for frame extraction
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d')!;

      // Create encoder for re-encoding frames
      const encodedFrames: Array<{ groupId: number; objectId: number; data: Uint8Array; isKeyframe: boolean; timestamp: number }> = [];

      // Check if VideoEncoder is available
      if (typeof VideoEncoder === 'undefined') {
        throw new Error('VideoEncoder not available - use a Chromium-based browser');
      }

      const encoder = new VideoEncoder({
        output: (chunk, metadata) => {
          const data = new Uint8Array(chunk.byteLength);
          chunk.copyTo(data);

          // Calculate group and object from frame index
          const frameIndex = encodedFrames.length;
          const groupId = Math.floor(frameIndex / this.options.framesPerGroup);
          const objectId = frameIndex % this.options.framesPerGroup;
          const isKeyframe = chunk.type === 'key';

          // Package with LOC container
          if (!this.packager) {
            this.packager = new LOCPackager();
          }

          const codecDescription = metadata?.decoderConfig?.description;
          const packedData = this.packager.packageVideo(data, {
            isKeyframe,
            captureTimestamp: (chunk.timestamp ?? 0) / 1000, // Convert microseconds to milliseconds
            codecDescription: codecDescription ? new Uint8Array(codecDescription as ArrayBuffer) : undefined,
          });

          encodedFrames.push({
            groupId,
            objectId,
            data: packedData,
            isKeyframe,
            timestamp: chunk.timestamp ?? 0,
          });

          // Update progress (50-100%)
          const progress = 50 + Math.round((encodedFrames.length / totalFrames) * 50);
          this.options.onProgress({
            phase: 'decoding',
            progress,
            framesDecoded: encodedFrames.length,
            totalFrames,
          });
        },
        error: (err) => {
          log.error('Encoder error', { error: err.message });
        },
      });

      encoder.configure({
        codec: this.options.codec,
        width,
        height,
        bitrate: this.options.bitrate,
        framerate: this.options.framerate,
        latencyMode: 'quality',
        avc: { format: 'annexb' },
      });

      // Extract and encode frames
      let frameIndex = 0;
      for (let time = 0; time < duration; time += frameDuration) {
        // Seek to time
        video.currentTime = time / 1000;
        await new Promise<void>((resolve) => {
          video.onseeked = () => resolve();
        });

        // Draw frame to canvas
        ctx.drawImage(video, 0, 0, width, height);

        // Create VideoFrame from canvas
        const frame = new VideoFrame(canvas, {
          timestamp: time * 1000, // microseconds
          duration: frameDuration * 1000,
        });

        // Encode - force keyframe at start of each group
        const isGroupStart = frameIndex % this.options.framesPerGroup === 0;
        encoder.encode(frame, { keyFrame: isGroupStart });
        frame.close();

        frameIndex++;
      }

      // Flush encoder
      await encoder.flush();
      encoder.close();

      // Store encoded frames
      for (const frame of encodedFrames) {
        const key = `${frame.groupId}:${frame.objectId}`;
        this.frames.set(key, {
          data: frame.data,
          isKeyframe: frame.isKeyframe,
          timestamp: frame.timestamp,
          duration: frameDuration * 1000,
        });
      }

      log.info('Video decoded', { framesEncoded: encodedFrames.length, groups: totalGroups });

    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  }

  /**
   * Check if VOD is loaded
   */
  get isLoaded(): boolean {
    return this.loaded;
  }

  /**
   * Get VOD metadata
   */
  getMetadata(): VODMetadata | null {
    return this.metadata;
  }

  /**
   * Get frame by group and object ID
   */
  getFrame(groupId: number, objectId: number): Uint8Array | null {
    const key = `${groupId}:${objectId}`;
    const frame = this.frames.get(key);
    return frame?.data ?? null;
  }

  /**
   * Check if frame is a keyframe
   */
  isKeyframe(groupId: number, objectId: number): boolean {
    const key = `${groupId}:${objectId}`;
    const frame = this.frames.get(key);
    return frame?.isKeyframe ?? false;
  }

  /**
   * Get publish options for use with publishVOD
   */
  getPublishOptions(): Omit<VODPublishOptions, 'priority' | 'groupOrder' | 'deliveryTimeout' | 'deliveryMode' | 'audioDeliveryMode'> {
    if (!this.metadata) {
      throw new Error('VOD not loaded. Call load() first.');
    }

    // When looping, wrap the group ID to loop through content
    const wrapGroupId = (groupId: number): number => {
      if (this.options.loop && this.originalTotalGroups > 0) {
        return groupId % this.originalTotalGroups;
      }
      return groupId;
    };

    return {
      metadata: this.metadata,
      getObject: async (groupId: number, objectId: number) => {
        const wrappedGroupId = wrapGroupId(groupId);
        return this.getFrame(wrappedGroupId, objectId);
      },
      isKeyframe: (groupId: number, objectId: number) => {
        const wrappedGroupId = wrapGroupId(groupId);
        return this.isKeyframe(wrappedGroupId, objectId);
      },
      objectsPerGroup: this.options.framesPerGroup,
    };
  }

  /**
   * Get total number of stored frames
   */
  get frameCount(): number {
    return this.frames.size;
  }

  /**
   * Clear all stored frames to free memory
   */
  clear(): void {
    this.frames.clear();
    this.metadata = null;
    this.loaded = false;
    log.info('VOD loader cleared');
  }
}
