// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Codec Decode Worker Implementation
 *
 * Web Worker that handles LOC unpackaging, jitter buffering, and WebCodecs
 * video/audio decoding. Supports multiple concurrent decode channels, each
 * with its own decoder instances and jitter buffers.
 *
 * Messages include a channelId to route data to the correct decoder context.
 * This allows a single worker to handle multiple subscriptions efficiently.
 */

import { LOCUnpackager, MediaType } from '../loc/loc-container.js';
import { parseH264SPS } from '../webcodecs/h264-sps-parser.js';
import { JitterBuffer } from '../pipeline/jitter-buffer.js';
import { GroupArbiter } from '../pipeline/group-arbiter.js';
import { PlayoutBuffer } from '../pipeline/playout-buffer.js';
import {
  createPlayoutBuffer,
  createPlayoutBufferFromTrack,
  type PolicyType,
} from '../pipeline/playout-buffer-factory.js';
import type {
  CodecDecodeWorkerRequest,
  CodecDecodeWorkerResponse,
  VideoDecoderWorkerConfig,
  AudioDecoderWorkerConfig,
  CodecDecodeWorkerConfig,
} from './codec-decode-worker-types.js';

// Global debug flag - disabled by default for performance
// Enable via init message config.debug or set to true here for debugging
let debug = false;

// Jitter buffer data types
interface VideoBufferData {
  data: Uint8Array;
  isKeyframe: boolean;
  codecDescription?: Uint8Array;
  arrivedAt: number; // performance.now() when object arrived
}

interface AudioBufferData {
  data: Uint8Array;
}

// Pending frame types
interface PendingVideoFrame {
  frame: VideoFrame;
  groupId: number;
  objectId: number;
  timestamp: number;
}

interface PendingAudioData {
  data: AudioData;
  groupId: number;
  objectId: number;
  timestamp: number;
}

/**
 * Channel state - each subscription gets its own decode context
 */
interface DecodeChannel {
  channelId: number;
  videoDecoder: VideoDecoder | null;
  audioDecoder: AudioDecoder | null;
  unpackager: LOCUnpackager;
  // Legacy jitter buffer (used when useGroupArbiter is false and no policyType)
  videoBuffer: JitterBuffer<VideoBufferData> | null;
  audioBuffer: JitterBuffer<AudioBufferData> | null;
  // Group-aware arbiter (LEGACY - used when useGroupArbiter is true and no policyType)
  videoArbiter: GroupArbiter<VideoBufferData> | null;
  audioArbiter: GroupArbiter<AudioBufferData> | null;
  // New PlayoutBuffer architecture (used when policyType is set)
  videoPlayoutBuffer: PlayoutBuffer<VideoBufferData> | null;
  audioPlayoutBuffer: PlayoutBuffer<AudioBufferData> | null;
  policyType: PolicyType | null;
  useGroupArbiter: boolean;
  videoSequence: number;
  audioSequence: number;
  pendingVideoFrames: PendingVideoFrame[];
  pendingAudioData: PendingAudioData[];
  currentVideoMeta: { groupId: number; objectId: number; timestamp: number; arrivedAt: number } | null;
  currentAudioMeta: { groupId: number; objectId: number; timestamp: number } | null;
  videoConfig: VideoDecoderWorkerConfig | null;
  hasReceivedKeyframe: boolean;
  droppedFramesBeforeKeyframe: number;
  enableStats: boolean;
  lastDecodedSequence: number;
  framesOutOfOrder: number;
  // Diagnostic tracking
  videoFramesDecoded: number;
  videoKeyframesReceived: number;
  audioFramesDecoded: number;
  lastVideoFrameInfo: { groupId: number; objectId: number; isKeyframe: boolean; dataSize: number; sequence: number } | null;
  lastAudioFrameInfo: { groupId: number; objectId: number; dataSize: number; sequence: number } | null;
  /** QuicR-Mac interop mode for LOC unpackaging */
  quicrInteropEnabled: boolean;
  /** Reorder buffer for B-frame presentation order (timestamp-sorted) */
  frameReorderBuffer: Array<{ frame: VideoFrame; groupId: number; objectId: number; timestamp: number; arrivedAt: number }>;
  /** Last emitted timestamp for reorder buffer */
  lastEmittedTimestamp: number;
}

// Map of channel ID to decode context
const channels = new Map<number, DecodeChannel>();

/**
 * Log helper
 */
function log(...args: unknown[]): void {
  if (debug) {
    console.log('[CodecDecodeWorker]', ...args);
  }
}

/**
 * Send response to main thread
 * Client uses O(1) registry dispatch to route by channelId
 */
function respond(msg: CodecDecodeWorkerResponse, transfer?: Transferable[]): void {
  if (transfer && transfer.length > 0) {
    (self as unknown as Worker).postMessage(msg, transfer);
  } else {
    self.postMessage(msg);
  }
}

/**
 * Create a new decode channel
 */
