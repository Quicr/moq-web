// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Draft-18 Data Stream Encoding/Decoding
 *
 * Handles encoding/decoding for:
 * - SUBGROUP_HEADER (unidirectional streams, 0b0XX1XXXX format)
 * - FETCH_HEADER (unidirectional streams, 0x05)
 * - Object headers within streams
 * - Object datagrams
 */

import { Logger } from '../utils/logger.js';
import { MOQTVarInt } from './moqt-varint.js';
import { Draft18BufferWriter, Draft18BufferReader } from './protocol-codec.js';
import {
  StreamTypeDraft18,
  type SubgroupHeaderDraft18,
  type ObjectHeaderDraft18,
  type ObjectDatagramDraft18,
  type FetchObjectDraft18,
} from '../messages/types.js';

const log = Logger.create('moqt:core:draft18-stream');

/**
 * Subgroup stream type bit flags (in 0b0XX1XXXX format)
 * Per draft-18 spec:
 *   Bit 0 (0x01): PROPERTIES — object properties present in all objects
 *   Bits 1-2 (0x06): SUBGROUP_ID_MODE — 00=0, 01=first obj ID, 10=explicit, 11=reserved
 *   Bit 3 (0x08): END_OF_GROUP
 *   Bit 4 (0x10): Always 1 (identifies as subgroup header)
 *   Bit 5 (0x20): DEFAULT_PRIORITY — when 1, Priority field omitted
 *   Bit 6 (0x40): FIRST_OBJECT — first object is first ever published in subgroup
 */
export const SubgroupFlags = {
  PROPERTIES: 0x01,              // Bit 0: Object properties present
  SUBGROUP_ID_MODE_MASK: 0x06,   // Bits 1-2: Subgroup ID mode
  END_OF_GROUP: 0x08,            // Bit 3: Last subgroup in group
  BASE_TYPE: 0x10,               // Bit 4: Always set
  DEFAULT_PRIORITY: 0x20,        // Bit 5: Priority field omitted (use default)
  FIRST_OBJECT: 0x40,            // Bit 6: First object is first in subgroup
} as const;

export const SubgroupIdMode = {
  ZERO: 0b00,          // Subgroup ID = 0, field absent
  FIRST_OBJECT: 0b01,  // Subgroup ID = first object ID, field absent
  EXPLICIT: 0b10,      // Subgroup ID field present
  RESERVED: 0b11,      // Reserved
} as const;

export class Draft18StreamCodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Draft18StreamCodecError';
  }
}

/**
 * Draft-18 Stream Codec for data streams
 */
export class Draft18StreamCodec {
  /**
   * Check if a stream type is a subgroup header
   */
  static isSubgroupHeader(streamType: number): boolean {
    // Pattern: 0b0XX1XXXX — bit 4 set, bit 7 clear
    // Valid ranges: 0x10-0x1F, 0x30-0x3F, 0x50-0x5F, 0x70-0x7F
    return (streamType & 0x10) !== 0 && (streamType & 0x80) === 0;
  }

  /**
   * Encode a subgroup header
   */
  static encodeSubgroupHeader(header: SubgroupHeaderDraft18): Uint8Array {
    const writer = new Draft18BufferWriter();

    // Build stream type from flags
    let streamType = SubgroupFlags.BASE_TYPE;

    // SUBGROUP_ID_MODE (bits 1-2): use explicit mode (0b10)
    streamType |= (SubgroupIdMode.EXPLICIT << 1);

    // FIRST_OBJECT bit
    if (header.firstObject === undefined || header.firstObject === 0n) {
      streamType |= SubgroupFlags.FIRST_OBJECT;
    }

    // END_OF_GROUP bit
    if ((header.streamType & SubgroupFlags.END_OF_GROUP) !== 0) {
      streamType |= SubgroupFlags.END_OF_GROUP;
    }

    // PROPERTIES bit
    if (header.subgroupProperties && header.subgroupProperties.size > 0) {
      streamType |= SubgroupFlags.PROPERTIES;
    }

    // DEFAULT_PRIORITY: we always write priority explicitly (bit=0)

    writer.writeVarInt(streamType);
    writer.writeVarInt(header.trackAlias);
    writer.writeVarInt(header.groupId);
    // Subgroup ID (present because SUBGROUP_ID_MODE = EXPLICIT)
    writer.writeVarInt(header.subgroupId);
    // Publisher Priority (present because DEFAULT_PRIORITY bit is 0)
    writer.writeByte(header.publisherPriority);

    return writer.toUint8Array();
  }

