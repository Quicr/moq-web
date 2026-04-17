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
import { MP4Parser, type VideoTrackInfo } from './mp4-parser.js';

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
  phase: 'fetching' | 'parsing' | 'remuxing' | 'decoding' | 'complete' | 'error';
  progress: number; // 0-100
  framesDecoded?: number;
  totalFrames?: number;
  error?: string;
  /** True if using fast remux path (H.264 source) */
  isRemuxing?: boolean;
}

/**
 * Extended metadata returned from preload for catalog building
 * Includes VOD-specific fields needed for player controls
 */
export interface VODPreloadMetadata {
  /** Duration in milliseconds */
  duration: number;
  /** Video width in pixels */
  width: number;
  /** Video height in pixels */
  height: number;
  /** Actual framerate extracted from video (frames per second) */
  framerate: number;
  /** Estimated total number of groups (GOPs) */
  totalGroups: number;
  /** Estimated GOP duration in milliseconds */
  gopDuration: number;
  /** Timescale (units per second, typically 1000 for ms) */
  timescale: number;
  /** Track duration in timescale units (for MSF catalog) */
  trackDuration: number;
  /** Codec string extracted from video (e.g., 'avc1.64001f') */
  codec?: string;
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

  private videoData: Uint8Array | null = null;
  private mimeType: string = 'video/mp4';

  /**
   * Preload video from URL - fetches and validates without full decode
   * Call this early to catch errors before the user initiates publishing
   * Returns extended metadata for catalog building (including VOD-specific fields)
   */
  async preload(url: string): Promise<VODPreloadMetadata> {
    log.info('Preloading VOD from URL', { url });

    // Fetch the video
    await this.fetchVideo(url);

    // Validate it can be loaded by a video element
    const basicMetadata = await this.validateVideo();

    // Try to extract actual framerate and codec from MP4 container
    const parsedInfo = this.parseVideoMetadata();
    log.info('VOD preloaded successfully', { ...basicMetadata, ...parsedInfo });

    return this.extendMetadata(basicMetadata, parsedInfo);
  }

  /**
   * Preload video from File - reads and validates without full decode
   * Use this for local files to avoid CORS issues
   * Returns extended metadata for catalog building (including VOD-specific fields)
   */
  async preloadFile(file: File): Promise<VODPreloadMetadata> {
    log.info('Preloading VOD from file', { name: file.name, size: file.size });

    // Read the file
    await this.readFile(file);

    // Validate it can be loaded by a video element
    const basicMetadata = await this.validateVideo();

    // Try to extract actual framerate and codec from MP4 container
    const parsedInfo = this.parseVideoMetadata();
    log.info('VOD preloaded successfully', { ...basicMetadata, ...parsedInfo });

    return this.extendMetadata(basicMetadata, parsedInfo);
  }

  /**
   * Read video data from a File object
   */
  private async readFile(file: File): Promise<void> {
    this.options.onProgress({ phase: 'fetching', progress: 0 });

    // Determine MIME type from file
    this.mimeType = file.type || 'video/mp4';
    log.info('File type', { mimeType: this.mimeType });

    // Read the file as ArrayBuffer
    const buffer = await file.arrayBuffer();
    this.videoData = new Uint8Array(buffer);

    this.options.onProgress({ phase: 'fetching', progress: 50 });
    log.info('File read', { bytes: this.videoData.length, mimeType: this.mimeType });
  }