function createChannel(channelId: number, config: CodecDecodeWorkerConfig): DecodeChannel {
  // Determine buffer strategy:
  // 1. policyType takes precedence (new architecture)
  // 2. Fall back to useGroupArbiter for backward compatibility
  // 3. Default to legacy JitterBuffer
  const policyType = config.policyType ?? null;
  const useGroupArbiter = !policyType && (config.useGroupArbiter ?? false);

  const channel: DecodeChannel = {
    channelId,
    videoDecoder: null,
    audioDecoder: null,
    unpackager: new LOCUnpackager(),
    videoBuffer: null,
    audioBuffer: null,
    videoArbiter: null,
    audioArbiter: null,
    videoPlayoutBuffer: null,
    audioPlayoutBuffer: null,
    policyType,
    useGroupArbiter,
    videoSequence: 0,
    audioSequence: 0,
    pendingVideoFrames: [],
    pendingAudioData: [],
    currentVideoMeta: null,
    currentAudioMeta: null,
    videoConfig: null,
    hasReceivedKeyframe: false,
    droppedFramesBeforeKeyframe: 0,
    enableStats: config.enableStats ?? false,
    lastDecodedSequence: -1,
    framesOutOfOrder: 0,
    // Diagnostic tracking
    videoFramesDecoded: 0,
    videoKeyframesReceived: 0,
    audioFramesDecoded: 0,
    lastVideoFrameInfo: null,
    lastAudioFrameInfo: null,
    quicrInteropEnabled: config.quicrInteropEnabled ?? false,
    frameReorderBuffer: [],
    lastEmittedTimestamp: -1,
  };

  const jitterDelay = config.jitterBufferDelay ?? 100;

  log(`Channel ${channelId} config`, {
    enableStats: channel.enableStats,
    jitterDelay,
    policyType,
    useGroupArbiter,
    quicrInteropEnabled: channel.quicrInteropEnabled,
    isLive: config.isLive,
    isLiveType: typeof config.isLive,
    willUseCatalogDriven: policyType && config.isLive !== undefined,
    effectivePolicy: policyType && config.isLive !== undefined
      ? (config.isLive ? 'live (from catalog)' : 'vod (from catalog)')
      : policyType || (useGroupArbiter ? 'legacy-arbiter' : 'legacy-jitter'),
  });

  // Create debug log relay callback for arbiter
  const arbiterDebugCallback = config.arbiterDebug
    ? (message: string, data?: Record<string, unknown>) => {
        respond({ type: 'arbiter-debug', channelId, message, data });
      }
    : undefined;

  // Initialize video if configured
  if (config.video) {
    if (policyType) {
      // NEW: Use PlayoutBuffer with appropriate policy
      if (config.isLive !== undefined) {
        // Catalog-driven: use isLive to select policy
        channel.videoPlayoutBuffer = createPlayoutBufferFromTrack<VideoBufferData>({
          isLive: config.isLive,
          framerate: config.catalogFramerate, // For VOD pacing
          minBufferFrames: config.minBufferFrames, // For VOD buffering
          debug: !!config.arbiterDebug,
          profileSettings: {
            jitterBufferDelay: jitterDelay,
            maxLatency: config.maxLatency,
            estimatedGopDuration: config.estimatedGopDuration,
            skipToLatestGroup: config.skipToLatestGroup,
            skipGraceFrames: config.skipGraceFrames,
            enableCatchUp: config.enableCatchUp,
            catchUpThreshold: config.catchUpThreshold,
            useLatencyDeadline: config.useLatencyDeadline,
          },
        });
        log(`Channel ${channelId} using PlayoutBuffer (catalog-driven, isLive=${config.isLive}, framerate=${config.catalogFramerate})`, {
          policyType: config.isLive ? 'live' : 'vod',
        });
      } else {
        // Explicit policy type
        channel.videoPlayoutBuffer = createPlayoutBuffer<VideoBufferData>(
          policyType,
          policyType === 'live' ? {
            jitterDelay,
            maxLatency: config.maxLatency ?? 500,
            estimatedGopDuration: config.estimatedGopDuration ?? 1000,
            catalogFramerate: config.catalogFramerate,
            catalogTimescale: config.catalogTimescale,
            skipToLatestGroup: config.skipToLatestGroup ?? false,
            skipGraceFrames: config.skipGraceFrames ?? 3,
            enableCatchUp: config.enableCatchUp ?? true,
            catchUpThreshold: config.catchUpThreshold ?? 5,
            useLatencyDeadline: config.useLatencyDeadline ?? true,
            debug: !!config.arbiterDebug,
          } : policyType === 'vod' ? {
            // Buffer at least 1 GOP (~30 frames) before starting playback
            // to give network time to stay ahead of playout
            minBufferFrames: config.minBufferFrames ?? 30,
            waitForCompleteGop: true,
            debug: !!config.arbiterDebug,
          } : {
            // adaptive defaults
            debug: !!config.arbiterDebug,
          }
        );
        log(`Channel ${channelId} using PlayoutBuffer (explicit policy)`, {
          policyType,
          skipToLatestGroup: config.skipToLatestGroup,
          enableCatchUp: config.enableCatchUp,
        });
      }
    } else if (useGroupArbiter) {
      // LEGACY: Use GroupArbiter for group-aware ordering
      channel.videoArbiter = new GroupArbiter<VideoBufferData>({
        jitterDelay,
        maxLatency: config.maxLatency ?? 500,
        estimatedGopDuration: config.estimatedGopDuration ?? 1000,
        catalogFramerate: config.catalogFramerate,
        catalogTimescale: config.catalogTimescale,
        allowPartialGroupDecode: true,
        skipOnlyToKeyframe: true,
        skipToLatestGroup: config.skipToLatestGroup ?? false,
        skipGraceFrames: config.skipGraceFrames ?? 3,
        enableCatchUp: config.enableCatchUp ?? true,
        catchUpThreshold: config.catchUpThreshold ?? 5,
        useLatencyDeadline: config.useLatencyDeadline ?? true,
        debug: true, // Force enabled for debugging
        debugLogCallback: arbiterDebugCallback,
      });
      log(`Channel ${channelId} using GroupArbiter for video (LEGACY)`, {
        skipToLatestGroup: config.skipToLatestGroup,
        skipGraceFrames: config.skipGraceFrames,
        enableCatchUp: config.enableCatchUp,
        catchUpThreshold: config.catchUpThreshold,
        useLatencyDeadline: config.useLatencyDeadline,
      });
    } else {
      // Use legacy JitterBuffer
      channel.videoBuffer = new JitterBuffer<VideoBufferData>({
        targetDelay: jitterDelay,
        maxDelay: 300,
        maxFramesPerCall: 5,
      });
    }
    initVideoDecoder(channel, config.video);
  }

  // Initialize audio if configured
  if (config.audio) {
    if (policyType) {
      // NEW: Use PlayoutBuffer for audio
      // Audio always uses a simpler policy - no keyframe requirements
      channel.audioPlayoutBuffer = createPlayoutBuffer<AudioBufferData>(
        policyType === 'vod' ? 'vod' : 'live', // Audio uses vod or live, not adaptive
        policyType === 'live' || policyType === 'adaptive' ? {
          jitterDelay,
          maxLatency: config.maxLatency ?? 500,
          estimatedGopDuration: 20, // Audio frames are typically ~20ms
          skipToLatestGroup: config.skipToLatestGroup ?? false,
          skipGraceFrames: config.skipGraceFrames ?? 3,
          enableCatchUp: config.enableCatchUp ?? true,
          catchUpThreshold: config.catchUpThreshold ?? 5,
          useLatencyDeadline: config.useLatencyDeadline ?? true,
        } : {
          minBufferFrames: 1,
          waitForCompleteGop: false, // Audio doesn't have GOPs
        }
      );
      log(`Channel ${channelId} using PlayoutBuffer for audio`, { policyType });
    } else if (useGroupArbiter) {
      // LEGACY: Use GroupArbiter for audio
      channel.audioArbiter = new GroupArbiter<AudioBufferData>({
        jitterDelay,
        maxLatency: config.maxLatency ?? 500,
        estimatedGopDuration: 20, // Audio frames are typically ~20ms
        allowPartialGroupDecode: true,
        skipOnlyToKeyframe: false, // Audio doesn't need keyframes (Opus)
        skipToLatestGroup: config.skipToLatestGroup ?? false,
        skipGraceFrames: config.skipGraceFrames ?? 3,
        enableCatchUp: config.enableCatchUp ?? true,
        catchUpThreshold: config.catchUpThreshold ?? 5,
        useLatencyDeadline: config.useLatencyDeadline ?? true,
        debug: true, // Force enabled for debugging
        debugLogCallback: arbiterDebugCallback,
      });
      log(`Channel ${channelId} using GroupArbiter for audio (LEGACY)`);
    } else {
      // Use legacy JitterBuffer
      channel.audioBuffer = new JitterBuffer<AudioBufferData>({
        targetDelay: jitterDelay,
        maxDelay: 300,
        maxFramesPerCall: 5,
      });
    }
    initAudioDecoder(channel, config.audio);
  }

  return channel;
}

