// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Draft-22 Message Encoding and Decoding
 *
 * Extends draft-18 wire format with draft-22 additions.
 * Delegates to Draft18MessageCodec for all shared message types.
 *
 * Differences from draft-18:
 * - PUBLISH_SKIPPED (0x0F) replaces PUBLISH_BLOCKED with different format
 * - PUBLISH_STATE_NOTIFY (0x22) is a new message type
 * - New setup options: MAX_FILTER_RANGES, MAX_REQUEST_UPDATES
 * - New parameters: LOCATION_FILTER, FILL_PARAMETERS, range filters, INCLUDE_PROPERTIES
 */

import { MOQTVarInt } from './moqt-varint.js';
import { Draft18BufferWriter, Draft18BufferReader } from './protocol-codec.js';
import { Draft18MessageCodec, Draft18CodecError, MAX_PARAMETER_COUNT, MAX_STRING_LENGTH, MAX_NAMESPACE_TUPLE_COUNT, MAX_TRACK_NAME_LENGTH } from './draft18-message-codec.js';
import {
  MessageTypeDraft18,
  MessageTypeDraft22,
  LocationFilterTypeDraft22,
  RequestParameterDraft22,
  type ControlMessageDraft18,
  type ControlMessageDraft22,
  type ClientSetupMessageDraft18,
  type ServerSetupMessageDraft18,
  type SubscribeMessageDraft18,
  type PublishSkippedMessageDraft22,
  type PublishStateNotifyMessageDraft22,
  type TrackNamespace,
  type Location,
} from '../messages/types.js';

// Module-level singletons
const TE = new TextEncoder();
const TD = new TextDecoder();

function assertBound(
  actual: number,
  limit: number,
  what: string,
): void {
  if (!Number.isFinite(actual) || actual < 0 || actual > limit) {
    throw new Draft18CodecError(
      `${what} ${actual} exceeds safety bound ${limit}`,
      undefined,
      'bounds-exceeded',
    );
  }
}

/**
 * Draft-22 Message Codec
 *
 * For messages shared with draft-18 (the vast majority), delegates directly
 * to Draft18MessageCodec. Only PUBLISH_SKIPPED and PUBLISH_STATE_NOTIFY
 * have different wire formats.
 */
export class Draft22MessageCodec {
  /**
   * Encode a draft-22 control message to bytes.
   * Delegates to Draft18MessageCodec for shared message types.
   */
  static encode(message: ControlMessageDraft22): Uint8Array {
    switch (message.type) {
      case MessageTypeDraft22.PUBLISH_SKIPPED:
        return Draft22MessageCodec.encodeFramed(
          message.type,
          (w) => Draft22MessageCodec.encodePublishSkipped(w, message as PublishSkippedMessageDraft22),
        );
      case MessageTypeDraft22.PUBLISH_STATE_NOTIFY:
        return Draft22MessageCodec.encodeFramed(
          message.type,
          (w) => Draft22MessageCodec.encodePublishStateNotify(w, message as PublishStateNotifyMessageDraft22),
        );
      case MessageTypeDraft18.SUBSCRIBE:
        return Draft22MessageCodec.encodeSubscribeDraft22(message as unknown as SubscribeMessageDraft18);
      default:
        // All other messages share draft-18 wire format
        return Draft18MessageCodec.encode(message as unknown as ControlMessageDraft18);
    }
  }

  /**
   * Decode a draft-22 control message from bytes.
   * Delegates to Draft18MessageCodec for shared message types.
   * Overrides SUBSCRIBE decode to handle draft-22 LOCATION_FILTER encoding.
   */
  static decode(buffer: Uint8Array, offset = 0): [ControlMessageDraft22, number] {
    // Peek at message type to decide which codec to use
    const [typeValue] = MOQTVarInt.decodeNumber(buffer, offset);

    switch (typeValue) {
      case MessageTypeDraft22.PUBLISH_SKIPPED:
        return Draft22MessageCodec.decodeFramed(buffer, offset, (reader) =>
          Draft22MessageCodec.decodePublishSkipped(reader),
        );
      case MessageTypeDraft22.PUBLISH_STATE_NOTIFY:
        return Draft22MessageCodec.decodeFramed(buffer, offset, (reader) =>
          Draft22MessageCodec.decodePublishStateNotify(reader),
        );
      case MessageTypeDraft22.SUBSCRIBE:
        return Draft22MessageCodec.decodeFramed(buffer, offset, (reader) =>
          Draft22MessageCodec.decodeSubscribeDraft22(reader),
        );
      default: {
        // Delegate to draft-18 for all shared messages
        const [msg, bytesRead] = Draft18MessageCodec.decode(buffer, offset);
        return [msg as unknown as ControlMessageDraft22, bytesRead];
      }
    }
  }