  /**
   * Decode a subgroup header
   */
  static decodeSubgroupHeader(buffer: Uint8Array, offset = 0): [SubgroupHeaderDraft18, number] {
    const reader = new Draft18BufferReader(buffer, offset);

    const streamType = reader.readVarIntNumber();

    if (!Draft18StreamCodec.isSubgroupHeader(streamType)) {
      throw new Draft18StreamCodecError(`Invalid subgroup header stream type: 0x${streamType.toString(16)}`);
    }

    const trackAlias = reader.readVarInt();
    const groupId = reader.readVarInt();

    // Subgroup ID: depends on SUBGROUP_ID_MODE (bits 1-2)
    const subgroupIdMode = (streamType & SubgroupFlags.SUBGROUP_ID_MODE_MASK) >> 1;
    let subgroupId: bigint;
    if (subgroupIdMode === SubgroupIdMode.EXPLICIT) {
      subgroupId = reader.readVarInt();
    } else if (subgroupIdMode === SubgroupIdMode.FIRST_OBJECT) {
      subgroupId = 0n; // Will be set to first object ID later
    } else {
      subgroupId = 0n;
    }

    // Publisher Priority: present only when DEFAULT_PRIORITY bit (0x20) is 0
    let publisherPriority = 128; // default
    if ((streamType & SubgroupFlags.DEFAULT_PRIORITY) === 0) {
      publisherPriority = reader.readByte();
    }

    const firstObject = (streamType & SubgroupFlags.FIRST_OBJECT) !== 0 ? 0n : undefined;

    return [
      {
        streamType,
        trackAlias,
        groupId,
        subgroupId,
        publisherPriority,
        firstObject,
      },
      reader.offset - offset,
    ];
  }

  /**
   * Encode a fetch header (stream type 0x05)
   */
  static encodeFetchHeader(requestId: bigint): Uint8Array {
    const writer = new Draft18BufferWriter();
    writer.writeVarInt(StreamTypeDraft18.FETCH_HEADER);
    writer.writeVarInt(requestId);
    return writer.toUint8Array();
  }

  /**
   * Decode a fetch header
   */
  static decodeFetchHeader(buffer: Uint8Array, offset = 0): [{ requestId: bigint }, number] {
    const reader = new Draft18BufferReader(buffer, offset);

    const streamType = reader.readVarIntNumber();
    if (streamType !== StreamTypeDraft18.FETCH_HEADER) {
      throw new Draft18StreamCodecError(`Expected FETCH_HEADER (0x05), got 0x${streamType.toString(16)}`);
    }

    const requestId = reader.readVarInt();
    return [{ requestId }, reader.offset - offset];
  }

  /**
   * Encode an object header (within a subgroup stream)
   */
  static encodeObjectHeader(header: ObjectHeaderDraft18, hasProperties = false): Uint8Array {
    const writer = new Draft18BufferWriter();

    writer.writeVarInt(header.objectIdDelta);

    if (hasProperties) {
      const propsWriter = new Draft18BufferWriter();
      if (header.objectProperties) {
        Draft18StreamCodec.encodeProperties(propsWriter, header.objectProperties);
      }
      const propsBytes = propsWriter.toUint8Array();
      writer.writeVarInt(propsBytes.length);
      writer.writeBytes(propsBytes);
    }

    writer.writeVarInt(header.payloadLength);

    return writer.toUint8Array();
  }

  /**
   * Decode an object header
   * hasProperties: determined by PROPERTIES bit (0x01) in stream type
   */
  static decodeObjectHeader(buffer: Uint8Array, offset = 0, hasProperties = false): [ObjectHeaderDraft18, number] {
    const reader = new Draft18BufferReader(buffer, offset);

    const objectIdDelta = reader.readVarInt();

    let objectProperties: Map<number, Uint8Array> | undefined;
    if (hasProperties) {
      const propsLength = reader.readVarIntNumber();
      if (propsLength > 0) {
        const propsEnd = reader.offset + propsLength;
        objectProperties = Draft18StreamCodec.decodeProperties(reader, propsEnd);
      }
    }

    const payloadLength = reader.readVarInt();

    return [
      {
        objectIdDelta,
        objectProperties,
        payloadLength,
      },
      reader.offset - offset,
    ];
  }

  /**
   * Encode an object datagram
   */
  static encodeObjectDatagram(datagram: ObjectDatagramDraft18): Uint8Array {
    const writer = new Draft18BufferWriter();

    writer.writeVarInt(0x01); // Datagram type
    writer.writeVarInt(datagram.trackAlias);
    writer.writeVarInt(datagram.groupId);
    writer.writeVarInt(datagram.objectId);
    writer.writeByte(datagram.publisherPriority);

    // Object properties
    const propsWriter = new Draft18BufferWriter();
    if (datagram.objectProperties) {
      Draft18StreamCodec.encodeProperties(propsWriter, datagram.objectProperties);
    }
    const propsBytes = propsWriter.toUint8Array();
    writer.writeVarInt(propsBytes.length);
    writer.writeBytes(propsBytes);

    // Payload (remainder of datagram)
    writer.writeBytes(datagram.payload);

    return writer.toUint8Array();
  }