/**
 * Initialize video decoder for a channel
 */
function initVideoDecoder(channel: DecodeChannel, config: VideoDecoderWorkerConfig): void {
  channel.videoConfig = config;

  channel.videoDecoder = new VideoDecoder({
    output: (frame) => {
      // Send decoded frame immediately
      // WebCodecs VideoDecoder handles B-frame reordering internally
      const meta = channel.currentVideoMeta;
      const now = performance.now();

      respond(
        {
          type: 'video-frame',
          channelId: channel.channelId,
          result: {
            frame,
            groupId: meta?.groupId ?? 0,
            objectId: meta?.objectId ?? 0,
            timestamp: frame.timestamp,
          },
        },
        [frame]
      );

      // Emit latency stats if enabled
      if (channel.enableStats && meta?.arrivedAt) {
        const processingDelay = now - meta.arrivedAt;
        const bufferDepth = channel.videoBuffer?.size ?? 0;
        const bufferDelay = channel.videoBuffer?.delay ?? 0;
        const bufferStats = channel.videoBuffer?.getStats();
        const framesDropped = bufferStats?.framesDropped ?? 0;
        const framesDroppedBeforeKeyframe = channel.droppedFramesBeforeKeyframe;
        const framesOutOfOrder = channel.framesOutOfOrder;
        log(`Emitting latency-stats (ch=${channel.channelId})`, { processingDelay: Math.round(processingDelay), bufferDepth, bufferDelay, framesDropped, framesDroppedBeforeKeyframe, framesOutOfOrder });
        respond({
          type: 'latency-stats',
          channelId: channel.channelId,
          stats: { processingDelay, bufferDepth, bufferDelay, framesDropped, framesDroppedBeforeKeyframe, framesOutOfOrder },
        });
      }
    },
    error: (err) => {
      // Capture diagnostic info before resetting state
      const diagnostics = {
        mediaType: 'video' as const,
        groupId: channel.lastVideoFrameInfo?.groupId,
        objectId: channel.lastVideoFrameInfo?.objectId,
        isKeyframe: channel.lastVideoFrameInfo?.isKeyframe,
        dataSize: channel.lastVideoFrameInfo?.dataSize,
        sequence: channel.lastVideoFrameInfo?.sequence,
        framesDecodedBefore: channel.videoFramesDecoded,
        keyframesReceived: channel.videoKeyframesReceived,
        hadKeyframe: channel.hasReceivedKeyframe,
        timestamp: Date.now(),
      };

      // Log detailed error info (always log errors, not just in debug mode)
      console.error(`[CodecDecodeWorker] VIDEO DECODE ERROR (channel ${channel.channelId}):`, {
        error: err.message,
        ...diagnostics,
        bufferSize: channel.videoBuffer?.size ?? 0,
        decoderState: channel.videoDecoder?.state,
      });

      // Reset keyframe state to force waiting for new keyframe after error
      channel.hasReceivedKeyframe = false;

      // Recover the decoder - WebCodecs errors often close the decoder entirely
      if (channel.videoConfig) {
        try {
          const decoderState = channel.videoDecoder?.state;

          if (decoderState === 'closed') {
            // Decoder is closed - must recreate it entirely
            console.log(`[CodecDecodeWorker] Decoder closed, recreating (channel ${channel.channelId})`);
            initVideoDecoder(channel, channel.videoConfig);
          } else if (decoderState === 'configured') {
            // Decoder still usable, just reset it
            channel.videoDecoder!.reset();
            const decoderConfig: VideoDecoderConfig = {
              codec: channel.videoConfig.codec,
              codedWidth: channel.videoConfig.codedWidth,
              codedHeight: channel.videoConfig.codedHeight,
            };
            if (channel.videoConfig.description) {
              decoderConfig.description = channel.videoConfig.description;
            }
            channel.videoDecoder!.configure(decoderConfig);
            console.log(`[CodecDecodeWorker] Decoder reset and reconfigured (channel ${channel.channelId})`);
          }
        } catch (resetErr) {
          console.error(`[CodecDecodeWorker] Failed to recover decoder (channel ${channel.channelId}):`, resetErr);
          // Last resort: recreate decoder
          try {
            initVideoDecoder(channel, channel.videoConfig);
            console.log(`[CodecDecodeWorker] Decoder recreated after recovery failure (channel ${channel.channelId})`);
          } catch (recreateErr) {
            console.error(`[CodecDecodeWorker] Failed to recreate decoder (channel ${channel.channelId}):`, recreateErr);
          }
        }
      }

      respond({ type: 'error', channelId: channel.channelId, message: err.message, diagnostics });
    },
  });

  const decoderConfig: VideoDecoderConfig = {
    codec: config.codec,
    codedWidth: config.codedWidth,
    codedHeight: config.codedHeight,
  };

  if (config.description) {
    decoderConfig.description = config.description;
  }

  channel.videoDecoder.configure(decoderConfig);
  log(`Video decoder configured (channel ${channel.channelId})`, config);
  respond({ type: 'video-ready', channelId: channel.channelId });
}

