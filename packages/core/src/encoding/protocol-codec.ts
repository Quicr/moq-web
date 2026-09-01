// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Protocol codec abstraction for version-specific encoding/decoding.
 *
 * IProtocolCodec is the single seam between session-layer code and the wire
 * format. Callers ask a codec to encode/decode; each version implements the
 * interface without leaking version conditionals to callers.
 *
 * Today the codec classes delegate to the legacy static MessageCodec /
 * Draft18MessageCodec / Draft18StreamCodec entry points; those still contain
 * per-version branches internally. Follow-up work will move the per-version
 * bodies into the respective codec class so that Draft16Codec never mentions
 * draft-18 and vice versa.
 */

import { IS_DRAFT_18 } from '../version/constants.js';
import { Version } from '../messages/types.js';
import type {
  ControlMessage,
  ControlMessageDraft18,
  TrackNamespace,
  FullTrackName,
  Location,
  ObjectHeader,
  MOQTObject,
  ObjectStatus,
  SubgroupHeader,
  FetchHeader,
  ClientSetupMessageDraft18,
  ServerSetupMessageDraft18,
} from '../messages/types.js';
import { MessageCodec, ObjectCodec } from './message-codec.js';
import type {
  FetchEncoderState,
  FetchDecoderState,
  FetchObjectResult,
} from './message-codec.js';
import { Draft18MessageCodec } from './draft18-message-codec.js';

/**
 * Capability flags exposed by a codec. Session-layer code can use these to
 * decide whether a feature is available without checking the wire version.
 */
export interface ProtocolCodecCapabilities {
  /** Setup handshake uses a dedicated setup stream (draft-18) rather than the
   *  first control-stream messages (draft-16/17). */
  readonly usesSetupStream: boolean;
  /** Each SUBSCRIBE / PUBLISH / etc. request opens its own bidi stream. */
  readonly perRequestBidiStream: boolean;
  /** Unsubscribe is expressed as REQUEST_UPDATE with forwardState=false. */
  readonly usesRequestUpdateForUnsubscribe: boolean;
  /** Wire format uses MOQT varints (draft-18) rather than QUIC varints. */
  readonly usesMoqtVarInt: boolean;
  /** SUBSCRIBE_OK / PUBLISH_DONE return unified Location fields (group+object). */
  readonly usesUnifiedLocation: boolean;
  /** Namespace-scoped responses include a requestId (draft-16 draft change). */
  readonly namespaceResponsesCarryRequestId: boolean;
}

/**
 * Common interface for protocol-version-specific codecs.
 *
 * Methods are intentionally narrow — they cover what session / stream /
 * datagram managers actually call. Version-shape mismatches (e.g. draft-18
 * `ControlMessageDraft18` vs draft-16 `ControlMessage`) are surfaced through
 * union return types; the caller narrows using `codec.version`.
 */
export interface IProtocolCodec {
  readonly version: Version;
  readonly capabilities: ProtocolCodecCapabilities;

  // ---- Control messages ----
  encodeControlMessage(message: ControlMessage | ControlMessageDraft18): Uint8Array;
  decodeControlMessage(
    buffer: Uint8Array,
    offset?: number,
  ): [ControlMessage | ControlMessageDraft18, number];

  // ---- Setup stream (draft-18) ----
  /** Encode the setup-stream client SETUP frame. Draft-16 codec throws. */
  encodeSetupStream(message: ClientSetupMessageDraft18): Uint8Array;
  /** Decode the setup-stream server SETUP frame. Draft-16 codec throws. */
  decodeSetupStream(buffer: Uint8Array, offset?: number): [ServerSetupMessageDraft18, number];
  /** Encode the leading byte(s) of the setup stream (stream type). */
  encodeSetupStreamHeader(): Uint8Array;
  decodeSetupStreamHeader(buffer: Uint8Array, offset?: number): [number, number];