  /**
   * Setup stream encoding/decoding - identical to draft-18
   */
  static encodeSetupStream(message: ClientSetupMessageDraft18): Uint8Array {
    return Draft18MessageCodec.encodeSetupStream(message);
  }

  static decodeSetupStream(buffer: Uint8Array, offset = 0): [ServerSetupMessageDraft18, number] {
    return Draft18MessageCodec.decodeSetupStream(buffer, offset);
  }

  // ============================================================================
  // Draft-22 Framing Helpers
  // ============================================================================

  private static encodeFramed(
    messageType: number,
    encodePayload: (writer: Draft18BufferWriter) => void,
  ): Uint8Array {
    const payloadWriter = new Draft18BufferWriter();
    encodePayload(payloadWriter);
    const payload = payloadWriter.toUint8Array();

    const typeBytes = MOQTVarInt.encode(BigInt(messageType));
    const result = new Uint8Array(typeBytes.length + 2 + payload.length);
    result.set(typeBytes, 0);
    result[typeBytes.length] = (payload.length >> 8) & 0xFF;
    result[typeBytes.length + 1] = payload.length & 0xFF;
    result.set(payload, typeBytes.length + 2);
    return result;
  }

  private static decodeFramed<T extends ControlMessageDraft22>(
    buffer: Uint8Array,
    offset: number,
    decodePayload: (reader: Draft18BufferReader) => T,
  ): [T, number] {
    const [, typeBytesRead] = MOQTVarInt.decodeNumber(buffer, offset);

    if (buffer.length < offset + typeBytesRead + 2) {
      throw new Draft18CodecError('Incomplete message: missing length field');
    }
    const payloadLength = (buffer[offset + typeBytesRead] << 8) | buffer[offset + typeBytesRead + 1];
    const headerSize = typeBytesRead + 2;

    if (buffer.length < offset + headerSize + payloadLength) {
      throw new Draft18CodecError('Incomplete message: not enough payload bytes');
    }

    const reader = new Draft18BufferReader(
      buffer.subarray(offset + headerSize, offset + headerSize + payloadLength),
    );

    const message = decodePayload(reader);
    return [message, headerSize + payloadLength];
  }

  // ============================================================================
  // PUBLISH_SKIPPED (0x0F) - Draft-22 replaces PUBLISH_BLOCKED
  // ============================================================================

  private static encodePublishSkipped(writer: Draft18BufferWriter, message: PublishSkippedMessageDraft22): void {
    // Track Namespace Suffix | Track Name Length | Track Name
    Draft22MessageCodec.encodeTrackNamespace(writer, message.trackNamespaceSuffix);
    Draft22MessageCodec.encodeString(writer, message.trackName);
  }

  private static decodePublishSkipped(reader: Draft18BufferReader): PublishSkippedMessageDraft22 {
    const trackNamespaceSuffix = Draft22MessageCodec.decodeTrackNamespace(reader);
    const trackName = Draft22MessageCodec.decodeTrackName(reader);

    return {
      type: MessageTypeDraft22.PUBLISH_SKIPPED,
      trackNamespaceSuffix,
      trackName,
    };
  }

  // ============================================================================
  // PUBLISH_STATE_NOTIFY (0x22) - New in draft-22
  // ============================================================================

