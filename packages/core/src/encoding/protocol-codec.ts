// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Protocol codec abstraction for version-specific encoding/decoding.
 *
 * This module provides a clean separation between draft-14/16 and draft-18
 * wire formats without spaghetti conditionals throughout the codebase.
 */

import { IS_DRAFT_18, IS_DRAFT_16 } from '../version/constants.js';
import { Version } from '../messages/types.js';
import type {
  ControlMessage,
  ControlMessageDraft18,
  TrackNamespace,
  FullTrackName,
  Location,
} from '../messages/types.js';

/**
 * Common interface for protocol-version-specific codecs
 */
export interface IProtocolCodec {
  readonly version: Version;

  encodeControlMessage(message: ControlMessage | ControlMessageDraft18): Uint8Array;
  decodeControlMessage(buffer: Uint8Array, offset?: number): [ControlMessage | ControlMessageDraft18, number];

  encodeSetupStreamHeader(): Uint8Array;
  decodeSetupStreamHeader(buffer: Uint8Array, offset?: number): [number, number];

  encodeVarInt(value: number | bigint): Uint8Array;
  decodeVarInt(buffer: Uint8Array, offset?: number): [bigint, number];
  decodeVarIntNumber(buffer: Uint8Array, offset?: number): [number, number];

  encodeNamespace(namespace: TrackNamespace): Uint8Array;
  decodeNamespace(buffer: Uint8Array, offset?: number): [TrackNamespace, number];

  encodeFullTrackName(fullTrackName: FullTrackName): Uint8Array;
  decodeFullTrackName(buffer: Uint8Array, offset?: number): [FullTrackName, number];

  encodeKeyValuePairs(pairs: Map<number, Uint8Array>, deltaEncoded?: boolean): Uint8Array;
  decodeKeyValuePairs(buffer: Uint8Array, offset?: number, count?: number): [Map<number, Uint8Array>, number];
}

/**
 * Get the protocol codec for the current build configuration
 */
export function getProtocolCodec(): IProtocolCodec {
  if (IS_DRAFT_18) {
    return Draft18Codec.instance;
  }
  return Draft14Codec.instance;
}

/**
 * Get a protocol codec for a specific version
 */
export function getProtocolCodecForVersion(version: Version): IProtocolCodec {
  switch (version) {
    case Version.DRAFT_18:
    case Version.DRAFT_17:
      return Draft18Codec.instance;
    case Version.DRAFT_16:
    case Version.DRAFT_15:
    case Version.DRAFT_14:
    default:
      return Draft14Codec.instance;
  }
}

/**
 * Check if the current build uses MOQT varints (draft-17+)
 */
export function usesMoqtVarInt(): boolean {
  return IS_DRAFT_18;
}

/**
 * Check if the current build uses QUIC varints (draft-14/15/16)
 */
export function usesQuicVarInt(): boolean {
  return !IS_DRAFT_18;
}

// Import the actual codec implementations
import { VarInt, BufferReader, BufferWriter } from './varint.js';
import { MOQTVarInt } from './moqt-varint.js';

/**
 * Draft-14/15/16 Codec Implementation
 *
 * Uses QUIC-style varints and the existing message-codec.ts encoding.
 */
class Draft14Codec implements IProtocolCodec {
  static readonly instance = new Draft14Codec();
  readonly version = IS_DRAFT_16 ? Version.DRAFT_16 : Version.DRAFT_14;

  private constructor() {}

  encodeControlMessage(message: ControlMessage): Uint8Array {
    // Delegate to existing MessageCodec for draft-14/16
    const { MessageCodec } = require('./message-codec.js');
    return MessageCodec.encode(message);
  }

  decodeControlMessage(buffer: Uint8Array, offset = 0): [ControlMessage, number] {
    const { MessageCodec } = require('./message-codec.js');
    return MessageCodec.decode(buffer, offset);
  }

  encodeSetupStreamHeader(): Uint8Array {
    // Draft-14/16: Control stream starts with stream type 0x40
    return VarInt.encode(0x40);
  }

  decodeSetupStreamHeader(buffer: Uint8Array, offset = 0): [number, number] {
    const [value, bytesRead] = VarInt.decodeNumber(buffer, offset);
    return [value, bytesRead];
  }

