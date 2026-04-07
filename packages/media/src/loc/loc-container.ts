// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview LOC Container Format Implementation
 *
 * Implements the LOC (Low Overhead Container) format as specified in
 * draft-ietf-moq-loc. LOC provides minimal overhead packaging of media
 * frames for MOQT transmission.
 *
 * Performance optimized for high-throughput media pipelines with:
 * - Zero-copy packaging via outputBuffer option
 * - Pre-calculated buffer sizes
 * - Direct buffer writes (no intermediate allocations)
 * - Inline varint encoding
 *
 * @see https://datatracker.ietf.org/doc/draft-ietf-moq-loc/
 *
 * @example
 * ```typescript
 * import { LOCPackager, LOCUnpackager, MediaType } from '@web-moq/media';
 *
 * // Package a video frame
 * const packager = new LOCPackager();
 * const packet = packager.packageVideo(encodedFrame, {
 *   isKeyframe: true,
 *   captureTimestamp: Date.now(),
 * });
 *
 * // Zero-copy with buffer pool
 * const size = packager.calculateVideoPacketSize(payload, options);
 * const buffer = pool.acquire(size);
 * const packet = packager.packageVideo(payload, { ...options, outputBuffer: buffer });
 * ```
 */

import { Logger, BufferReader } from '@web-moq/core';

const log = Logger.create('moqt:media:loc');

/**
 * Media types supported by LOC
 */
export enum MediaType {
  /** Video media (H.264, etc.) */
  VIDEO = 0,
  /** Audio media (Opus, etc.) */
  AUDIO = 1,
}

/**
 * LOC extension types
 */
export enum LOCExtensionType {
  /** Capture timestamp extension */
  CAPTURE_TIMESTAMP = 0x01,
  /** Video frame marking (layering info) */
  VIDEO_FRAME_MARKING = 0x02,
  /** Audio level extension */
  AUDIO_LEVEL = 0x03,
  /** Codec-specific data */
  CODEC_DATA = 0x10,
}

/**
 * Video frame marking data
 */
export interface VideoFrameMarking {
  /** Temporal layer ID (0-7) */
  temporalId: number;
  /** Spatial layer ID (0-3) */
  spatialId: number;
  /** Is this the last frame in the temporal unit */
  endOfFrame: boolean;
  /** Is this frame discardable */
  discardable: boolean;
  /** Is this a base layer frame */
  baseLayer: boolean;
}

/**
 * LOC packet options for video
 */
export interface LOCVideoOptions {
  /** Whether this is a keyframe */
  isKeyframe: boolean;
  /** Capture timestamp in milliseconds */
  captureTimestamp?: number;
  /** Video frame marking info */
  frameMarking?: VideoFrameMarking;
  /** Codec description (for keyframes) */
  codecDescription?: Uint8Array;
  /** Optional pre-allocated output buffer for zero-copy packaging */
  outputBuffer?: Uint8Array;
}

/**
 * LOC packet options for audio
 */
export interface LOCAudioOptions {
  /** Capture timestamp in milliseconds */
  captureTimestamp?: number;
  /** Audio level (0-127, per RFC 6464) */
  audioLevel?: number;
  /** Whether voice activity was detected */
  voiceActivity?: boolean;
  /** Optional pre-allocated output buffer for zero-copy packaging */
  outputBuffer?: Uint8Array;
}

/**
 * LOC packet header
 */
export interface LOCHeader {
  /** Media type */
  mediaType: MediaType;
  /** Whether this is a keyframe */
  isKeyframe: boolean;
  /** Sequence number */
  sequenceNumber: number;
  /** Extensions present */
  extensions: LOCExtension[];
}

/**
 * LOC extension
 */
export interface LOCExtension {
  /** Extension type */
  type: LOCExtensionType;
  /** Extension data */
  data: Uint8Array;
}

/**
 * Unpacked LOC frame
 */
export interface LOCFrame {
  /** LOC header */
  header: LOCHeader;
  /** Media payload */
  payload: Uint8Array;
  /** Capture timestamp (if present) */
  captureTimestamp?: number;
  /** Video frame marking (if present) */
  frameMarking?: VideoFrameMarking;
  /** Audio level (if present) */
  audioLevel?: { level: number; voiceActivity: boolean };
  /** Codec description (if present) */
  codecDescription?: Uint8Array;
}

// ============================================================================
// Inline VarInt encoding for maximum performance (avoids function call overhead)
// ============================================================================

