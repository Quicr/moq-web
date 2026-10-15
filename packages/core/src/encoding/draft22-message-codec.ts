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
import { Draft18MessageCodec, Draft18CodecError } from './draft18-message-codec.js';
import {
  assertBound,
  encodeTrackNamespace,
  decodeTrackNamespace,
  encodeString,
  decodeTrackName,
  encodeFramed,
  decodeFramed,
  MAX_PARAMETER_COUNT,
  MAX_STRING_LENGTH,
} from './codec-helpers.js';
import {
  MessageTypeDraft18,
  MessageTypeDraft22,
  GroupOrder,
  LocationFilterTypeDraft22,
  RequestParameterDraft22,
  type ControlMessageDraft18,
  type ControlMessageDraft22,
  type ClientSetupMessageDraft18,
  type ServerSetupMessageDraft18,
  type SubscribeMessageDraft22,
  type LocationFilterDraft22,
  type PublishSkippedMessageDraft22,
  type PublishStateNotifyMessageDraft22,
  type FetchMessageDraft22,
} from '../messages/types.js';

/** §9.20: SUBSCRIBER_PRIORITY default when the parameter is omitted */
const DEFAULT_SUBSCRIBER_PRIORITY = 128;

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
        return encodeFramed(
          message.type,
          (w) => Draft22MessageCodec.encodePublishSkipped(w, message as PublishSkippedMessageDraft22),
        );
      case MessageTypeDraft22.PUBLISH_STATE_NOTIFY:
        return encodeFramed(
          message.type,
          (w) => Draft22MessageCodec.encodePublishStateNotify(w, message as PublishStateNotifyMessageDraft22),
        );
      case MessageTypeDraft22.FETCH:
        return encodeFramed(
          message.type,
          (w) => Draft22MessageCodec.encodeFetch(w, message as FetchMessageDraft22),
        );
      case MessageTypeDraft22.SUBSCRIBE:
        return Draft22MessageCodec.encodeSubscribeDraft22(message as SubscribeMessageDraft22);
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
        return decodeFramed(buffer, offset, (reader) =>
          Draft22MessageCodec.decodePublishSkipped(reader),
        );
      case MessageTypeDraft22.PUBLISH_STATE_NOTIFY:
        return decodeFramed(buffer, offset, (reader) =>
          Draft22MessageCodec.decodePublishStateNotify(reader),
        );
      case MessageTypeDraft22.FETCH:
        return decodeFramed(buffer, offset, (reader) =>
          Draft22MessageCodec.decodeFetch(reader),
        );
      case MessageTypeDraft22.SUBSCRIBE:
        return decodeFramed(buffer, offset, (reader) =>
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

  // encodeFramed / decodeFramed — imported from codec-helpers.ts

  // ============================================================================
  // PUBLISH_SKIPPED (0x0F) - Draft-22 replaces PUBLISH_BLOCKED
  // ============================================================================

  private static encodePublishSkipped(writer: Draft18BufferWriter, message: PublishSkippedMessageDraft22): void {
    // Track Namespace Suffix | Track Name Length | Track Name
    encodeTrackNamespace(writer, message.trackNamespaceSuffix);
    encodeString(writer, message.trackName);
  }

  private static decodePublishSkipped(reader: Draft18BufferReader): PublishSkippedMessageDraft22 {
    const trackNamespaceSuffix = decodeTrackNamespace(reader);
    const trackName = decodeTrackName(reader);

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

  private static decodeSubscribeDraft22(reader: Draft18BufferReader): SubscribeMessageDraft22 {
    const requestId = reader.readVarInt();
    const trackNamespace = decodeTrackNamespace(reader);
    const trackName = decodeTrackName(reader);

    const numParams = reader.readVarIntNumber();
    assertBound(numParams, MAX_PARAMETER_COUNT, 'SUBSCRIBE numParams');

    // §9.20.18: FORWARD defaults to 1 when omitted
    let forwardState = true;
    let locationFilter: LocationFilterDraft22 | undefined;
    const parameters = new Map<number, Uint8Array>();

    let previousType = 0;
    for (let i = 0; i < numParams; i++) {
      const type = previousType + reader.readVarIntNumber();
      previousType = type;

      switch (type) {
        case RequestParameterDraft22.FORWARD: {
          // §9.20.18: any value other than 0 or 1 is a PROTOCOL_VIOLATION
          const forward = reader.readByte();
          if (forward !== 0 && forward !== 1) {
            throw new Draft18CodecError(`Invalid FORWARD ${forward} (PROTOCOL_VIOLATION)`);
          }
          forwardState = forward === 1;
          break;
        }
        case RequestParameterDraft22.LOCATION_FILTER:
          locationFilter = Draft22MessageCodec.decodeLocationFilter(reader);
          break;
        default:
          parameters.set(type, Draft22MessageCodec.readParameterValue(reader, type));
      }
    }

    return {
      type: MessageTypeDraft22.SUBSCRIBE,
      requestId,
      trackNamespace,
      trackName,
      forwardState,
      locationFilter,
      parameters: parameters.size > 0 ? parameters : undefined,
    };
  }

  // ============================================================================
  // FETCH (0x16) - Draft-22 §9.11: range carried in LOCATION_FILTER
  // ============================================================================

  private static encodeFetch(writer: Draft18BufferWriter, message: FetchMessageDraft22): void {
    if (message.groupOrder !== GroupOrder.ASCENDING && message.groupOrder !== GroupOrder.DESCENDING) {
      throw new Draft18CodecError(`Invalid FETCH GROUP_ORDER ${message.groupOrder} (PROTOCOL_VIOLATION)`);
    }

    writer.writeVarInt(message.requestId);
    encodeTrackNamespace(writer, message.trackNamespace);
    encodeString(writer, message.trackName);

    const params: Array<{ type: number; encode: (pw: Draft18BufferWriter) => void }> = [
      {
        type: RequestParameterDraft22.SUBSCRIBER_PRIORITY,
        encode: (pw) => pw.writeByte(message.subscriberPriority),
      },
      {
        type: RequestParameterDraft22.GROUP_ORDER,
        encode: (pw) => pw.writeByte(message.groupOrder),
      },
    ];

    const filter = message.locationFilter;
    if (filter) {
      params.push({
        type: RequestParameterDraft22.LOCATION_FILTER,
        encode: (pw) => Draft22MessageCodec.encodeLocationFilter(pw, filter),
      });
    }

    if (message.fillTimeoutMs !== undefined) {
      params.push({
        type: RequestParameterDraft22.FILL_TIMEOUT,
        encode: (pw) => pw.writeVarInt(message.fillTimeoutMs!),
      });
    }

    // Pass through additional parameters (e.g. AUTHORIZATION_TOKEN)
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
    writer.writeVarInt(BigInt(params.length));
    let prevType = 0;
    for (const param of params) {
      writer.writeVarInt(BigInt(param.type - prevType));
      prevType = param.type;
      param.encode(writer);
    }
  }

  private static decodeFetch(reader: Draft18BufferReader): FetchMessageDraft22 {
    const requestId = reader.readVarInt();
    const trackNamespace = decodeTrackNamespace(reader, MessageTypeDraft18.FETCH);
    const trackName = decodeTrackName(reader, MessageTypeDraft18.FETCH);

    const numParams = reader.readVarIntNumber();
    assertBound(numParams, MAX_PARAMETER_COUNT, 'FETCH numParams', MessageTypeDraft18.FETCH);

    // §9.20: omitted SUBSCRIBER_PRIORITY is 128, omitted GROUP_ORDER is ascending
    let subscriberPriority = DEFAULT_SUBSCRIBER_PRIORITY;
    let groupOrder = GroupOrder.ASCENDING;
    let locationFilter: LocationFilterDraft22 | undefined;
    let fillTimeoutMs: bigint | undefined;
    const parameters = new Map<number, Uint8Array>();

    let previousType = 0;
    for (let i = 0; i < numParams; i++) {
      const type = previousType + reader.readVarIntNumber();
      previousType = type;

      switch (type) {
        case RequestParameterDraft22.SUBSCRIBER_PRIORITY:
          subscriberPriority = reader.readByte();
          break;
        case RequestParameterDraft22.GROUP_ORDER: {
          // §9.20.8: any value other than 1 or 2 is a PROTOCOL_VIOLATION
          const order = reader.readByte();
          if (order !== GroupOrder.ASCENDING && order !== GroupOrder.DESCENDING) {
            throw new Draft18CodecError(`Invalid FETCH GROUP_ORDER ${order} (PROTOCOL_VIOLATION)`);
          }
          groupOrder = order;
          break;
        }
        case RequestParameterDraft22.LOCATION_FILTER:
          locationFilter = Draft22MessageCodec.decodeLocationFilter(reader);
          break;
        case RequestParameterDraft22.FILL_TIMEOUT:
          fillTimeoutMs = reader.readVarInt();
          break;
        default:
          parameters.set(type, Draft22MessageCodec.readParameterValue(reader, type));
      }
    }

    return {
      type: MessageTypeDraft22.FETCH,
      requestId,
      trackNamespace,
      trackName,
      subscriberPriority,
      groupOrder,
      locationFilter,
      fillTimeoutMs,
      parameters: parameters.size > 0 ? parameters : undefined,
    };
  }

  /**
   * §9.20.9: LOCATION_FILTER value is not length-prefixed; fields depend on
   * the filter type.
   */
  private static encodeLocationFilter(
    writer: Draft18BufferWriter,
    filter: LocationFilterDraft22,
  ): void {
    writer.writeVarInt(BigInt(filter.type));

    switch (filter.type) {
      case LocationFilterTypeDraft22.NONE:
      case LocationFilterTypeDraft22.NEXT_OBJECT:
        return;
      case LocationFilterTypeDraft22.RELATIVE_START:
        writer.writeVarInt(filter.startLocation?.group ?? 0n);
        return;
      case LocationFilterTypeDraft22.ABSOLUTE_START:
        writer.writeVarInt(filter.startLocation?.group ?? 0n);
        writer.writeVarInt(filter.startLocation?.object ?? 0n);
        return;
      case LocationFilterTypeDraft22.ABSOLUTE_START_GROUP_END:
        writer.writeVarInt(filter.startLocation?.group ?? 0n);
        writer.writeVarInt(filter.startLocation?.object ?? 0n);
        writer.writeVarInt(filter.endGroupDelta ?? 0n);
        return;
      case LocationFilterTypeDraft22.ABSOLUTE_RANGE:
        writer.writeVarInt(filter.startLocation?.group ?? 0n);
        writer.writeVarInt(filter.startLocation?.object ?? 0n);
        writer.writeVarInt(filter.endGroupDelta ?? 0n);
        writer.writeVarInt(filter.endObject ?? 0n);
        return;
      default:
        throw new Draft18CodecError(`Unknown LOCATION_FILTER type: ${filter.type}`);
    }
  }

  private static decodeLocationFilter(
    reader: Draft18BufferReader,
  ): LocationFilterDraft22 {
    const type = reader.readVarIntNumber();

    switch (type) {
      case LocationFilterTypeDraft22.NONE:
      case LocationFilterTypeDraft22.NEXT_OBJECT:
        return { type };
      case LocationFilterTypeDraft22.RELATIVE_START:
        return { type, startLocation: { group: reader.readVarInt(), object: 0n } };
      case LocationFilterTypeDraft22.ABSOLUTE_START:
        return { type, startLocation: { group: reader.readVarInt(), object: reader.readVarInt() } };
      case LocationFilterTypeDraft22.ABSOLUTE_START_GROUP_END: {
        const startLocation = { group: reader.readVarInt(), object: reader.readVarInt() };
        return { type, startLocation, endGroupDelta: reader.readVarInt() };
      }
      case LocationFilterTypeDraft22.ABSOLUTE_RANGE: {
        const startLocation = { group: reader.readVarInt(), object: reader.readVarInt() };
        const endGroupDelta = reader.readVarInt();
        return { type, startLocation, endGroupDelta, endObject: reader.readVarInt() };
      }
      default:
        throw new Draft18CodecError(`Unknown LOCATION_FILTER type: ${type}`);
    }
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
  static encodeSubscribeDraft22(message: SubscribeMessageDraft22): Uint8Array {
    return encodeFramed(MessageTypeDraft22.SUBSCRIBE, (w) => {
      w.writeVarInt(message.requestId);
      encodeTrackNamespace(w, message.trackNamespace);
      encodeString(w, message.trackName);

      const params: Array<{ type: number; encode: (pw: Draft18BufferWriter) => void }> = [];

      // FORWARD (0x10) — always sent; the omitted default (1) would unpause
      params.push({
        type: RequestParameterDraft22.FORWARD,
        encode: (pw) => pw.writeByte(message.forwardState ? 0x01 : 0x00),
      });

      // LOCATION_FILTER (0x21)
      const filter = message.locationFilter;
      if (filter !== undefined) {
        params.push({
          type: RequestParameterDraft22.LOCATION_FILTER,
          encode: (pw) => Draft22MessageCodec.encodeLocationFilter(pw, filter),
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

  // encodeTrackNamespace, decodeTrackNamespace, encodeString, decodeTrackName
  // — imported from codec-helpers.ts
}
