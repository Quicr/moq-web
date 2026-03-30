// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Codec Encode Worker Implementation
 *
 * Web Worker that handles WebCodecs video/audio encoding and LOC packaging.
 * Supports multiple concurrent encode channels, each with its own encoder
 * instances and state. Messages include a channelId to route data to the
 * correct encoder context.
 */

import { LOCPackager } from '../loc/loc-container.js';
import type {
  CodecEncodeWorkerConfig,
  CodecEncodeWorkerRequest,
  CodecEncodeWorkerResponse,
  VideoEncodedResult,
  AudioEncodedResult,
} from './codec-encode-worker-types.js';

// Global debug flag
let debug = false;

/**
 * Generate initial group ID from current time.
 * Uses last 32 bits of millisecond timestamp (~50 days coverage).
 * This ensures unique group IDs across different publish sessions.
 */
function getInitialGroupId(): number {
  return Date.now() >>> 0;  // Unsigned 32-bit (~50 days of milliseconds)
}

/**
 * Channel state - each publication gets its own encode context
 */
interface EncodeChannel {
  channelId: number;
  videoEncoder: VideoEncoder | null;
  audioEncoder: AudioEncoder | null;
  packager: LOCPackager;
  videoGroupId: number;
  videoObjectId: number;
  audioGroupId: number;
  audioObjectId: number;
  forceNextKeyframe: boolean;
  /** Frame counter for keyframe interval */
  videoFrameCount: number;
  /** Keyframe interval in frames (0 = no auto keyframes) */
  keyframeIntervalFrames: number;
}

// Map of channel ID to encode context
const channels = new Map<number, EncodeChannel>();

/**
 * Log helper
 */
function log(...args: unknown[]): void {
  if (debug) {
    console.log('[CodecEncodeWorker]', ...args);
  }
}

/**
 * Send response to main thread
 */
function respond(msg: CodecEncodeWorkerResponse, transfer?: Transferable[]): void {
  if (transfer && transfer.length > 0) {
    (self as unknown as Worker).postMessage(msg, transfer);
  } else {
    self.postMessage(msg);
  }
}

/**
 * Create a new encode channel
 */
function createChannel(channelId: number, config: CodecEncodeWorkerConfig): EncodeChannel {
  // Calculate keyframe interval in frames (default: 2 seconds worth of frames)
  const framerate = config.video?.framerate ?? 30;
  const keyframeIntervalSeconds = config.video?.keyframeInterval ?? 2;
  const keyframeIntervalFrames = Math.round(keyframeIntervalSeconds * framerate);

  const channel: EncodeChannel = {
    channelId,
    videoEncoder: null,
    audioEncoder: null,
    packager: new LOCPackager(),
    videoGroupId: getInitialGroupId(),
    videoObjectId: 0,
    audioGroupId: getInitialGroupId(),
    audioObjectId: 0,
    forceNextKeyframe: false,
    videoFrameCount: 0,
    keyframeIntervalFrames,
  };

  log(`Channel ${channelId} created with keyframeIntervalFrames=${keyframeIntervalFrames}`);

  if (config.video) {
    initVideoEncoder(channel, config.video);
  }

  if (config.audio) {
    initAudioEncoder(channel, config.audio);
  }

  return channel;
}

/**
 * Initialize video encoder for a channel
 */
function initVideoEncoder(channel: EncodeChannel, config: CodecEncodeWorkerConfig['video']): void {
  if (!config) return;

  channel.videoEncoder = new VideoEncoder({
    output: (chunk, metadata) => handleEncodedVideoChunk(channel, chunk, metadata),
    error: (err) => {
      log(`Video encoder error (channel ${channel.channelId})`, err);
      respond({ type: 'error', channelId: channel.channelId, message: err.message });
    },
  });

  channel.videoEncoder.configure({
    codec: config.codec,
    width: config.width,
    height: config.height,
    bitrate: config.bitrate,
    framerate: config.framerate,
    latencyMode: 'realtime',
    avc: { format: 'annexb' },
  });

  log(`Video encoder configured (channel ${channel.channelId})`, config);
  respond({ type: 'video-ready', channelId: channel.channelId });
}

/**
 * Initialize audio encoder for a channel
 */
function initAudioEncoder(channel: EncodeChannel, config: CodecEncodeWorkerConfig['audio']): void {
  if (!config) return;

  channel.audioEncoder = new AudioEncoder({
    output: (chunk) => handleEncodedAudioChunk(channel, chunk),
    error: (err) => {
      log(`Audio encoder error (channel ${channel.channelId})`, err);
      respond({ type: 'error', channelId: channel.channelId, message: err.message });
    },
  });

  channel.audioEncoder.configure({
    codec: config.codec,
    sampleRate: config.sampleRate,
    numberOfChannels: config.numberOfChannels,
    bitrate: config.bitrate,
  });

  log(`Audio encoder configured (channel ${channel.channelId})`, config);
  respond({ type: 'audio-ready', channelId: channel.channelId });
}

