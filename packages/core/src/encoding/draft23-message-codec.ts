// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Draft-23 Message Encoding and Decoding
 *
 * Draft-23 is a delta on draft-22, so this codec hands every message to
 * Draft22MessageCodec with the draft-23 dialect (vi64 Message Length,
 * draft-23 parameter table and error registries, non-empty Track Names) and
 * only owns the bodies that changed:
 *
 * - SETUP: MAX_CONTROL_MESSAGE_SIZE (§9.1.8)
 * - REQUEST_ERROR: Error Details replace the Redirect field (§9.4)
 * - NAMESPACE: gains a parameter block (§9.15)
 * - 0x18 (FETCH_OK) is reserved: a FETCH is answered with REQUEST_OK (§9.3)
 */

import { Draft18BufferWriter, Draft18BufferReader } from './protocol-codec.js';
import { Draft18CodecError, CODEC_MALFORMED } from './draft18-message-codec.js';
import { Draft22MessageCodec, type WireDialect } from './draft22-message-codec.js';
import {
  normalizeRequestErrorCodeDraft23,
  normalizePublishDoneErrorCodeDraft23,
} from './grease.js';
import {
  DEFAULT_MAX_CONTROL_MESSAGE_SIZE,
  MAX_SAFE_KEY,
  decodeReasonPhrase,
  decodeString,
  decodeTrackName,
  decodeTrackNamespace,
  decodeFramed,
  encodeFramed,
  encodeReasonPhrase,
  encodeString,
  encodeTrackNamespace,
  peekMessageType,
  readKvpKey,
  readKvpLength,
  skipKvpValue,
  type ControlFraming,
} from './codec-helpers.js';
import { ParameterScopeDraft22, PARAMETERS_DRAFT23, encodeParameters, decodeParameters } from './draft22-parameters.js';
import type { Violation } from './violation.js';
import {
  ErrorDetailTypeDraft23,
  MessageTypeDraft18,
  RequestErrorCodeDraft23,
  SetupOptionDraft23,
  type ClientSetupMessageDraft18,
  type ControlMessageDraft22,
  type NamespaceMessageDraft18,
  type RequestErrorMessageDraft18,
  type RequestErrorRedirectDraft18,
  type ServerSetupMessageDraft18,
} from '../messages/types.js';

/** §9.3: FETCH_OK's old type, reserved in draft-23 */
const RESERVED_FETCH_OK = 0x18;

/**
 * UNSUPPORTED_PROPERTY Error Details kept per REQUEST_ERROR. More are parsed
 * and dropped, so a peer cannot make us hold an array the size of the message.
 */
export const MAX_UNSUPPORTED_PROPERTIES = 64;

/** Draft-23 framing with this endpoint's and its peer's MAX_CONTROL_MESSAGE_SIZE */
export function draft23Framing(
  maxSendLength = DEFAULT_MAX_CONTROL_MESSAGE_SIZE,
  maxReceiveLength = DEFAULT_MAX_CONTROL_MESSAGE_SIZE,
): ControlFraming {
  return { varintLength: true, maxSendLength, maxReceiveLength };
}

/** The draft-23 dialect for a given framing */
export function draft23Dialect(framing: ControlFraming = draft23Framing()): WireDialect {
  return {
    framing,
    normalizers: {
      requestError: normalizeRequestErrorCodeDraft23,
      publishDone: normalizePublishDoneErrorCodeDraft23,
    },
    parameters: PARAMETERS_DRAFT23,
    requireTrackName: true,
  };
}

/** Draft-23 with both MAX_CONTROL_MESSAGE_SIZEs at their default */
export const DIALECT_DRAFT23: WireDialect = draft23Dialect();

function codecViolation(message: string, violation: Violation, messageType?: MessageTypeDraft18): Draft18CodecError {
  return new Draft18CodecError(`${message} (PROTOCOL_VIOLATION)`, messageType, CODEC_MALFORMED, violation);
}

/** A grease Error Detail Type, 0x7f * N + 0x9D (§13), varied so peers cannot special-case one */
function greaseDetailType(): number {
  return 0x7f * Math.floor(Math.random() * 64) + 0x9d;
}