/** Maximum values for each varint encoding length */
const VARINT_MAX_1BYTE = 63;
const VARINT_MAX_2BYTE = 16383;
const VARINT_MAX_4BYTE = 1073741823;

/**
 * Get encoded length of a varint (inline for performance)
 */
function varintEncodedLength(value: number): 1 | 2 | 4 | 8 {
  if (value <= VARINT_MAX_1BYTE) return 1;
  if (value <= VARINT_MAX_2BYTE) return 2;
  if (value <= VARINT_MAX_4BYTE) return 4;
  return 8;
}

/**
 * Write varint directly to buffer at offset, return bytes written
 * Optimized inline implementation avoiding VarInt class overhead
 */
function writeVarintAt(buffer: Uint8Array, offset: number, value: number): number {
  if (value <= VARINT_MAX_1BYTE) {
    buffer[offset] = value;
    return 1;
  }
  if (value <= VARINT_MAX_2BYTE) {
    buffer[offset] = 0x40 | (value >> 8);
    buffer[offset + 1] = value & 0xff;
    return 2;
  }
  if (value <= VARINT_MAX_4BYTE) {
    buffer[offset] = 0x80 | (value >> 24);
    buffer[offset + 1] = (value >> 16) & 0xff;
    buffer[offset + 2] = (value >> 8) & 0xff;
    buffer[offset + 3] = value & 0xff;
    return 4;
  }
  // 8-byte encoding for large values
  const high = Math.floor(value / 0x100000000);
  const low = value >>> 0;
  buffer[offset] = 0xc0 | (high >> 24);
  buffer[offset + 1] = (high >> 16) & 0xff;
  buffer[offset + 2] = (high >> 8) & 0xff;
  buffer[offset + 3] = high & 0xff;
  buffer[offset + 4] = (low >> 24) & 0xff;
  buffer[offset + 5] = (low >> 16) & 0xff;
  buffer[offset + 6] = (low >> 8) & 0xff;
  buffer[offset + 7] = low & 0xff;
  return 8;
}

/**
 * Write varint for bigint values (timestamps in microseconds)
 */
function writeVarintBigIntAt(buffer: Uint8Array, offset: number, value: bigint): number {
  if (value <= BigInt(VARINT_MAX_1BYTE)) {
    buffer[offset] = Number(value);
    return 1;
  }
  if (value <= BigInt(VARINT_MAX_2BYTE)) {
    const v = Number(value);
    buffer[offset] = 0x40 | (v >> 8);
    buffer[offset + 1] = v & 0xff;
    return 2;
  }
  if (value <= BigInt(VARINT_MAX_4BYTE)) {
    const v = Number(value);
    buffer[offset] = 0x80 | (v >> 24);
    buffer[offset + 1] = (v >> 16) & 0xff;
    buffer[offset + 2] = (v >> 8) & 0xff;
    buffer[offset + 3] = v & 0xff;
    return 4;
  }
  // 8-byte encoding
  buffer[offset] = Number(0xc0n | ((value >> 56n) & 0x3fn));
  buffer[offset + 1] = Number((value >> 48n) & 0xffn);
  buffer[offset + 2] = Number((value >> 40n) & 0xffn);
  buffer[offset + 3] = Number((value >> 32n) & 0xffn);
  buffer[offset + 4] = Number((value >> 24n) & 0xffn);
  buffer[offset + 5] = Number((value >> 16n) & 0xffn);
  buffer[offset + 6] = Number((value >> 8n) & 0xffn);
  buffer[offset + 7] = Number(value & 0xffn);
  return 8;
}

/**
 * Get encoded length for bigint varint
 */
function varintBigIntEncodedLength(value: bigint): number {
  if (value <= BigInt(VARINT_MAX_1BYTE)) return 1;
  if (value <= BigInt(VARINT_MAX_2BYTE)) return 2;
  if (value <= BigInt(VARINT_MAX_4BYTE)) return 4;
  return 8;
}

// ============================================================================
// LOC Packager - High Performance Implementation
// ============================================================================

/**
 * LOC Packager
 *
 * @remarks
 * Packages encoded media frames into LOC format for MOQT transmission.
 * Optimized for high-throughput with zero-copy buffer support.
 *
 * @example
 * ```typescript
 * const packager = new LOCPackager();
 *
 * // Standard packaging (allocates new buffer)
 * const packet = packager.packageVideo(videoData, {
 *   isKeyframe: true,
 *   captureTimestamp: performance.now(),
 * });
 *
 * // Zero-copy with pre-allocated buffer
 * const size = packager.calculateVideoPacketSize(videoData, options);
 * const buffer = bufferPool.acquire(size);
 * const packet = packager.packageVideo(videoData, { ...options, outputBuffer: buffer });
 * // packet is a view into buffer, release buffer when done
 * ```
 */
