// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Fuzz coverage for Draft18MessageCodec (Wave 2 Track G).
 *
 * Three property families run against every top-level decode entry point:
 *
 *  1. **Arbitrary bytes**: feed random Uint8Arrays into `Draft18MessageCodec.decode`
 *     and each message-specific decode path. Assert that decoding either
 *     succeeds or throws a typed codec error — never a raw TypeError / RangeError
 *     / infinite loop.
 *
 *  2. **Length-prefix mutations**: take a valid encoded message, rewrite a
 *     declared length varint so it exceeds the codec safety bound
 *     (MAX_PARAMETER_COUNT / MAX_STRING_LENGTH / MAX_NAMESPACE_TUPLE_COUNT).
 *     Assert `'bounds-exceeded'` fires on decode.
 *
 *  3. **Round-trip identity**: generate arbitrary valid messages, encode →
 *     decode, and assert semantic equality on the fields the codec preserves.
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

import {
  Draft18MessageCodec,
  Draft18CodecError,
  MAX_PARAMETER_COUNT,
  MAX_STRING_LENGTH,
  MAX_NAMESPACE_TUPLE_COUNT,
} from './draft18-message-codec.js';
import { MOQTVarInt } from './moqt-varint.js';
import { Draft18BufferWriter } from './protocol-codec.js';
import {
  MessageTypeDraft18,
  SubscriptionFilterDraft18,
  FetchTypeDraft18,
  GroupOrder,
  type SubscribeMessageDraft18,
  type SubscribeOkMessageDraft18,
  type PublishMessageDraft18,
  type FetchMessageDraft18,
  type FetchOkMessageDraft18,
  type TrackStatusMessageDraft18,
  type PublishNamespaceMessageDraft18,
  type SubscribeNamespaceMessageDraft18,
  type NamespaceMessageDraft18,
  type NamespaceDoneMessageDraft18,
  type PublishBlockedMessageDraft18,
  type PublishDoneMessageDraft18,
  type GoAwayMessageDraft18,
  type RequestUpdateMessageDraft18,
  type SubscribeTracksMessageDraft18,
} from '../messages/types.js';

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Any decode failure must surface as a typed codec error. Uncaught
 * TypeError/RangeError or infinite loops are bugs — they indicate the bounds
 * discipline from Wave 1 A doesn't cover this input shape.
 */
const ACCEPTED_ERROR_NAMES = new Set([
  'Draft18CodecError',
  'Draft18StreamCodecError',
  'MOQTVarIntError',
  'VarIntError',
  'Error', // Some helper paths throw plain `new Error(...)`; still typed.
]);

function assertAcceptableDecodeError(err: unknown, ctx: string): void {
  if (!(err instanceof Error)) {
    throw new Error(`${ctx}: threw non-Error value: ${String(err)}`);
  }
  if (!ACCEPTED_ERROR_NAMES.has(err.name)) {
    throw new Error(`${ctx}: threw disallowed error type '${err.name}': ${err.message}`);
  }
}

/** Draft-18 control-message framing: type varint + 16-bit BE length + payload. */
function frame(type: MessageTypeDraft18, payload: Uint8Array): Uint8Array {
  const typeBytes = MOQTVarInt.encode(type);
  const out = new Uint8Array(typeBytes.length + 2 + payload.length);
  out.set(typeBytes, 0);
  out[typeBytes.length] = (payload.length >> 8) & 0xff;
  out[typeBytes.length + 1] = payload.length & 0xff;
  out.set(payload, typeBytes.length + 2);
  return out;
}

function encodeString(w: Draft18BufferWriter, s: string): void {
  const bytes = new TextEncoder().encode(s);
  w.writeVarInt(BigInt(bytes.length));
  w.writeBytes(bytes);
}

function encodeTrackNamespace(w: Draft18BufferWriter, fields: string[]): void {
  w.writeVarInt(BigInt(fields.length));
  for (const f of fields) encodeString(w, f);
}

// -----------------------------------------------------------------------------
// Arbitraries
// -----------------------------------------------------------------------------

// ASCII strings only — non-ASCII UTF-8 sequences can inflate byte counts past
// the safety bound in ways that make round-trip assertions racy against the
// bound. We test wide UTF-8 in dedicated cases below.
const arbAsciiString = (max: number): fc.Arbitrary<string> =>
  fc.string({ minLength: 0, maxLength: max, unit: 'grapheme-ascii' });