export class Draft23MessageCodec {
  static encode(message: ControlMessageDraft22, dialect: WireDialect = DIALECT_DRAFT23): Uint8Array {
    const type: number = message.type;
    switch (type) {
      case MessageTypeDraft18.SETUP:
        return Draft22MessageCodec.encode(Draft23MessageCodec.setupWithOptions(message), dialect);
      case MessageTypeDraft18.REQUEST_ERROR:
        return encodeFramed(
          type,
          (w) => Draft23MessageCodec.encodeRequestError(w, message as unknown as RequestErrorMessageDraft18),
          dialect.framing,
        );
      case MessageTypeDraft18.NAMESPACE:
        return encodeFramed(
          type,
          (w) => Draft23MessageCodec.encodeNamespace(w, message as unknown as NamespaceMessageDraft18),
          dialect.framing,
        );
      case MessageTypeDraft18.FETCH_OK:
        throw new Draft18CodecError('FETCH_OK is not a draft-23 message: answer a FETCH with REQUEST_OK (§9.3)');
      default:
        return Draft22MessageCodec.encode(message, dialect);
    }
  }

  static decode(buffer: Uint8Array, offset = 0, dialect: WireDialect = DIALECT_DRAFT23): [ControlMessageDraft22, number] {
    const typeValue = peekMessageType(buffer, offset);

    switch (typeValue) {
      case RESERVED_FETCH_OK:
        throw codecViolation(`Reserved message type 0x${typeValue.toString(16)}`, 'unexpected-message');
      case MessageTypeDraft18.SETUP: {
        const [setup, bytesRead] = Draft22MessageCodec.decode(buffer, offset, dialect);
        return [Draft23MessageCodec.liftSetupOptions(setup as ServerSetupMessageDraft18), bytesRead];
      }
      case MessageTypeDraft18.REQUEST_ERROR:
        return decodeFramed(
          buffer,
          offset,
          (reader) => Draft23MessageCodec.decodeRequestError(reader, dialect) as unknown as ControlMessageDraft22,
          dialect.framing,
        );
      case MessageTypeDraft18.NAMESPACE:
        return decodeFramed(buffer, offset, (reader) => Draft23MessageCodec.decodeNamespace(reader), dialect.framing);
      default:
        return Draft22MessageCodec.decode(buffer, offset, dialect);
    }
  }

  static encodeSetupStream(message: ClientSetupMessageDraft18, dialect: WireDialect = DIALECT_DRAFT23): Uint8Array {
    return Draft22MessageCodec.encodeSetupStream(Draft23MessageCodec.setupWithOptions(message), dialect);
  }

  static decodeSetupStream(
    buffer: Uint8Array,
    offset = 0,
    dialect: WireDialect = DIALECT_DRAFT23,
  ): [ServerSetupMessageDraft18, number] {
    const [setup, bytesRead] = Draft22MessageCodec.decodeSetupStream(buffer, offset, dialect);

    return [Draft23MessageCodec.liftSetupOptions(setup), bytesRead];
  }

  // ============================================================================
  // SETUP (§9.1): MAX_CONTROL_MESSAGE_SIZE
  // ============================================================================

  /**
   * The draft-18 SETUP codec carries options it does not know as extensions,
   * so MAX_CONTROL_MESSAGE_SIZE travels as one: an even type, so a varint.
   */
  private static setupWithOptions<T extends ClientSetupMessageDraft18 | ControlMessageDraft22>(message: T): T {
    const setup = message as ClientSetupMessageDraft18;
    if (setup.maxControlMessageSize === undefined) {
      return message;
    }
    Draft23MessageCodec.assertMaxControlMessageSize(setup.maxControlMessageSize);

    const extensions = new Map(setup.extensions);
    extensions.set(SetupOptionDraft23.MAX_CONTROL_MESSAGE_SIZE, { varint: BigInt(setup.maxControlMessageSize) });

    return { ...setup, extensions } as T;
  }