  private static encodePublishStateNotify(writer: Draft18BufferWriter, message: PublishStateNotifyMessageDraft22): void {
    // Number of Parameters (vi64) | Parameters (..)
    const params = message.parameters ?? new Map<number, Uint8Array>();
    const sortedEntries = Array.from(params.entries()).sort((a, b) => a[0] - b[0]);
    writer.writeVarInt(BigInt(sortedEntries.length));
    let previousType = 0;
    for (const [key, value] of sortedEntries) {
      writer.writeVarInt(BigInt(key - previousType));
      previousType = key;
      // Use KVP encoding: even keys = varint value (raw bytes), odd keys = length-prefixed
      if (key % 2 === 0) {
        writer.writeBytes(value);
      } else {
        writer.writeVarInt(value.length);
        writer.writeBytes(value);
      }
    }
  }

  private static decodePublishStateNotify(reader: Draft18BufferReader): PublishStateNotifyMessageDraft22 {
    const numParams = reader.readVarIntNumber();
    assertBound(numParams, MAX_PARAMETER_COUNT, 'PUBLISH_STATE_NOTIFY numParams');

    const parameters = new Map<number, Uint8Array>();
    let previousType = 0;
    for (let i = 0; i < numParams; i++) {
      const delta = reader.readVarIntNumber();
      const type = previousType + delta;
      previousType = type;

      if (type % 2 === 0) {
        // Even type: varint value
        const value = reader.readVarInt();
        parameters.set(type, MOQTVarInt.encode(value));
      } else {
        // Odd type: length-prefixed value
        const length = reader.readVarIntNumber();
        assertBound(length, MAX_STRING_LENGTH, 'PUBLISH_STATE_NOTIFY param length');
        parameters.set(type, reader.readBytes(length));
      }
    }

    return {
      type: MessageTypeDraft22.PUBLISH_STATE_NOTIFY,
      parameters,
    };
  }

  // ============================================================================
  // SUBSCRIBE decode — draft-22 uses LOCATION_FILTER instead of SUBSCRIPTION_FILTER
  // ============================================================================

  private static decodeSubscribeDraft22(reader: Draft18BufferReader): SubscribeMessageDraft18 {
    const requestId = reader.readVarInt();
    const trackNamespace = Draft22MessageCodec.decodeTrackNamespace(reader);
    const trackName = Draft22MessageCodec.decodeTrackName(reader);

    const numParams = reader.readVarIntNumber();
    assertBound(numParams, MAX_PARAMETER_COUNT, 'SUBSCRIBE numParams');

    // Default: no filter (draft-22 NONE = 0x00 maps to NEXT_GROUP_START for compat)
    let filter = 1; // NEXT_GROUP_START / RELATIVE_START
    let startLocation: Location | undefined;
    let endGroupDelta: bigint | undefined;
    const parameters = new Map<number, Uint8Array>();

    let previousType = 0;
    for (let i = 0; i < numParams; i++) {
      const delta = reader.readVarIntNumber();
      const type = previousType + delta;
      previousType = type;

      if (type === RequestParameterDraft22.LOCATION_FILTER) {
        // Draft-22 §9.20.9: LOCATION_FILTER uses the 6-mode encoding
        const filterType = reader.readVarIntNumber();
        filter = filterType;

        switch (filterType) {
          case LocationFilterTypeDraft22.NONE:
          case LocationFilterTypeDraft22.NEXT_OBJECT:
            // No additional fields
            break;
          case LocationFilterTypeDraft22.RELATIVE_START:
            // StartGroup (relative)
            startLocation = { group: reader.readVarInt(), object: 0n };
            break;
          case LocationFilterTypeDraft22.ABSOLUTE_START:
            // StartGroup, StartObject
            startLocation = { group: reader.readVarInt(), object: reader.readVarInt() };
            break;
          case LocationFilterTypeDraft22.ABSOLUTE_START_GROUP_END:
            // StartGroup, StartObject, EndGroupDelta
            startLocation = { group: reader.readVarInt(), object: reader.readVarInt() };
            endGroupDelta = reader.readVarInt();
            break;
          case LocationFilterTypeDraft22.ABSOLUTE_RANGE:
            // StartGroup, StartObject, EndGroupDelta, EndObject
            startLocation = { group: reader.readVarInt(), object: reader.readVarInt() };
            endGroupDelta = reader.readVarInt();
            reader.readVarInt(); // EndObject — consumed but stored in parameters for passthrough
            break;
          default:
            throw new Draft18CodecError(`Unknown LOCATION_FILTER type: ${filterType}`);
        }
      } else {
        // Read parameter value based on draft-22 rules
        const value = Draft22MessageCodec.readParameterValue(reader, type);
        parameters.set(type, value);
      }
    }

    return {
      type: MessageTypeDraft18.SUBSCRIBE,
      requestId,
      trackNamespace,
      trackName,
      forwardState: true,
      filter,
      startLocation,
      endGroupDelta,
      parameters: parameters.size > 0 ? parameters : undefined,
    };
  }