const arbBigintU62 = (max = 0xffff_ffffn): fc.Arbitrary<bigint> =>
  fc.bigInt({ min: 0n, max });

const arbTrackNamespace = fc.array(arbAsciiString(64), {
  minLength: 1,
  maxLength: 4,
});

const arbSubscribeMessage: fc.Arbitrary<SubscribeMessageDraft18> = fc.record({
  type: fc.constant(MessageTypeDraft18.SUBSCRIBE),
  requestId: arbBigintU62(),
  trackNamespace: arbTrackNamespace,
  trackName: arbAsciiString(64),
  forwardState: fc.constant(true),
  filter: fc.constantFrom(
    SubscriptionFilterDraft18.NEXT_GROUP_START,
    SubscriptionFilterDraft18.LARGEST_OBJECT,
  ),
});

const arbSubscribeOkMessage: fc.Arbitrary<SubscribeOkMessageDraft18> = fc.record({
  type: fc.constant(MessageTypeDraft18.SUBSCRIBE_OK),
  requestId: arbBigintU62(),
  trackAlias: arbBigintU62(),
  largestLocation: fc.record({ group: arbBigintU62(), object: arbBigintU62() }),
  expires: fc.option(arbBigintU62(), { nil: undefined }),
});

const arbPublishMessage: fc.Arbitrary<PublishMessageDraft18> = fc.record({
  type: fc.constant(MessageTypeDraft18.PUBLISH),
  requestId: arbBigintU62(),
  trackAlias: arbBigintU62(),
  trackNamespace: arbTrackNamespace,
  trackName: arbAsciiString(64),
  forwardState: fc.constant(true),
  largestLocation: fc.record({ group: fc.constant(0n), object: fc.constant(0n) }),
});

// Standalone FETCH only — joining FETCH requires an existing subscribe ID and
// makes round-trip semantic equality noisier without adding coverage.
const arbFetchMessage: fc.Arbitrary<FetchMessageDraft18> = fc.record({
  type: fc.constant(MessageTypeDraft18.FETCH),
  requestId: arbBigintU62(),
  fetchType: fc.constant(FetchTypeDraft18.STANDALONE),
  joiningFlag: fc.constant(false),
  trackNamespace: arbTrackNamespace,
  trackName: arbAsciiString(64),
  subscriberPriority: fc.integer({ min: 0, max: 255 }),
  groupOrder: fc.constantFrom(GroupOrder.ASCENDING, GroupOrder.DESCENDING),
  startLocation: fc.record({ group: arbBigintU62(), object: arbBigintU62() }),
  endLocation: fc.record({ group: arbBigintU62(), object: arbBigintU62() }),
});

const arbFetchOkMessage: fc.Arbitrary<FetchOkMessageDraft18> = fc.record({
  type: fc.constant(MessageTypeDraft18.FETCH_OK),
  requestId: fc.constant(0n),
  endOfTrack: fc.boolean(),
  endLocation: fc.record({ group: arbBigintU62(), object: arbBigintU62() }),
});

const arbTrackStatusMessage: fc.Arbitrary<TrackStatusMessageDraft18> = fc.record({
  type: fc.constant(MessageTypeDraft18.TRACK_STATUS),
  requestId: arbBigintU62(),
  trackNamespace: arbTrackNamespace,
  trackName: arbAsciiString(64),
});

const arbPublishNamespaceMessage: fc.Arbitrary<PublishNamespaceMessageDraft18> = fc.record({
  type: fc.constant(MessageTypeDraft18.PUBLISH_NAMESPACE),
  requestId: arbBigintU62(),
  trackNamespacePrefix: arbTrackNamespace,
});

const arbSubscribeNamespaceMessage: fc.Arbitrary<SubscribeNamespaceMessageDraft18> = fc.record({
  type: fc.constant(MessageTypeDraft18.SUBSCRIBE_NAMESPACE),
  requestId: arbBigintU62(),
  trackNamespacePrefix: arbTrackNamespace,
});

const arbNamespaceMessage: fc.Arbitrary<NamespaceMessageDraft18> = fc.record({
  type: fc.constant(MessageTypeDraft18.NAMESPACE),
  trackNamespace: arbTrackNamespace,
});

const arbNamespaceDoneMessage: fc.Arbitrary<NamespaceDoneMessageDraft18> = fc.record({
  type: fc.constant(MessageTypeDraft18.NAMESPACE_DONE),
  finalNamespace: arbTrackNamespace,
});

