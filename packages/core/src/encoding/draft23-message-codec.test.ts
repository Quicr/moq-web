// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { describe, it, expect } from 'vitest';
import { Draft23MessageCodec, DIALECT_DRAFT23, draft23Dialect, draft23Framing, MAX_UNSUPPORTED_PROPERTIES } from './draft23-message-codec';
import { Draft22MessageCodec } from './draft22-message-codec';
import { Draft18CodecError, isIncompleteDecode } from './draft18-message-codec';
import { controlFrameSize, encodeDraft18AuthToken, AuthTokenAliasType } from './codec-helpers';
import { MOQTVarInt } from './moqt-varint';
import { createProtocolCodec, getProtocolCodecForVersion } from './protocol-codec';
import { terminationCodeFor, violationOf } from './violation';
import {
  normalizeRequestErrorCodeDraft23,
  normalizeSessionErrorCodeDraft23,
  normalizePublishDoneErrorCodeDraft23,
  normalizeStreamResetErrorCodeDraft23,
} from './grease';
import {
  MessageTypeDraft18,
  MessageTypeDraft22,
  Version,
  GroupOrder,
  LocationFilterTypeDraft22,
  RequestErrorCodeDraft23,
  SessionErrorCodeDraft23,
  SessionErrorCodeDraft18,
  PublishDoneErrorCodeDraft23,
  type ClientSetupMessageDraft18,
  type ServerSetupMessageDraft18,
  type SubscribeMessageDraft22,
  type PublishMessageDraft22,
  type SubscribeTracksMessageDraft22,
  type RequestUpdateMessageDraft22,
  type RequestErrorMessageDraft18,
  type RequestOkMessageDraft18,
  type NamespaceMessageDraft18,
  type ControlMessageDraft22,
} from '../messages/types';
import { ALPN_PROTOCOL, VERSION_NUMBER, isDraftAtLeast, draftNumber } from '../version/constants';

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

/** Decode and assert the violation kind the codec reports */
function expectViolation(fn: () => unknown, kind: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught, 'expected a throw').toBeInstanceOf(Error);
  expect(violationOf(caught)).toBe(kind);
}

function roundTrip<T extends ControlMessageDraft22>(message: T): T {
  const encoded = Draft23MessageCodec.encode(message);
  const [decoded, bytesRead] = Draft23MessageCodec.decode(encoded);
  expect(bytesRead).toBe(encoded.length);
  return decoded as T;
}

const subscribe = (overrides: Partial<SubscribeMessageDraft22> = {}): SubscribeMessageDraft22 => ({
  type: MessageTypeDraft22.SUBSCRIBE,
  requestId: 4n,
  trackNamespace: ['live'],
  trackName: 'video',
  forwardState: true,
  ...overrides,
});

describe('draft-23 version', () => {
  it('uses version 0xff000017 and ALPN moqt-23', () => {
    expect(Version.DRAFT_23).toBe(0xff000017);
    expect(VERSION_NUMBER.DRAFT_23).toBe(0xff000017);
    expect(ALPN_PROTOCOL.DRAFT_23).toBe('moqt-23');
  });

  it('isDraftAtLeast orders drafts so draft-23 inherits draft-22 behaviour', () => {
    expect(draftNumber('draft-23')).toBe(23);
    expect(isDraftAtLeast('draft-23', 22)).toBe(true);
    expect(isDraftAtLeast('draft-23', 18)).toBe(true);
    expect(isDraftAtLeast('draft-22', 23)).toBe(false);
    expect(isDraftAtLeast('draft-16', 18)).toBe(false);
  });

  it('gives each session its own draft-23 codec, and shares earlier ones', () => {
    const a = createProtocolCodec(Version.DRAFT_23);
    const b = createProtocolCodec(Version.DRAFT_23);
    expect(a).not.toBe(b);
    expect(a.version).toBe(Version.DRAFT_23);
    expect(createProtocolCodec(Version.DRAFT_22)).toBe(getProtocolCodecForVersion(Version.DRAFT_22));
  });
});

