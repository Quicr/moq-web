// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Type declarations for WebCodecs APIs not yet in TypeScript's lib.dom
 */

/**
 * MediaStreamTrackProcessor - processes MediaStreamTrack into a ReadableStream
 */
interface MediaStreamTrackProcessorInit {
  track: MediaStreamTrack;
  maxBufferSize?: number;
}

declare class MediaStreamTrackProcessor<T extends VideoFrame | AudioData> {
  constructor(init: MediaStreamTrackProcessorInit);
  readonly readable: ReadableStream<T>;
}

/**
 * MediaStreamTrackGenerator - generates MediaStreamTrack from a WritableStream
 */
interface MediaStreamTrackGeneratorInit {
  kind: 'audio' | 'video';
}

declare class MediaStreamTrackGenerator extends MediaStreamTrack {
  constructor(init: MediaStreamTrackGeneratorInit);
  readonly writable: WritableStream<VideoFrame | AudioData>;
}