/**
 * Initialize audio decoder for a channel
 */
function initAudioDecoder(channel: DecodeChannel, config: AudioDecoderWorkerConfig): void {
  channel.audioDecoder = new AudioDecoder({
    output: (data) => {
      // Store decoded audio with metadata
      if (channel.currentAudioMeta) {
        channel.pendingAudioData.push({
          data,
          groupId: channel.currentAudioMeta.groupId,
          objectId: channel.currentAudioMeta.objectId,
          timestamp: channel.currentAudioMeta.timestamp,
        });
      } else {
        // No metadata - use data timestamp
        channel.pendingAudioData.push({
          data,
          groupId: 0,
          objectId: 0,
          timestamp: data.timestamp,
        });
      }
    },
    error: (err) => {
      // Capture diagnostic info (only on error - not in hot path)
      const diagnostics = {
        mediaType: 'audio' as const,
        groupId: channel.lastAudioFrameInfo?.groupId,
        objectId: channel.lastAudioFrameInfo?.objectId,
        dataSize: channel.lastAudioFrameInfo?.dataSize,
        sequence: channel.lastAudioFrameInfo?.sequence,
        framesDecodedBefore: channel.audioFramesDecoded,
        keyframesReceived: 0, // Opus is always key
        hadKeyframe: true,
        timestamp: Date.now(),
      };

      console.error(`[CodecDecodeWorker] AUDIO DECODE ERROR (channel ${channel.channelId}):`, {
        error: err.message,
        ...diagnostics,
      });

      respond({ type: 'error', channelId: channel.channelId, message: err.message, diagnostics });
    },
  });

  channel.audioDecoder.configure({
    codec: config.codec,
    sampleRate: config.sampleRate,
    numberOfChannels: config.numberOfChannels,
  });

  log(`Audio decoder configured (channel ${channel.channelId})`, config);
  respond({ type: 'audio-ready', channelId: channel.channelId });
}

/**
 * Reconfigure video decoder for a channel
 */
function reconfigureVideoDecoder(channel: DecodeChannel, config: VideoDecoderWorkerConfig): void {
  if (!channel.videoDecoder) {
    log(`Cannot reconfigure - video decoder not initialized (channel ${channel.channelId})`);
    return;
  }

  if (channel.videoDecoder.state === 'closed') {
    log(`Cannot reconfigure - video decoder is closed (channel ${channel.channelId})`);
    return;
  }

  channel.videoConfig = config;

  const decoderConfig: VideoDecoderConfig = {
    codec: config.codec,
    codedWidth: config.codedWidth,
    codedHeight: config.codedHeight,
  };

  if (config.description) {
    decoderConfig.description = config.description;
  }

  // Reset before reconfigure to ensure clean state transition
  // (e.g., switching from no-description/Annex B to AVCC with description)
  channel.videoDecoder.reset();
  channel.videoDecoder.configure(decoderConfig);
  log(`Video decoder reconfigured (channel ${channel.channelId})`, config);
}

/**
 * Push data to a channel
 */