describe('§9 control message framing (vi64 Message Length)', () => {
  it('frames a NAMESPACE as Type | vi64 Length | Body', () => {
    const message: NamespaceMessageDraft18 = { type: MessageTypeDraft18.NAMESPACE, trackNamespace: ['a'] };
    // 08 | len 4 | tuple count 1, len 1, 'a' | 0 parameters
    expect(hex(Draft23MessageCodec.encode(message as unknown as ControlMessageDraft22))).toBe('0804010161' + '00');
  });

  it('draft-22 keeps the 16-bit length for the same body', () => {
    const message = subscribe();
    const d22 = Draft22MessageCodec.encode(message);
    const d23 = Draft23MessageCodec.encode(message);
    // Type 03, then d22 has two length bytes and d23 one
    expect(d22.length).toBe(d23.length + 1);
    expect(d22[1]).toBe(0x00);
  });

  it('uses a multi-byte length for a body over 127 bytes', () => {
    const encoded = Draft23MessageCodec.encode(subscribe({ trackName: 'x'.repeat(200) }));
    expect(encoded[1] & 0x80).toBe(0x80);
    expect(roundTrip(subscribe({ trackName: 'x'.repeat(200) })).trackName).toBe('x'.repeat(200));
  });

  it('reports an incomplete header or body as incomplete, not malformed', () => {
    const encoded = Draft23MessageCodec.encode(subscribe());
    for (const cut of [1, 2, encoded.length - 1]) {
      try {
        Draft23MessageCodec.decode(encoded.subarray(0, cut));
        expect.unreachable();
      } catch (err) {
        expect(isIncompleteDecode(err)).toBe(true);
      }
    }
  });

  it('rejects a length above MAX_CONTROL_MESSAGE_SIZE before the body arrives (FIELD_LENGTH_EXCEEDED)', () => {
    // Type SUBSCRIBE, Length 65536, and no body at all
    const header = new Uint8Array([0x03, ...MOQTVarInt.encode(65536)]);
    expectViolation(() => Draft23MessageCodec.decode(header), 'field-length');
    expectViolation(() => controlFrameSize(header, 0, DIALECT_DRAFT23.framing), 'field-length');
  });

  it('accepts and sends messages over 64 KiB up to a raised limit', () => {
    const big = draft23Dialect(draft23Framing(1 << 20, 1 << 20));
    // Authorization Tokens may repeat; five near-maximal ones exceed 2^16 bytes
    const token = encodeDraft18AuthToken({
      aliasType: AuthTokenAliasType.USE_VALUE,
      tokenType: 1,
      tokenValue: new Uint8Array(16000).fill(7),
    });
    const message = subscribe({ authTokens: Array.from({ length: 5 }, () => token) });
    const encoded = Draft23MessageCodec.encode(message, big);
    expect(encoded.length).toBeGreaterThan(0xffff);

    const [decoded, bytesRead] = Draft23MessageCodec.decode(encoded, 0, big);
    expect(bytesRead).toBe(encoded.length);
    expect((decoded as SubscribeMessageDraft22).authTokens).toHaveLength(5);

    // The default limit refuses it both ways
    expectViolation(() => Draft23MessageCodec.encode(message), 'field-length');
    expectViolation(() => Draft23MessageCodec.decode(encoded), 'field-length');
  });

  it('refuses to send a body over the peer limit', () => {
    expectViolation(() => Draft23MessageCodec.encode(subscribe(), draft23Dialect(draft23Framing(10, 65535))), 'field-length');
  });

  it('controlFrameSize gives the whole frame size once the header is in', () => {
    const encoded = Draft23MessageCodec.encode(subscribe());
    expect(controlFrameSize(encoded, 0, DIALECT_DRAFT23.framing)).toBe(encoded.length);
    expect(controlFrameSize(encoded.subarray(0, 1), 0, DIALECT_DRAFT23.framing)).toBeUndefined();
  });

  it('per-session codec limits apply to both directions and never drop below 65535', () => {
    const codec = createProtocolCodec(Version.DRAFT_23);
    codec.setControlMessageLimits({ maxSendLength: 10, maxReceiveLength: 1 << 20 });
    expect(codec.controlFraming.maxSendLength).toBe(65535);
    expect(codec.controlFraming.maxReceiveLength).toBe(1 << 20);
  });

  it('closes on trailing bytes in a body (MALFORMED_MESSAGE)', () => {
    const encoded = Draft23MessageCodec.encode(subscribe());
    const body = encoded.subarray(2);
    const padded = new Uint8Array([0x03, body.length + 1, ...body, 0x00]);
    expectViolation(() => Draft23MessageCodec.decode(padded), 'malformed-message');
  });
});