  /** Move MAX_CONTROL_MESSAGE_SIZE out of the decoded extensions into its field */
  private static liftSetupOptions(setup: ServerSetupMessageDraft18): ServerSetupMessageDraft18 {
    const option = setup.extensions?.get(SetupOptionDraft23.MAX_CONTROL_MESSAGE_SIZE);
    if (!option) {
      return setup;
    }
    if (!('varint' in option)) {
      throw codecViolation('MAX_CONTROL_MESSAGE_SIZE is not a varint', 'malformed-key-value', MessageTypeDraft18.SETUP);
    }
    const size = option.varint;
    // Sizes beyond 2^53 are effectively unbounded
    const maxControlMessageSize = size > MAX_SAFE_KEY ? Number.MAX_SAFE_INTEGER : Number(size);
    Draft23MessageCodec.assertMaxControlMessageSize(maxControlMessageSize);

    const extensions = new Map(setup.extensions);
    extensions.delete(SetupOptionDraft23.MAX_CONTROL_MESSAGE_SIZE);

    return { ...setup, maxControlMessageSize, extensions: extensions.size > 0 ? extensions : undefined };
  }

  /** §9.1.8: the value MUST be at least 65535 */
  private static assertMaxControlMessageSize(size: number): void {
    if (!Number.isSafeInteger(size) || size < DEFAULT_MAX_CONTROL_MESSAGE_SIZE) {
      throw codecViolation(
        `MAX_CONTROL_MESSAGE_SIZE ${size} is below ${DEFAULT_MAX_CONTROL_MESSAGE_SIZE}`,
        'malformed-key-value',
        MessageTypeDraft18.SETUP,
      );
    }
  }

  // ============================================================================
  // REQUEST_ERROR (§9.4): Error Code | Retry Interval | Error Reason | Error Details
  // ============================================================================

  private static encodeRequestError(writer: Draft18BufferWriter, message: RequestErrorMessageDraft18): void {
    writer.writeVarInt(message.errorCode);
    writer.writeVarInt(message.retryInterval ?? 0n);
    encodeReasonPhrase(writer, message.reasonPhrase);

    // §9.4.2: Error Details are Key-Value-Pairs in ascending Type order
    if (message.errorCode === RequestErrorCodeDraft23.REDIRECT) {
      if (!message.redirect) {
        throw new Draft18CodecError('REQUEST_ERROR with REDIRECT requires a REDIRECT Error Detail (§9.4.2.1)');
      }
      const redirect = new Draft18BufferWriter();
      Draft23MessageCodec.encodeRedirect(redirect, message.redirect);
      writer.writeVarInt(ErrorDetailTypeDraft23.REDIRECT);
      writer.writeVarInt(redirect.length);
      writer.writeBytes(redirect.toUint8Array());
    }

    const properties = message.errorCode === RequestErrorCodeDraft23.UNSUPPORTED_EXTENSION
      ? message.unsupportedProperties ?? []
      : [];
    // Types are delta-coded; REDIRECT and UNSUPPORTED_PROPERTY never share a
    // message (their Error Codes differ)
    let previousType = message.errorCode === RequestErrorCodeDraft23.REDIRECT ? ErrorDetailTypeDraft23.REDIRECT : 0;
    for (const propertyType of properties) {
      writer.writeVarInt(ErrorDetailTypeDraft23.UNSUPPORTED_PROPERTY - previousType);
      previousType = ErrorDetailTypeDraft23.UNSUPPORTED_PROPERTY;
      writer.writeVarInt(propertyType);
    }

    // §13: a grease type sorts after every defined one. A 0 byte is both an
    // even type's varint value and an odd type's zero length.
    if (message.greaseDetail) {
      writer.writeVarInt(greaseDetailType() - previousType);
      writer.writeVarInt(0);
    }
  }

  private static decodeRequestError(reader: Draft18BufferReader, dialect: WireDialect): RequestErrorMessageDraft18 {
    const errorCode = dialect.normalizers.requestError(Draft23MessageCodec.readCode(reader));
    const retryInterval = reader.readVarInt();
    const reasonPhrase = decodeReasonPhrase(reader, MessageTypeDraft18.REQUEST_ERROR);

    const message: RequestErrorMessageDraft18 = {
      type: MessageTypeDraft18.REQUEST_ERROR,
      requestId: 0n,
      errorCode,
      retryInterval,
      reasonPhrase,
    };
    Draft23MessageCodec.decodeErrorDetails(reader, message);

    // §9.4.2.1: REDIRECT without its Error Detail is malformed
    if (errorCode === RequestErrorCodeDraft23.REDIRECT && !message.redirect) {
      throw codecViolation('REQUEST_ERROR REDIRECT has no REDIRECT Error Detail', 'malformed-message', MessageTypeDraft18.REQUEST_ERROR);
    }

    return message;
  }