function pushData(
  channel: DecodeChannel,
  data: Uint8Array,
  groupId: number,
  objectId: number,
  timestamp: number
): void {
  log(`pushData called (channel ${channel.channelId})`, {
    groupId,
    objectId,
    dataSize: data?.length ?? 0,
    hasVideoArbiter: !!channel.videoArbiter,
    hasVideoBuffer: !!channel.videoBuffer,
    firstByte: data?.length > 0 ? `0x${data[0].toString(16)}` : 'empty',
  });
  try {
    const mediaType = channel.unpackager.getMediaType(data);
    log(`Media type determined (channel ${channel.channelId})`, {
      mediaType: mediaType === MediaType.VIDEO ? 'VIDEO' : 'AUDIO',
      groupId,
      objectId,
    });

    if (mediaType === MediaType.VIDEO) {
      const frame = channel.unpackager.unpackage(data, channel.quicrInteropEnabled);
      const isKeyframe = frame.header.isKeyframe;

      log(`LOC unpacked video frame (channel ${channel.channelId})`, {
        groupId,
        objectId,
        isKeyframe,
        payloadSize: frame.payload.byteLength,
        hasCodecDescription: !!frame.codecDescription,
        captureTimestamp: frame.captureTimestamp,
      });

      // NOTE: Codec description is stored in VideoBufferData and used at decode time.
      // Do NOT reconfigure decoder here - it must happen when the keyframe is actually
      // decoded, not when it's received. Otherwise, the arbiter may still be outputting
      // delta frames from the previous group after the reconfigure, causing errors.

      const arrivedAt = performance.now();
      const videoData: VideoBufferData = {
        data: frame.payload,
        isKeyframe,
        codecDescription: frame.codecDescription,
        arrivedAt,
      };

      if (channel.videoPlayoutBuffer) {
        // NEW: Use PlayoutBuffer
        // Pass LOC captureTimestamp for proper frame ordering and timing
        const locTimestampUs = frame.captureTimestamp !== undefined ? Math.floor(frame.captureTimestamp * 1000) : undefined;

        // DIAGNOSTIC: Log if captureTimestamp is missing (first 10 frames only to avoid spam)
        if (locTimestampUs === undefined && channel.videoFramesDecoded < 10) {
          console.warn(`[CodecDecodeWorker] WARNING: No captureTimestamp in LOC for g${groupId}/o${objectId}`, {
            hasCaptureTimestamp: frame.captureTimestamp !== undefined,
            captureTimestamp: frame.captureTimestamp,
          });
        }

        channel.videoPlayoutBuffer.addFrame({
          groupId,
          objectId,
          data: videoData,
          isKeyframe,
          locTimestamp: locTimestampUs,
        });

        log(`Pushed video to PlayoutBuffer (channel ${channel.channelId})`, {
          groupId,
          objectId,
          isKeyframe,
          locTimestamp: locTimestampUs,
          captureTimestampMs: frame.captureTimestamp,
          activeGroup: channel.videoPlayoutBuffer.getActiveGroupId(),
          groupCount: channel.videoPlayoutBuffer.getGroupCount(),
          policyType: channel.policyType,
        });
      } else if (channel.videoArbiter) {
        // LEGACY: Use GroupArbiter
        channel.videoArbiter.addFrame({
          groupId,
          objectId,
          data: videoData,
          isKeyframe,
          locTimestamp: frame.captureTimestamp ? Math.floor(frame.captureTimestamp * 1000) : undefined,
        });

        log(`Pushed video to arbiter (channel ${channel.channelId})`, {
          groupId,
          objectId,
          isKeyframe,
          activeGroup: channel.videoArbiter.getActiveGroupId(),
          groupCount: channel.videoArbiter.getGroupCount(),
        });
      } else if (channel.videoBuffer) {
        // Use legacy JitterBuffer
        channel.videoBuffer.push({
          data: videoData,
          timestamp: timestamp / 1000, // Convert to ms
          sequence: channel.videoSequence++,
          groupId,
          objectId,
          isKeyframe,
          receivedAt: arrivedAt,
        });

        log(`Pushed video (channel ${channel.channelId})`, {
          groupId,
          objectId,
          isKeyframe,
          timestamp: timestamp / 1000, // ms
          sequence: channel.videoSequence - 1,
          bufferSize: channel.videoBuffer.size
        });
      }
    } else if (mediaType === MediaType.AUDIO) {
      const frame = channel.unpackager.unpackage(data, channel.quicrInteropEnabled);
      const audioData: AudioBufferData = { data: frame.payload };

      if (channel.audioPlayoutBuffer) {
        // NEW: Use PlayoutBuffer for audio
        channel.audioPlayoutBuffer.addFrame({
          groupId,
          objectId,
          data: audioData,
          isKeyframe: true, // Opus is always key
        });

        log(`Pushed audio to PlayoutBuffer (channel ${channel.channelId})`, { groupId, objectId });
      } else if (channel.audioArbiter) {
        // LEGACY: Use GroupArbiter
        channel.audioArbiter.addFrame({
          groupId,
          objectId,
          data: audioData,
          isKeyframe: true, // Opus is always key
          locTimestamp: frame.captureTimestamp ? Math.floor(frame.captureTimestamp * 1000) : undefined,
        });

        log(`Pushed audio to arbiter (channel ${channel.channelId})`, { groupId, objectId });
      } else if (channel.audioBuffer) {
        // Use legacy JitterBuffer
        channel.audioBuffer.push({
          data: audioData,
          timestamp: timestamp / 1000, // Convert to ms
          sequence: channel.audioSequence++,
          groupId,
          objectId,
          isKeyframe: true, // Opus is always key
          receivedAt: performance.now(),
        });

        log(`Pushed audio (channel ${channel.channelId})`, { groupId, objectId, bufferSize: channel.audioBuffer.size });
      }
    }
  } catch (err) {
    const errorMsg = (err as Error).message;
    // Log error directly to console (not as object) so it's visible
    console.error(`[CodecDecodeWorker] PUSH ERROR (ch=${channel.channelId} g${groupId}/o${objectId}):`, errorMsg);
    log(`pushData error (channel ${channel.channelId})`, {
      groupId,
      objectId,
      dataSize: data?.length ?? 0,
      error: errorMsg,
    });
    respond({ type: 'error', channelId: channel.channelId, message: `Unpackaging failed: ${errorMsg}` });
  }
}

/**
 * Decode a video frame entry (shared by JitterBuffer and GroupArbiter paths)
 */
function decodeVideoFrame(
  channel: DecodeChannel,
  frameData: VideoBufferData,
  groupId: number,
  objectId: number,
  timestampMs: number,
  sequence: number
): boolean {
  // Wait for keyframe before starting to decode
  if (!channel.hasReceivedKeyframe && !frameData.isKeyframe) {
    channel.droppedFramesBeforeKeyframe++;
    log(`Dropping delta frame - waiting for keyframe (channel ${channel.channelId})`, {
      groupId,
      objectId,
      droppedCount: channel.droppedFramesBeforeKeyframe,
    });
    return false;
  }

  if (frameData.isKeyframe) {
    channel.hasReceivedKeyframe = true;
    channel.videoKeyframesReceived++;
    log(`KEYFRAME received (channel ${channel.channelId})`, {
      groupId,
      objectId,
      droppedBeforeKeyframe: channel.droppedFramesBeforeKeyframe,
    });

    // Reconfigure decoder if this keyframe has a codec description
    // This MUST happen at decode time (not push time) because the arbiter may buffer
    // the keyframe while still outputting delta frames from the previous group
    if (frameData.codecDescription && channel.videoConfig) {
      const desc = frameData.codecDescription;
      const firstBytes = Array.from(desc.slice(0, Math.min(16, desc.length)))
        .map(b => b.toString(16).padStart(2, '0'))
        .join(' ');
      log(`Reconfiguring decoder with codec description (channel ${channel.channelId})`, {
        size: desc.length,
        firstBytes,
        isAvcC: desc[0] === 1,
        groupId,
        objectId,
      });

      reconfigureVideoDecoder(channel, {
        ...channel.videoConfig,
        description: frameData.codecDescription,
      });

      // Parse SPS for max_num_reorder_frames and notify main thread
      try {
        const spsInfo = parseH264SPS(new Uint8Array(frameData.codecDescription));
        if (spsInfo) {
          log(`SPS parsed (channel ${channel.channelId})`, {
            profileIdc: spsInfo.profileIdc,
            levelIdc: spsInfo.levelIdc,
            maxNumReorderFrames: spsInfo.maxNumReorderFrames,
            maxNumRefFrames: spsInfo.maxNumRefFrames,
          });
          respond({
            type: 'sps-info',
            channelId: channel.channelId,
            maxNumReorderFrames: spsInfo.maxNumReorderFrames,
            profileIdc: spsInfo.profileIdc,
            levelIdc: spsInfo.levelIdc,
          });
        }
      } catch {
        // SPS parsing failure is non-fatal — reorder buffer keeps its default
      }
    }
  }

  // Check for out-of-order decode
  const expectedSequence = channel.lastDecodedSequence + 1;
  const isOutOfOrder = channel.lastDecodedSequence >= 0 && sequence !== expectedSequence;
  if (isOutOfOrder) {
    channel.framesOutOfOrder++;
    log(`OUT OF ORDER frame (channel ${channel.channelId})`, {
      expected: expectedSequence,
      got: sequence,
      totalOutOfOrder: channel.framesOutOfOrder,
    });
  }
  channel.lastDecodedSequence = sequence;

  // Debug: log first bytes of payload to verify format
  if (debug) {
    const payloadPreview = Array.from(frameData.data.slice(0, Math.min(20, frameData.data.length)))
      .map(b => b.toString(16).padStart(2, '0'))
      .join(' ');
    const hasAnnexBStartCode = frameData.data[0] === 0 && frameData.data[1] === 0 &&
      (frameData.data[2] === 1 || (frameData.data[2] === 0 && frameData.data[3] === 1));
    const nalType = hasAnnexBStartCode
      ? (frameData.data[frameData.data[2] === 1 ? 3 : 4] & 0x1f)
      : (frameData.data[0] & 0x1f);

    console.log(`[CodecDecodeWorker] PAYLOAD FORMAT (ch=${channel.channelId} g${groupId}/o${objectId}):`,
      `bytes=${payloadPreview}`,
      `annexB=${hasAnnexBStartCode}`,
      `nalType=${nalType}`,
      `isKey=${frameData.isKeyframe}`);
  }

  log(`Decoding frame (channel ${channel.channelId})`, {
    groupId,
    objectId,
    sequence,
    timestamp: timestampMs,
    isKeyframe: frameData.isKeyframe,
    dataSize: frameData.data.length,
    outOfOrder: isOutOfOrder,
  });

  try {
    // Set current metadata for the decoder output callback
    channel.currentVideoMeta = {
      groupId,
      objectId,
      timestamp: timestampMs * 1000, // Back to microseconds
      arrivedAt: frameData.arrivedAt,
    };

    // Track frame info for diagnostics
    if (!channel.lastVideoFrameInfo) {
      channel.lastVideoFrameInfo = { groupId: 0, objectId: 0, isKeyframe: false, dataSize: 0, sequence: 0 };
    }
    channel.lastVideoFrameInfo.groupId = groupId;
    channel.lastVideoFrameInfo.objectId = objectId;
    channel.lastVideoFrameInfo.isKeyframe = frameData.isKeyframe;
    channel.lastVideoFrameInfo.dataSize = frameData.data.length;
    channel.lastVideoFrameInfo.sequence = sequence;

    // Check decoder state before decoding
    if (channel.videoDecoder!.state === 'closed') {
      log(`Cannot decode - video decoder is closed (channel ${channel.channelId})`);
      return false;
    }

    const chunk = new EncodedVideoChunk({
      type: frameData.isKeyframe ? 'key' : 'delta',
      timestamp: timestampMs * 1000, // Back to microseconds
      data: frameData.data,
    });

    channel.videoDecoder!.decode(chunk);
    channel.videoFramesDecoded++;
    return true;
  } catch (err) {
    log(`Error decoding video (channel ${channel.channelId})`, err);
    return false;
  }
}