describe('§9.1.8 MAX_CONTROL_MESSAGE_SIZE setup option', () => {
  const setup = (size?: number): ClientSetupMessageDraft18 => ({
    type: MessageTypeDraft18.SETUP,
    supportedVersions: [Version.DRAFT_23],
    maxControlMessageSize: size,
  } as ClientSetupMessageDraft18);

  it('round-trips as a varint under option 0x10', () => {
    const encoded = Draft23MessageCodec.encodeSetupStream(setup(1 << 20));
    const [decoded] = Draft23MessageCodec.decodeSetupStream(encoded);
    expect(decoded.maxControlMessageSize).toBe(1 << 20);
    expect(decoded.extensions).toBeUndefined();
    // Length | delta 0x10 | varint(2^20)
    const value = MOQTVarInt.encode(1 << 20);
    expect(hex(encoded)).toBe(hex(new Uint8Array([1 + value.length, 0x10, ...value])));
  });

  it('round-trips on the control stream too', () => {
    const [decoded] = Draft23MessageCodec.decode(Draft23MessageCodec.encode(setup(70000) as unknown as ControlMessageDraft22));
    expect((decoded as unknown as ServerSetupMessageDraft18).maxControlMessageSize).toBe(70000);
  });

  it('is absent when not configured', () => {
    const [decoded] = Draft23MessageCodec.decodeSetupStream(Draft23MessageCodec.encodeSetupStream(setup()));
    expect(decoded.maxControlMessageSize).toBeUndefined();
  });

  it('rejects a value below 65535 (MALFORMED_KEY_VALUE)', () => {
    // Length 2 | delta 0x10 | 100
    expectViolation(() => Draft23MessageCodec.decodeSetupStream(new Uint8Array([2, 0x10, 100])), 'malformed-key-value');
    expect(() => Draft23MessageCodec.encodeSetupStream(setup(1000))).toThrow();
  });

  it('is an unknown extension to a draft-22 peer', () => {
    const encoded = Draft23MessageCodec.encodeSetupStream(setup(70000));
    // Same body, 16-bit length
    const body = encoded.subarray(1);
    const [decoded] = Draft22MessageCodec.decodeSetupStream(new Uint8Array([0, body.length, ...body]));
    expect(decoded.maxControlMessageSize).toBeUndefined();
    expect(decoded.extensions?.get(0x10)).toEqual({ varint: 70000n });
  });
});

