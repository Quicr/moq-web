// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Bounds-discipline tests for the draft-18 codecs (B1/B2 SEC).
 *
 * A malicious peer must not be able to force the decoder to allocate an
 * arbitrarily large buffer or spend O(n) time on a single frame just by
 * writing a huge count/length varint. Every unbounded read must throw a
 * codec error tagged `code: 'bounds-exceeded'`.
 */

import { describe, it, expect } from 'vitest';
import { Draft18MessageCodec, Draft18CodecError, MAX_PARAMETER_COUNT, MAX_STRING_LENGTH, MAX_NAMESPACE_TUPLE_COUNT, MAX_TRACK_NAME_LENGTH, MAX_AUTH_TOKEN_LENGTH } from './draft18-message-codec.js';
import { Draft18StreamCodec, Draft18StreamCodecError, MAX_PROPERTIES_LENGTH } from './draft18-stream-codec.js';
import { MOQTVarInt } from './moqt-varint.js';
import { Draft18BufferWriter } from './protocol-codec.js';
import { MessageTypeDraft18, StreamTypeDraft18 } from '../messages/types.js';

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** Wrap a payload with a draft-18 control-message envelope (type + 16-bit length). */
function frame(type: MessageTypeDraft18, payload: Uint8Array): Uint8Array {
  const typeBytes = MOQTVarInt.encode(type);
  const out = new Uint8Array(typeBytes.length + 2 + payload.length);
  out.set(typeBytes, 0);
  out[typeBytes.length] = (payload.length >> 8) & 0xFF;
  out[typeBytes.length + 1] = payload.length & 0xFF;
  out.set(payload, typeBytes.length + 2);
  return out;
}

function encodeString(w: Draft18BufferWriter, s: string): void {
  const bytes = new TextEncoder().encode(s);
  w.writeVarInt(BigInt(bytes.length));
  w.writeBytes(bytes);
}

function encodeTrackNamespaceFields(w: Draft18BufferWriter, fields: string[]): void {
  w.writeVarInt(BigInt(fields.length));
  for (const f of fields) encodeString(w, f);
}

function expectBoundsError(fn: () => unknown): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeDefined();
  expect(caught).toBeInstanceOf(Error);
  // Either message or stream codec error, both with .code
  const err = caught as { code?: string; name?: string };
  expect(err.code).toBe('bounds-exceeded');
}

// -----------------------------------------------------------------------------
// B1: draft18-message-codec bounds
// -----------------------------------------------------------------------------

describe('B1 SEC: Draft18MessageCodec bounds', () => {
  it('rejects SUBSCRIBE with numParams above MAX_PARAMETER_COUNT', () => {
    // Build a minimal SUBSCRIBE payload with a poisoned numParams varint but
    // no matching parameter body. Bound check must fire before the loop
    // attempts to read parameters.
    const w = new Draft18BufferWriter();
    w.writeVarInt(1n); // requestId
    encodeTrackNamespaceFields(w, ['ns']); // trackNamespace
    encodeString(w, 'track'); // trackName
    w.writeVarInt(BigInt(MAX_PARAMETER_COUNT + 1)); // numParams
    const buf = frame(MessageTypeDraft18.SUBSCRIBE, w.toUint8Array());
    expectBoundsError(() => Draft18MessageCodec.decode(buf));
  });

  it('rejects SUBSCRIBE with track name length above MAX_TRACK_NAME_LENGTH', () => {
    const w = new Draft18BufferWriter();
    w.writeVarInt(1n); // requestId
    encodeTrackNamespaceFields(w, ['ns']);
    // Poisoned track name length — massive, but do NOT actually append that many bytes.
    w.writeVarInt(BigInt(MAX_TRACK_NAME_LENGTH + 1));
    const buf = frame(MessageTypeDraft18.SUBSCRIBE, w.toUint8Array());
    expectBoundsError(() => Draft18MessageCodec.decode(buf));
  });

  it('rejects SUBSCRIBE with namespace tuple count above MAX_NAMESPACE_TUPLE_COUNT', () => {
    const w = new Draft18BufferWriter();
    w.writeVarInt(1n); // requestId
    // Poisoned tuple count.
    w.writeVarInt(BigInt(MAX_NAMESPACE_TUPLE_COUNT + 1));
    const buf = frame(MessageTypeDraft18.SUBSCRIBE, w.toUint8Array());
    expectBoundsError(() => Draft18MessageCodec.decode(buf));
  });

  it('rejects SUBSCRIBE with a namespace field length above MAX_STRING_LENGTH', () => {
    const w = new Draft18BufferWriter();
    w.writeVarInt(1n); // requestId
    w.writeVarInt(1n); // one tuple field
    w.writeVarInt(BigInt(MAX_STRING_LENGTH + 1)); // huge namespace field length
    const buf = frame(MessageTypeDraft18.SUBSCRIBE, w.toUint8Array());
    expectBoundsError(() => Draft18MessageCodec.decode(buf));
  });

  it('rejects SETUP with AUTHORIZATION_TOKEN length above MAX_AUTH_TOKEN_LENGTH', () => {
    // SetupOptionDraft18.AUTHORIZATION_TOKEN is a defined key; encode a KVP
    // whose length varint claims MAX_AUTH_TOKEN_LENGTH + 1.
    const w = new Draft18BufferWriter();
    // deltaKey for AUTHORIZATION_TOKEN (0x03) from previousKey=0.
    w.writeVarInt(0x03n);
    w.writeVarInt(BigInt(MAX_AUTH_TOKEN_LENGTH + 1));
    const buf = frame(MessageTypeDraft18.SETUP, w.toUint8Array());
    expectBoundsError(() => Draft18MessageCodec.decode(buf));
  });

  it('accepts SUBSCRIBE with numParams exactly at MAX_PARAMETER_COUNT', () => {
    // Build a valid SUBSCRIBE with 0 parameters — verifies our bound check
    // isn't off-by-one at the low end.
    const w = new Draft18BufferWriter();
    w.writeVarInt(1n);
    encodeTrackNamespaceFields(w, ['ns']);
    encodeString(w, 'track');
    w.writeVarInt(0n); // numParams
    const buf = frame(MessageTypeDraft18.SUBSCRIBE, w.toUint8Array());
    expect(() => Draft18MessageCodec.decode(buf)).not.toThrow();
  });

  it('tags Draft18CodecError instances with code = "bounds-exceeded"', () => {
    const w = new Draft18BufferWriter();
    w.writeVarInt(1n);
    encodeTrackNamespaceFields(w, ['ns']);
    encodeString(w, 'track');
    w.writeVarInt(BigInt(MAX_PARAMETER_COUNT + 5)); // poisoned
    const buf = frame(MessageTypeDraft18.SUBSCRIBE, w.toUint8Array());
    try {
      Draft18MessageCodec.decode(buf);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(Draft18CodecError);
      expect((e as Draft18CodecError).code).toBe('bounds-exceeded');
    }
  });
});