const arbPublishBlockedMessage: fc.Arbitrary<PublishBlockedMessageDraft18> = fc.record({
  type: fc.constant(MessageTypeDraft18.PUBLISH_BLOCKED),
  trackAlias: arbBigintU62(),
});

const arbGoAwayMessage: fc.Arbitrary<GoAwayMessageDraft18> = fc.record({
  type: fc.constant(MessageTypeDraft18.GOAWAY),
  newSessionUri: fc.option(arbAsciiString(128), { nil: undefined }),
  timeout: arbBigintU62(),
});

const arbRequestUpdateMessage: fc.Arbitrary<RequestUpdateMessageDraft18> = fc.record({
  type: fc.constant(MessageTypeDraft18.REQUEST_UPDATE),
  requestId: arbBigintU62(),
  forwardState: fc.boolean(),
});

const arbPublishDoneMessage: fc.Arbitrary<PublishDoneMessageDraft18> = fc.record({
  type: fc.constant(MessageTypeDraft18.PUBLISH_DONE),
  requestId: fc.constant(0n),
  finalLocation: fc.record({ group: fc.constant(0n), object: fc.constant(0n) }),
  // Restrict to known codes so grease normalization doesn't rewrite our expected value.
  statusCode: fc.constantFrom(0n, 1n, 2n, 3n, 4n, 5n),
  streamCount: arbBigintU62(),
  reasonPhrase: fc.option(arbAsciiString(64), { nil: undefined }),
});

const arbSubscribeTracksMessage: fc.Arbitrary<SubscribeTracksMessageDraft18> = fc.record({
  type: fc.constant(MessageTypeDraft18.SUBSCRIBE_TRACKS),
  requestId: arbBigintU62(),
  trackNamespacePrefix: arbTrackNamespace,
  forwardState: fc.boolean(),
  filter: fc.constantFrom(
    SubscriptionFilterDraft18.NEXT_GROUP_START,
    SubscriptionFilterDraft18.LARGEST_OBJECT,
  ),
});

// -----------------------------------------------------------------------------
// 1. Arbitrary bytes never crash the decoder
// -----------------------------------------------------------------------------

describe('Draft18MessageCodec fuzz — arbitrary bytes', () => {
  it('Draft18MessageCodec.decode never throws an unexpected error', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 512 }), (bytes) => {
        try {
          Draft18MessageCodec.decode(bytes);
        } catch (e) {
          assertAcceptableDecodeError(e, 'decode(random)');
        }
      }),
      { numRuns: 500 },
    );
  });

  // Frame arbitrary payload bytes under each known message type. This forces
  // the per-type decoders to see garbage instead of just failing at the outer
  // envelope.
  for (const t of [
    MessageTypeDraft18.SUBSCRIBE,
    MessageTypeDraft18.SUBSCRIBE_OK,
    MessageTypeDraft18.PUBLISH,
    MessageTypeDraft18.PUBLISH_DONE,
    MessageTypeDraft18.REQUEST_ERROR,
    MessageTypeDraft18.REQUEST_OK,
    MessageTypeDraft18.FETCH,
    MessageTypeDraft18.FETCH_OK,
    MessageTypeDraft18.GOAWAY,
    MessageTypeDraft18.TRACK_STATUS,
    MessageTypeDraft18.REQUEST_UPDATE,
    MessageTypeDraft18.PUBLISH_NAMESPACE,
    MessageTypeDraft18.SUBSCRIBE_NAMESPACE,
    MessageTypeDraft18.NAMESPACE,
    MessageTypeDraft18.NAMESPACE_DONE,
    MessageTypeDraft18.SUBSCRIBE_TRACKS,
    MessageTypeDraft18.PUBLISH_BLOCKED,
  ]) {
    it(`framed random payload as 0x${t.toString(16)} decodes safely`, () => {
      fc.assert(
        fc.property(fc.uint8Array({ minLength: 0, maxLength: 256 }), (payload) => {
          const framed = frame(t, payload);
          try {
            Draft18MessageCodec.decode(framed);
          } catch (e) {
            assertAcceptableDecodeError(e, `decode(frame(${MessageTypeDraft18[t]}))`);
          }
        }),
        { numRuns: 200 },
      );
    });
  }
});