describe('§9.19.18 PAUSED replaces FORWARD', () => {
  it('encodes paused as PAUSED (0x11) = 1 and forwarding as 0', () => {
    const paused = Draft23MessageCodec.encode(subscribe({ forwardState: false }));
    const forwarding = Draft23MessageCodec.encode(subscribe({ forwardState: true }));
    // ... | 1 parameter | delta 0x11 | value
    expect(hex(paused).endsWith('011101')).toBe(true);
    expect(hex(forwarding).endsWith('011100')).toBe(true);
    expect(roundTrip(subscribe({ forwardState: false })).forwardState).toBe(false);
    expect(roundTrip(subscribe({ forwardState: true })).forwardState).toBe(true);
  });

  it('defaults to unpaused when omitted from SUBSCRIBE', () => {
    // 03 | len | req 4 | ns ['a'] | name 'v' | 0 params
    const body = [0x04, 0x01, 0x01, 0x61, 0x01, 0x76, 0x00];
    const [decoded] = Draft23MessageCodec.decode(new Uint8Array([0x03, body.length, ...body]));
    expect((decoded as SubscribeMessageDraft22).forwardState).toBe(true);
  });

  it('leaves the state unchanged when omitted from REQUEST_UPDATE', () => {
    const update: RequestUpdateMessageDraft22 = { type: MessageTypeDraft22.REQUEST_UPDATE, requestId: 2n };
    expect(roundTrip(update).forwardState).toBeUndefined();
  });

  it('rejects the draft-22 FORWARD parameter (INVALID_PARAMETER)', () => {
    const body = [0x04, 0x01, 0x01, 0x61, 0x01, 0x76, 0x01, 0x10, 0x01];
    expectViolation(() => Draft23MessageCodec.decode(new Uint8Array([0x03, body.length, ...body])), 'invalid-parameter');
  });

  it('rejects a PAUSED value other than 0 or 1 (INVALID_PARAMETER)', () => {
    const body = [0x04, 0x01, 0x01, 0x61, 0x01, 0x76, 0x01, 0x11, 0x02];
    expectViolation(() => Draft23MessageCodec.decode(new Uint8Array([0x03, body.length, ...body])), 'invalid-parameter');
  });

  it('draft-22 is unchanged: FORWARD (0x10) = 0 when paused', () => {
    expect(hex(Draft22MessageCodec.encode(subscribe({ forwardState: false }))).endsWith('011000')).toBe(true);
  });
});

describe('§9.19.15 FILL_PARAMETERS is a parameter count, not a length', () => {
  it('encodes FILL_PARAMETERS as Number of Parameters | Parameters', () => {
    const message = subscribe({ forwardState: true, fill: { subscriberPriority: 7 } });
    // ... | 2 params | delta 0x11 PAUSED 0 | delta 0x12 (0x23) FILL: 1 param, delta 0x20 SUBSCRIBER_PRIORITY 7
    expect(hex(Draft23MessageCodec.encode(message)).endsWith('02' + '1100' + '12' + '01' + '2007')).toBe(true);
    expect(roundTrip(message).fill).toEqual({ subscriberPriority: 7 });
  });

  it('round-trips every fill parameter, including LOCATION_FILTER and range filters', () => {
    const fill = {
      fillTimeoutMs: 500n,
      subscriberPriority: 9,
      groupOrder: GroupOrder.DESCENDING,
      locationFilter: { type: LocationFilterTypeDraft22.ABSOLUTE_START, startLocation: { group: 3n, object: 1n } },
    };
    expect(roundTrip(subscribe({ fill })).fill).toEqual(fill);
  });

  it('is allowed in PUBLISH and SUBSCRIBE_TRACKS in draft-23 only (#2007)', () => {
    const publish: PublishMessageDraft22 = {
      type: MessageTypeDraft22.PUBLISH,
      requestId: 3n,
      trackAlias: 1n,
      trackNamespace: ['live'],
      trackName: 'v',
      forwardState: true,
      fill: { subscriberPriority: 1 },
    };
    expect(roundTrip(publish).fill).toEqual({ subscriberPriority: 1 });
    expect(() => Draft22MessageCodec.encode(publish)).toThrow(Draft18CodecError);
  });

  it('rejects a parameter not allowed inside FILL_PARAMETERS (INVALID_PARAMETER)', () => {
    // FILL with 1 param: delta 0x11 PAUSED
    const body = [0x04, 0x01, 0x01, 0x61, 0x01, 0x76, 0x01, 0x23, 0x01, 0x11, 0x00];
    expectViolation(() => Draft23MessageCodec.decode(new Uint8Array([0x03, body.length, ...body])), 'invalid-parameter');
  });
});