  // ============================================================================
  // Draft-22 Parameter Value Reading
  // ============================================================================

  /**
   * Read a parameter value based on draft-22 type rules.
   * Handles new parameter types (INCLUDE_PROPERTIES, range filters, FILL_PARAMETERS).
   * Falls through to draft-18 compatible reading for shared types.
   */
  private static readParameterValue(reader: Draft18BufferReader, type: number): Uint8Array {
    switch (type) {
      // uint8 parameters
      case RequestParameterDraft22.FORWARD:
      case RequestParameterDraft22.SUBSCRIBER_PRIORITY:
      case RequestParameterDraft22.GROUP_ORDER:
      case RequestParameterDraft22.INCLUDE_PROPERTIES: {
        const b = reader.readByte();
        return new Uint8Array([b]);
      }

      // varint parameters
      case RequestParameterDraft22.EXPIRES:
      case RequestParameterDraft22.OBJECT_DELIVERY_TIMEOUT:
      case RequestParameterDraft22.SUBGROUP_DELIVERY_TIMEOUT:
      case RequestParameterDraft22.RENDEZVOUS_TIMEOUT:
      case RequestParameterDraft22.FILL_TIMEOUT:
      case RequestParameterDraft22.NEW_GROUP_REQUEST:
        return MOQTVarInt.encode(reader.readVarInt());

      // Location (two varints)
      case RequestParameterDraft22.LARGEST_OBJECT: {
        const g = reader.readVarInt();
        const o = reader.readVarInt();
        const gBytes = MOQTVarInt.encode(g);
        const oBytes = MOQTVarInt.encode(o);
        const result = new Uint8Array(gBytes.length + oBytes.length);
        result.set(gBytes, 0);
        result.set(oBytes, gBytes.length);
        return result;
      }

      // Length-prefixed auth token
      case RequestParameterDraft22.AUTHORIZATION_TOKEN: {
        const length = reader.readVarIntNumber();
        assertBound(length, 16384, 'AUTHORIZATION_TOKEN parameter length');
        return reader.readBytes(length);
      }

      // Length-prefixed structured parameters (range filters, fill params, etc.)
      case RequestParameterDraft22.FILL_PARAMETERS:
      case RequestParameterDraft22.SUBGROUP_FILTER:
      case RequestParameterDraft22.OBJECTID_FILTER:
      case RequestParameterDraft22.PRIORITY_FILTER:
      case RequestParameterDraft22.OBJECT_PROPERTY_FILTER:
      case RequestParameterDraft22.TRACK_PROPERTY_FILTER:
      case RequestParameterDraft22.TRACK_NAMESPACE_PREFIX: {
        const length = reader.readVarIntNumber();
        assertBound(length, MAX_STRING_LENGTH, `parameter 0x${type.toString(16)} value length`);
        return reader.readBytes(length);
      }

      // Default: length-prefixed for odd, varint for even
      default: {
        if (type % 2 === 0) {
          return MOQTVarInt.encode(reader.readVarInt());
        }
        const length = reader.readVarIntNumber();
        assertBound(length, MAX_STRING_LENGTH, 'parameter value length');
        return reader.readBytes(length);
      }
    }
  }

  // ============================================================================
  // SUBSCRIBE encode — draft-22 uses LOCATION_FILTER
  // ============================================================================