  /**
   * Decode an object datagram
   */
  static decodeObjectDatagram(buffer: Uint8Array, offset = 0): [ObjectDatagramDraft18, number] {
    const reader = new Draft18BufferReader(buffer, offset);

    const datagramType = reader.readVarIntNumber();
    if (datagramType !== 0x01) {
      throw new Draft18StreamCodecError(`Expected datagram type 0x01, got 0x${datagramType.toString(16)}`);
    }

    const trackAlias = reader.readVarInt();
    const groupId = reader.readVarInt();
    const objectId = reader.readVarInt();
    const publisherPriority = reader.readByte();

    const propsLength = reader.readVarIntNumber();
    let objectProperties: Map<number, Uint8Array> | undefined;
    if (propsLength > 0) {
      const propsEnd = reader.offset + propsLength;
      objectProperties = Draft18StreamCodec.decodeProperties(reader, propsEnd);
    }

    // Remainder is payload
    const payload = buffer.subarray(reader.offset);

    return [
      {
        trackAlias,
        groupId,
        objectId,
        publisherPriority,
        objectProperties,
        payload,
      },
      buffer.length - offset,
    ];
  }

  /**
   * Encode a fetch object (within a fetch stream)
   */
  static encodeFetchObject(obj: FetchObjectDraft18): Uint8Array {
    const writer = new Draft18BufferWriter();

    // Flags: Bit 0 = END_OF_FETCH
    const flags = obj.endOfFetch ? 0x01 : 0x00;
    writer.writeVarInt(flags);

    writer.writeVarInt(obj.groupId);
    writer.writeVarInt(obj.subgroupId);
    writer.writeVarInt(obj.objectId);
    writer.writeByte(obj.publisherPriority);

    // Object properties
    const propsWriter = new Draft18BufferWriter();
    if (obj.objectProperties) {
      Draft18StreamCodec.encodeProperties(propsWriter, obj.objectProperties);
    }
    const propsBytes = propsWriter.toUint8Array();
    writer.writeVarInt(propsBytes.length);
    writer.writeBytes(propsBytes);

    writer.writeVarInt(obj.payloadLength);

    return writer.toUint8Array();
  }

  /**
   * Decode a fetch object
   */
  static decodeFetchObject(buffer: Uint8Array, offset = 0): [FetchObjectDraft18, number] {
    const reader = new Draft18BufferReader(buffer, offset);

    const flags = reader.readVarIntNumber();
    const endOfFetch = (flags & 0x01) !== 0;

    const groupId = reader.readVarInt();
    const subgroupId = reader.readVarInt();
    const objectId = reader.readVarInt();
    const publisherPriority = reader.readByte();

    const propsLength = reader.readVarIntNumber();
    let objectProperties: Map<number, Uint8Array> | undefined;
    if (propsLength > 0) {
      const propsEnd = reader.offset + propsLength;
      objectProperties = Draft18StreamCodec.decodeProperties(reader, propsEnd);
    }

    const payloadLength = reader.readVarInt();

    return [
      {
        endOfFetch,
        groupId,
        subgroupId,
        objectId,
        publisherPriority,
        objectProperties,
        payloadLength,
      },
      reader.offset - offset,
    ];
  }

  /**
   * Encode setup stream header (0x2F00 for control stream)
   */
  static encodeSetupStreamHeader(): Uint8Array {
    return MOQTVarInt.encode(StreamTypeDraft18.SETUP);
  }

  /**
   * Decode setup stream header
   */
  static decodeSetupStreamHeader(buffer: Uint8Array, offset = 0): [number, number] {
    const [value, bytesRead] = MOQTVarInt.decodeNumber(buffer, offset);
    if (value !== StreamTypeDraft18.SETUP) {
      log.warn('Unexpected stream type, expected SETUP', { expected: StreamTypeDraft18.SETUP, got: value });
    }
    return [value, bytesRead];
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  private static encodeProperties(writer: Draft18BufferWriter, props: Map<number, Uint8Array>): void {
    const sortedEntries = Array.from(props.entries()).sort((a, b) => a[0] - b[0]);
    let previousKey = 0;

    for (const [key, value] of sortedEntries) {
      writer.writeVarInt(key - previousKey);
      previousKey = key;

      if (key % 2 === 0) {
        // Even key: value bytes directly
        writer.writeBytes(value);
      } else {
        // Odd key: length + bytes
        writer.writeVarInt(value.length);
        writer.writeBytes(value);
      }
    }
  }

  private static decodeProperties(reader: Draft18BufferReader, endOffset: number): Map<number, Uint8Array> {
    const props = new Map<number, Uint8Array>();
    let previousKey = 0;

    while (reader.offset < endOffset) {
      const deltaKey = reader.readVarIntNumber();
      const key = previousKey + deltaKey;
      previousKey = key;

      if (key % 2 === 0) {
        // Even key: value is a single varint
        const value = reader.readVarInt();
        props.set(key, MOQTVarInt.encode(value));
      } else {
        // Odd key: length + bytes
        const length = reader.readVarIntNumber();
        props.set(key, reader.readBytes(length));
      }
    }

    return props;
  }
}