  // ---- Subgroup streams ----
  encodeSubgroupHeader(header: SubgroupHeader, endOfGroup?: boolean): [Uint8Array, boolean];
  decodeSubgroupHeader(buffer: Uint8Array): [SubgroupHeader, number, boolean, boolean];
  encodeStreamObject(
    objectId: number,
    payload: Uint8Array,
    status?: ObjectStatus,
    previousObjectId?: number,
    hasExtensions?: boolean,
    extensions?: Map<number, number | Uint8Array>,
  ): Uint8Array;
  decodeStreamObject(
    buffer: Uint8Array,
    offset?: number,
    hasExtensions?: boolean,
    previousObjectId?: number,
  ): [number, Uint8Array, ObjectStatus, number];

  // ---- Datagrams ----
  encodeDatagramHeader(header: ObjectHeader): Uint8Array;
  decodeDatagramHeader(buffer: Uint8Array): [ObjectHeader, number];
  encodeDatagramObject(object: MOQTObject): Uint8Array;
  decodeDatagramObject(buffer: Uint8Array): MOQTObject;

  // ---- Fetch streams ----
  encodeFetchHeader(header: FetchHeader): Uint8Array;
  decodeFetchHeader(buffer: Uint8Array): [FetchHeader, number];
  createFetchEncoderState(): FetchEncoderState;
  createFetchDecoderState(): FetchDecoderState;
  encodeFetchObject(
    groupId: number,
    subgroupId: number,
    objectId: number,
    payload: Uint8Array,
    state: FetchEncoderState,
    priority?: number,
  ): Uint8Array;
  decodeFetchObject(buffer: Uint8Array, state: FetchDecoderState): FetchObjectResult;

  // ---- Primitives ----
  encodeVarInt(value: number | bigint): Uint8Array;
  decodeVarInt(buffer: Uint8Array, offset?: number): [bigint, number];
  decodeVarIntNumber(buffer: Uint8Array, offset?: number): [number, number];

  encodeNamespace(namespace: TrackNamespace): Uint8Array;
  decodeNamespace(buffer: Uint8Array, offset?: number): [TrackNamespace, number];
  encodeFullTrackName(fullTrackName: FullTrackName): Uint8Array;
  decodeFullTrackName(buffer: Uint8Array, offset?: number): [FullTrackName, number];

  encodeKeyValuePairs(pairs: Map<number, Uint8Array>, deltaEncoded?: boolean): Uint8Array;
  decodeKeyValuePairs(
    buffer: Uint8Array,
    offset?: number,
    count?: number,
  ): [Map<number, Uint8Array>, number];
}

/**
 * Get the protocol codec for the current build configuration.
 *
 * Today this is driven by the compile-time IS_DRAFT_18 flag. When we move to
 * runtime version negotiation, this becomes a lookup keyed on the negotiated
 * version.
 */
export function getProtocolCodec(): IProtocolCodec {
  if (IS_DRAFT_18) {
    return Draft18Codec.instance;
  }
  return Draft16Codec.instance;
}

/**
 * Get a protocol codec for a specific version. Prefer `getProtocolCodec()`
 * unless you need to encode/decode against a peer with a different version.
 */
export function getProtocolCodecForVersion(version: Version): IProtocolCodec {
  switch (version) {
    case Version.DRAFT_18:
    case Version.DRAFT_17:
      return Draft18Codec.instance;
    case Version.DRAFT_16:
    default:
      return Draft16Codec.instance;
  }
}

/**
 * Check if the current build uses MOQT varints (draft-18).
 * @deprecated Prefer `getProtocolCodec().capabilities.usesMoqtVarInt`.
 */
export function usesMoqtVarInt(): boolean {
  return IS_DRAFT_18;
}

/**
 * Check if the current build uses QUIC varints (draft-16/17).
 * @deprecated Prefer `!getProtocolCodec().capabilities.usesMoqtVarInt`.
 */
export function usesQuicVarInt(): boolean {
  return !IS_DRAFT_18;
}

// Import the actual codec implementations
import { VarInt, BufferReader, BufferWriter } from './varint.js';
import { MOQTVarInt } from './moqt-varint.js';
import { Draft18StreamCodec } from './draft18-stream-codec.js';

const NOT_SUPPORTED_DRAFT16 = 'Setup-stream encode/decode is draft-18-only';

