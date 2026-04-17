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
 * LOC extension types (standard)
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
 * QuicR extension types (fixed-size immutable extensions for quicr-mac interop)
 * @see docs/quicr-interop-report.md
 */
export enum QuicRExtensionType {
  /** Capture timestamp - 6 bytes, microseconds epoch */
  CAPTURE_TIMESTAMP = 0x02,
  /** Sequence number - 4 bytes */
  SEQUENCE_NUMBER = 0x04,
  /** Audio energy level - 6 bytes */
  ENERGY_LEVEL = 0x06,
  /** Participant ID - 8 bytes */
  PARTICIPANT_ID = 0x08,
  /** Voice activity detection - 12 bytes */
  VAD = 0x0c,
}

/**
 * Fixed sizes for QuicR extension types (in bytes)
 */
export const QUICR_EXTENSION_SIZES = {
  [QuicRExtensionType.CAPTURE_TIMESTAMP]: 6,
  [QuicRExtensionType.SEQUENCE_NUMBER]: 4,
  [QuicRExtensionType.ENERGY_LEVEL]: 6,
  [QuicRExtensionType.PARTICIPANT_ID]: 8,
  [QuicRExtensionType.VAD]: 12,
} as const;

/**
 * VAD extension data structure (12 bytes) for QuicR interop
 */
