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
  FetchSubgroupMode,
  FetchObjectEndOfRange,
  SubgroupIdModeDraft18,
  type SubgroupHeaderDraft18,
  type ObjectHeaderDraft18,
  type ObjectDatagramDraft18,
  type FetchObjectDraft18,
} from '../messages/types.js';

/**
 * Datagram Type flag bits (spec §11.3.1).
 * Valid Type values are in the ranges 0x00..0x0F and 0x20..0x2F (form 0b00X0XXXX).
 */
export const DatagramFlags = {
  PROPERTIES: 0x01,
  END_OF_GROUP: 0x02,
  ZERO_OBJECT_ID: 0x04,
  DEFAULT_PRIORITY: 0x08,
  STATUS: 0x20,
} as const;

/**
 * Fetch Object flag bits (spec §11.4.4.1).
 * The first byte before each fetch object encodes optional-field presence.
 */
export const FetchObjectFlags = {
  SUBGROUP_MODE_MASK: 0x03, // 2 LSB: 0=zero, 1=first-object, 2=explicit, 3=reserved
  OBJECT_ID_DELTA: 0x04,
  GROUP_ID_DELTA: 0x08,
  PRIORITY: 0x10,
  PROPERTIES: 0x20,
  DATAGRAM_MODE: 0x40,
} as const;

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
  RESERVED: 0b11,      // Reserved (PROTOCOL_VIOLATION on receive per §11.4.2)
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
   * Encode a subgroup header (spec §11.4.2).
   *
   * The Type byte is derived from the header fields:
   *   0x10 base (bit 4 always set)
   *   0x01 PROPERTIES iff `hasProperties`
   *   0x06 SUBGROUP_ID_MODE (0=zero, 1=first-object, 2=explicit)
   *   0x08 END_OF_GROUP iff `endOfGroup`
   *   0x20 DEFAULT_PRIORITY iff `publisherPriority` is undefined
   *   0x40 FIRST_OBJECT iff `firstObject !== false`
   *
   * The Subgroup ID field is only present when subgroupIdMode === EXPLICIT.
   * The Publisher Priority field is only present when DEFAULT_PRIORITY bit is 0.
   */
  static encodeSubgroupHeader(header: SubgroupHeaderDraft18): Uint8Array {
    const writer = new Draft18BufferWriter();

    const subgroupIdMode = header.subgroupIdMode ?? SubgroupIdModeDraft18.EXPLICIT;
    if (subgroupIdMode > SubgroupIdModeDraft18.EXPLICIT) {
      throw new Draft18StreamCodecError(`Reserved subgroup ID mode ${subgroupIdMode} cannot be encoded (spec §11.4.2)`);
    }
    if (subgroupIdMode === SubgroupIdModeDraft18.EXPLICIT && header.subgroupId === undefined) {
      throw new Draft18StreamCodecError('subgroupIdMode=EXPLICIT requires subgroupId to be set');
    }

    const hasProperties = header.hasProperties === true;
    const endOfGroup = header.endOfGroup === true;
    const defaultPriority = header.publisherPriority === undefined;
    // Default: this stream contains the first object in the subgroup, per spec-common case.
    const firstObject = header.firstObject !== false;

    let streamType = SubgroupFlags.BASE_TYPE;
    if (hasProperties) streamType |= SubgroupFlags.PROPERTIES;
    streamType |= (subgroupIdMode << 1) & SubgroupFlags.SUBGROUP_ID_MODE_MASK;
    if (endOfGroup) streamType |= SubgroupFlags.END_OF_GROUP;
    if (defaultPriority) streamType |= SubgroupFlags.DEFAULT_PRIORITY;
    if (firstObject) streamType |= SubgroupFlags.FIRST_OBJECT;

    writer.writeVarInt(streamType);
    writer.writeVarInt(header.trackAlias);
    writer.writeVarInt(header.groupId);
    if (subgroupIdMode === SubgroupIdModeDraft18.EXPLICIT) {
      writer.writeVarInt(header.subgroupId!);
    }
    if (!defaultPriority) {
      writer.writeByte(header.publisherPriority!);
    }

    return writer.toUint8Array();
  }

  /**
   * Decode a subgroup header (spec §11.4.2).
   */
  static decodeSubgroupHeader(buffer: Uint8Array, offset = 0): [SubgroupHeaderDraft18, number] {
    const reader = new Draft18BufferReader(buffer, offset);

    const streamType = reader.readVarIntNumber();

    if (!Draft18StreamCodec.isSubgroupHeader(streamType)) {
      throw new Draft18StreamCodecError(`Invalid subgroup header stream type: 0x${streamType.toString(16)}`);
    }

    const modeBits = (streamType & SubgroupFlags.SUBGROUP_ID_MODE_MASK) >> 1;
    if (modeBits === 0b11) {
      throw new Draft18StreamCodecError(
        `Reserved SUBGROUP_ID_MODE 0b11 in stream type 0x${streamType.toString(16)} (spec §11.4.2 PROTOCOL_VIOLATION)`,
      );
    }
    const subgroupIdMode = modeBits as SubgroupIdModeDraft18;

    const hasProperties = (streamType & SubgroupFlags.PROPERTIES) !== 0;
    const endOfGroup = (streamType & SubgroupFlags.END_OF_GROUP) !== 0;
    const defaultPriority = (streamType & SubgroupFlags.DEFAULT_PRIORITY) !== 0;
    const firstObject = (streamType & SubgroupFlags.FIRST_OBJECT) !== 0;

    const trackAlias = reader.readVarInt();
    const groupId = reader.readVarInt();

    let subgroupId: bigint | undefined;
    if (subgroupIdMode === SubgroupIdModeDraft18.EXPLICIT) {
      subgroupId = reader.readVarInt();
    } else if (subgroupIdMode === SubgroupIdModeDraft18.ZERO) {
      subgroupId = 0n;
    }
    // FIRST_OBJECT_ID: resolved after first object arrives; leave undefined.

    const publisherPriority = defaultPriority ? undefined : reader.readByte();

    return [
      {
        streamType,
        trackAlias,
        groupId,
        subgroupIdMode,
        subgroupId,
        publisherPriority,
        hasProperties: hasProperties ? true : undefined,
        endOfGroup: endOfGroup ? true : undefined,
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
   * Check if a byte is a valid OBJECT_DATAGRAM type (spec §11.3.1).
   * Valid form is 0b00X0XXXX (ranges 0x00-0x0F, 0x20-0x2F).
   * Type values with both STATUS (0x20) and END_OF_GROUP (0x02) set are invalid.
   */
  static isDatagramType(type: number): boolean {
    if ((type & 0xd0) !== 0x00 && (type & 0xd0) !== 0x00) {
      // sanity — bits 4, 6, 7 must be 0
    }
    // Form check: bits 4, 6, 7 must be zero → (type & 0xd0) === 0
    if ((type & 0xd0) !== 0) return false;
    // Invalid: STATUS + END_OF_GROUP
    if ((type & DatagramFlags.STATUS) !== 0 && (type & DatagramFlags.END_OF_GROUP) !== 0) return false;
    return true;
  }

  /**
   * Encode an object datagram (spec §11.3.1).
   *
   * Derives the Type byte from the datagram fields:
   *   PROPERTIES(0x01) set iff objectProperties present;
   *   END_OF_GROUP(0x02) set from datagram.endOfGroup;
   *   ZERO_OBJECT_ID(0x04) set iff objectId is 0 or undefined;
   *   DEFAULT_PRIORITY(0x08) set iff publisherPriority is undefined;
   *   STATUS(0x20) set iff objectStatus is defined (payload is then absent).
   */
  static encodeObjectDatagram(datagram: ObjectDatagramDraft18): Uint8Array {
    const writer = new Draft18BufferWriter();

    const hasProperties = datagram.objectProperties !== undefined && datagram.objectProperties.size > 0;
    const isStatus = datagram.objectStatus !== undefined;
    const objectIdIsZero = datagram.objectId === undefined || datagram.objectId === 0n;
    const priorityDefault = datagram.publisherPriority === undefined;
    const endOfGroup = datagram.endOfGroup === true;

    if (isStatus && endOfGroup) {
      throw new Draft18StreamCodecError('OBJECT_DATAGRAM cannot have both STATUS and END_OF_GROUP (spec §11.3.1)');
    }
    if (isStatus && hasProperties && (datagram.objectStatus as number) !== 0) {
      throw new Draft18StreamCodecError(
        'OBJECT_DATAGRAM with STATUS and PROPERTIES requires Object Status == Normal (spec §11.3.1)',
      );
    }

    let type = 0;
    if (hasProperties) type |= DatagramFlags.PROPERTIES;
    if (endOfGroup) type |= DatagramFlags.END_OF_GROUP;
    if (objectIdIsZero) type |= DatagramFlags.ZERO_OBJECT_ID;
    if (priorityDefault) type |= DatagramFlags.DEFAULT_PRIORITY;
    if (isStatus) type |= DatagramFlags.STATUS;

    writer.writeVarInt(type);
    writer.writeVarInt(datagram.trackAlias);
    writer.writeVarInt(datagram.groupId);

    if (!objectIdIsZero) {
      writer.writeVarInt(datagram.objectId!);
    }
    if (!priorityDefault) {
      writer.writeByte(datagram.publisherPriority!);
    }

    if (hasProperties) {
      const propsWriter = new Draft18BufferWriter();
      Draft18StreamCodec.encodeProperties(propsWriter, datagram.objectProperties!);
      const propsBytes = propsWriter.toUint8Array();
      if (propsBytes.length === 0) {
        throw new Draft18StreamCodecError('PROPERTIES bit set but properties encoded to zero bytes');
      }
      writer.writeVarInt(propsBytes.length);
      writer.writeBytes(propsBytes);
    }

    if (isStatus) {
      writer.writeVarInt(datagram.objectStatus as number);
    } else if (datagram.payload) {
      writer.writeBytes(datagram.payload);
    }

    return writer.toUint8Array();
  }

  /**
   * Decode an object datagram (spec §11.3.1).
   */
  static decodeObjectDatagram(buffer: Uint8Array, offset = 0): [ObjectDatagramDraft18, number] {
    const reader = new Draft18BufferReader(buffer, offset);

    const type = reader.readVarIntNumber();
    if (!Draft18StreamCodec.isDatagramType(type)) {
      throw new Draft18StreamCodecError(`Invalid OBJECT_DATAGRAM type: 0x${type.toString(16)}`);
    }

    const hasProperties = (type & DatagramFlags.PROPERTIES) !== 0;
    const endOfGroup = (type & DatagramFlags.END_OF_GROUP) !== 0;
    const zeroObjectId = (type & DatagramFlags.ZERO_OBJECT_ID) !== 0;
    const defaultPriority = (type & DatagramFlags.DEFAULT_PRIORITY) !== 0;
    const hasStatus = (type & DatagramFlags.STATUS) !== 0;

    const trackAlias = reader.readVarInt();
    const groupId = reader.readVarInt();
    const objectId = zeroObjectId ? 0n : reader.readVarInt();
    const publisherPriority = defaultPriority ? undefined : reader.readByte();

    let objectProperties: Map<number, Uint8Array> | undefined;
    if (hasProperties) {
      const propsLength = reader.readVarIntNumber();
      if (propsLength === 0) {
        throw new Draft18StreamCodecError(
          'PROPERTIES bit set with Properties Length == 0 (spec §11.3.1 PROTOCOL_VIOLATION)',
        );
      }
      const propsEnd = reader.offset + propsLength;
      objectProperties = Draft18StreamCodec.decodeProperties(reader, propsEnd);
    }

    let objectStatus: number | undefined;
    let payload: Uint8Array | undefined;
    if (hasStatus) {
      objectStatus = reader.readVarIntNumber();
      if (hasProperties && objectStatus !== 0) {
        throw new Draft18StreamCodecError(
          'OBJECT_DATAGRAM with STATUS and PROPERTIES requires Object Status == Normal (spec §11.3.1)',
        );
      }
    } else {
      payload = buffer.subarray(reader.offset);
    }

    return [
      {
        trackAlias,
        groupId,
        objectId,
        publisherPriority,
        objectProperties,
        endOfGroup: endOfGroup ? true : undefined,
        objectStatus,
        payload,
      },
      buffer.length - offset,
    ];
  }

  /**
   * Encode a fetch object (spec §11.4.4).
   *
   * The Serialization Flags byte is derived from which optional fields are populated:
   *   2 LSB = subgroupMode (FetchSubgroupMode.ZERO/PRIOR/PRIOR_PLUS_ONE/EXPLICIT)
   *   0x04 OBJECT_ID_DELTA present, 0x08 GROUP_ID_DELTA present,
   *   0x10 PRIORITY present, 0x20 PROPERTIES present, 0x40 DATAGRAM_MODE.
   *
   * When `endOfRange` is defined, the special marker (0x8C or 0x10C) is written instead
   * of a normal flag byte. In that case only Group ID and Object ID are written (§11.4.4.2).
   */
  static encodeFetchObject(obj: FetchObjectDraft18): Uint8Array {
    const writer = new Draft18BufferWriter();

    // End-of-Range marker: only Group ID Delta and Object ID Delta follow.
    if (obj.endOfRange !== undefined) {
      writer.writeVarInt(obj.endOfRange);
      if (obj.groupIdDelta === undefined || obj.objectIdDelta === undefined) {
        throw new Draft18StreamCodecError(
          'End-of-Range fetch object requires Group ID and Object ID (spec §11.4.4.2)',
        );
      }
      writer.writeVarInt(obj.groupIdDelta);
      writer.writeVarInt(obj.objectIdDelta);
      return writer.toUint8Array();
    }

    const hasObjectIdDelta = obj.objectIdDelta !== undefined;
    const hasGroupIdDelta = obj.groupIdDelta !== undefined;
    const hasPriority = obj.publisherPriority !== undefined;
    const hasProperties = obj.objectProperties !== undefined && obj.objectProperties.size > 0;
    const datagramMode = obj.datagramMode === true;

    let flags = obj.subgroupMode & FetchObjectFlags.SUBGROUP_MODE_MASK;
    if (hasObjectIdDelta) flags |= FetchObjectFlags.OBJECT_ID_DELTA;
    if (hasGroupIdDelta) flags |= FetchObjectFlags.GROUP_ID_DELTA;
    if (hasPriority) flags |= FetchObjectFlags.PRIORITY;
    if (hasProperties) flags |= FetchObjectFlags.PROPERTIES;
    if (datagramMode) flags |= FetchObjectFlags.DATAGRAM_MODE;

    if (flags >= 128) {
      // Above 128 the byte is reserved for End of Range markers only.
      throw new Draft18StreamCodecError(`Fetch object serialization flags 0x${flags.toString(16)} >= 128 is reserved`);
    }

    writer.writeVarInt(flags);

    // Field order per spec §11.4.4:
    //   [Group ID Delta] [Subgroup ID] [Object ID Delta] [Priority] [Properties] Payload Length [Payload]
    if (hasGroupIdDelta) {
      writer.writeVarInt(obj.groupIdDelta!);
    }
    if (!datagramMode && obj.subgroupMode === FetchSubgroupMode.EXPLICIT) {
      if (obj.subgroupId === undefined) {
        throw new Draft18StreamCodecError('subgroupMode=EXPLICIT requires subgroupId');
      }
      writer.writeVarInt(obj.subgroupId);
    }
    if (hasObjectIdDelta) {
      writer.writeVarInt(obj.objectIdDelta!);
    }
    if (hasPriority) {
      writer.writeByte(obj.publisherPriority!);
    }
    if (hasProperties) {
      const propsWriter = new Draft18BufferWriter();
      Draft18StreamCodec.encodeProperties(propsWriter, obj.objectProperties!);
      const propsBytes = propsWriter.toUint8Array();
      writer.writeVarInt(propsBytes.length);
      writer.writeBytes(propsBytes);
    }

    writer.writeVarInt(obj.payloadLength ?? 0n);

    return writer.toUint8Array();
  }

  /**
   * Decode a fetch object (spec §11.4.4).
   */
  static decodeFetchObject(buffer: Uint8Array, offset = 0): [FetchObjectDraft18, number] {
    const reader = new Draft18BufferReader(buffer, offset);

    const flags = reader.readVarIntNumber();

    // End of Range indicators (§11.4.4.2)
    if (flags === FetchObjectEndOfRange.NON_EXISTENT || flags === FetchObjectEndOfRange.UNKNOWN) {
      const groupIdDelta = reader.readVarInt();
      const objectIdDelta = reader.readVarInt();
      return [
        {
          subgroupMode: FetchSubgroupMode.ZERO,
          endOfRange: flags,
          groupIdDelta,
          objectIdDelta,
        },
        reader.offset - offset,
      ];
    }

    if (flags >= 128) {
      throw new Draft18StreamCodecError(
        `Invalid fetch object serialization flags: 0x${flags.toString(16)} (spec §11.4.4)`,
      );
    }

    const subgroupMode = (flags & FetchObjectFlags.SUBGROUP_MODE_MASK) as FetchSubgroupMode;
    const hasObjectIdDelta = (flags & FetchObjectFlags.OBJECT_ID_DELTA) !== 0;
    const hasGroupIdDelta = (flags & FetchObjectFlags.GROUP_ID_DELTA) !== 0;
    const hasPriority = (flags & FetchObjectFlags.PRIORITY) !== 0;
    const hasProperties = (flags & FetchObjectFlags.PROPERTIES) !== 0;
    const datagramMode = (flags & FetchObjectFlags.DATAGRAM_MODE) !== 0;

    const groupIdDelta = hasGroupIdDelta ? reader.readVarInt() : undefined;
    const subgroupId = !datagramMode && subgroupMode === FetchSubgroupMode.EXPLICIT ? reader.readVarInt() : undefined;
    const objectIdDelta = hasObjectIdDelta ? reader.readVarInt() : undefined;
    const publisherPriority = hasPriority ? reader.readByte() : undefined;

    let objectProperties: Map<number, Uint8Array> | undefined;
    if (hasProperties) {
      const propsLength = reader.readVarIntNumber();
      if (propsLength === 0) {
        throw new Draft18StreamCodecError('PROPERTIES flag set with zero-length properties (spec §11.4.4)');
      }
      const propsEnd = reader.offset + propsLength;
      objectProperties = Draft18StreamCodec.decodeProperties(reader, propsEnd);
    }

    const payloadLength = reader.readVarInt();

    return [
      {
        subgroupMode,
        groupIdDelta,
        subgroupId,
        objectIdDelta,
        publisherPriority,
        objectProperties,
        payloadLength,
        datagramMode: datagramMode ? true : undefined,
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