  /** Error Codes beyond 2^53 are unknown, and normalize to INTERNAL_ERROR */
  private static readCode(reader: Draft18BufferReader): number {
    const code = reader.readVarInt();

    return code > MAX_SAFE_KEY ? Number.MAX_SAFE_INTEGER : Number(code);
  }

  /**
   * §9.4.2: unknown types, and known types beside an Error Code they are not
   * defined for, are ignored. A repeated REDIRECT keeps the first.
   */
  private static decodeErrorDetails(reader: Draft18BufferReader, message: RequestErrorMessageDraft18): void {
    let previousType = 0n;
    while (reader.hasMore) {
      const type = readKvpKey(reader, previousType);
      previousType = type;

      if (type === BigInt(ErrorDetailTypeDraft23.REDIRECT) && message.errorCode === RequestErrorCodeDraft23.REDIRECT) {
        const value = reader.readBytes(readKvpLength(reader, 'REDIRECT Error Detail length'));
        const redirect = Draft23MessageCodec.decodeRedirect(value);
        message.redirect ??= redirect;
        continue;
      }
      if (
        type === BigInt(ErrorDetailTypeDraft23.UNSUPPORTED_PROPERTY)
        && message.errorCode === RequestErrorCodeDraft23.UNSUPPORTED_EXTENSION
      ) {
        const propertyType = reader.readVarInt();
        const properties = (message.unsupportedProperties ??= []);
        if (properties.length < MAX_UNSUPPORTED_PROPERTIES) {
          properties.push(propertyType);
        }
        continue;
      }

      skipKvpValue(reader, type);
    }
  }

  private static encodeRedirect(writer: Draft18BufferWriter, redirect: RequestErrorRedirectDraft18): void {
    // Connect URI Length | Connect URI | Track Namespace | Track Name Length | Track Name
    encodeString(writer, redirect.connectUri);
    encodeTrackNamespace(writer, redirect.trackNamespace);
    encodeString(writer, redirect.trackName);
  }

  /** §8.3: a REDIRECT value that does not parse exactly is MALFORMED_KEY_VALUE */
  private static decodeRedirect(value: Uint8Array): RequestErrorRedirectDraft18 {
    const reader = new Draft18BufferReader(value);
    let redirect: RequestErrorRedirectDraft18;
    try {
      const connectUri = decodeString(reader);
      const trackNamespace = decodeTrackNamespace(reader, MessageTypeDraft18.REQUEST_ERROR);
      // An empty Track Name is how a namespace-scoped redirect names no Track
      const trackName = decodeTrackName(reader, MessageTypeDraft18.REQUEST_ERROR, trackNamespace);
      redirect = { connectUri, trackNamespace, trackName };
    } catch (err) {
      if (err instanceof Draft18CodecError && err.violation) {
        throw err;
      }
      throw codecViolation(
        `REDIRECT Error Detail does not parse: ${(err as Error).message}`,
        'malformed-key-value',
        MessageTypeDraft18.REQUEST_ERROR,
      );
    }
    if (reader.hasMore) {
      throw codecViolation('REDIRECT Error Detail has trailing bytes', 'malformed-key-value', MessageTypeDraft18.REQUEST_ERROR);
    }

    return redirect;
  }

  // ============================================================================
  // NAMESPACE (§9.15): Track Namespace Suffix | Number of Parameters | Parameters
  // ============================================================================

  private static encodeNamespace(writer: Draft18BufferWriter, message: NamespaceMessageDraft18): void {
    encodeTrackNamespace(writer, message.trackNamespace);
    // No parameters are defined for NAMESPACE yet
    encodeParameters(writer, ParameterScopeDraft22.NAMESPACE, {}, PARAMETERS_DRAFT23);
  }

  private static decodeNamespace(reader: Draft18BufferReader): ControlMessageDraft22 {
    const trackNamespace = decodeTrackNamespace(reader, MessageTypeDraft18.NAMESPACE);
    decodeParameters(reader, ParameterScopeDraft22.NAMESPACE, PARAMETERS_DRAFT23);

    return { type: MessageTypeDraft18.NAMESPACE, trackNamespace } as NamespaceMessageDraft18;
  }
}