  encodeVarInt(value: number | bigint): Uint8Array {
    return VarInt.encode(value);
  }

  decodeVarInt(buffer: Uint8Array, offset = 0): [bigint, number] {
    return VarInt.decode(buffer, offset);
  }

  decodeVarIntNumber(buffer: Uint8Array, offset = 0): [number, number] {
    return VarInt.decodeNumber(buffer, offset);
  }

  encodeNamespace(namespace: TrackNamespace): Uint8Array {
    const writer = new BufferWriter();
    writer.writeVarInt(namespace.length);
    for (const element of namespace) {
      writer.writeString(element);
    }
    return writer.toUint8Array();
  }

  decodeNamespace(buffer: Uint8Array, offset = 0): [TrackNamespace, number] {
    const reader = new BufferReader(buffer, offset);
    const count = reader.readVarIntNumber();
    const namespace: TrackNamespace = [];
    for (let i = 0; i < count; i++) {
      namespace.push(reader.readString());
    }
    return [namespace, reader.offset - offset];
  }

  encodeFullTrackName(fullTrackName: FullTrackName): Uint8Array {
    const writer = new BufferWriter();
    writer.writeVarInt(fullTrackName.namespace.length);
    for (const element of fullTrackName.namespace) {
      writer.writeString(element);
    }
    writer.writeString(fullTrackName.trackName);
    return writer.toUint8Array();
  }

  decodeFullTrackName(buffer: Uint8Array, offset = 0): [FullTrackName, number] {
    const reader = new BufferReader(buffer, offset);
    const namespaceCount = reader.readVarIntNumber();
    const namespace: string[] = [];
    for (let i = 0; i < namespaceCount; i++) {
      namespace.push(reader.readString());
    }
    const trackName = reader.readString();
    return [{ namespace, trackName }, reader.offset - offset];
  }

  encodeKeyValuePairs(pairs: Map<number, Uint8Array>, deltaEncoded = false): Uint8Array {
    const writer = new BufferWriter();
    writer.writeVarInt(pairs.size);

    if (deltaEncoded && IS_DRAFT_16) {
      const sortedEntries = Array.from(pairs.entries()).sort((a, b) => a[0] - b[0]);
      let previousKey = 0;
      for (const [key, value] of sortedEntries) {
        writer.writeVarInt(key - previousKey);
        previousKey = key;
        if (key % 2 === 0) {
          writer.writeBytes(value);
        } else {
          writer.writeVarInt(value.length);
          writer.writeBytes(value);
        }
      }
    } else {
      for (const [key, value] of pairs) {
        writer.writeVarInt(key);
        writer.writeVarInt(value.length);
        writer.writeBytes(value);
      }
    }
    return writer.toUint8Array();
  }

  decodeKeyValuePairs(buffer: Uint8Array, offset = 0, count?: number): [Map<number, Uint8Array>, number] {
    const reader = new BufferReader(buffer, offset);
    const pairCount = count ?? reader.readVarIntNumber();
    const pairs = new Map<number, Uint8Array>();

    if (IS_DRAFT_16) {
      let previousKey = 0;
      for (let i = 0; i < pairCount; i++) {
        const deltaKey = reader.readVarIntNumber();
        const key = previousKey + deltaKey;
        previousKey = key;
        if (key % 2 === 0) {
          const value = reader.readVarIntNumber();
          pairs.set(key, VarInt.encode(value));
        } else {
          const length = reader.readVarIntNumber();
          pairs.set(key, reader.readBytes(length));
        }
      }
    } else {
      for (let i = 0; i < pairCount; i++) {
        const key = reader.readVarIntNumber();
        const length = reader.readVarIntNumber();
        pairs.set(key, reader.readBytes(length));
      }
    }
    return [pairs, reader.offset - offset];
  }
}

/**
 * Draft-18 Codec Implementation
 *
 * Uses MOQT-style varints (leading 1-bits) and new wire format.
 */
class Draft18Codec implements IProtocolCodec {
  static readonly instance = new Draft18Codec();
  readonly version = Version.DRAFT_18;

  private constructor() {}