/**
 * Draft-16 / draft-17 codec.
 *
 * Delegates to MessageCodec / ObjectCodec. Those classes still contain
 * per-version branches internally; they will be pared down to draft-16-only
 * bodies in a follow-up as callers stop reaching for the static entry points
 * directly.
 */
class Draft16Codec implements IProtocolCodec {
  static readonly instance = new Draft16Codec();
  readonly version = Version.DRAFT_16;
  readonly capabilities: ProtocolCodecCapabilities = {
    usesSetupStream: false,
    perRequestBidiStream: false,
    usesRequestUpdateForUnsubscribe: false,
    usesMoqtVarInt: false,
    usesUnifiedLocation: false,
    namespaceResponsesCarryRequestId: true,
  };

  private constructor() {}

  // ---- Control messages ----
  encodeControlMessage(message: ControlMessage): Uint8Array {
    return MessageCodec.encode(message);
  }

  decodeControlMessage(buffer: Uint8Array, offset = 0): [ControlMessage, number] {
    return MessageCodec.decode(buffer, offset);
  }

  // ---- Setup stream (unsupported on draft-16) ----
  encodeSetupStream(_message: ClientSetupMessageDraft18): Uint8Array {
    throw new Error(NOT_SUPPORTED_DRAFT16);
  }

  decodeSetupStream(_buffer: Uint8Array, _offset = 0): [ServerSetupMessageDraft18, number] {
    throw new Error(NOT_SUPPORTED_DRAFT16);
  }

  encodeSetupStreamHeader(): Uint8Array {
    // Draft-16: Control stream starts with stream type 0x40
    return VarInt.encode(0x40);
  }

  decodeSetupStreamHeader(buffer: Uint8Array, offset = 0): [number, number] {
    return VarInt.decodeNumber(buffer, offset);
  }

  // ---- Subgroup streams ----
  encodeSubgroupHeader(header: SubgroupHeader, endOfGroup = false): [Uint8Array, boolean] {
    return ObjectCodec.encodeSubgroupHeader(header, endOfGroup);
  }

  decodeSubgroupHeader(buffer: Uint8Array): [SubgroupHeader, number, boolean, boolean] {
    return ObjectCodec.decodeSubgroupHeader(buffer);
  }

  encodeStreamObject(
    objectId: number,
    payload: Uint8Array,
    status?: ObjectStatus,
    previousObjectId?: number,
    hasExtensions?: boolean,
    extensions?: Map<number, number | Uint8Array>,
  ): Uint8Array {
    return ObjectCodec.encodeStreamObject(
      objectId,
      payload,
      status,
      previousObjectId,
      hasExtensions,
      extensions,
    );
  }

  decodeStreamObject(
    buffer: Uint8Array,
    offset = 0,
    hasExtensions = true,
    previousObjectId = -1,
  ): [number, Uint8Array, ObjectStatus, number] {
    return ObjectCodec.decodeStreamObject(buffer, offset, hasExtensions, previousObjectId);
  }

  // ---- Datagrams ----
  encodeDatagramHeader(header: ObjectHeader): Uint8Array {
    return ObjectCodec.encodeDatagramHeader(header);
  }

  decodeDatagramHeader(buffer: Uint8Array): [ObjectHeader, number] {
    return ObjectCodec.decodeDatagramHeader(buffer);
  }

  encodeDatagramObject(object: MOQTObject): Uint8Array {
    return ObjectCodec.encodeDatagramObject(object);
  }

  decodeDatagramObject(buffer: Uint8Array): MOQTObject {
    return ObjectCodec.decodeDatagramObject(buffer);
  }

  // ---- Fetch streams ----
  encodeFetchHeader(header: FetchHeader): Uint8Array {
    return ObjectCodec.encodeFetchHeader(header);
  }

  decodeFetchHeader(buffer: Uint8Array): [FetchHeader, number] {
    return ObjectCodec.decodeFetchHeader(buffer);
  }

  createFetchEncoderState(): FetchEncoderState {
    return ObjectCodec.createFetchEncoderState();
  }

  createFetchDecoderState(): FetchDecoderState {
    return ObjectCodec.createFetchDecoderState();
  }