describe('SUBSCRIBE_TRACKS and PUBLISH parameter scopes (#1995, #2018)', () => {
  it('SUBSCRIBE_TRACKS carries LOCATION_FILTER, priority and delivery timeouts', () => {
    const message: SubscribeTracksMessageDraft22 = {
      type: MessageTypeDraft22.SUBSCRIBE_TRACKS,
      requestId: 6n,
      trackNamespacePrefix: ['room'],
      forwardState: false,
      locationFilter: { type: LocationFilterTypeDraft22.NEXT_OBJECT },
      parameters: new Map([
        [0x02, MOQTVarInt.encode(100)],
        [0x06, MOQTVarInt.encode(200)],
        [0x20, new Uint8Array([5])],
      ]),
    };
    const decoded = roundTrip(message);
    expect(decoded.forwardState).toBe(false);
    expect(decoded.locationFilter).toEqual({ type: LocationFilterTypeDraft22.NEXT_OBJECT });
    expect([...(decoded.parameters?.keys() ?? [])]).toEqual([0x02, 0x06, 0x20]);
    expect(() => Draft22MessageCodec.encode(message)).toThrow(Draft18CodecError);
  });

  it('SUBSCRIBE_TRACKS rejects RENDEZVOUS_TIMEOUT and NEW_GROUP_REQUEST', () => {
    for (const type of [0x04, 0x32]) {
      const message: SubscribeTracksMessageDraft22 = {
        type: MessageTypeDraft22.SUBSCRIBE_TRACKS,
        requestId: 6n,
        trackNamespacePrefix: ['room'],
        forwardState: true,
        parameters: new Map([[type, MOQTVarInt.encode(1)]]),
      };
      expect(() => Draft23MessageCodec.encode(message)).toThrow(Draft18CodecError);
    }
  });

  it('PUBLISH carries SUBSCRIBE_TRACKS_ID (0x36) as a typed field', () => {
    const publish: PublishMessageDraft22 = {
      type: MessageTypeDraft22.PUBLISH,
      requestId: 3n,
      trackAlias: 1n,
      trackNamespace: ['live'],
      trackName: 'v',
      forwardState: true,
      subscribeTracksId: 6n,
    };
    const decoded = roundTrip(publish);
    expect(decoded.subscribeTracksId).toBe(6n);
    expect(decoded.parameters).toBeUndefined();
    expect(() => Draft22MessageCodec.encode(publish)).toThrow(Draft18CodecError);
  });

  it('SUBSCRIBE_TRACKS_ID is not allowed in SUBSCRIBE', () => {
    expect(() => Draft23MessageCodec.encode(subscribe({ parameters: new Map([[0x36, MOQTVarInt.encode(1)]]) }))).toThrow();
  });
});

describe('§9.19 parameter block hardening', () => {
  it('a Type Delta past 2^64-1 is DELTA_ENCODING_OVERFLOW', () => {
    // 2 params: delta 0x02 varint 1, then delta 2^64-1
    const max = MOQTVarInt.encode((1n << 64n) - 1n);
    const body = [0x04, 0x01, 0x01, 0x61, 0x01, 0x76, 0x02, 0x02, 0x01, ...max, 0x00];
    expectViolation(() => Draft23MessageCodec.decode(new Uint8Array([0x03, body.length, ...body])), 'delta-overflow');
  });

  it('a parameter count larger than the body is malformed, and fails fast', () => {
    const count = MOQTVarInt.encode(1_000_000);
    const body = [0x04, 0x01, 0x01, 0x61, 0x01, 0x76, ...count];
    expectViolation(() => Draft23MessageCodec.decode(new Uint8Array([0x03, body.length, ...body])), 'malformed-message');
  });

  it('a duplicate parameter is INVALID_PARAMETER', () => {
    const body = [0x04, 0x01, 0x01, 0x61, 0x01, 0x76, 0x02, 0x11, 0x00, 0x00, 0x00];
    expectViolation(() => Draft23MessageCodec.decode(new Uint8Array([0x03, body.length, ...body])), 'invalid-parameter');
  });
});