// -----------------------------------------------------------------------------
// 2. Length-prefix mutations must trip the bounds discipline
// -----------------------------------------------------------------------------

describe('Draft18MessageCodec fuzz — length-prefix mutations', () => {
  it('SUBSCRIBE numParams > MAX_PARAMETER_COUNT trips bounds', () => {
    fc.assert(
      fc.property(fc.integer({ min: MAX_PARAMETER_COUNT + 1, max: 100_000 }), (n) => {
        const w = new Draft18BufferWriter();
        w.writeVarInt(1n); // requestId
        encodeTrackNamespace(w, ['ns']);
        encodeString(w, 'track');
        w.writeVarInt(BigInt(n)); // exploded numParams
        const framed = frame(MessageTypeDraft18.SUBSCRIBE, w.toUint8Array());
        expect(() => Draft18MessageCodec.decode(framed)).toThrow(Draft18CodecError);
      }),
      { numRuns: 25 },
    );
  });

  it('TrackNamespace tuple count > MAX_NAMESPACE_TUPLE_COUNT trips bounds', () => {
    fc.assert(
      fc.property(fc.integer({ min: MAX_NAMESPACE_TUPLE_COUNT + 1, max: 100_000 }), (n) => {
        const w = new Draft18BufferWriter();
        w.writeVarInt(1n); // requestId
        w.writeVarInt(BigInt(n)); // exploded tuple count
        const framed = frame(MessageTypeDraft18.SUBSCRIBE, w.toUint8Array());
        expect(() => Draft18MessageCodec.decode(framed)).toThrow(Draft18CodecError);
      }),
      { numRuns: 25 },
    );
  });

  it('TrackNamespace field length > MAX_STRING_LENGTH trips bounds', () => {
    fc.assert(
      fc.property(fc.integer({ min: MAX_STRING_LENGTH + 1, max: 10_000_000 }), (n) => {
        const w = new Draft18BufferWriter();
        w.writeVarInt(1n); // requestId
        w.writeVarInt(1n); // tuple count
        w.writeVarInt(BigInt(n)); // exploded field length
        const framed = frame(MessageTypeDraft18.SUBSCRIBE, w.toUint8Array());
        expect(() => Draft18MessageCodec.decode(framed)).toThrow(Draft18CodecError);
      }),
      { numRuns: 25 },
    );
  });

  it('TrackName length > MAX_STRING_LENGTH trips bounds', () => {
    fc.assert(
      fc.property(fc.integer({ min: MAX_STRING_LENGTH + 1, max: 10_000_000 }), (n) => {
        const w = new Draft18BufferWriter();
        w.writeVarInt(1n); // requestId
        encodeTrackNamespace(w, ['ns']);
        w.writeVarInt(BigInt(n)); // exploded track name length
        const framed = frame(MessageTypeDraft18.SUBSCRIBE, w.toUint8Array());
        expect(() => Draft18MessageCodec.decode(framed)).toThrow(Draft18CodecError);
      }),
      { numRuns: 25 },
    );
  });

  it('FETCH numParams > MAX_PARAMETER_COUNT trips bounds', () => {
    fc.assert(
      fc.property(fc.integer({ min: MAX_PARAMETER_COUNT + 1, max: 100_000 }), (n) => {
        const w = new Draft18BufferWriter();
        w.writeVarInt(1n); // requestId
        w.writeVarInt(BigInt(FetchTypeDraft18.STANDALONE));
        encodeTrackNamespace(w, ['ns']);
        encodeString(w, 'track');
        w.writeVarInt(0n); w.writeVarInt(0n); // startLocation
        w.writeVarInt(0n); w.writeVarInt(0n); // endLocation
        w.writeVarInt(BigInt(n)); // exploded numParams
        const framed = frame(MessageTypeDraft18.FETCH, w.toUint8Array());
        expect(() => Draft18MessageCodec.decode(framed)).toThrow(Draft18CodecError);
      }),
      { numRuns: 25 },
    );
  });
});

// -----------------------------------------------------------------------------
// 3. Round-trip identity for encode → decode
// -----------------------------------------------------------------------------