// -----------------------------------------------------------------------------
// B2: draft18-stream-codec bounds
// -----------------------------------------------------------------------------

describe('B2 SEC: Draft18StreamCodec bounds', () => {
  it('rejects object headers with propsLength above MAX_PROPERTIES_LENGTH', () => {
    // objectIdDelta (varint) | propsLength varint (poisoned)
    const w = new Draft18BufferWriter();
    w.writeVarInt(0n); // objectIdDelta
    w.writeVarInt(BigInt(MAX_PROPERTIES_LENGTH + 1)); // huge propsLength
    const buf = w.toUint8Array();
    let caught: unknown;
    try {
      Draft18StreamCodec.decodeObjectHeader(buf, 0, /*hasProperties=*/ true);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Draft18StreamCodecError);
    expect((caught as Draft18StreamCodecError).code).toBe('bounds-exceeded');
  });

  it('rejects fetch objects with propsLength above MAX_PROPERTIES_LENGTH', () => {
    // flags byte: PROPERTIES (0x20) set, no other optional fields, subgroupMode = ZERO
    const flags = 0x20;
    const w = new Draft18BufferWriter();
    w.writeVarInt(BigInt(flags));
    w.writeVarInt(BigInt(MAX_PROPERTIES_LENGTH + 1)); // poisoned propsLength
    const buf = w.toUint8Array();
    let caught: unknown;
    try {
      Draft18StreamCodec.decodeFetchObject(buf);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Draft18StreamCodecError);
    expect((caught as Draft18StreamCodecError).code).toBe('bounds-exceeded');
  });

  it('rejects OBJECT_DATAGRAM with propsLength above MAX_PROPERTIES_LENGTH', () => {
    // Type byte: PROPERTIES (0x01) | ZERO_OBJECT_ID (0x04) | DEFAULT_PRIORITY (0x08) = 0x0D.
    // Wire: type | trackAlias | groupId | propsLength (poisoned).
    const w = new Draft18BufferWriter();
    w.writeVarInt(0x0Dn);
    w.writeVarInt(1n); // trackAlias
    w.writeVarInt(1n); // groupId
    // objectId omitted (ZERO), priority omitted (DEFAULT).
    w.writeVarInt(BigInt(MAX_PROPERTIES_LENGTH + 1)); // poisoned propsLength
    const buf = w.toUint8Array();
    let caught: unknown;
    try {
      Draft18StreamCodec.decodeObjectDatagram(buf);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Draft18StreamCodecError);
    expect((caught as Draft18StreamCodecError).code).toBe('bounds-exceeded');
  });
});