export class LOCPackager {
  /** Video sequence counter */
  private videoSequence = 0;
  /** Audio sequence counter */
  private audioSequence = 0;
  /** Reusable internal buffer for when no outputBuffer provided */
  private internalBuffer: Uint8Array;

  /**
   * Create a new LOCPackager
   *
   * @param initialBufferSize - Initial size for internal buffer (default: 256KB)
   */
  constructor(initialBufferSize = 262144) {
    this.internalBuffer = new Uint8Array(initialBufferSize);
    log.debug('LOCPackager created', { bufferSize: initialBufferSize });
  }

  /**
   * Calculate the exact packet size for a video frame
   *
   * @param payload - Encoded video data
   * @param options - Packaging options
   * @returns Exact size in bytes needed for the LOC packet
   */
  calculateVideoPacketSize(payload: Uint8Array, options: LOCVideoOptions): number {
    let size = 1; // Header byte
    size += varintEncodedLength(this.videoSequence);

    // Timestamp extension: type(1) + length_varint + data_varint(up to 8)
    if (options.captureTimestamp !== undefined) {
      const timestampMicros = BigInt(Math.floor(options.captureTimestamp * 1000));
      const tsLen = varintBigIntEncodedLength(timestampMicros);
      size += 1 + varintEncodedLength(tsLen) + tsLen;
    }

    // Frame marking extension: type(1) + length_varint(1) + data(1)
    if (options.frameMarking) {
      size += 1 + 1 + 1; // type + length(1) + marking byte
    }

    // Codec description extension: type(1) + length_varint + data
    if (options.codecDescription) {
      size += 1 + varintEncodedLength(options.codecDescription.byteLength) + options.codecDescription.byteLength;
    }

    // Payload length + payload
    size += varintEncodedLength(payload.byteLength);
    size += payload.byteLength;

    return size;
  }

  /**
   * Calculate the exact packet size for an audio frame
   *
   * @param payload - Encoded audio data
   * @param options - Packaging options
   * @returns Exact size in bytes needed for the LOC packet
   */
  calculateAudioPacketSize(payload: Uint8Array, options: LOCAudioOptions = {}): number {
    let size = 1; // Header byte
    size += varintEncodedLength(this.audioSequence);

    // Timestamp extension
    if (options.captureTimestamp !== undefined) {
      const timestampMicros = BigInt(Math.floor(options.captureTimestamp * 1000));
      const tsLen = varintBigIntEncodedLength(timestampMicros);
      size += 1 + varintEncodedLength(tsLen) + tsLen;
    }

    // Audio level extension: type(1) + length(1=varint for 1) + data(1)
    if (options.audioLevel !== undefined) {
      size += 1 + 1 + 1;
    }

    // Payload length + payload
    size += varintEncodedLength(payload.byteLength);
    size += payload.byteLength;

    return size;
  }