/**
 * Handle encoded video chunk from VideoEncoder
 */
function handleEncodedVideoChunk(
  channel: EncodeChannel,
  chunk: EncodedVideoChunk,
  metadata?: EncodedVideoChunkMetadata
): void {
  // Extract chunk data
  const data = new Uint8Array(chunk.byteLength);
  chunk.copyTo(data);

  const isKeyframe = chunk.type === 'key';

  // Update group/object IDs
  if (isKeyframe) {
    channel.videoGroupId++;
    channel.videoObjectId = 0;
  } else {
    channel.videoObjectId++;
  }

  // Extract codec description for keyframes
  let codecDescription: Uint8Array | undefined;
  if (isKeyframe && metadata?.decoderConfig?.description) {
    const desc = metadata.decoderConfig.description;
    if (desc instanceof ArrayBuffer) {
      codecDescription = new Uint8Array(desc);
    } else if (ArrayBuffer.isView(desc)) {
      codecDescription = new Uint8Array(desc.buffer, desc.byteOffset, desc.byteLength);
    }
  }

  // Package with LOC
  const locData = channel.packager.packageVideo(data, {
    isKeyframe,
    captureTimestamp: performance.now(),
    codecDescription,
  });

  const result: VideoEncodedResult = {
    data: locData,
    groupId: channel.videoGroupId,
    objectId: channel.videoObjectId,
    isKeyframe,
    timestamp: chunk.timestamp,
    duration: chunk.duration ?? 0,
    codecDescription,
  };

  // Build transfer list
  const transfer: Transferable[] = [locData.buffer];
  if (codecDescription) {
    transfer.push(codecDescription.buffer);
  }

  respond({ type: 'video-encoded', channelId: channel.channelId, result }, transfer);
}

/**
 * Handle encoded audio chunk from AudioEncoder
 */
function handleEncodedAudioChunk(channel: EncodeChannel, chunk: EncodedAudioChunk): void {
  // Extract chunk data
  const data = new Uint8Array(chunk.byteLength);
  chunk.copyTo(data);

  // Each audio frame = new group, objectId always 0
  channel.audioGroupId++;
  channel.audioObjectId = 0;

  // Package with LOC
  const locData = channel.packager.packageAudio(data, {
    captureTimestamp: performance.now(),
  });

  const result: AudioEncodedResult = {
    data: locData,
    groupId: channel.audioGroupId,
    objectId: channel.audioObjectId,
    timestamp: chunk.timestamp,
    duration: chunk.duration ?? 0,
  };

  respond({ type: 'audio-encoded', channelId: channel.channelId, result }, [locData.buffer]);
}

/**
 * Encode a video frame
 */
function encodeVideoFrame(channel: EncodeChannel, frame: VideoFrame, forceKeyframe?: boolean): void {
  if (!channel.videoEncoder) {
    log(`Video encoder not initialized (channel ${channel.channelId})`);
    frame.close();
    return;
  }

  // Check if encoder is still open
  if (channel.videoEncoder.state === 'closed') {
    log(`Video encoder is closed (channel ${channel.channelId})`);
    frame.close();
    return;
  }

  try {
    // Auto-generate keyframes at configured interval
    const autoKeyframe = channel.keyframeIntervalFrames > 0 &&
      channel.videoFrameCount % channel.keyframeIntervalFrames === 0;
    const keyFrame = forceKeyframe || channel.forceNextKeyframe || autoKeyframe;
    channel.forceNextKeyframe = false;
    channel.videoFrameCount++;

    channel.videoEncoder.encode(frame, { keyFrame });
  } catch (err) {
    log(`Error encoding video frame (channel ${channel.channelId})`, err);
    respond({ type: 'error', channelId: channel.channelId, message: (err as Error).message });
  } finally {
    frame.close();
  }
}

/**
 * Encode audio data
 */
function encodeAudioData(channel: EncodeChannel, data: AudioData): void {
  if (!channel.audioEncoder) {
    log(`Audio encoder not initialized (channel ${channel.channelId})`);
    data.close();
    return;
  }

  // Check if encoder is still open
  if (channel.audioEncoder.state === 'closed') {
    log(`Audio encoder is closed (channel ${channel.channelId})`);
    data.close();
    return;
  }

  try {
    channel.audioEncoder.encode(data);
  } catch (err) {
    log(`Error encoding audio data (channel ${channel.channelId})`, err);
    respond({ type: 'error', channelId: channel.channelId, message: (err as Error).message });
  } finally {
    data.close();
  }
}