export interface VADData {
  /** Voice activity detected flag */
  voiceActivity: boolean;
  /** Speech probability (0-255) */
  speechProbability: number;
  /** Energy level in dB (-128 to +127, stored as unsigned 0-255) */
  energyLevel: number;
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
  /** Enable QuicR-Mac interop mode (fixed-size immutable extensions) */
  quicrInterop?: boolean;
  /** VAD data for QuicR interop mode */
  vadData?: VADData;
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
  /** Enable QuicR-Mac interop mode (fixed-size immutable extensions) */
  quicrInterop?: boolean;
  /** VAD data for QuicR interop mode */
  vadData?: VADData;
  /** Participant ID for QuicR interop mode (32-bit) */
  participantId?: number;
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
  /** VAD data (if present, QuicR interop) */
  vadData?: VADData;
  /** Participant ID (if present, QuicR interop) */
  participantId?: number;
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
// QuicR Interop Wire Format Helpers (Fixed-Size Extensions)
// ============================================================================

/**
 * Write a 6-byte timestamp (microseconds, big-endian) for QuicR interop
 */
function writeQuicRTimestamp6(buffer: Uint8Array, offset: number, timestampMs: number): number {
  const micros = BigInt(Math.floor(timestampMs * 1000));
  // Write 6 bytes big-endian (48 bits)
  buffer[offset] = Number((micros >> 40n) & 0xffn);
  buffer[offset + 1] = Number((micros >> 32n) & 0xffn);
  buffer[offset + 2] = Number((micros >> 24n) & 0xffn);
  buffer[offset + 3] = Number((micros >> 16n) & 0xffn);
  buffer[offset + 4] = Number((micros >> 8n) & 0xffn);
  buffer[offset + 5] = Number(micros & 0xffn);
  return 6;
}

/**
 * Read a 6-byte timestamp (microseconds, big-endian) -> milliseconds for QuicR interop
 */
function readQuicRTimestamp6(buffer: Uint8Array, offset: number): number {
  const micros =
    (BigInt(buffer[offset]) << 40n) |
    (BigInt(buffer[offset + 1]) << 32n) |
    (BigInt(buffer[offset + 2]) << 24n) |
    (BigInt(buffer[offset + 3]) << 16n) |
    (BigInt(buffer[offset + 4]) << 8n) |
    BigInt(buffer[offset + 5]);
  return Number(micros) / 1000;
}

/**
 * Write a 4-byte sequence number (big-endian) for QuicR interop
 */
function writeQuicRSequence4(buffer: Uint8Array, offset: number, seq: number): number {
  buffer[offset] = (seq >> 24) & 0xff;
  buffer[offset + 1] = (seq >> 16) & 0xff;
  buffer[offset + 2] = (seq >> 8) & 0xff;
  buffer[offset + 3] = seq & 0xff;
  return 4;
}

/**
 * Read a 4-byte sequence number (big-endian) for QuicR interop
 */
function readQuicRSequence4(buffer: Uint8Array, offset: number): number {
  return (
    (buffer[offset] << 24) |
    (buffer[offset + 1] << 16) |
    (buffer[offset + 2] << 8) |
    buffer[offset + 3]
  ) >>> 0;
}

/**
 * Write a 12-byte VAD extension for QuicR interop
 * Format: [voiceActivity(1)] [speechProbability(1)] [energyLevel(1)] [reserved(9)]
 */
function writeQuicRVAD12(buffer: Uint8Array, offset: number, vad: VADData): number {
  buffer[offset] = vad.voiceActivity ? 1 : 0;
  buffer[offset + 1] = vad.speechProbability & 0xff;
  // energyLevel is signed (-128 to +127), store as unsigned (0-255)
  buffer[offset + 2] = (vad.energyLevel + 128) & 0xff;
  // Reserved bytes (9 bytes, zero-filled)
  for (let i = 3; i < 12; i++) {
    buffer[offset + i] = 0;
  }
  return 12;
}

/**
 * Read a 12-byte VAD extension for QuicR interop
 */
function readQuicRVAD12(buffer: Uint8Array, offset: number): VADData {
  return {
    voiceActivity: buffer[offset] !== 0,
    speechProbability: buffer[offset + 1],
    energyLevel: buffer[offset + 2] - 128,
  };
}

/**
 * Write a 6-byte energy level extension for QuicR interop
 * Format: [flags(1)] [level(1)] [reserved(4)]
 */
function writeQuicREnergyLevel6(buffer: Uint8Array, offset: number, level: number, voiceActivity: boolean): number {
  buffer[offset] = voiceActivity ? 0x80 : 0x00;
  buffer[offset + 1] = level & 0x7f;
  // Reserved (4 bytes)
  buffer[offset + 2] = 0;
  buffer[offset + 3] = 0;
  buffer[offset + 4] = 0;
  buffer[offset + 5] = 0;
  return 6;
}

/**
 * Read a 6-byte energy level extension for QuicR interop
 */
function readQuicREnergyLevel6(buffer: Uint8Array, offset: number): { level: number; voiceActivity: boolean } {
  return {
    voiceActivity: (buffer[offset] & 0x80) !== 0,
    level: buffer[offset + 1] & 0x7f,
  };
}

/**
 * Write an 8-byte participant ID (big-endian) for QuicR interop
 */
function writeQuicRParticipantId8(buffer: Uint8Array, offset: number, id: number): number {
  // Write as 64-bit big-endian (upper 32 bits are 0 for 32-bit IDs)
  buffer[offset] = 0;
  buffer[offset + 1] = 0;
  buffer[offset + 2] = 0;
  buffer[offset + 3] = 0;
  buffer[offset + 4] = (id >> 24) & 0xff;
  buffer[offset + 5] = (id >> 16) & 0xff;
  buffer[offset + 6] = (id >> 8) & 0xff;
  buffer[offset + 7] = id & 0xff;
  return 8;
}

/**
 * Read an 8-byte participant ID (returns lower 32 bits) for QuicR interop
 */
function readQuicRParticipantId8(buffer: Uint8Array, offset: number): number {
  return (
    (buffer[offset + 4] << 24) |
    (buffer[offset + 5] << 16) |
    (buffer[offset + 6] << 8) |
    buffer[offset + 7]
  ) >>> 0;
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
  /** Participant ID for QuicR interop mode */
  private participantId: number;

  /**
   * Create a new LOCPackager
   *
   * @param initialBufferSize - Initial size for internal buffer (default: 256KB)
   * @param participantId - Participant ID for QuicR interop mode (default: 0)
   */
  constructor(initialBufferSize = 262144, participantId = 0) {
    this.internalBuffer = new Uint8Array(initialBufferSize);
    this.participantId = participantId;
    log.debug('LOCPackager created', { bufferSize: initialBufferSize, participantId });
  }

  /**
   * Set participant ID for QuicR interop mode
   */
  setParticipantId(id: number): void {
    this.participantId = id;
  }

  /**
   * Calculate the exact packet size for a video frame
   *
   * @param payload - Encoded video data
   * @param options - Packaging options
   * @returns Exact size in bytes needed for the LOC packet
   */
  calculateVideoPacketSize(payload: Uint8Array, options: LOCVideoOptions): number {
    // QuicR interop mode uses fixed-size extensions
    if (options.quicrInterop) {
      return this.calculateQuicRVideoPacketSize(payload, options);
    }

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
   * Calculate QuicR video packet size (fixed-size extensions)
   */
  private calculateQuicRVideoPacketSize(payload: Uint8Array, options: LOCVideoOptions): number {
    let size = 1; // Header byte (no sequence in header for QuicR)

    // CaptureTimestamp (0x02): type(1) + length(1) + data(6)
    if (options.captureTimestamp !== undefined) {
      size += 1 + 1 + 6;
    }

    // SequenceNumber (0x04): type(1) + length(1) + data(4) - always present
    size += 1 + 1 + 4;

    // VAD (0x0C): type(1) + length(1) + data(12)
    if (options.vadData) {
      size += 1 + 1 + 12;
    }

    // Codec description: type(1) + length_varint + data (only on keyframes)
    if (options.codecDescription && options.isKeyframe) {
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
    // QuicR interop mode uses fixed-size extensions
    if (options.quicrInterop) {
      return this.calculateQuicRAudioPacketSize(payload, options);
    }

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
   * Calculate QuicR audio packet size (fixed-size extensions)
   */
  private calculateQuicRAudioPacketSize(payload: Uint8Array, options: LOCAudioOptions): number {
    let size = 1; // Header byte (no sequence in header for QuicR)

    // CaptureTimestamp (0x02): type(1) + length(1) + data(6)
    if (options.captureTimestamp !== undefined) {
      size += 1 + 1 + 6;
    }

    // SequenceNumber (0x04): type(1) + length(1) + data(4) - always present
    size += 1 + 1 + 4;

    // VAD (0x0C): type(1) + length(1) + data(12)
    if (options.vadData) {
      size += 1 + 1 + 12;
    }

    // EnergyLevel (0x06): type(1) + length(1) + data(6)
    if (options.audioLevel !== undefined) {
      size += 1 + 1 + 6;
    }

    // ParticipantID (0x08): type(1) + length(1) + data(8) - always present for audio
    size += 1 + 1 + 8;

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
    // QuicR interop mode uses fixed-size extensions
    if (options.quicrInterop) {
      return this.packageQuicRVideoInto(buffer, payload, options);
    }

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
   * Package a video frame in QuicR interop format (fixed-size extensions)
   */
  private packageQuicRVideoInto(buffer: Uint8Array, payload: Uint8Array, options: LOCVideoOptions): number {
    let offset = 0;

    // Count extensions
    let extensionCount = 0;
    if (options.captureTimestamp !== undefined) extensionCount++;
    extensionCount++; // SequenceNumber always present
    if (options.vadData) extensionCount++;
    if (options.codecDescription && options.isKeyframe) extensionCount++;

    // Header byte: MKKK EEEE (M=0 for video, K=keyframe, EEEE=extension count)
    // No sequence number in header for QuicR mode
    const headerByte = (options.isKeyframe ? 0x40 : 0) | (extensionCount & 0x0f);
    buffer[offset++] = headerByte;

    // Extension: CaptureTimestamp (0x02, 6 bytes)
    if (options.captureTimestamp !== undefined) {
      buffer[offset++] = QuicRExtensionType.CAPTURE_TIMESTAMP;
      buffer[offset++] = 6; // Fixed length
      offset += writeQuicRTimestamp6(buffer, offset, options.captureTimestamp);
    }

    // Extension: SequenceNumber (0x04, 4 bytes) - always present
    buffer[offset++] = QuicRExtensionType.SEQUENCE_NUMBER;
    buffer[offset++] = 4; // Fixed length
    offset += writeQuicRSequence4(buffer, offset, this.videoSequence++);

    // Extension: VAD (0x0C, 12 bytes)
    if (options.vadData) {
      buffer[offset++] = QuicRExtensionType.VAD;
      buffer[offset++] = 12; // Fixed length
      offset += writeQuicRVAD12(buffer, offset, options.vadData);
    }

    // Extension: Codec description (variable length, only on keyframes)
    if (options.codecDescription && options.isKeyframe) {
      buffer[offset++] = LOCExtensionType.CODEC_DATA;
      offset += writeVarintAt(buffer, offset, options.codecDescription.byteLength);
      buffer.set(options.codecDescription, offset);
      offset += options.codecDescription.byteLength;
    }

    // Payload length
    offset += writeVarintAt(buffer, offset, payload.byteLength);

    // Payload
    buffer.set(payload, offset);
    offset += payload.byteLength;

    log.trace('Packed QuicR video', {
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
    // QuicR interop mode uses fixed-size extensions
    if (options.quicrInterop) {
      return this.packageQuicRAudioInto(buffer, payload, options);
    }

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
   * Package an audio frame in QuicR interop format (fixed-size extensions)
   */
  private packageQuicRAudioInto(buffer: Uint8Array, payload: Uint8Array, options: LOCAudioOptions): number {
    let offset = 0;

    // Count extensions
    let extensionCount = 0;
    if (options.captureTimestamp !== undefined) extensionCount++;
    extensionCount++; // SequenceNumber always present
    if (options.vadData) extensionCount++;
    if (options.audioLevel !== undefined) extensionCount++;
    extensionCount++; // ParticipantID always present for audio

    // Header byte: MKKK EEEE (M=1 for audio, K=1 opus always keyframe)
    const headerByte = 0x80 | 0x40 | (extensionCount & 0x0f);
    buffer[offset++] = headerByte;

    // Extension: CaptureTimestamp (0x02, 6 bytes)
    if (options.captureTimestamp !== undefined) {
      buffer[offset++] = QuicRExtensionType.CAPTURE_TIMESTAMP;
      buffer[offset++] = 6;
      offset += writeQuicRTimestamp6(buffer, offset, options.captureTimestamp);
    }

    // Extension: SequenceNumber (0x04, 4 bytes) - always present
    buffer[offset++] = QuicRExtensionType.SEQUENCE_NUMBER;
    buffer[offset++] = 4;
    offset += writeQuicRSequence4(buffer, offset, this.audioSequence++);

    // Extension: VAD (0x0C, 12 bytes)
    if (options.vadData) {
      buffer[offset++] = QuicRExtensionType.VAD;
      buffer[offset++] = 12;
      offset += writeQuicRVAD12(buffer, offset, options.vadData);
    }

    // Extension: EnergyLevel (0x06, 6 bytes)
    if (options.audioLevel !== undefined) {
      buffer[offset++] = QuicRExtensionType.ENERGY_LEVEL;
      buffer[offset++] = 6;
      offset += writeQuicREnergyLevel6(buffer, offset, options.audioLevel, options.voiceActivity ?? false);
    }

    // Extension: ParticipantID (0x08, 8 bytes) - always present for audio
    buffer[offset++] = QuicRExtensionType.PARTICIPANT_ID;
    buffer[offset++] = 8;
    offset += writeQuicRParticipantId8(buffer, offset, options.participantId ?? this.participantId);

    // Payload length
    offset += writeVarintAt(buffer, offset, payload.byteLength);

    // Payload
    buffer.set(payload, offset);
    offset += payload.byteLength;

    log.trace('Packed QuicR audio', {
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
   * @param quicrInterop - Whether to parse in QuicR interop mode (no sequence in header)
   * @returns Unpacked frame with header, extensions, and payload
   *
   * @remarks
   * This method handles multiple LOC format variants:
   * 1. Standard LOC with payload length field
   * 2. LOC without payload length (for datagram delivery)
   * 3. QuicR interop mode with fixed-size extensions
   */
  unpackage(packet: Uint8Array, quicrInterop = false): LOCFrame {
    const reader = new BufferReader(packet);

    // Header byte
    const headerByte = reader.readByte();
    const mediaType = (headerByte >> 7) & 0x01;
    const isKeyframe = (headerByte & 0x40) !== 0;
    const extensionCount = headerByte & 0x0f;

    // Sequence number (only in standard mode, not QuicR interop)
    let sequenceNumber = 0;
    if (!quicrInterop) {
      sequenceNumber = reader.readVarIntNumber();
    }

    // Parse extensions
    const extensions: LOCExtension[] = [];
    let captureTimestamp: number | undefined;
    let frameMarking: VideoFrameMarking | undefined;
    let audioLevel: { level: number; voiceActivity: boolean } | undefined;
    let codecDescription: Uint8Array | undefined;
    let vadData: VADData | undefined;
    let participantId: number | undefined;

    for (let i = 0; i < extensionCount; i++) {
      const type = reader.readByte();
      // In QuicR mode, length is always a single byte; in standard mode it's VarInt
      const length = quicrInterop ? reader.readByte() : reader.readVarIntNumber();
      const data = reader.readBytes(length);

      extensions.push({ type, data });

      // Parse known extensions based on mode
      // Note: QuicR and standard LOC share some extension type values (e.g., 0x02)
      // so we need to check the mode to parse correctly
      if (quicrInterop) {
        // QuicR interop mode - fixed-size extensions
        switch (type) {
          case QuicRExtensionType.CAPTURE_TIMESTAMP:
            // QuicR uses fixed 6-byte timestamp
            captureTimestamp = readQuicRTimestamp6(data, 0);
            break;
          case QuicRExtensionType.SEQUENCE_NUMBER:
            sequenceNumber = readQuicRSequence4(data, 0);
            break;
          case QuicRExtensionType.VAD:
            vadData = readQuicRVAD12(data, 0);
            break;
          case QuicRExtensionType.ENERGY_LEVEL: {
            const parsed = readQuicREnergyLevel6(data, 0);
            audioLevel = { level: parsed.level, voiceActivity: parsed.voiceActivity };
            break;
          }
          case QuicRExtensionType.PARTICIPANT_ID:
            participantId = readQuicRParticipantId8(data, 0);
            break;
          case LOCExtensionType.CODEC_DATA:
            // Codec data uses same type in both modes
            codecDescription = data;
            break;
        }
      } else {
        // Standard LOC mode - variable-length extensions
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
      vadData,
      participantId,
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