describe('§2.4.1 Track Names must not be empty (#1954)', () => {
  it('rejects an empty Track Name in SUBSCRIBE', () => {
    const body = [0x04, 0x01, 0x01, 0x61, 0x00, 0x00];
    expectViolation(() => Draft23MessageCodec.decode(new Uint8Array([0x03, body.length, ...body])), 'protocol-violation');
  });

  it('draft-22 still accepts it', () => {
    const body = [0x04, 0x01, 0x01, 0x61, 0x00, 0x00];
    const [decoded] = Draft22MessageCodec.decode(new Uint8Array([0x03, 0x00, body.length, ...body]));
    expect((decoded as SubscribeMessageDraft22).trackName).toBe('');
  });
});

describe('§9.3 FETCH_OK is a REQUEST_OK (#2009)', () => {
  it('treats type 0x18 as reserved (UNEXPECTED_MESSAGE)', () => {
    expectViolation(() => Draft23MessageCodec.decode(new Uint8Array([0x18, 0x00])), 'unexpected-message');
  });

  it('refuses to encode FETCH_OK', () => {
    const fetchOk = { type: MessageTypeDraft18.FETCH_OK, requestId: 0n, endOfTrack: false, endLocation: { group: 1n, object: 0n } };
    expect(() => Draft23MessageCodec.encode(fetchOk as unknown as ControlMessageDraft22)).toThrow(/REQUEST_OK/);
  });

  it('REQUEST_OK carries EXPIRES, LARGEST_OBJECT and Track Properties for a FETCH', () => {
    const ok: RequestOkMessageDraft18 = {
      type: MessageTypeDraft18.REQUEST_OK,
      requestId: 0n,
      expires: 1000n,
      largestLocation: { group: 9n, object: 3n },
      trackProperties: new Map([[0x3c, MOQTVarInt.encode(4)]]),
    };
    const decoded = roundTrip(ok as unknown as ControlMessageDraft22) as unknown as RequestOkMessageDraft18;
    expect(decoded.expires).toBe(1000n);
    expect(decoded.largestLocation).toEqual({ group: 9n, object: 3n });
    expect(decoded.trackProperties?.size).toBe(1);
  });
});

