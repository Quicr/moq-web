// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview LOC Container Format Implementation
 *
 * Implements the LOC (Low Overhead Container) format as specified in
 * draft-ietf-moq-loc. LOC provides minimal overhead packaging of media
 * frames for MOQT transmission.
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
 * // Unpackage
 * const unpackager = new LOCUnpackager();
 * const frame = unpackager.unpackage(packet);
 * ```
 */

import { Logger, BufferReader, BufferWriter } from '@web-moq/core';

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

/**
 * LOC Packager
 *
 * @remarks
 * Packages encoded media frames into LOC format for MOQT transmission.
 * LOC provides minimal overhead while supporting optional extensions
 * for timing, layering, and codec information.
 *
 * @example
 * ```typescript
 * const packager = new LOCPackager();
 *
 * // Package video keyframe
 * const videoPacket = packager.packageVideo(videoData, {
 *   isKeyframe: true,
 *   captureTimestamp: performance.now(),
 *   codecDescription: codecDescription,
 * });
 *
 * // Package audio frame
 * const audioPacket = packager.packageAudio(audioData, {
 *   captureTimestamp: performance.now(),
 *   audioLevel: 64,
 *   voiceActivity: true,
 * });
 * ```
 */
export class LOCPackager {
  /** Video sequence counter */
  private videoSequence = 0;
  /** Audio sequence counter */
  private audioSequence = 0;

  /**
   * Create a new LOCPackager
   */
  constructor() {
    log.debug('LOCPackager created');
  }

  /**
   * Package a video frame
   *
   * @param payload - Encoded video data
   * @param options - Packaging options
   * @returns LOC-formatted packet
   *
   * @example
   * ```typescript
   * const packet = packager.packageVideo(h264Data, {
   *   isKeyframe: true,
   *   captureTimestamp: Date.now(),
   * });
   * ```
   */
  packageVideo(payload: Uint8Array, options: LOCVideoOptions): Uint8Array {
    const extensions: LOCExtension[] = [];

    // Add capture timestamp extension
    if (options.captureTimestamp !== undefined) {
      extensions.push(this.createTimestampExtension(options.captureTimestamp));
    }

    // Add video frame marking extension
    if (options.frameMarking) {
      extensions.push(this.createFrameMarkingExtension(options.frameMarking));
    }

    // Add codec description extension
    if (options.codecDescription) {
      extensions.push({
        type: LOCExtensionType.CODEC_DATA,
        data: options.codecDescription,
      });
    }

    const header: LOCHeader = {
      mediaType: MediaType.VIDEO,
      isKeyframe: options.isKeyframe,
      sequenceNumber: this.videoSequence++,
      extensions,
    };

    return this.encodePacket(header, payload);
  }

  /**
   * Package an audio frame
   *
   * @param payload - Encoded audio data
   * @param options - Packaging options
   * @returns LOC-formatted packet
   *
   * @example
   * ```typescript
   * const packet = packager.packageAudio(opusData, {
   *   captureTimestamp: Date.now(),
   *   audioLevel: 80,
   * });
   * ```
   */
  packageAudio(payload: Uint8Array, options: LOCAudioOptions = {}): Uint8Array {
    const extensions: LOCExtension[] = [];

    // Add capture timestamp extension
    if (options.captureTimestamp !== undefined) {
      extensions.push(this.createTimestampExtension(options.captureTimestamp));
    }

    // Add audio level extension
    if (options.audioLevel !== undefined) {
      extensions.push(this.createAudioLevelExtension(
        options.audioLevel,
        options.voiceActivity ?? false
      ));
    }

    const header: LOCHeader = {
      mediaType: MediaType.AUDIO,
      isKeyframe: true, // Opus frames are always key frames
      sequenceNumber: this.audioSequence++,
      extensions,
    };

    return this.encodePacket(header, payload);
  }

  /**
   * Create a capture timestamp extension
   */
  private createTimestampExtension(timestamp: number): LOCExtension {
    const writer = new BufferWriter();
    // 64-bit timestamp in microseconds
    writer.writeVarInt(Math.floor(timestamp * 1000));
    return {
      type: LOCExtensionType.CAPTURE_TIMESTAMP,
      data: writer.toUint8Array(),
    };
  }

  /**
   * Create a video frame marking extension
   */
  private createFrameMarkingExtension(marking: VideoFrameMarking): LOCExtension {
    // Pack into single byte: TTTSSBDE
    // TTT = temporalId (3 bits), SS = spatialId (2 bits),
    // B = baseLayer, D = discardable, E = endOfFrame
    let byte = 0;
    byte |= (marking.temporalId & 0x07) << 5;
    byte |= (marking.spatialId & 0x03) << 3;
    byte |= marking.baseLayer ? 0x04 : 0;
    byte |= marking.discardable ? 0x02 : 0;
    byte |= marking.endOfFrame ? 0x01 : 0;

    return {
      type: LOCExtensionType.VIDEO_FRAME_MARKING,
      data: new Uint8Array([byte]),
    };
  }

  /**
   * Create an audio level extension
   */
  private createAudioLevelExtension(
    level: number,
    voiceActivity: boolean
  ): LOCExtension {
    // RFC 6464 format: V + level (7 bits)
    const byte = (voiceActivity ? 0x80 : 0) | (level & 0x7F);
    return {
      type: LOCExtensionType.AUDIO_LEVEL,
      data: new Uint8Array([byte]),
    };
  }

  /**
   * Encode a LOC packet
   */
  private encodePacket(header: LOCHeader, payload: Uint8Array): Uint8Array {
    const writer = new BufferWriter();

    // Header byte: MKKK EEEE
    // M = media type (0=video, 1=audio)
    // KKK = keyframe + reserved (1 bit keyframe, 2 bits reserved)
    // EEEE = extension count (4 bits)
    let headerByte = 0;
    headerByte |= (header.mediaType & 0x01) << 7;
    headerByte |= header.isKeyframe ? 0x40 : 0;
    headerByte |= Math.min(header.extensions.length, 15);

    writer.writeByte(headerByte);

    // Sequence number
    writer.writeVarInt(header.sequenceNumber);

    // Extensions
    for (const ext of header.extensions) {
      writer.writeByte(ext.type);
      writer.writeVarInt(ext.data.length);
      writer.writeBytes(ext.data);
    }

    // Payload length
    writer.writeVarInt(payload.length);

    // Payload
    writer.writeBytes(payload);

    const packet = writer.toUint8Array();

    log.trace('Packed LOC', {
      mediaType: header.mediaType,
      isKeyframe: header.isKeyframe,
      sequence: header.sequenceNumber,
      extensions: header.extensions.length,
      payloadSize: payload.length,
      totalSize: packet.length,
    });

    return packet;
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
   * 2. LOC without payload length (for datagram delivery where object boundaries are implicit)
   *
   * When the payload length field is missing or invalid (exceeds remaining bytes),
   * the remaining bytes after header and extensions are used as the payload.
   * This is common in datagram delivery where the MOQT layer already defines object boundaries.
   *
   * @example
   * ```typescript
   * const frame = unpackager.unpackage(packet);
   *
   * console.log('Media type:', frame.header.mediaType);
   * console.log('Is keyframe:', frame.header.isKeyframe);
   * console.log('Payload size:', frame.payload.length);
   *
   * if (frame.captureTimestamp) {
   *   console.log('Capture delay:', Date.now() - frame.captureTimestamp);
   * }
   * ```
   */
  unpackage(packet: Uint8Array): LOCFrame {
    const reader = new BufferReader(packet);

    // Header byte
    const headerByte = reader.readByte();
    const mediaType = (headerByte >> 7) & 0x01;
    const isKeyframe = (headerByte & 0x40) !== 0;
    const extensionCount = headerByte & 0x0F;

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
            level: byte & 0x7F,
          };
          break;
        }
        case LOCExtensionType.CODEC_DATA:
          codecDescription = data;
          break;
      }
    }

    // Try to read payload length - some LOC variants omit this field for datagram delivery
    // where the object boundary is already defined by the transport layer
    let payload: Uint8Array;
    const positionBeforePayloadLength = reader.offset;

    try {
      // Payload length - read as bigint first for validation
      const payloadLengthBigInt = reader.readVarInt();

      // Check if payload length is reasonable
      // In datagram delivery, remaining bytes after header should equal the payload
      // Allow small tolerance for padding or trailing bytes
      if (payloadLengthBigInt <= BigInt(reader.remaining) &&
          payloadLengthBigInt <= BigInt(Number.MAX_SAFE_INTEGER)) {
        const payloadLength = Number(payloadLengthBigInt);
        payload = reader.readBytes(payloadLength);
      } else {
        // Payload length doesn't match remaining bytes - likely LOC variant without length field
        // Rewind and use remaining bytes as payload
        log.debug('LOC payload length mismatch, using remaining bytes', {
          payloadLengthBigInt: payloadLengthBigInt.toString(),
          remaining: reader.remaining,
        });
        // Reset position to before we read the invalid payload length
        // and read all remaining bytes as payload
        throw new Error('fallback to remaining bytes');
      }
    } catch {
      // Failed to read valid payload length - assume LOC without length field
      // This is common in datagram delivery where object boundaries are implicit
      // Create a new reader from the position where payload should start
      const remainingFromPosition = packet.slice(positionBeforePayloadLength);
      payload = remainingFromPosition;

      log.debug('Using remaining bytes as LOC payload (no length field)', {
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
   * Quick check if packet is a video keyframe
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
   * Quick check for media type
   *
   * @param packet - LOC packet
   * @returns Media type
   */
  getMediaType(packet: Uint8Array): MediaType {
    if (packet.length < 1) return MediaType.VIDEO;
    return (packet[0] >> 7) & 0x01;
  }
}

/**
 * Create a simple LOC packet without extensions (minimal overhead)
 *
 * @param mediaType - Media type
 * @param isKeyframe - Whether this is a keyframe
 * @param sequenceNumber - Sequence number
 * @param payload - Media payload
 * @returns LOC packet
 */
export function createSimpleLOCPacket(
  mediaType: MediaType,
  isKeyframe: boolean,
  sequenceNumber: number,
  payload: Uint8Array
): Uint8Array {
  const writer = new BufferWriter();

  // Header byte (no extensions)
  let headerByte = 0;
  headerByte |= (mediaType & 0x01) << 7;
  headerByte |= isKeyframe ? 0x40 : 0;

  writer.writeByte(headerByte);
  writer.writeVarInt(sequenceNumber);
  writer.writeVarInt(payload.length);
  writer.writeBytes(payload);

  return writer.toUint8Array();
}
