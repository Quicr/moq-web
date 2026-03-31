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
import { JitterBuffer } from '../pipeline/jitter-buffer.js';
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
  videoBuffer: JitterBuffer<VideoBufferData> | null;
  audioBuffer: JitterBuffer<AudioBufferData> | null;
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
  const channel: DecodeChannel = {
    channelId,
    videoDecoder: null,
    audioDecoder: null,
    unpackager: new LOCUnpackager(),
    videoBuffer: null,
    audioBuffer: null,
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
  };

  log(`Channel ${channelId} config`, { enableStats: channel.enableStats, jitterDelay: config.jitterBufferDelay });

  const jitterDelay = config.jitterBufferDelay ?? 100;

  // Initialize video if configured
  if (config.video) {
    channel.videoBuffer = new JitterBuffer<VideoBufferData>({
      targetDelay: jitterDelay,
      maxDelay: 300,
      maxFramesPerCall: 5,
    });
    initVideoDecoder(channel, config.video);
  }

  // Initialize audio if configured
  if (config.audio) {
    channel.audioBuffer = new JitterBuffer<AudioBufferData>({
      targetDelay: jitterDelay,
      maxDelay: 300,
      maxFramesPerCall: 5,
    });
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
      // Send decoded frame immediately instead of batching
      // This reduces latency by one poll cycle
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
            timestamp: meta?.timestamp ?? frame.timestamp,
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

      // Reset the decoder to recover from error state
      // This puts it back to "configured" state, ready to decode from next keyframe
      if (channel.videoDecoder && channel.videoDecoder.state !== 'closed') {
        try {
          channel.videoDecoder.reset();
          // Reconfigure after reset
          if (channel.videoConfig) {
            const decoderConfig: VideoDecoderConfig = {
              codec: channel.videoConfig.codec,
              codedWidth: channel.videoConfig.codedWidth,
              codedHeight: channel.videoConfig.codedHeight,
            };
            if (channel.videoConfig.description) {
              decoderConfig.description = channel.videoConfig.description;
            }
            channel.videoDecoder.configure(decoderConfig);
            console.log(`[CodecDecodeWorker] Decoder reset and reconfigured (channel ${channel.channelId})`);
          }
        } catch (resetErr) {
          console.error(`[CodecDecodeWorker] Failed to reset decoder (channel ${channel.channelId}):`, resetErr);
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

  channel.videoConfig = config;

  const decoderConfig: VideoDecoderConfig = {
    codec: config.codec,
    codedWidth: config.codedWidth,
    codedHeight: config.codedHeight,
  };

  if (config.description) {
    decoderConfig.description = config.description;
  }

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
  try {
    const mediaType = channel.unpackager.getMediaType(data);

    if (mediaType === MediaType.VIDEO && channel.videoBuffer) {
      const frame = channel.unpackager.unpackage(data);
      const isKeyframe = frame.header.isKeyframe;

      // If keyframe has codec description, reconfigure decoder
      if (isKeyframe && frame.codecDescription && channel.videoConfig) {
        reconfigureVideoDecoder(channel, {
          ...channel.videoConfig,
          description: frame.codecDescription,
        });
      }

      const arrivedAt = performance.now();
      channel.videoBuffer.push({
        data: {
          data: frame.payload,
          isKeyframe,
          codecDescription: frame.codecDescription,
          arrivedAt,
        },
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
    } else if (mediaType === MediaType.AUDIO && channel.audioBuffer) {
      const frame = channel.unpackager.unpackage(data);

      channel.audioBuffer.push({
        data: { data: frame.payload },
        timestamp: timestamp / 1000, // Convert to ms
        sequence: channel.audioSequence++,
        groupId,
        objectId,
        isKeyframe: true, // Opus is always key
        receivedAt: performance.now(),
      });

      log(`Pushed audio (channel ${channel.channelId})`, { groupId, objectId, bufferSize: channel.audioBuffer.size });
    }
  } catch (err) {
    respond({ type: 'error', channelId: channel.channelId, message: `Unpackaging failed: ${(err as Error).message}` });
  }
}

/**
 * Poll a channel for ready frames
 */
function pollChannel(channel: DecodeChannel): { videoFrames: number; audioFrames: number } {
  let videoCount = 0;
  let audioCount = 0;

  // Process video buffer
  if (channel.videoBuffer && channel.videoDecoder) {
    const readyFrames = channel.videoBuffer.getReadyFrames();

    for (const frame of readyFrames) {
      // Wait for keyframe before starting to decode
      // This prevents WebCodecs decoder errors when delta frames arrive first
      if (!channel.hasReceivedKeyframe && !frame.data.isKeyframe) {
        channel.droppedFramesBeforeKeyframe++;
        // Log every dropped frame for debugging
        log(`Dropping delta frame - waiting for keyframe (channel ${channel.channelId})`, {
          groupId: frame.groupId,
          objectId: frame.objectId,
          droppedCount: channel.droppedFramesBeforeKeyframe,
        });
        continue;
      }

      if (frame.data.isKeyframe) {
        channel.hasReceivedKeyframe = true;
        channel.videoKeyframesReceived++;
        log(`KEYFRAME received (channel ${channel.channelId})`, {
          groupId: frame.groupId,
          objectId: frame.objectId,
          droppedBeforeKeyframe: channel.droppedFramesBeforeKeyframe,
        });
      }

      // Check for out-of-order decode
      const expectedSequence = channel.lastDecodedSequence + 1;
      const isOutOfOrder = channel.lastDecodedSequence >= 0 && frame.sequence !== expectedSequence;
      if (isOutOfOrder) {
        channel.framesOutOfOrder++;
        log(`OUT OF ORDER frame (channel ${channel.channelId})`, {
          expected: expectedSequence,
          got: frame.sequence,
          totalOutOfOrder: channel.framesOutOfOrder,
        });
      }
      channel.lastDecodedSequence = frame.sequence;

      // Log every frame being decoded for debugging
      log(`Decoding frame (channel ${channel.channelId})`, {
        groupId: frame.groupId,
        objectId: frame.objectId,
        sequence: frame.sequence,
        timestamp: frame.timestamp,
        isKeyframe: frame.data.isKeyframe,
        dataSize: frame.data.data.length,
        outOfOrder: isOutOfOrder,
      });

      try {
        // Set current metadata for the decoder output callback
        channel.currentVideoMeta = {
          groupId: frame.groupId,
          objectId: frame.objectId,
          timestamp: frame.timestamp * 1000, // Back to microseconds
          arrivedAt: frame.data.arrivedAt,
        };

        // Track frame info for diagnostics (reuse object to avoid allocations)
        if (!channel.lastVideoFrameInfo) {
          channel.lastVideoFrameInfo = { groupId: 0, objectId: 0, isKeyframe: false, dataSize: 0, sequence: 0 };
        }
        channel.lastVideoFrameInfo.groupId = frame.groupId;
        channel.lastVideoFrameInfo.objectId = frame.objectId;
        channel.lastVideoFrameInfo.isKeyframe = frame.data.isKeyframe;
        channel.lastVideoFrameInfo.dataSize = frame.data.data.length;
        channel.lastVideoFrameInfo.sequence = frame.sequence;

        const chunk = new EncodedVideoChunk({
          type: frame.data.isKeyframe ? 'key' : 'delta',
          timestamp: frame.timestamp * 1000, // Back to microseconds
          data: frame.data.data,
        });

        channel.videoDecoder.decode(chunk);
        channel.videoFramesDecoded++;
        videoCount++;
      } catch (err) {
        log(`Error decoding video (channel ${channel.channelId})`, err);
      }
    }
  }

  // Process audio buffer
  if (channel.audioBuffer && channel.audioDecoder) {
    const readyFrames = channel.audioBuffer.getReadyFrames();

    for (const frame of readyFrames) {
      try {
        // Set current metadata for the decoder output callback
        channel.currentAudioMeta = {
          groupId: frame.groupId,
          objectId: frame.objectId,
          timestamp: frame.timestamp * 1000, // Back to microseconds
        };

        // Track frame info for diagnostics (reuse object to avoid allocations)
        if (!channel.lastAudioFrameInfo) {
          channel.lastAudioFrameInfo = { groupId: 0, objectId: 0, dataSize: 0, sequence: 0 };
        }
        channel.lastAudioFrameInfo.groupId = frame.groupId;
        channel.lastAudioFrameInfo.objectId = frame.objectId;
        channel.lastAudioFrameInfo.dataSize = frame.data.data.length;
        channel.lastAudioFrameInfo.sequence = frame.sequence;

        const chunk = new EncodedAudioChunk({
          type: 'key', // Opus is always key
          timestamp: frame.timestamp * 1000, // Back to microseconds
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

  log(`Channel ${channel.channelId} reset`);
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

  // Close decoders
  channel.videoDecoder?.close();
  channel.audioDecoder?.close();

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
    channel.videoDecoder?.close();
    channel.audioDecoder?.close();
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

    case 'destroy':
      destroyChannel(msg.channelId);
      break;

    case 'close':
      closeWorker();
      break;
  }
};

log('Codec decode worker loaded (multiplexed)');