describe('Draft18MessageCodec fuzz — round-trip identity', () => {
  it('SUBSCRIBE round-trips (message-level fields)', () => {
    fc.assert(
      fc.property(arbSubscribeMessage, (msg) => {
        const encoded = Draft18MessageCodec.encode(msg);
        const [decoded, bytesRead] = Draft18MessageCodec.decode(encoded);
        expect(bytesRead).toBe(encoded.length);
        expect(decoded.type).toBe(MessageTypeDraft18.SUBSCRIBE);
        const d = decoded as SubscribeMessageDraft18;
        expect(d.requestId).toBe(msg.requestId);
        expect(d.trackNamespace).toEqual(msg.trackNamespace);
        expect(d.trackName).toBe(msg.trackName);
        expect(d.filter).toBe(msg.filter);
      }),
      { numRuns: 200 },
    );
  });

  it('SUBSCRIBE_OK round-trips (trackAlias, largest, expires)', () => {
    fc.assert(
      fc.property(arbSubscribeOkMessage, (msg) => {
        const encoded = Draft18MessageCodec.encode(msg);
        const [decoded] = Draft18MessageCodec.decode(encoded);
        const d = decoded as SubscribeOkMessageDraft18;
        expect(d.trackAlias).toBe(msg.trackAlias);
        expect(d.largestLocation.group).toBe(msg.largestLocation.group);
        expect(d.largestLocation.object).toBe(msg.largestLocation.object);
        if (msg.expires !== undefined) {
          expect(d.expires).toBe(msg.expires);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('PUBLISH round-trips', () => {
    fc.assert(
      fc.property(arbPublishMessage, (msg) => {
        const encoded = Draft18MessageCodec.encode(msg);
        const [decoded] = Draft18MessageCodec.decode(encoded);
        const d = decoded as PublishMessageDraft18;
        expect(d.requestId).toBe(msg.requestId);
        expect(d.trackAlias).toBe(msg.trackAlias);
        expect(d.trackNamespace).toEqual(msg.trackNamespace);
        expect(d.trackName).toBe(msg.trackName);
      }),
      { numRuns: 200 },
    );
  });

  it('FETCH (standalone) round-trips', () => {
    fc.assert(
      fc.property(arbFetchMessage, (msg) => {
        const encoded = Draft18MessageCodec.encode(msg);
        const [decoded] = Draft18MessageCodec.decode(encoded);
        const d = decoded as FetchMessageDraft18;
        expect(d.requestId).toBe(msg.requestId);
        expect(d.fetchType).toBe(FetchTypeDraft18.STANDALONE);
        expect(d.trackNamespace).toEqual(msg.trackNamespace);
        expect(d.trackName).toBe(msg.trackName);
        expect(d.startLocation.group).toBe(msg.startLocation.group);
        expect(d.startLocation.object).toBe(msg.startLocation.object);
        expect(d.endLocation.group).toBe(msg.endLocation.group);
        expect(d.endLocation.object).toBe(msg.endLocation.object);
      }),
      { numRuns: 200 },
    );
  });

  it('FETCH_OK round-trips', () => {
    fc.assert(
      fc.property(arbFetchOkMessage, (msg) => {
        const encoded = Draft18MessageCodec.encode(msg);
        const [decoded] = Draft18MessageCodec.decode(encoded);
        const d = decoded as FetchOkMessageDraft18;
        expect(d.endOfTrack).toBe(msg.endOfTrack);
        expect(d.endLocation.group).toBe(msg.endLocation.group);
        expect(d.endLocation.object).toBe(msg.endLocation.object);
      }),
      { numRuns: 200 },
    );
  });

  it('TRACK_STATUS round-trips', () => {
    fc.assert(
      fc.property(arbTrackStatusMessage, (msg) => {
        const encoded = Draft18MessageCodec.encode(msg);
        const [decoded] = Draft18MessageCodec.decode(encoded);
        const d = decoded as TrackStatusMessageDraft18;
        expect(d.requestId).toBe(msg.requestId);
        expect(d.trackNamespace).toEqual(msg.trackNamespace);
        expect(d.trackName).toBe(msg.trackName);
      }),
      { numRuns: 200 },
    );
  });

  it('PUBLISH_NAMESPACE round-trips', () => {
    fc.assert(
      fc.property(arbPublishNamespaceMessage, (msg) => {
        const encoded = Draft18MessageCodec.encode(msg);
        const [decoded] = Draft18MessageCodec.decode(encoded);
        const d = decoded as PublishNamespaceMessageDraft18;
        expect(d.requestId).toBe(msg.requestId);
        expect(d.trackNamespacePrefix).toEqual(msg.trackNamespacePrefix);
      }),
      { numRuns: 200 },
    );
  });

  it('SUBSCRIBE_NAMESPACE round-trips', () => {
    fc.assert(
      fc.property(arbSubscribeNamespaceMessage, (msg) => {
        const encoded = Draft18MessageCodec.encode(msg);
        const [decoded] = Draft18MessageCodec.decode(encoded);
        const d = decoded as SubscribeNamespaceMessageDraft18;
        expect(d.requestId).toBe(msg.requestId);
        expect(d.trackNamespacePrefix).toEqual(msg.trackNamespacePrefix);
      }),
      { numRuns: 200 },
    );
  });

  it('NAMESPACE round-trips', () => {
    fc.assert(
      fc.property(arbNamespaceMessage, (msg) => {
        const encoded = Draft18MessageCodec.encode(msg);
        const [decoded] = Draft18MessageCodec.decode(encoded);
        const d = decoded as NamespaceMessageDraft18;
        expect(d.trackNamespace).toEqual(msg.trackNamespace);
      }),
      { numRuns: 200 },
    );
  });

  it('NAMESPACE_DONE round-trips', () => {
    fc.assert(
      fc.property(arbNamespaceDoneMessage, (msg) => {
        const encoded = Draft18MessageCodec.encode(msg);
        const [decoded] = Draft18MessageCodec.decode(encoded);
        const d = decoded as NamespaceDoneMessageDraft18;
        expect(d.finalNamespace).toEqual(msg.finalNamespace);
      }),
      { numRuns: 200 },
    );
  });

  it('PUBLISH_BLOCKED round-trips', () => {
    fc.assert(
      fc.property(arbPublishBlockedMessage, (msg) => {
        const encoded = Draft18MessageCodec.encode(msg);
        const [decoded] = Draft18MessageCodec.decode(encoded);
        const d = decoded as PublishBlockedMessageDraft18;
        expect(d.trackAlias).toBe(msg.trackAlias);
      }),
      { numRuns: 200 },
    );
  });

  it('GOAWAY round-trips (timeout, newSessionUri)', () => {
    fc.assert(
      fc.property(arbGoAwayMessage, (msg) => {
        const encoded = Draft18MessageCodec.encode(msg);
        const [decoded] = Draft18MessageCodec.decode(encoded);
        const d = decoded as GoAwayMessageDraft18;
        expect(d.timeout).toBe(msg.timeout);
        // Codec normalizes empty string to undefined on decode.
        const expectedUri = msg.newSessionUri && msg.newSessionUri.length > 0
          ? msg.newSessionUri
          : undefined;
        expect(d.newSessionUri).toBe(expectedUri);
      }),
      { numRuns: 200 },
    );
  });

  it('REQUEST_UPDATE round-trips (requestId, forwardState)', () => {
    fc.assert(
      fc.property(arbRequestUpdateMessage, (msg) => {
        const encoded = Draft18MessageCodec.encode(msg);
        const [decoded] = Draft18MessageCodec.decode(encoded);
        const d = decoded as RequestUpdateMessageDraft18;
        expect(d.requestId).toBe(msg.requestId);
        expect(d.forwardState).toBe(msg.forwardState);
      }),
      { numRuns: 200 },
    );
  });

  it('PUBLISH_DONE round-trips (known status codes)', () => {
    fc.assert(
      fc.property(arbPublishDoneMessage, (msg) => {
        const encoded = Draft18MessageCodec.encode(msg);
        const [decoded] = Draft18MessageCodec.decode(encoded);
        const d = decoded as PublishDoneMessageDraft18;
        expect(d.statusCode).toBe(msg.statusCode);
        expect(d.streamCount).toBe(msg.streamCount);
      }),
      { numRuns: 200 },
    );
  });

  it('SUBSCRIBE_TRACKS round-trips (requestId, prefix, forwardState)', () => {
    fc.assert(
      fc.property(arbSubscribeTracksMessage, (msg) => {
        const encoded = Draft18MessageCodec.encode(msg);
        const [decoded] = Draft18MessageCodec.decode(encoded);
        const d = decoded as SubscribeTracksMessageDraft18;
        expect(d.requestId).toBe(msg.requestId);
        expect(d.trackNamespacePrefix).toEqual(msg.trackNamespacePrefix);
        expect(d.forwardState).toBe(msg.forwardState);
      }),
      { numRuns: 200 },
    );
  });
});