describe('§9.4 REQUEST_ERROR Error Details (#2010, #2011)', () => {
  const error = (overrides: Partial<RequestErrorMessageDraft18>): RequestErrorMessageDraft18 => ({
    type: MessageTypeDraft18.REQUEST_ERROR,
    requestId: 0n,
    errorCode: RequestErrorCodeDraft23.INTERNAL_ERROR,
    retryInterval: 0n,
    reasonPhrase: '',
    ...overrides,
  });
  const decodeError = (message: RequestErrorMessageDraft18): RequestErrorMessageDraft18 =>
    roundTrip(message as unknown as ControlMessageDraft22) as unknown as RequestErrorMessageDraft18;

  it('carries REDIRECT as Error Detail 0x01', () => {
    const redirect = { connectUri: 'moqt://relay.example/', trackNamespace: ['live'], trackName: 'v2' };
    const encoded = Draft23MessageCodec.encode(error({ errorCode: RequestErrorCodeDraft23.REDIRECT, redirect }) as unknown as ControlMessageDraft22);
    // 05 | len | code 0x34 | retry 0 | reason len 0 | detail type 1 | ...
    expect(hex(encoded.subarray(2, 6))).toBe('34000001');
    expect(decodeError(error({ errorCode: RequestErrorCodeDraft23.REDIRECT, redirect })).redirect).toEqual(redirect);
  });

  it('a REDIRECT code with no REDIRECT detail is MALFORMED_MESSAGE', () => {
    expectViolation(() => Draft23MessageCodec.decode(new Uint8Array([0x05, 0x03, 0x34, 0x00, 0x00])), 'malformed-message');
  });

  it('a REDIRECT detail that does not parse exactly is MALFORMED_KEY_VALUE', () => {
    // detail 1, length 2, URI length 0, then a stray byte instead of a namespace
    const body = [0x34, 0x00, 0x00, 0x01, 0x02, 0x00, 0x05];
    expectViolation(() => Draft23MessageCodec.decode(new Uint8Array([0x05, body.length, ...body])), 'malformed-key-value');
  });

  it('carries one UNSUPPORTED_PROPERTY detail per unknown mandatory property', () => {
    const decoded = decodeError(error({
      errorCode: RequestErrorCodeDraft23.UNSUPPORTED_EXTENSION,
      unsupportedProperties: [0x4000n, 0x4002n],
    }));
    expect(decoded.unsupportedProperties).toEqual([0x4000n, 0x4002n]);
  });

  it('ignores unknown detail types, including repeats', () => {
    // UNSUPPORTED_EXTENSION | retry 0 | reason '' | type 0x9D grease (odd: length 1) x2 | type 0x02 delta...
    const grease = MOQTVarInt.encode(0x9d);
    const body = [0x33, 0x00, 0x00, ...grease, 0x01, 0xaa, 0x00, 0x01, 0xbb];
    const [decoded] = Draft23MessageCodec.decode(new Uint8Array([0x05, body.length, ...body]));
    expect((decoded as unknown as RequestErrorMessageDraft18).unsupportedProperties).toBeUndefined();
  });

  it('a greased REQUEST_ERROR decodes as without the grease (§13)', () => {
    const redirect = { connectUri: '', trackNamespace: ['live'], trackName: 'v2' };
    const cases = [
      error({ reasonPhrase: 'busy' }),
      error({ errorCode: RequestErrorCodeDraft23.REDIRECT, redirect }),
      error({ errorCode: RequestErrorCodeDraft23.UNSUPPORTED_EXTENSION, unsupportedProperties: [0x4000n] }),
    ];
    for (const message of cases) {
      for (let i = 0; i < 32; i++) {
        const plain = Draft23MessageCodec.encode(message as unknown as ControlMessageDraft22);
        const greased = Draft23MessageCodec.encode({ ...message, greaseDetail: true } as unknown as ControlMessageDraft22);
        expect(greased.length).toBeGreaterThan(plain.length);
        expect(Draft23MessageCodec.decode(greased)[0]).toEqual(Draft23MessageCodec.decode(plain)[0]);
      }
    }
  });

  it('a codec with grease on greases only REQUEST_ERROR', () => {
    const codec = createProtocolCodec(Version.DRAFT_23);
    const plain = codec.encodeControlMessage(error({}));
    codec.setGrease?.(true);
    expect(codec.encodeControlMessage(error({})).length).toBeGreaterThan(plain.length);
    const goaway = { type: MessageTypeDraft18.GOAWAY, newSessionUri: '', timeout: 0n };
    expect(codec.encodeControlMessage(goaway)).toEqual(createProtocolCodec(Version.DRAFT_23).encodeControlMessage(goaway));
  });

  it('ignores a known detail beside an Error Code it is not defined for', () => {
    // INTERNAL_ERROR with UNSUPPORTED_PROPERTY 0x4000
    const property = MOQTVarInt.encode(0x4000);
    const body = [0x00, 0x00, 0x00, 0x02, ...property];
    const [decoded] = Draft23MessageCodec.decode(new Uint8Array([0x05, body.length, ...body]));
    expect((decoded as unknown as RequestErrorMessageDraft18).unsupportedProperties).toBeUndefined();
  });

  it(`keeps at most ${MAX_UNSUPPORTED_PROPERTIES} UNSUPPORTED_PROPERTY details`, () => {
    const many = Array.from({ length: 500 }, (_, i) => BigInt(0x4000 + 2 * i));
    const decoded = decodeError(error({ errorCode: RequestErrorCodeDraft23.UNSUPPORTED_EXTENSION, unsupportedProperties: many }));
    expect(decoded.unsupportedProperties).toHaveLength(MAX_UNSUPPORTED_PROPERTIES);
  });

  it('normalizes UNAVAILABLE as known and PREFIX_OVERLAP as INTERNAL_ERROR', () => {
    expect(decodeError(error({ errorCode: RequestErrorCodeDraft23.UNAVAILABLE, retryInterval: 5n })).errorCode).toBe(0xa);
    expect(decodeError(error({ errorCode: 0x30 })).errorCode).toBe(RequestErrorCodeDraft23.INTERNAL_ERROR);
  });
});