  encodeFetchObject(
    groupId: number,
    subgroupId: number,
    objectId: number,
    payload: Uint8Array,
    state: FetchEncoderState,
    priority = 128,
  ): Uint8Array {
    return ObjectCodec.encodeFetchObject(groupId, subgroupId, objectId, payload, state, priority);
  }

  decodeFetchObject(buffer: Uint8Array, state: FetchDecoderState): FetchObjectResult {
    return ObjectCodec.decodeFetchObject(buffer, state);
  }

  // ---- Primitives ----
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

    if (deltaEncoded) {
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

  decodeKeyValuePairs(
    buffer: Uint8Array,
    offset = 0,
    count?: number,
  ): [Map<number, Uint8Array>, number] {
    const reader = new BufferReader(buffer, offset);
    const pairCount = count ?? reader.readVarIntNumber();
    const pairs = new Map<number, Uint8Array>();

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
    return [pairs, reader.offset - offset];
  }
}

/**
 * Draft-18 codec.
 *
 * Delegates control-message encoding to Draft18MessageCodec and stream-level
 * encoding to Draft18StreamCodec. Wraps shape differences (ObjectHeader with
 * absolute IDs vs draft-18's delta-based header) at this seam so session-layer
 * code doesn't need to know.
 */
class Draft18Codec implements IProtocolCodec {
  static readonly instance = new Draft18Codec();
  readonly version = Version.DRAFT_18;
  readonly capabilities: ProtocolCodecCapabilities = {
    usesSetupStream: true,
    perRequestBidiStream: true,
    usesRequestUpdateForUnsubscribe: true,
    usesMoqtVarInt: true,
    usesUnifiedLocation: true,
    namespaceResponsesCarryRequestId: false,
  };

  private constructor() {}

  // ---- Control messages ----
  encodeControlMessage(message: ControlMessageDraft18): Uint8Array {
    return Draft18MessageCodec.encode(message);
  }

  decodeControlMessage(buffer: Uint8Array, offset = 0): [ControlMessageDraft18, number] {
    return Draft18MessageCodec.decode(buffer, offset);
  }

  // ---- Setup stream ----
  encodeSetupStream(message: ClientSetupMessageDraft18): Uint8Array {
    return Draft18MessageCodec.encodeSetupStream(message);
  }

  decodeSetupStream(buffer: Uint8Array, offset = 0): [ServerSetupMessageDraft18, number] {
    return Draft18MessageCodec.decodeSetupStream(buffer, offset);
  }

  encodeSetupStreamHeader(): Uint8Array {
    return Draft18StreamCodec.encodeSetupStreamHeader();
  }

  decodeSetupStreamHeader(buffer: Uint8Array, offset = 0): [number, number] {
    return Draft18StreamCodec.decodeSetupStreamHeader(buffer, offset);
  }

  // ---- Subgroup streams ----
  encodeSubgroupHeader(header: SubgroupHeader, endOfGroup = false): [Uint8Array, boolean] {
    // ObjectCodec.encodeSubgroupHeader already dispatches to Draft18StreamCodec
    // when IS_DRAFT_18 is set. Route through it for now — moving the draft-18
    // body into this method is a follow-up cleanup.
    return ObjectCodec.encodeSubgroupHeader(header, endOfGroup);
  }

  decodeSubgroupHeader(buffer: Uint8Array): [SubgroupHeader, number, boolean, boolean] {
    return ObjectCodec.decodeSubgroupHeader(buffer);
  }

  encodeStreamObject(
    objectId: number,
    payload: Uint8Array,
    status?: ObjectStatus,
    previousObjectId?: number,
    hasExtensions?: boolean,
    extensions?: Map<number, number | Uint8Array>,
  ): Uint8Array {
    return ObjectCodec.encodeStreamObject(
      objectId,
      payload,
      status,
      previousObjectId,
      hasExtensions,
      extensions,
    );
  }

  decodeStreamObject(
    buffer: Uint8Array,
    offset = 0,
    hasExtensions = true,
    previousObjectId = -1,
  ): [number, Uint8Array, ObjectStatus, number] {
    return ObjectCodec.decodeStreamObject(buffer, offset, hasExtensions, previousObjectId);
  }