/**
 * Flush encoders for a channel
 */
async function flushChannel(channel: EncodeChannel): Promise<void> {
  try {
    await channel.videoEncoder?.flush();
    await channel.audioEncoder?.flush();
    respond({ type: 'flushed', channelId: channel.channelId });
  } catch (err) {
    respond({ type: 'error', channelId: channel.channelId, message: (err as Error).message });
  }
}

/**
 * Reset channel state
 */
function resetChannel(channel: EncodeChannel): void {
  channel.videoGroupId = getInitialGroupId();
  channel.videoObjectId = 0;
  channel.audioGroupId = getInitialGroupId();
  channel.audioObjectId = 0;
  channel.forceNextKeyframe = false;
  channel.videoFrameCount = 0;
  channel.packager.reset();
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

  // Close encoders (check state to avoid closing already-closed encoders)
  if (channel.videoEncoder && channel.videoEncoder.state !== 'closed') {
    channel.videoEncoder.close();
  }
  if (channel.audioEncoder && channel.audioEncoder.state !== 'closed') {
    channel.audioEncoder.close();
  }

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
    if (channel.videoEncoder && channel.videoEncoder.state !== 'closed') {
      channel.videoEncoder.close();
    }
    if (channel.audioEncoder && channel.audioEncoder.state !== 'closed') {
      channel.audioEncoder.close();
    }
  }
  channels.clear();

  respond({ type: 'closed' });
  log('Worker closed');
}

/**
 * Message handler
 */
self.onmessage = async (event: MessageEvent<CodecEncodeWorkerRequest>): Promise<void> => {
  const msg = event.data;

  switch (msg.type) {
    case 'init': {
      debug = msg.config.debug ?? debug;
      const channel = createChannel(msg.channelId, msg.config);
      channels.set(msg.channelId, channel);
      respond({ type: 'ready', channelId: msg.channelId });
      log(`Channel ${msg.channelId} initialized`);
      break;
    }

    case 'encode-video': {
      const channel = channels.get(msg.channelId);
      if (!channel) {
        log(`Channel ${msg.channelId} not found for encode-video`);
        msg.frame.close();
        return;
      }
      encodeVideoFrame(channel, msg.frame, msg.forceKeyframe);
      break;
    }

    case 'encode-audio': {
      const channel = channels.get(msg.channelId);
      if (!channel) {
        log(`Channel ${msg.channelId} not found for encode-audio`);
        msg.data.close();
        return;
      }
      encodeAudioData(channel, msg.data);
      break;
    }

    case 'update-video-bitrate': {
      const channel = channels.get(msg.channelId);
      if (!channel) {
        log(`Channel ${msg.channelId} not found for update-video-bitrate`);
        return;
      }
      // Note: WebCodecs doesn't support dynamic bitrate changes easily
      // Would need to reconfigure encoder
      log(`Update video bitrate requested (channel ${msg.channelId}, not implemented)`, msg.bitrate);
      break;
    }

    case 'update-audio-bitrate': {
      const channel = channels.get(msg.channelId);
      if (!channel) {
        log(`Channel ${msg.channelId} not found for update-audio-bitrate`);
        return;
      }
      log(`Update audio bitrate requested (channel ${msg.channelId}, not implemented)`, msg.bitrate);
      break;
    }

    case 'reconfigure-audio': {
      const channel = channels.get(msg.channelId);
      if (!channel) {
        log(`Channel ${msg.channelId} not found for reconfigure-audio`);
        return;
      }
      // Close existing encoder if any
      if (channel.audioEncoder) {
        try {
          channel.audioEncoder.close();
        } catch {
          // Ignore close errors
        }
      }
      // Re-initialize with new config
      initAudioEncoder(channel, msg.config);
      log(`Audio encoder reconfigured (channel ${msg.channelId})`, msg.config);
      break;
    }

    case 'force-keyframe': {
      const channel = channels.get(msg.channelId);
      if (!channel) {
        log(`Channel ${msg.channelId} not found for force-keyframe`);
        return;
      }
      channel.forceNextKeyframe = true;
      log(`Next frame will be keyframe (channel ${msg.channelId})`);
      break;
    }

    case 'flush': {
      const channel = channels.get(msg.channelId);
      if (!channel) {
        log(`Channel ${msg.channelId} not found for flush`);
        return;
      }
      await flushChannel(channel);
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

log('Codec encode worker loaded (multiplexed)');