/**
 * Poll a channel for ready frames
 */
function pollChannel(channel: DecodeChannel): { videoFrames: number; audioFrames: number } {
  let videoCount = 0;
  let audioCount = 0;

  // Process video - PlayoutBuffer path (NEW)
  if (channel.videoPlayoutBuffer && channel.videoDecoder) {
    // Call tick() to update timing (for live policy deadline checks)
    channel.videoPlayoutBuffer.tick();

    // Capture the active group ID BEFORE calling getReadyFrames() because
    // getReadyFrames() may switch to a new group after outputting all frames
    // from the current group. All returned frames are from this group.
    const frameGroupId = channel.videoPlayoutBuffer.getActiveGroupId();
    const readyFrames = channel.videoPlayoutBuffer.getReadyFrames(5);

    for (const frame of readyFrames) {
      const sequence = channel.videoSequence++;
      // Use locTimestamp (presentation time) if available, fall back to receivedAt
      // locTimestamp is in microseconds, convert to milliseconds for decodeVideoFrame
      const timestampMs = frame.locTimestamp !== undefined
        ? frame.locTimestamp / 1000
        : frame.receivedAt;
      if (decodeVideoFrame(
        channel,
        frame.data,
        frameGroupId,
        frame.objectId,
        timestampMs,
        sequence
      )) {
        videoCount++;
      }
    }

    // Log PlayoutBuffer stats periodically
    if (videoCount > 0 && channel.videoFramesDecoded % 30 === 0) {
      const stats = channel.videoPlayoutBuffer.getCombinedStats();
      log(`PlayoutBuffer stats (channel ${channel.channelId})`, {
        activeGroup: channel.videoPlayoutBuffer.getActiveGroupId(),
        groupCount: channel.videoPlayoutBuffer.getGroupCount(),
        policyType: channel.policyType,
        framesOutput: stats.framesOutput,
        framesDropped: stats.framesDropped,
        groupsCompleted: stats.groupsCompleted,
        groupsSkipped: stats.groupsSkipped,
      });
    }
  }
  // Process video - GroupArbiter path (LEGACY)
  else if (channel.videoArbiter && channel.videoDecoder) {
    // Capture the active group ID BEFORE calling getReadyFrames() because
    // getReadyFrames() may switch to a new group after outputting all frames
    // from the current group. All returned frames are from this group.
    const frameGroupId = channel.videoArbiter.getActiveGroupId();
    const readyFrames = channel.videoArbiter.getReadyFrames(5);

    for (const frame of readyFrames) {
      // GroupArbiter uses objectId as sequence when output in order
      const sequence = channel.videoSequence++;
      if (decodeVideoFrame(
        channel,
        frame.data,
        frameGroupId,
        frame.objectId,
        frame.receivedTick, // Use receivedTick as timestamp proxy
        sequence
      )) {
        videoCount++;
      }
    }

    // Log arbiter stats periodically
    if (videoCount > 0 && channel.videoFramesDecoded % 30 === 0) {
      const stats = channel.videoArbiter.getStats();
      log(`Arbiter stats (channel ${channel.channelId})`, {
        activeGroup: channel.videoArbiter.getActiveGroupId(),
        groupCount: channel.videoArbiter.getGroupCount(),
        framesOutput: stats.framesOutput,
        groupsCompleted: stats.groupsCompleted,
        groupsSkipped: stats.groupsSkipped,
      });
    }
  }
  // Process video - JitterBuffer path (legacy)
  else if (channel.videoBuffer && channel.videoDecoder) {
    const readyFrames = channel.videoBuffer.getReadyFrames();

    for (const frame of readyFrames) {
      if (decodeVideoFrame(
        channel,
        frame.data,
        frame.groupId,
        frame.objectId,
        frame.timestamp,
        frame.sequence
      )) {
        videoCount++;
      }
    }
  }

  // Process audio - PlayoutBuffer path (NEW)
  if (channel.audioPlayoutBuffer && channel.audioDecoder) {
    // Call tick() to update timing
    channel.audioPlayoutBuffer.tick();

    const audioFrameGroupId = channel.audioPlayoutBuffer.getActiveGroupId();
    const readyFrames = channel.audioPlayoutBuffer.getReadyFrames(5);

    for (const frame of readyFrames) {
      try {
        const groupId = audioFrameGroupId;
        channel.currentAudioMeta = {
          groupId,
          objectId: frame.objectId,
          timestamp: frame.receivedAt * 1000,
        };

        if (!channel.lastAudioFrameInfo) {
          channel.lastAudioFrameInfo = { groupId: 0, objectId: 0, dataSize: 0, sequence: 0 };
        }
        channel.lastAudioFrameInfo.groupId = groupId;
        channel.lastAudioFrameInfo.objectId = frame.objectId;
        channel.lastAudioFrameInfo.dataSize = frame.data.data.length;
        channel.lastAudioFrameInfo.sequence = channel.audioSequence++;

        const chunk = new EncodedAudioChunk({
          type: 'key',
          timestamp: frame.receivedAt * 1000,
          data: frame.data.data,
        });

        channel.audioDecoder.decode(chunk);
        channel.audioFramesDecoded++;
        audioCount++;
      } catch (err) {
        log(`Error decoding audio (channel ${channel.channelId})`, err);
      }
    }
  }
  // Process audio - GroupArbiter path (LEGACY)
  else if (channel.audioArbiter && channel.audioDecoder) {
    // Capture the active group ID BEFORE calling getReadyFrames()
    const audioFrameGroupId = channel.audioArbiter.getActiveGroupId();
    const readyFrames = channel.audioArbiter.getReadyFrames(5);

    for (const frame of readyFrames) {
      try {
        const groupId = audioFrameGroupId;
        channel.currentAudioMeta = {
          groupId,
          objectId: frame.objectId,
          timestamp: frame.receivedTick * 1000,
        };

        if (!channel.lastAudioFrameInfo) {
          channel.lastAudioFrameInfo = { groupId: 0, objectId: 0, dataSize: 0, sequence: 0 };
        }
        channel.lastAudioFrameInfo.groupId = groupId;
        channel.lastAudioFrameInfo.objectId = frame.objectId;
        channel.lastAudioFrameInfo.dataSize = frame.data.data.length;
        channel.lastAudioFrameInfo.sequence = channel.audioSequence++;

        const chunk = new EncodedAudioChunk({
          type: 'key',
          timestamp: frame.receivedTick * 1000,
          data: frame.data.data,
        });

        channel.audioDecoder.decode(chunk);
        channel.audioFramesDecoded++;
        audioCount++;
      } catch (err) {
        log(`Error decoding audio (channel ${channel.channelId})`, err);
      }
    }
  }
  // Process audio - JitterBuffer path (legacy)
  else if (channel.audioBuffer && channel.audioDecoder) {
    const readyFrames = channel.audioBuffer.getReadyFrames();

    for (const frame of readyFrames) {
      try {
        channel.currentAudioMeta = {
          groupId: frame.groupId,
          objectId: frame.objectId,
          timestamp: frame.timestamp * 1000,
        };

        if (!channel.lastAudioFrameInfo) {
          channel.lastAudioFrameInfo = { groupId: 0, objectId: 0, dataSize: 0, sequence: 0 };
        }
        channel.lastAudioFrameInfo.groupId = frame.groupId;
        channel.lastAudioFrameInfo.objectId = frame.objectId;
        channel.lastAudioFrameInfo.dataSize = frame.data.data.length;
        channel.lastAudioFrameInfo.sequence = frame.sequence;

        const chunk = new EncodedAudioChunk({
          type: 'key',
          timestamp: frame.timestamp * 1000,
          data: frame.data.data,
        });

        channel.audioDecoder.decode(chunk);
        channel.audioFramesDecoded++;
        audioCount++;
      } catch (err) {
        log(`Error decoding audio (channel ${channel.channelId})`, err);
      }
    }
  }

  // Send decoded frames back to main thread
  sendPendingFrames(channel);

  return { videoFrames: videoCount, audioFrames: audioCount };
}