  // ---- Datagrams ----
  encodeDatagramHeader(header: ObjectHeader): Uint8Array {
    return ObjectCodec.encodeDatagramHeader(header);
  }

  decodeDatagramHeader(buffer: Uint8Array): [ObjectHeader, number] {
    return ObjectCodec.decodeDatagramHeader(buffer);
  }

  encodeDatagramObject(object: MOQTObject): Uint8Array {
    return ObjectCodec.encodeDatagramObject(object);
  }

  decodeDatagramObject(buffer: Uint8Array): MOQTObject {
    return ObjectCodec.decodeDatagramObject(buffer);
  }

  // ---- Fetch streams ----
  encodeFetchHeader(header: FetchHeader): Uint8Array {
    return ObjectCodec.encodeFetchHeader(header);
  }

  decodeFetchHeader(buffer: Uint8Array): [FetchHeader, number] {
    return ObjectCodec.decodeFetchHeader(buffer);
  }

  createFetchEncoderState(): FetchEncoderState {
    return ObjectCodec.createFetchEncoderState();
  }

  createFetchDecoderState(): FetchDecoderState {
    return ObjectCodec.createFetchDecoderState();
  }

  encodeFetchObject(
    groupId: number,
    subgroupId: number,
    objectId: number,
    payload: Uint8Array,
    state: FetchEncoderState,
    priority = 128,
  ): Uint8Array {
    return ObjectCodec.encodeFetchObject(groupId, subgroupId, objectId, payload, state, priority);
  }

  decodeFetchObject(buffer: Uint8Array, state: FetchDecoderState): FetchObjectResult {
    return ObjectCodec.decodeFetchObject(buffer, state);
  }

  // ---- Primitives ----
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
    writer.writeVarInt(fullTrackName.namespace.length);
    for (const element of fullTrackName.namespace) {
      const bytes = new TextEncoder().encode(element);
      writer.writeVarInt(bytes.length);
      writer.writeBytes(bytes);
    }
    const trackNameBytes = new TextEncoder().encode(fullTrackName.trackName);
    writer.writeVarInt(trackNameBytes.length);
    writer.writeBytes(trackNameBytes);
    return writer.toUint8Array();
  }

  decodeFullTrackName(buffer: Uint8Array, offset = 0): [FullTrackName, number] {
    const reader = new Draft18BufferReader(buffer, offset);
    const namespaceCount = reader.readVarIntNumber();
    const namespace: string[] = [];
    for (let i = 0; i < namespaceCount; i++) {
      const length = reader.readVarIntNumber();
      const bytes = reader.readBytes(length);
      namespace.push(new TextDecoder().decode(bytes));
    }
    const trackNameLength = reader.readVarIntNumber();
    const trackNameBytes = reader.readBytes(trackNameLength);
    const trackName = new TextDecoder().decode(trackNameBytes);
    return [{ namespace, trackName }, reader.offset - offset];
  }

  encodeKeyValuePairs(pairs: Map<number, Uint8Array>, _deltaEncoded = true): Uint8Array {
    // Draft-18 always uses delta encoding.
    const writer = new Draft18BufferWriter();
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
    return writer.toUint8Array();
  }

  decodeKeyValuePairs(
    buffer: Uint8Array,
    offset = 0,
    _count?: number,
  ): [Map<number, Uint8Array>, number] {
    // Draft-18: read until end of buffer (no count prefix for properties).
    const reader = new Draft18BufferReader(buffer, offset);
    const pairs = new Map<number, Uint8Array>();
    let previousKey = 0;

    while (reader.hasMore) {
      const deltaKey = reader.readVarIntNumber();
      const key = previousKey + deltaKey;
      previousKey = key;

      if (key % 2 === 0) {
        const [value, _] = MOQTVarInt.decode(buffer, reader.offset);
        const valueBytes = MOQTVarInt.encode(value);
        reader.skip(MOQTVarInt.encodedLength(value));
        pairs.set(key, valueBytes);
      } else {
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
 * Buffer writer using MOQT varints for draft-18.
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
 * Buffer reader using MOQT varints for draft-18.
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

export { Draft16Codec, Draft18Codec };