describe('§9.15 NAMESPACE Parameters (#1858)', () => {
  it('round-trips with an empty parameter block', () => {
    const message = { type: MessageTypeDraft18.NAMESPACE, trackNamespace: ['a', 'b'] };
    const decoded = roundTrip(message as unknown as ControlMessageDraft22) as unknown as NamespaceMessageDraft18;
    expect(decoded.trackNamespace).toEqual(['a', 'b']);
  });

  it('rejects any parameter, as none are defined for NAMESPACE (INVALID_PARAMETER)', () => {
    expectViolation(() => Draft23MessageCodec.decode(new Uint8Array([0x08, 0x06, 0x01, 0x01, 0x61, 0x01, 0x02, 0x05])), 'invalid-parameter');
  });

  it('rejects a NAMESPACE without its parameter count (MALFORMED_MESSAGE)', () => {
    expectViolation(() => Draft23MessageCodec.decode(new Uint8Array([0x08, 0x03, 0x01, 0x01, 0x61])), 'malformed-message');
  });
});

describe('violation kinds map to draft-specific Session Termination Codes', () => {
  it('draft-23 uses the specific code for each kind (§12.2)', () => {
    expect(terminationCodeFor('malformed-message', 'draft-23')).toBe(SessionErrorCodeDraft23.MALFORMED_MESSAGE);
    expect(terminationCodeFor('invalid-parameter', 'draft-23')).toBe(0x305);
    expect(terminationCodeFor('delta-overflow', 'draft-23')).toBe(0x400);
    expect(terminationCodeFor('field-length', 'draft-23')).toBe(0x401);
    expect(terminationCodeFor('malformed-object', 'draft-23')).toBe(0x201);
    expect(terminationCodeFor('protocol-violation', 'draft-23')).toBe(SessionErrorCodeDraft23.PROTOCOL_VIOLATION);
  });

  it('earlier drafts close with PROTOCOL_VIOLATION, or KEY_VALUE_FORMATTING_ERROR for a KVP', () => {
    for (const draft of ['draft-18', 'draft-22'] as const) {
      expect(terminationCodeFor('malformed-message', draft)).toBe(SessionErrorCodeDraft18.PROTOCOL_VIOLATION);
      expect(terminationCodeFor('delta-overflow', draft)).toBe(SessionErrorCodeDraft18.PROTOCOL_VIOLATION);
      expect(terminationCodeFor('malformed-key-value', draft)).toBe(SessionErrorCodeDraft18.KEY_VALUE_FORMATTING_ERROR);
    }
  });

  it('infers a kind from legacy codec tags', () => {
    expect(violationOf(new Draft18CodecError('x', undefined, 'malformed'))).toBe('malformed-message');
    expect(violationOf(new Draft18CodecError('x', undefined, 'bounds-exceeded'))).toBe('field-length');
    expect(violationOf(new Error('x'))).toBeUndefined();
  });
});

describe('draft-23 error code registries', () => {
  it('keeps the category of unknown session codes in 0x200-0x4FF', () => {
    expect(normalizeSessionErrorCodeDraft23(0x305)).toBe(0x305);
    expect(normalizeSessionErrorCodeDraft23(0x2ff)).toBe(0x2ff);
    expect(normalizeSessionErrorCodeDraft23(0x500)).toBe(SessionErrorCodeDraft23.INTERNAL_ERROR);
    // 0x7f * 4 + 0x9d = 0x299 is grease inside a category range
    expect(normalizeSessionErrorCodeDraft23(0x299)).toBe(SessionErrorCodeDraft23.INTERNAL_ERROR);
  });

  it('adds EXPIRED_AUTH_TOKEN to PUBLISH_DONE and drops UNKNOWN_OBJECT_STATUS from resets', () => {
    expect(normalizePublishDoneErrorCodeDraft23(0x7)).toBe(PublishDoneErrorCodeDraft23.EXPIRED_AUTH_TOKEN);
    expect(normalizeStreamResetErrorCodeDraft23(0x6)).toBe(0x0);
    expect(normalizeRequestErrorCodeDraft23(0xa)).toBe(0xa);
  });
});