/**
 * Send pending decoded frames for a channel
 */
function sendPendingFrames(channel: DecodeChannel): void {
  // Video frames are now sent immediately from decoder output callback
  // No batching needed for video

  // Send audio data
  for (const { data, groupId, objectId, timestamp } of channel.pendingAudioData) {
    respond(
      {
        type: 'audio-data',
        channelId: channel.channelId,
        result: { data, groupId, objectId, timestamp },
      },
      [data]
    );
  }
  channel.pendingAudioData = [];
}

/**
 * Reset a channel
 */
function resetChannel(channel: DecodeChannel): void {
  channel.videoBuffer?.reset();
  channel.audioBuffer?.reset();
  channel.videoArbiter?.reset();
  channel.audioArbiter?.reset();
  channel.videoPlayoutBuffer?.reset();
  channel.audioPlayoutBuffer?.reset();
  channel.videoSequence = 0;
  channel.audioSequence = 0;
  channel.currentVideoMeta = null;
  channel.currentAudioMeta = null;
  channel.hasReceivedKeyframe = false;
  channel.droppedFramesBeforeKeyframe = 0;
  channel.lastDecodedSequence = -1;
  channel.framesOutOfOrder = 0;
  // Reset diagnostic counters
  channel.videoFramesDecoded = 0;
  channel.videoKeyframesReceived = 0;
  channel.audioFramesDecoded = 0;
  channel.lastVideoFrameInfo = null;
  channel.lastAudioFrameInfo = null;

  // Close any pending frames
  for (const { frame } of channel.pendingVideoFrames) {
    frame.close();
  }
  channel.pendingVideoFrames = [];

  for (const { data } of channel.pendingAudioData) {
    data.close();
  }
  channel.pendingAudioData = [];

  // Reset reorder buffer
  for (const entry of channel.frameReorderBuffer) {
    try { entry.frame.close(); } catch { /* ignore */ }
  }
  channel.frameReorderBuffer = [];
  channel.lastEmittedTimestamp = -1;

  log(`Channel ${channel.channelId} reset`);
}

