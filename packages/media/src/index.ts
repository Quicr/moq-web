// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview MOQT Media Library
 *
 * WebCodecs encoding/decoding with LOC container format for MOQT.
 * Provides complete media capture, encoding, packaging, decoding,
 * and playback pipelines.
 *
 * @packageDocumentation
 *
 * @example
 * ```typescript
 * import {
 *   PublishPipeline,
 *   SubscribePipeline,
 *   H264Encoder,
 *   OpusEncoder,
 *   LOCPackager,
 * } from '@web-moq/media';
 *
 * // Publishing pipeline
 * const publishPipeline = new PublishPipeline({
 *   video: { width: 1280, height: 720, bitrate: 2_000_000, framerate: 30 },
 *   audio: { sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 },
 * });
 *
 * publishPipeline.on('video-object', (obj) => transport.send(obj));
 * await publishPipeline.start(mediaStream);
 *
 * // Subscribe pipeline
 * const subscribePipeline = new SubscribePipeline({
 *   video: { codec: 'avc1.4D401E', codedWidth: 1280, codedHeight: 720 },
 *   audio: { sampleRate: 48000, numberOfChannels: 2 },
 * });
 *
 * subscribePipeline.on('video-frame', (frame) => render(frame));
 * await subscribePipeline.start();
 * ```
 */

// WebCodecs encoders
export { H264Encoder, H264Profiles, getCodecForResolution } from './webcodecs/video-encoder.js';
export type {
  VideoEncoderConfig,
  EncodedVideoFrame,
  VideoEncoderEvent,
} from './webcodecs/video-encoder.js';

export { OpusEncoder } from './webcodecs/audio-encoder.js';
export type {
  OpusEncoderOptions,
  EncodedAudioFrame,
  AudioEncoderEvent,
} from './webcodecs/audio-encoder.js';

// WebCodecs decoders
export { H264Decoder } from './webcodecs/video-decoder.js';
export type {
  VideoDecoderConfig,
  VideoDecoderEvent,
} from './webcodecs/video-decoder.js';

export { OpusDecoder } from './webcodecs/audio-decoder.js';
export type {
  AudioDecoderConfig,
  AudioDecoderEvent,
} from './webcodecs/audio-decoder.js';

// LOC container
export {
  LOCPackager,
  LOCUnpackager,
  MediaType,
  LOCExtensionType,
  QuicRExtensionType,
  QUICR_EXTENSION_SIZES,
  createSimpleLOCPacket,
} from './loc/loc-container.js';
export type {
  LOCVideoOptions,
  LOCAudioOptions,
  LOCHeader,
  LOCExtension,
  LOCFrame,
  VideoFrameMarking,
  VADData,
} from './loc/loc-container.js';

// Jitter buffer
export { JitterBuffer } from './pipeline/jitter-buffer.js';
export type {
  BufferedFrame,
  JitterBufferConfig,
  JitterBufferStats,
} from './pipeline/jitter-buffer.js';

// Group-aware jitter buffer (deadline-based ordering)
export { GroupArbiter } from './pipeline/group-arbiter.js';
export { TimingEstimator, createTimingEstimator } from './pipeline/timing-estimator.js';
export { MonotonicTickProvider, WallClockTickProvider } from './pipeline/tick-provider.js';
export type { TickProvider, TickProviderConfig } from './pipeline/tick-provider.js';
export type { TimingEstimatorConfig } from './pipeline/timing-estimator.js';
export type {
  GroupState,
  GroupStatus,
  FrameEntry,
  ArbiterStats,
  TimingConfig,
  ArbiterFrameInput,
} from './pipeline/group-arbiter-types.js';
export {
  DEFAULT_TIMING_CONFIG,
  createGroupState,
  createArbiterStats,
} from './pipeline/group-arbiter-types.js';

// Backpressure control
export { BackpressureController } from './pipeline/backpressure.js';
export type {
  QueuedItem,
  BackpressureConfig,
  BackpressureStats,
} from './pipeline/backpressure.js';

// Pipelines
export { PublishPipeline } from './pipeline/publish-pipeline.js';
export type {
  PublishPipelineConfig,
  PublishedObject,
  PipelineEvent,
} from './pipeline/publish-pipeline.js';

export { SubscribePipeline } from './pipeline/subscribe-pipeline.js';
export type {
  SubscribePipelineConfig,
  ReceivedObject,
  SubscribePipelineEvent,
  JitterSample,
} from './pipeline/subscribe-pipeline.js';

// Media Session
export { MediaSession } from './session/index.js';
export type {
  SessionState,
  MediaSessionEventType,
  MediaConfig,
  MediaSubscribeOptions,
  MediaPublishOptions,
  MediaSessionOptions,
  WorkerConfig,
} from './session/index.js';
export { getResolutionConfig } from './session/index.js';

// Web Workers - LOC-only (existing)
export {
  EncodeWorkerClient,
  DecodeWorkerClient,
  createEncodeWorker,
  createDecodeWorker,
  prepareForTransfer,
  prepareMultipleForTransfer,
} from './workers/index.js';
export type {
  EncodeWorkerRequest,
  EncodeWorkerResponse,
  EncodeWorkerConfig,
  DecodeWorkerRequest,
  DecodeWorkerResponse,
  DecodeWorkerConfig,
} from './workers/index.js';

// Web Workers - Codec + LOC (new - WebCodecs in worker)
export {
  CodecEncodeWorkerClient,
  CodecDecodeWorkerClient,
} from './workers/index.js';
export type {
  CodecEncodeWorkerConfig,
  VideoEncoderWorkerConfig,
  AudioEncoderWorkerConfig,
  VideoEncodedResult,
  AudioEncodedResult,
  CodecDecodeWorkerConfig,
  VideoDecoderWorkerConfig,
  AudioDecoderWorkerConfig,
  VideoDecodedResult,
  AudioDecodedResult,
} from './workers/index.js';

// Voice Activity Detection
export { BaseVAD, LibfvadVAD, SileroVAD } from './vad/index.js';
export type {
  VAD,
  VADConfig,
  VADResult,
  VADEvents,
  VADProvider,
  LibfvadModule,
  SileroVADFactory,
} from './vad/index.js';

// Experience Profiles
export {
  EXPERIENCE_PROFILES,
  EXPERIENCE_PROFILE_ORDER,
  getExperienceProfile,
  profileFromTargetLatency,
  detectCurrentProfile,
} from './profiles/index.js';
export type {
  ExperienceProfileName,
  DefinedProfileName,
  ExperienceProfileSettings,
  ExperienceProfile,
} from './profiles/index.js';

// VOD Loader
export { VODLoader } from './vod/vod-loader.js';
export type { VODLoadProgress, VODLoaderOptions } from './vod/vod-loader.js';