  /**
   * Package a video frame directly into a buffer
   *
   * @param buffer - Target buffer (must be large enough)
   * @param payload - Encoded video data
   * @param options - Packaging options
   * @returns Number of bytes written
   */
  packageVideoInto(buffer: Uint8Array, payload: Uint8Array, options: LOCVideoOptions): number {
    let offset = 0;

    // Count extensions for header byte
    let extensionCount = 0;
    if (options.captureTimestamp !== undefined) extensionCount++;
    if (options.frameMarking) extensionCount++;
    if (options.codecDescription) extensionCount++;

    // Header byte: MKKK EEEE
    // M=0 (video), K=keyframe, EEEE=extension count
    const headerByte = (options.isKeyframe ? 0x40 : 0) | (extensionCount & 0x0f);
    buffer[offset++] = headerByte;

    // Sequence number
    offset += writeVarintAt(buffer, offset, this.videoSequence++);

    // Extensions
    if (options.captureTimestamp !== undefined) {
      const timestampMicros = BigInt(Math.floor(options.captureTimestamp * 1000));
      const tsLen = varintBigIntEncodedLength(timestampMicros);

      buffer[offset++] = LOCExtensionType.CAPTURE_TIMESTAMP;
      offset += writeVarintAt(buffer, offset, tsLen);
      offset += writeVarintBigIntAt(buffer, offset, timestampMicros);
    }

    if (options.frameMarking) {
      const m = options.frameMarking;
      const markingByte =
        ((m.temporalId & 0x07) << 5) |
        ((m.spatialId & 0x03) << 3) |
        (m.baseLayer ? 0x04 : 0) |
        (m.discardable ? 0x02 : 0) |
        (m.endOfFrame ? 0x01 : 0);

      buffer[offset++] = LOCExtensionType.VIDEO_FRAME_MARKING;
      buffer[offset++] = 1; // length = 1 (varint encoded)
      buffer[offset++] = markingByte;
    }

    if (options.codecDescription) {
      buffer[offset++] = LOCExtensionType.CODEC_DATA;
      offset += writeVarintAt(buffer, offset, options.codecDescription.byteLength);
      buffer.set(options.codecDescription, offset);
      offset += options.codecDescription.byteLength;
    }

    // Payload length
    offset += writeVarintAt(buffer, offset, payload.byteLength);

    // Payload (direct copy)
    buffer.set(payload, offset);
    offset += payload.byteLength;

    log.trace('Packed LOC video', {
      isKeyframe: options.isKeyframe,
      sequence: this.videoSequence - 1,
      extensions: extensionCount,
      payloadSize: payload.byteLength,
      totalSize: offset,
    });

    return offset;
  }

  /**
   * Package an audio frame directly into a buffer
   *
   * @param buffer - Target buffer (must be large enough)
   * @param payload - Encoded audio data
   * @param options - Packaging options
   * @returns Number of bytes written
   */
  packageAudioInto(buffer: Uint8Array, payload: Uint8Array, options: LOCAudioOptions = {}): number {
    let offset = 0;

    // Count extensions
    let extensionCount = 0;
    if (options.captureTimestamp !== undefined) extensionCount++;
    if (options.audioLevel !== undefined) extensionCount++;

    // Header byte: MKKK EEEE
    // M=1 (audio), K=1 (opus always keyframe), EEEE=extension count
    const headerByte = 0x80 | 0x40 | (extensionCount & 0x0f);
    buffer[offset++] = headerByte;

    // Sequence number
    offset += writeVarintAt(buffer, offset, this.audioSequence++);

    // Extensions
    if (options.captureTimestamp !== undefined) {
      const timestampMicros = BigInt(Math.floor(options.captureTimestamp * 1000));
      const tsLen = varintBigIntEncodedLength(timestampMicros);

      buffer[offset++] = LOCExtensionType.CAPTURE_TIMESTAMP;
      offset += writeVarintAt(buffer, offset, tsLen);
      offset += writeVarintBigIntAt(buffer, offset, timestampMicros);
    }

    if (options.audioLevel !== undefined) {
      const levelByte = (options.voiceActivity ? 0x80 : 0) | (options.audioLevel & 0x7f);
      buffer[offset++] = LOCExtensionType.AUDIO_LEVEL;
      buffer[offset++] = 1; // length = 1
      buffer[offset++] = levelByte;
    }

    // Payload length
    offset += writeVarintAt(buffer, offset, payload.byteLength);

    // Payload
    buffer.set(payload, offset);
    offset += payload.byteLength;

    log.trace('Packed LOC audio', {
      sequence: this.audioSequence - 1,
      extensions: extensionCount,
      payloadSize: payload.byteLength,
      totalSize: offset,
    });

    return offset;
  }

  /**
   * Package a video frame
   *
   * @param payload - Encoded video data
   * @param options - Packaging options
   * @returns LOC-formatted packet (view into outputBuffer if provided)
   *
   * @remarks
   * When `outputBuffer` is provided, returns a view into that buffer (zero-copy).
   * When not provided, uses internal buffer and returns a copy.
   *
   * For maximum performance with buffer pooling:
   * ```typescript
   * const size = packager.calculateVideoPacketSize(payload, options);
   * const buffer = pool.acquire(size);
   * const packet = packager.packageVideo(payload, { ...options, outputBuffer: buffer });
   * await send(packet);
   * pool.release(buffer);
   * ```
   */
  packageVideo(payload: Uint8Array, options: LOCVideoOptions): Uint8Array {
    if (options.outputBuffer) {
      // Zero-copy path: write directly to provided buffer
      const bytesWritten = this.packageVideoInto(options.outputBuffer, payload, options);
      return options.outputBuffer.subarray(0, bytesWritten);
    }

    // Allocation path: ensure internal buffer is large enough
    const requiredSize = this.calculateVideoPacketSize(payload, options);
    if (requiredSize > this.internalBuffer.byteLength) {
      // Grow buffer (2x or required, whichever is larger)
      this.internalBuffer = new Uint8Array(Math.max(requiredSize, this.internalBuffer.byteLength * 2));
    }

    const bytesWritten = this.packageVideoInto(this.internalBuffer, payload, options);

    // Return a copy (caller owns the returned buffer)
    return this.internalBuffer.slice(0, bytesWritten);
  }