/**
 * Safely close a decoder (handles already-closed state)
 */
function safeCloseDecoder(decoder: VideoDecoder | AudioDecoder | null): void {
  if (decoder && decoder.state !== 'closed') {
    try {
      decoder.close();
    } catch {
      // Ignore errors from closing - decoder may already be closed
    }
  }
}

/**
 * Destroy a channel
 */
function destroyChannel(channelId: number): void {
  const channel = channels.get(channelId);
  if (!channel) {
    log(`Channel ${channelId} not found`);
    return;
  }

  // Reset first to clean up pending frames
  resetChannel(channel);

  // Close decoders (safely handles already-closed state)
  safeCloseDecoder(channel.videoDecoder);
  safeCloseDecoder(channel.audioDecoder);

  // Remove from map
  channels.delete(channelId);

  respond({ type: 'destroyed', channelId });
  log(`Channel ${channelId} destroyed`);
}

/**
 * Close worker and all channels
 */
function closeWorker(): void {
  // Destroy all channels
  for (const channelId of channels.keys()) {
    const channel = channels.get(channelId)!;
    resetChannel(channel);
    safeCloseDecoder(channel.videoDecoder);
    safeCloseDecoder(channel.audioDecoder);
  }
  channels.clear();

  respond({ type: 'closed' });
  log('Worker closed');
}

/**
 * Message handler
 */
self.onmessage = (event: MessageEvent<CodecDecodeWorkerRequest>): void => {
  const msg = event.data;

  switch (msg.type) {
    case 'init': {
      debug = msg.config.debug ?? debug;
      if (debug) {
        log('INIT message received', {
          channelId: msg.channelId,
          existingChannels: Array.from(channels.keys()),
        });
      }
      const channel = createChannel(msg.channelId, msg.config);
      channels.set(msg.channelId, channel);
      if (debug) {
        log('Channel created', {
          channelId: msg.channelId,
          totalChannels: channels.size,
        });
      }
      respond({ type: 'ready', channelId: msg.channelId });
      log(`Channel ${msg.channelId} initialized`);
      break;
    }

    case 'push': {
      const channel = channels.get(msg.channelId);
      if (!channel) {
        log(`Channel ${msg.channelId} not found for push`);
        return;
      }
      pushData(channel, msg.data, msg.groupId, msg.objectId, msg.timestamp);
      break;
    }

    case 'poll': {
      const channel = channels.get(msg.channelId);
      if (!channel) {
        log(`Channel ${msg.channelId} not found for poll`);
        return;
      }
      const { videoFrames, audioFrames } = pollChannel(channel);
      respond({ type: 'poll-result', channelId: msg.channelId, videoFrames, audioFrames });
      break;
    }

    case 'poll-all': {
      // Poll all channels
      for (const channel of channels.values()) {
        pollChannel(channel);
      }
      break;
    }

    case 'reconfigure-video': {
      const channel = channels.get(msg.channelId);
      if (!channel) {
        log(`Channel ${msg.channelId} not found for reconfigure-video`);
        return;
      }
      reconfigureVideoDecoder(channel, msg.config);
      break;
    }

    case 'reconfigure-audio': {
      const channel = channels.get(msg.channelId);
      if (!channel) {
        log(`Channel ${msg.channelId} not found for reconfigure-audio`);
        return;
      }
      if (channel.audioDecoder) {
        channel.audioDecoder.configure({
          codec: msg.config.codec,
          sampleRate: msg.config.sampleRate,
          numberOfChannels: msg.config.numberOfChannels,
        });
        log(`Audio decoder reconfigured (channel ${msg.channelId})`, msg.config);
      }
      break;
    }

    case 'reset': {
      const channel = channels.get(msg.channelId);
      if (!channel) {
        log(`Channel ${msg.channelId} not found for reset`);
        return;
      }
      resetChannel(channel);
      break;
    }

    case 'mark-group-complete': {
      const channel = channels.get(msg.channelId);
      if (!channel) {
        log(`Channel ${msg.channelId} not found for mark-group-complete`);
        return;
      }
      // Signal the buffers/arbiters that the group is complete
      channel.videoPlayoutBuffer?.markGroupComplete(msg.groupId);
      channel.audioPlayoutBuffer?.markGroupComplete(msg.groupId);
      channel.videoArbiter?.markGroupComplete(msg.groupId);
      channel.audioArbiter?.markGroupComplete(msg.groupId);
      log(`Group ${msg.groupId} marked complete (channel ${msg.channelId})`);
      break;
    }

    case 'skip-group': {
      const channel = channels.get(msg.channelId);
      if (!channel) {
        log(`Channel ${msg.channelId} not found for skip-group`);
        return;
      }
      // Skip unavailable group so sequential playback advances past it
      channel.videoPlayoutBuffer?.skipGroup(msg.groupId);
      channel.audioPlayoutBuffer?.skipGroup(msg.groupId);
      log(`Group ${msg.groupId} skipped (channel ${msg.channelId})`);
      break;
    }

    case 'pause': {
      const channel = channels.get(msg.channelId);
      if (!channel) {
        log(`Channel ${msg.channelId} not found for pause`);
        return;
      }
      // Pause frame release in playout buffers
      channel.videoPlayoutBuffer?.getPolicy()?.pause?.();
      channel.audioPlayoutBuffer?.getPolicy()?.pause?.();
      log(`Channel ${msg.channelId} paused`);
      break;
    }

    case 'resume': {
      const channel = channels.get(msg.channelId);
      if (!channel) {
        log(`Channel ${msg.channelId} not found for resume`);
        return;
      }
      // Resume frame release in playout buffers
      channel.videoPlayoutBuffer?.getPolicy()?.resume?.();
      channel.audioPlayoutBuffer?.getPolicy()?.resume?.();
      log(`Channel ${msg.channelId} resumed`);
      break;
    }

    case 'destroy':
      destroyChannel(msg.channelId);
      break;

    case 'close':
      closeWorker();
      break;
  }
};

log('Codec decode worker loaded (multiplexed)');