  encodeControlMessage(message: ControlMessageDraft18): Uint8Array {
    // Will be implemented in the draft-18 message codec
    const { Draft18MessageCodec } = require('./draft18-message-codec.js');
    return Draft18MessageCodec.encode(message);
  }

  decodeControlMessage(buffer: Uint8Array, offset = 0): [ControlMessageDraft18, number] {
    const { Draft18MessageCodec } = require('./draft18-message-codec.js');
    return Draft18MessageCodec.decode(buffer, offset);
  }

  encodeSetupStreamHeader(): Uint8Array {
    // Draft-18: Control stream type is 0x2F00
    return MOQTVarInt.encode(0x2f00);
  }

  decodeSetupStreamHeader(buffer: Uint8Array, offset = 0): [number, number] {
    const [value, bytesRead] = MOQTVarInt.decodeNumber(buffer, offset);
    return [value, bytesRead];
  }

  encodeVarInt(value: number | bigint): Uint8Array {
    return MOQTVarInt.encode(value);
  }

  decodeVarInt(buffer: Uint8Array, offset = 0): [bigint, number] {
    return MOQTVarInt.decode(buffer, offset);
  }

  decodeVarIntNumber(buffer: Uint8Array, offset = 0): [number, number] {
    return MOQTVarInt.decodeNumber(buffer, offset);
  }

  encodeNamespace(namespace: TrackNamespace): Uint8Array {
    const writer = new Draft18BufferWriter();
    writer.writeVarInt(namespace.length);
    for (const element of namespace) {
      const bytes = new TextEncoder().encode(element);
      writer.writeVarInt(bytes.length);
      writer.writeBytes(bytes);
    }
    return writer.toUint8Array();
  }

  decodeNamespace(buffer: Uint8Array, offset = 0): [TrackNamespace, number] {
    const reader = new Draft18BufferReader(buffer, offset);
    const count = reader.readVarIntNumber();
    const namespace: TrackNamespace = [];
    for (let i = 0; i < count; i++) {
      const length = reader.readVarIntNumber();
      const bytes = reader.readBytes(length);
      namespace.push(new TextDecoder().decode(bytes));
    }
    return [namespace, reader.offset - offset];
  }

  encodeFullTrackName(fullTrackName: FullTrackName): Uint8Array {
    const writer = new Draft18BufferWriter();
    // Namespace
    writer.writeVarInt(fullTrackName.namespace.length);
    for (const element of fullTrackName.namespace) {
      const bytes = new TextEncoder().encode(element);
      writer.writeVarInt(bytes.length);
      writer.writeBytes(bytes);
    }
    // Track name
    const trackNameBytes = new TextEncoder().encode(fullTrackName.trackName);
    writer.writeVarInt(trackNameBytes.length);
    writer.writeBytes(trackNameBytes);
    return writer.toUint8Array();
  }

  decodeFullTrackName(buffer: Uint8Array, offset = 0): [FullTrackName, number] {
    const reader = new Draft18BufferReader(buffer, offset);
    // Namespace
    const namespaceCount = reader.readVarIntNumber();
    const namespace: string[] = [];
    for (let i = 0; i < namespaceCount; i++) {
      const length = reader.readVarIntNumber();
      const bytes = reader.readBytes(length);
      namespace.push(new TextDecoder().decode(bytes));
    }
    // Track name
    const trackNameLength = reader.readVarIntNumber();
    const trackNameBytes = reader.readBytes(trackNameLength);
    const trackName = new TextDecoder().decode(trackNameBytes);
    return [{ namespace, trackName }, reader.offset - offset];
  }

  encodeKeyValuePairs(pairs: Map<number, Uint8Array>, _deltaEncoded = true): Uint8Array {
    // Draft-18 always uses delta encoding
    const writer = new Draft18BufferWriter();
    const sortedEntries = Array.from(pairs.entries()).sort((a, b) => a[0] - b[0]);
    let previousKey = 0;

    for (const [key, value] of sortedEntries) {
      writer.writeVarInt(key - previousKey);
      previousKey = key;
      if (key % 2 === 0) {
        // Even key: value is varint bytes directly
        writer.writeBytes(value);
      } else {
        // Odd key: length + bytes
        writer.writeVarInt(value.length);
        writer.writeBytes(value);
      }
    }
    return writer.toUint8Array();
  }