  /**
   * Package an audio frame
   *
   * @param payload - Encoded audio data
   * @param options - Packaging options
   * @returns LOC-formatted packet (view into outputBuffer if provided)
   */
  packageAudio(payload: Uint8Array, options: LOCAudioOptions = {}): Uint8Array {
    if (options.outputBuffer) {
      // Zero-copy path
      const bytesWritten = this.packageAudioInto(options.outputBuffer, payload, options);
      return options.outputBuffer.subarray(0, bytesWritten);
    }

    // Allocation path
    const requiredSize = this.calculateAudioPacketSize(payload, options);
    if (requiredSize > this.internalBuffer.byteLength) {
      this.internalBuffer = new Uint8Array(Math.max(requiredSize, this.internalBuffer.byteLength * 2));
    }

    const bytesWritten = this.packageAudioInto(this.internalBuffer, payload, options);
    return this.internalBuffer.slice(0, bytesWritten);
  }

  /**
   * Get current video sequence number (for debugging/stats)
   */
  get currentVideoSequence(): number {
    return this.videoSequence;
  }

  /**
   * Get current audio sequence number (for debugging/stats)
   */
  get currentAudioSequence(): number {
    return this.audioSequence;
  }

  /**
   * Reset sequence counters
   */
  reset(): void {
    this.videoSequence = 0;
    this.audioSequence = 0;
    log.debug('LOCPackager reset');
  }
}

// ============================================================================
// LOC Unpackager
// ============================================================================

/**
 * LOC Unpackager
 *
 * @remarks
 * Unpackages LOC-formatted packets back into media frames.
 * Extracts header information, extensions, and payload.
 *
 * @example
 * ```typescript
 * const unpackager = new LOCUnpackager();
 *
 * const frame = unpackager.unpackage(locPacket);
 *
 * if (frame.header.mediaType === MediaType.VIDEO) {
 *   decodeVideo(frame.payload, frame.header.isKeyframe);
 * } else {
 *   decodeAudio(frame.payload);
 * }
 * ```
 */
export class LOCUnpackager {
  /**
   * Create a new LOCUnpackager
   */
  constructor() {
    log.debug('LOCUnpackager created');
  }