  /**
   * Encode SUBSCRIBE with draft-22 LOCATION_FILTER encoding.
   */
  static encodeSubscribeDraft22(message: SubscribeMessageDraft18): Uint8Array {
    return Draft22MessageCodec.encodeFramed(MessageTypeDraft22.SUBSCRIBE, (w) => {
      w.writeVarInt(message.requestId);
      Draft22MessageCodec.encodeTrackNamespace(w, message.trackNamespace);
      Draft22MessageCodec.encodeString(w, message.trackName);

      const params: Array<{ type: number; encode: (pw: Draft18BufferWriter) => void }> = [];

      // FORWARD (0x10)
      if (message.forwardState !== false) {
        params.push({ type: RequestParameterDraft22.FORWARD, encode: (pw) => pw.writeByte(0x01) });
      }

      // LOCATION_FILTER (0x21) — draft-22 6-mode encoding
      if (message.filter !== undefined) {
        params.push({
          type: RequestParameterDraft22.LOCATION_FILTER,
          encode: (pw) => {
            pw.writeVarInt(BigInt(message.filter));
            const ft = message.filter as number;
            if (ft === LocationFilterTypeDraft22.RELATIVE_START) {
              pw.writeVarInt(message.startLocation?.group ?? 0n);
            } else if (ft === LocationFilterTypeDraft22.ABSOLUTE_START) {
              pw.writeVarInt(message.startLocation?.group ?? 0n);
              pw.writeVarInt(message.startLocation?.object ?? 0n);
            } else if (ft === LocationFilterTypeDraft22.ABSOLUTE_START_GROUP_END) {
              pw.writeVarInt(message.startLocation?.group ?? 0n);
              pw.writeVarInt(message.startLocation?.object ?? 0n);
              pw.writeVarInt(message.endGroupDelta ?? 0n);
            } else if (ft === LocationFilterTypeDraft22.ABSOLUTE_RANGE) {
              pw.writeVarInt(message.startLocation?.group ?? 0n);
              pw.writeVarInt(message.startLocation?.object ?? 0n);
              pw.writeVarInt(message.endGroupDelta ?? 0n);
              pw.writeVarInt(0n); // EndObject
            }
          },
        });
      }

      // Pass through additional parameters
      if (message.parameters) {
        for (const [type, value] of message.parameters) {
          if (type % 2 === 0) {
            params.push({ type, encode: (pw) => pw.writeBytes(value) });
          } else {
            params.push({ type, encode: (pw) => { pw.writeVarInt(BigInt(value.length)); pw.writeBytes(value); } });
          }
        }
      }

      // Write count + delta-encoded parameters
      params.sort((a, b) => a.type - b.type);
      w.writeVarInt(BigInt(params.length));
      let prevType = 0;
      for (const param of params) {
        w.writeVarInt(BigInt(param.type - prevType));
        prevType = param.type;
        param.encode(w);
      }
    });
  }

  // ============================================================================
  // Shared Helper Methods
  // ============================================================================

  private static encodeTrackNamespace(writer: Draft18BufferWriter, namespace: TrackNamespace): void {
    writer.writeVarInt(namespace.length);
    for (const field of namespace) {
      const bytes = TE.encode(field);
      writer.writeVarInt(bytes.length);
      writer.writeBytes(bytes);
    }
  }

  private static decodeTrackNamespace(reader: Draft18BufferReader): TrackNamespace {
    const count = reader.readVarIntNumber();
    assertBound(count, MAX_NAMESPACE_TUPLE_COUNT, 'TrackNamespace tuple count');
    const namespace: string[] = [];
    for (let i = 0; i < count; i++) {
      const length = reader.readVarIntNumber();
      assertBound(length, MAX_STRING_LENGTH, 'TrackNamespace field length');
      const bytes = reader.readBytes(length);
      namespace.push(TD.decode(bytes));
    }
    return namespace;
  }

  private static encodeString(writer: Draft18BufferWriter, str: string): void {
    const bytes = TE.encode(str);
    writer.writeVarInt(bytes.length);
    writer.writeBytes(bytes);
  }

  private static decodeTrackName(reader: Draft18BufferReader): string {
    const length = reader.readVarIntNumber();
    assertBound(length, MAX_TRACK_NAME_LENGTH, 'TrackName length');
    const bytes = reader.readBytes(length);
    return TD.decode(bytes);
  }
}