  decodeKeyValuePairs(buffer: Uint8Array, offset = 0, _count?: number): [Map<number, Uint8Array>, number] {
    // Draft-18: Read until end of buffer (no count prefix for properties)
    const reader = new Draft18BufferReader(buffer, offset);
    const pairs = new Map<number, Uint8Array>();
    let previousKey = 0;

    while (reader.hasMore) {
      const deltaKey = reader.readVarIntNumber();
      const key = previousKey + deltaKey;
      previousKey = key;

      if (key % 2 === 0) {
        // Even key: value is a single varint
        const [value, _] = MOQTVarInt.decode(buffer, reader.offset);
        const valueBytes = MOQTVarInt.encode(value);
        reader.skip(MOQTVarInt.encodedLength(value));
        pairs.set(key, valueBytes);
      } else {
        // Odd key: length + bytes
        const length = reader.readVarIntNumber();
        pairs.set(key, reader.readBytes(length));
      }
    }
    return [pairs, reader.offset - offset];
  }

  encodeLocation(location: Location): Uint8Array {
    const writer = new Draft18BufferWriter();
    writer.writeVarInt(location.group);
    writer.writeVarInt(location.object);
    return writer.toUint8Array();
  }

  decodeLocation(buffer: Uint8Array, offset = 0): [Location, number] {
    const reader = new Draft18BufferReader(buffer, offset);
    const group = reader.readVarInt();
    const object = reader.readVarInt();
    return [{ group, object }, reader.offset - offset];
  }
}

/**
 * Buffer writer using MOQT varints for draft-18
 */
export class Draft18BufferWriter {
  private chunks: Uint8Array[] = [];
  private totalLength = 0;

  writeVarInt(value: number | bigint): void {
    const encoded = MOQTVarInt.encode(value);
    this.chunks.push(encoded);
    this.totalLength += encoded.length;
  }

  writeByte(value: number): void {
    const arr = new Uint8Array(1);
    arr[0] = value & 0xff;
    this.chunks.push(arr);
    this.totalLength += 1;
  }

  writeBytes(bytes: Uint8Array): void {
    this.chunks.push(bytes);
    this.totalLength += bytes.length;
  }

  writeString(str: string): void {
    const bytes = new TextEncoder().encode(str);
    this.writeVarInt(bytes.length);
    this.writeBytes(bytes);
  }

  get length(): number {
    return this.totalLength;
  }

  toUint8Array(): Uint8Array {
    const result = new Uint8Array(this.totalLength);
    let offset = 0;
    for (const chunk of this.chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }
}

/**
 * Buffer reader using MOQT varints for draft-18
 */
export class Draft18BufferReader {
  private buffer: Uint8Array;
  private _offset: number;

  constructor(buffer: Uint8Array, offset = 0) {
    this.buffer = buffer;
    this._offset = offset;
  }

  get offset(): number {
    return this._offset;
  }

  get remaining(): number {
    return this.buffer.length - this._offset;
  }

  get hasMore(): boolean {
    return this._offset < this.buffer.length;
  }

  readVarInt(): bigint {
    const [value, bytesRead] = MOQTVarInt.decode(this.buffer, this._offset);
    this._offset += bytesRead;
    return value;
  }

  readVarIntNumber(): number {
    const [value, bytesRead] = MOQTVarInt.decodeNumber(this.buffer, this._offset);
    this._offset += bytesRead;
    return value;
  }

  readByte(): number {
    if (this._offset >= this.buffer.length) {
      throw new Error('Buffer underflow');
    }
    return this.buffer[this._offset++];
  }

  readBytes(length: number): Uint8Array {
    if (this._offset + length > this.buffer.length) {
      throw new Error(`Buffer underflow: need ${length} bytes, have ${this.remaining}`);
    }
    const result = this.buffer.subarray(this._offset, this._offset + length);
    this._offset += length;
    return result;
  }

  readString(): string {
    const length = this.readVarIntNumber();
    const bytes = this.readBytes(length);
    return new TextDecoder().decode(bytes);
  }

  skip(bytes: number): void {
    this._offset += bytes;
  }
}

export { Draft14Codec, Draft18Codec };