  /**
   * Unpackage a LOC packet
   *
   * @param packet - LOC-formatted packet
   * @returns Unpacked frame with header, extensions, and payload
   *
   * @remarks
   * This method handles two LOC format variants:
   * 1. Standard LOC with payload length field
   * 2. LOC without payload length (for datagram delivery)
   */
  unpackage(packet: Uint8Array): LOCFrame {
    const reader = new BufferReader(packet);

    // Header byte
    const headerByte = reader.readByte();
    const mediaType = (headerByte >> 7) & 0x01;
    const isKeyframe = (headerByte & 0x40) !== 0;
    const extensionCount = headerByte & 0x0f;

    // Sequence number
    const sequenceNumber = reader.readVarIntNumber();

    // Parse extensions
    const extensions: LOCExtension[] = [];
    let captureTimestamp: number | undefined;
    let frameMarking: VideoFrameMarking | undefined;
    let audioLevel: { level: number; voiceActivity: boolean } | undefined;
    let codecDescription: Uint8Array | undefined;

    for (let i = 0; i < extensionCount; i++) {
      const type = reader.readByte() as LOCExtensionType;
      const length = reader.readVarIntNumber();
      const data = reader.readBytes(length);

      extensions.push({ type, data });

      // Parse known extensions
      switch (type) {
        case LOCExtensionType.CAPTURE_TIMESTAMP: {
          const extReader = new BufferReader(data);
          captureTimestamp = Number(extReader.readVarInt()) / 1000;
          break;
        }
        case LOCExtensionType.VIDEO_FRAME_MARKING: {
          const byte = data[0];
          frameMarking = {
            temporalId: (byte >> 5) & 0x07,
            spatialId: (byte >> 3) & 0x03,
            baseLayer: (byte & 0x04) !== 0,
            discardable: (byte & 0x02) !== 0,
            endOfFrame: (byte & 0x01) !== 0,
          };
          break;
        }
        case LOCExtensionType.AUDIO_LEVEL: {
          const byte = data[0];
          audioLevel = {
            voiceActivity: (byte & 0x80) !== 0,
            level: byte & 0x7f,
          };
          break;
        }
        case LOCExtensionType.CODEC_DATA:
          codecDescription = data;
          break;
      }
    }

    // Read payload - handle both variants (with/without length field)
    let payload: Uint8Array;
    const positionBeforePayloadLength = reader.offset;

    try {
      const payloadLengthBigInt = reader.readVarInt();

      if (
        payloadLengthBigInt <= BigInt(reader.remaining) &&
        payloadLengthBigInt <= BigInt(Number.MAX_SAFE_INTEGER)
      ) {
        const payloadLength = Number(payloadLengthBigInt);
        payload = reader.readBytes(payloadLength);
      } else {
        throw new Error('fallback to remaining bytes');
      }
    } catch {
      // LOC variant without length field (datagram delivery)
      payload = packet.slice(positionBeforePayloadLength);
      log.debug('Using remaining bytes as LOC payload', {
        payloadSize: payload.length,
        position: positionBeforePayloadLength,
      });
    }

    const header: LOCHeader = {
      mediaType,
      isKeyframe,
      sequenceNumber,
      extensions,
    };

    log.trace('Unpacked LOC', {
      mediaType,
      isKeyframe,
      sequence: sequenceNumber,
      extensions: extensionCount,
      payloadSize: payload.length,
    });

    return {
      header,
      payload,
      captureTimestamp,
      frameMarking,
      audioLevel,
      codecDescription,
    };
  }

  /**
   * Quick check if packet is a video keyframe (no full parse)
   *
   * @param packet - LOC packet
   * @returns True if packet is a video keyframe
   */
  isVideoKeyframe(packet: Uint8Array): boolean {
    if (packet.length < 1) return false;
    const headerByte = packet[0];
    const mediaType = (headerByte >> 7) & 0x01;
    const isKeyframe = (headerByte & 0x40) !== 0;
    return mediaType === MediaType.VIDEO && isKeyframe;
  }

  /**
   * Quick check for media type (no full parse)
   *
   * @param packet - LOC packet
   * @returns Media type
   */
  getMediaType(packet: Uint8Array): MediaType {
    if (packet.length < 1) return MediaType.VIDEO;
    return (packet[0] >> 7) & 0x01;
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Create a simple LOC packet without extensions (minimal overhead)
 *
 * @param mediaType - Media type
 * @param isKeyframe - Whether this is a keyframe
 * @param sequenceNumber - Sequence number
 * @param payload - Media payload
 * @param outputBuffer - Optional pre-allocated buffer
 * @returns LOC packet
 */
export function createSimpleLOCPacket(
  mediaType: MediaType,
  isKeyframe: boolean,
  sequenceNumber: number,
  payload: Uint8Array,
  outputBuffer?: Uint8Array
): Uint8Array {
  // Calculate size: header(1) + seq(varint) + payloadLen(varint) + payload
  const seqLen = varintEncodedLength(sequenceNumber);
  const payloadLenLen = varintEncodedLength(payload.byteLength);
  const totalSize = 1 + seqLen + payloadLenLen + payload.byteLength;

  const buffer = outputBuffer && outputBuffer.byteLength >= totalSize
    ? outputBuffer
    : new Uint8Array(totalSize);

  let offset = 0;

  // Header byte (no extensions)
  let headerByte = (mediaType & 0x01) << 7;
  if (isKeyframe) headerByte |= 0x40;
  buffer[offset++] = headerByte;

  // Sequence
  offset += writeVarintAt(buffer, offset, sequenceNumber);

  // Payload length
  offset += writeVarintAt(buffer, offset, payload.byteLength);

  // Payload
  buffer.set(payload, offset);
  offset += payload.byteLength;

  return outputBuffer ? buffer.subarray(0, offset) : buffer;
}

/**
 * Calculate size for a simple LOC packet (no extensions)
 */
export function calculateSimpleLOCPacketSize(sequenceNumber: number, payloadLength: number): number {
  return 1 + varintEncodedLength(sequenceNumber) + varintEncodedLength(payloadLength) + payloadLength;
}