  /**
   * Load video from URL (full decode)
   * If preload() was already called, uses cached video data
   */
  async load(url: string): Promise<void> {
    log.info('Loading VOD from URL', { url });
    this.options.onProgress({ phase: 'fetching', progress: 0 });

    try {
      // Fetch if not already preloaded
      if (!this.videoData) {
        await this.fetchVideo(url);
      } else {
        log.info('Using preloaded video data');
        this.options.onProgress({ phase: 'fetching', progress: 50 });
      }

      this.options.onProgress({ phase: 'decoding', progress: 50 });

      // Decode the video
      await this.decodeVideo(this.videoData!);

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
   * Load video from File (full decode)
   * If preloadFile() was already called, uses cached video data
   */
  async loadFile(file: File): Promise<void> {
    log.info('Loading VOD from file', { name: file.name, size: file.size });
    this.options.onProgress({ phase: 'fetching', progress: 0 });

    try {
      // Read if not already preloaded
      if (!this.videoData) {
        await this.readFile(file);
      } else {
        log.info('Using preloaded video data');
        this.options.onProgress({ phase: 'fetching', progress: 50 });
      }

      this.options.onProgress({ phase: 'decoding', progress: 50 });

      // Decode the video
      await this.decodeVideo(this.videoData!);

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
   * Fetch video data from URL
   */
  private async fetchVideo(url: string): Promise<void> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch video: ${response.status} ${response.statusText}`);
    }

    // Get MIME type from response
    const contentType = response.headers.get('content-type');
    if (contentType) {
      this.mimeType = contentType.split(';')[0].trim();
      log.info('Video content type', { mimeType: this.mimeType });
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
    this.videoData = new Uint8Array(receivedBytes);
    let offset = 0;
    for (const chunk of chunks) {
      this.videoData.set(chunk, offset);
      offset += chunk.length;
    }

    log.info('Video fetched', { bytes: receivedBytes, mimeType: this.mimeType });
  }

  /**
   * Validate video can be loaded by HTMLVideoElement
   */
  private async validateVideo(): Promise<{ duration: number; width: number; height: number }> {
    if (!this.videoData) {
      throw new Error('No video data to validate');
    }

    const bufferCopy = new ArrayBuffer(this.videoData.byteLength);
    new Uint8Array(bufferCopy).set(this.videoData);
    const blob = new Blob([bufferCopy], { type: this.mimeType });
    const blobUrl = URL.createObjectURL(blob);

    try {
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.crossOrigin = 'anonymous';
      video.preload = 'metadata';

      const metadata = await new Promise<{ duration: number; width: number; height: number }>((resolve, reject) => {
        video.onloadedmetadata = () => {
          resolve({
            duration: video.duration * 1000,
            width: video.videoWidth,
            height: video.videoHeight,
          });
        };
        video.onerror = () => {
          const mediaError = video.error;
          let errorMsg = 'Failed to load video metadata';
          if (mediaError) {
            const errorCodes: Record<number, string> = {
              1: 'MEDIA_ERR_ABORTED',
              2: 'MEDIA_ERR_NETWORK',
              3: 'MEDIA_ERR_DECODE (codec not supported?)',
              4: 'MEDIA_ERR_SRC_NOT_SUPPORTED (format not supported)',
            };
            errorMsg = errorCodes[mediaError.code] || `Error code: ${mediaError.code}`;
          }
          reject(new Error(errorMsg));
        };
        video.src = blobUrl;
      });

      return metadata;
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  }

  /**
   * Try to parse video container to extract actual framerate and codec
   * Returns null values if parsing fails (e.g., non-MP4 format)
   */
  private parseVideoMetadata(): { framerate?: number; codec?: string; sampleCount?: number } {
    if (!this.videoData) {
      return {};
    }

    try {
      const parser = new MP4Parser(this.videoData);
      const result = parser.parse();

      if (result.videoTrack) {
        const track = result.videoTrack;
        // Calculate actual framerate from sample count and duration
        const framerate = track.samples.length / (track.durationMs / 1000);
        log.info('Extracted video metadata from MP4', {
          codec: track.codec,
          framerate: framerate.toFixed(2),
          sampleCount: track.samples.length,
          durationMs: track.durationMs,
        });
        return {
          framerate: Math.round(framerate * 100) / 100, // Round to 2 decimal places
          codec: track.codec,
          sampleCount: track.samples.length,
        };
      }
    } catch (err) {
      log.warn('Could not parse video container for metadata', { error: (err as Error).message });
    }

    return {};
  }

  /**
   * Extend basic metadata with VOD-specific fields for catalog building
   * Uses actual framerate from parsed video if available, otherwise falls back to configured
   */
  private extendMetadata(
    basic: { duration: number; width: number; height: number },
    parsed: { framerate?: number; codec?: string; sampleCount?: number } = {}
  ): VODPreloadMetadata {
    // Use actual framerate from video if available, otherwise use configured
    const framerate = parsed.framerate ?? this.options.framerate;
    const framesPerGroup = this.options.framesPerGroup;

    // Calculate GOP duration from frames per group and framerate
    const gopDurationMs = (framesPerGroup / framerate) * 1000;

    // Estimate total number of groups
    const totalGroups = Math.ceil(basic.duration / gopDurationMs);

    // Use milliseconds as timescale (standard for media)
    const timescale = 1000;

    return {
      ...basic,
      framerate,
      totalGroups,
      gopDuration: gopDurationMs,
      timescale,
      trackDuration: Math.round(basic.duration), // Already in ms, round to integer
      codec: parsed.codec,
    };
  }

  /**
   * Process video data - tries remuxing first (fast), falls back to transcoding
   */
  private async decodeVideo(videoData: Uint8Array): Promise<void> {
    this.options.onProgress({ phase: 'parsing', progress: 50 });

    // Try to parse MP4 and remux if H.264
    const parser = new MP4Parser(videoData);
    const parseResult = parser.parse();

    if (parseResult.canRemux && parseResult.videoTrack) {
      log.info('Using fast remux path (H.264 source)', {
        codec: parseResult.videoTrack.codec,
        samples: parseResult.videoTrack.samples.length,
      });
      await this.remuxVideo(videoData, parseResult.videoTrack, parser);
    } else {
      log.info('Using transcode path', { reason: parseResult.remuxReason });
      await this.transcodeVideo(videoData);
    }
  }

  /**
   * Fast remux path - extract H.264 NAL units directly from MP4 container
   * No decode/encode needed, just repackage for MOQT
   */
  private async remuxVideo(_videoData: Uint8Array, track: VideoTrackInfo, parser: MP4Parser): Promise<void> {
    const { samples, timescale, durationMs, width, height, avcConfig } = track;

    log.info('Remuxing H.264 video', {
      samples: samples.length,
      duration: `${(durationMs / 1000).toFixed(1)}s`,
      resolution: `${width}x${height}`,
    });

    this.options.onProgress({ phase: 'remuxing', progress: 50, isRemuxing: true });

    // Group samples by GOP (keyframe to next keyframe)
    // We'll create one MOQT group per GOP
    const gops: Array<{ samples: typeof samples; startTime: number }> = [];
    let currentGop: typeof samples = [];
    let gopStartTime = 0;

    for (const sample of samples) {
      if (sample.isKeyframe && currentGop.length > 0) {
        gops.push({ samples: currentGop, startTime: gopStartTime });
        currentGop = [];
        gopStartTime = (sample.dts / timescale) * 1000;
      }
      currentGop.push(sample);
      if (currentGop.length === 1) {
        gopStartTime = (sample.dts / timescale) * 1000;
      }
    }
    if (currentGop.length > 0) {
      gops.push({ samples: currentGop, startTime: gopStartTime });
    }

    log.info('Organized into GOPs', { gopCount: gops.length, totalSamples: samples.length });

    // Calculate average GOP size for metadata
    const avgGopSize = samples.length / gops.length;
    this.originalTotalGroups = gops.length;

    this.metadata = {
      duration: this.options.loop ? Number.MAX_SAFE_INTEGER : durationMs,
      totalGroups: this.options.loop ? Number.MAX_SAFE_INTEGER : gops.length,
      framerate: samples.length / (durationMs / 1000), // Actual framerate from samples
      gopDuration: durationMs / gops.length,
      timescale: 1000,
    };

    // Pass raw avcC for WebCodecs decoder description (expects AVCDecoderConfigurationRecord, not Annex B)
    const codecDescription = avcConfig;

    // Process each GOP
    if (!this.packager) {
      this.packager = new LOCPackager();
    }

    let processedSamples = 0;
    for (let groupId = 0; groupId < gops.length; groupId++) {
      const gop = gops[groupId];

      for (let objectId = 0; objectId < gop.samples.length; objectId++) {
        const sample = gop.samples[objectId];

        // Extract raw NAL data (length-prefixed avc format) - WebCodecs expects this when avcC description is provided
        const nalData = parser.extractSampleRaw(sample);

        // Package with LOC container
        const timestamp = (sample.dts / timescale) * 1000;
        const duration = (sample.duration / timescale) * 1000;

        const packedData = this.packager.packageVideo(nalData, {
          isKeyframe: sample.isKeyframe,
          captureTimestamp: timestamp,
          codecDescription: sample.isKeyframe ? codecDescription : undefined,
        });

        // Store frame
        const key = `${groupId}:${objectId}`;
        this.frames.set(key, {
          data: packedData,
          isKeyframe: sample.isKeyframe,
          timestamp: timestamp * 1000, // microseconds
          duration: duration * 1000,
        });

        processedSamples++;

        // Update progress (50-100%)
        if (processedSamples % 100 === 0 || processedSamples === samples.length) {
          const progress = 50 + Math.round((processedSamples / samples.length) * 50);
          this.options.onProgress({
            phase: 'remuxing',
            progress,
            framesDecoded: processedSamples,
            totalFrames: samples.length,
            isRemuxing: true,
          });
        }
      }
    }

    log.info('Video remuxed', {
      framesProcessed: processedSamples,
      groups: gops.length,
      avgGopSize: Math.round(avgGopSize),
    });
  }

  /**
   * Transcode path - decode and re-encode video (slow, but works for any format)
   */
  private async transcodeVideo(videoData: Uint8Array): Promise<void> {
    // Create a blob URL for the video
    const bufferCopy = new ArrayBuffer(videoData.byteLength);
    new Uint8Array(bufferCopy).set(videoData);
    const blob = new Blob([bufferCopy], { type: this.mimeType });
    const blobUrl = URL.createObjectURL(blob);

    try {
      // Use HTMLVideoElement to extract frames
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.crossOrigin = 'anonymous';
      video.preload = 'auto';

      await new Promise<void>((resolve, reject) => {
        video.onloadedmetadata = () => resolve();
        video.onerror = () => {
          const mediaError = video.error;
          let errorMsg = 'Failed to load video metadata';
          if (mediaError) {
            const errorCodes: Record<number, string> = {
              1: 'MEDIA_ERR_ABORTED - fetching aborted by user',
              2: 'MEDIA_ERR_NETWORK - network error during download',
              3: 'MEDIA_ERR_DECODE - error decoding video (codec not supported?)',
              4: 'MEDIA_ERR_SRC_NOT_SUPPORTED - video format/codec not supported',
            };
            errorMsg = errorCodes[mediaError.code] || `Unknown error code: ${mediaError.code}`;
            if (mediaError.message) {
              errorMsg += ` - ${mediaError.message}`;
            }
          }
          log.error('Video element error', { errorMsg, mediaError });
          reject(new Error(errorMsg));
        };
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

      // Auto-detect codec for 4K resolution
      // H.264 Baseline/Main don't support resolutions above 1920x1080
      let codec = this.options.codec;
      if (width > 1920 || height > 1080) {
        const isBaselineOrMain = codec.startsWith('avc1.42') || codec.startsWith('avc1.4D');
        if (isBaselineOrMain) {
          codec = 'avc1.640033'; // H.264 High Level 5.1 for 4K
          log.info('Auto-upgraded codec for 4K resolution', {
            original: this.options.codec,
            upgraded: codec,
            resolution: `${width}x${height}`
          });
        }
      }

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
        codec,
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

      log.info('Video transcoded', { framesEncoded: encodedFrames.length, groups: totalGroups });

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
   * Returns a copy of the data to prevent ArrayBuffer detachment issues
   * when the same frame is accessed multiple times (e.g., SUBSCRIBE + FETCH)
   */
  getFrame(groupId: number, objectId: number): Uint8Array | null {
    const key = `${groupId}:${objectId}`;
    const frame = this.frames.get(key);
    if (!frame?.data) return null;
    return frame.data.slice();
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
    this.videoData = null;
    this.loaded = false;
    log.info('VOD loader cleared');
  }

  /**
   * Check if video data has been fetched (preloaded)
   */
  get isPreloaded(): boolean {
    return this.videoData !== null;
  }

  /**
   * Create a blob URL for local video playback
   * Useful for playing the video locally when a subscriber connects
   */
  createPlaybackUrl(): string | null {
    if (!this.videoData) {
      log.warn('Cannot create playback URL - no video data loaded');
      return null;
    }
    const blob = new Blob([new Uint8Array(this.videoData)], { type: this.mimeType });
    return URL.createObjectURL(blob);
  }

  /**
   * Get video duration in milliseconds
   */
  getDuration(): number {
    return this.metadata?.duration ?? 0;
  }
}
