// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Draft-22 §9.20 Message Parameters: every parameter is framed by its
 * spec-defined type, and only in the messages that allow it.
 */

import { describe, it, expect } from 'vitest';
import { Draft22MessageCodec } from './draft22-message-codec';
import {
  GroupOrder,
  LocationFilterTypeDraft22,
  MessageTypeDraft18,
  MessageTypeDraft22,
  RequestParameterDraft22,
  type ControlMessageDraft22,
  type FetchMessageDraft22,
  type PublishMessageDraft22,
  type PublishStateNotifyMessageDraft22,
  type RangeFilterDraft22,
  type RequestUpdateMessageDraft22,
  type SubscribeMessageDraft22,
  type SubscribeTracksMessageDraft22,
  type TrackStatusMessageDraft22,
} from '../messages/types';

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);

describe('Draft22 §9.20 message parameters', () => {
  describe('PUBLISH_STATE_NOTIFY (§9.10)', () => {
    // type | len(8) | nparams=2
    // | LARGEST_OBJECT(0x09) 5,7 | LOCATION_FILTER(+0x18) ABSOLUTE_START 3,1
    const wire = bytes(0x22, 0x00, 0x08, 0x02, 0x09, 0x05, 0x07, 0x18, 0x02, 0x03, 0x01);
    const message: PublishStateNotifyMessageDraft22 = {
      type: MessageTypeDraft22.PUBLISH_STATE_NOTIFY,
      largestLocation: { group: 5n, object: 7n },
      locationFilter: {
        type: LocationFilterTypeDraft22.ABSOLUTE_START,
        startLocation: { group: 3n, object: 1n },
      },
    };

    it('encodes LARGEST_OBJECT as a Location and LOCATION_FILTER unprefixed', () => {
      expect(Draft22MessageCodec.encode(message)).toEqual(wire);
    });

    it('decodes LARGEST_OBJECT and LOCATION_FILTER', () => {
      const [decoded, bytesRead] = Draft22MessageCodec.decode(wire);

      expect(decoded).toEqual(message);
      expect(bytesRead).toBe(wire.length);
    });

    it('roundtrips FORWARD', () => {
      const withForward = { ...message, forwardState: false };

      const [decoded] = Draft22MessageCodec.decode(Draft22MessageCodec.encode(withForward));

      expect(decoded).toEqual(withForward);
    });

    it('roundtrips an empty notification', () => {
      const empty: PublishStateNotifyMessageDraft22 = { type: MessageTypeDraft22.PUBLISH_STATE_NOTIFY };

      const [decoded] = Draft22MessageCodec.decode(Draft22MessageCodec.encode(empty));

      expect(decoded).toEqual(empty);
    });

    it('rejects a parameter it does not allow', () => {
      // SUBSCRIBER_PRIORITY (0x20) is not allowed in PUBLISH_STATE_NOTIFY
      const wireBad = bytes(0x22, 0x00, 0x03, 0x01, 0x20, 0x05);

      expect(() => Draft22MessageCodec.decode(wireBad)).toThrow(/SUBSCRIBER_PRIORITY.*PUBLISH_STATE_NOTIFY.*PROTOCOL_VIOLATION/);
    });
  });

  describe('PUBLISH (§9.8)', () => {
    // type | len(15) | reqId=1 | ns(1,"a") | name(1,"t") | alias=2 | nparams=3
    // | LARGEST_OBJECT 5,7 | FORWARD(+7)=1 | LOCATION_FILTER(+0x11) NEXT_OBJECT
    const wire = bytes(
      0x1d, 0x00, 0x0f,
      0x01, 0x01, 0x01, 0x61, 0x01, 0x74, 0x02,
      0x03,
      0x09, 0x05, 0x07,
      0x07, 0x01,
      0x11, 0x05,
    );
    const message: PublishMessageDraft22 = {
      type: MessageTypeDraft22.PUBLISH,
      requestId: 1n,
      trackNamespace: ['a'],
      trackName: 't',
      trackAlias: 2n,
      forwardState: true,
      largestLocation: { group: 5n, object: 7n },
      locationFilter: { type: LocationFilterTypeDraft22.NEXT_OBJECT },
    };

    it('encodes to the exact spec bytes', () => {
      expect(Draft22MessageCodec.encode(message)).toEqual(wire);
    });

    it('decodes LARGEST_OBJECT, FORWARD and LOCATION_FILTER', () => {
      const [decoded, bytesRead] = Draft22MessageCodec.decode(wire);

      expect(decoded).toEqual(message);
      expect(bytesRead).toBe(wire.length);
    });

    it('roundtrips other parameters and track properties', () => {
      const full: PublishMessageDraft22 = {
        ...message,
        parameters: new Map([[0x20, bytes(0x40)]]), // SUBSCRIBER_PRIORITY
        trackProperties: new Map([[0x06, bytes(0x0a)]]),
      };

      const [decoded] = Draft22MessageCodec.decode(Draft22MessageCodec.encode(full));

      expect(decoded).toEqual(full);
    });

    it('treats a missing FORWARD as 1 and a missing LARGEST_OBJECT as none', () => {
      const bare = bytes(0x1d, 0x00, 0x08, 0x01, 0x01, 0x01, 0x61, 0x01, 0x74, 0x02, 0x00);

      const [decoded] = Draft22MessageCodec.decode(bare);
      const d = decoded as PublishMessageDraft22;

      expect(d.forwardState).toBe(true);
      expect(d.largestLocation).toBeUndefined();
    });

    it('rejects INCLUDE_PROPERTIES, which PUBLISH does not allow', () => {
      const wireBad = bytes(0x1d, 0x00, 0x0a, 0x01, 0x01, 0x01, 0x61, 0x01, 0x74, 0x02, 0x01, 0x35, 0x01);

      expect(() => Draft22MessageCodec.decode(wireBad)).toThrow(/INCLUDE_PROPERTIES.*PROTOCOL_VIOLATION/);
    });
  });

  describe('REQUEST_UPDATE (§9.5)', () => {
    // type | len(7) | reqId=9 | nparams=2 | FORWARD=0
    // | LOCATION_FILTER(+0x11) RELATIVE_START 2
    const wire = bytes(0x02, 0x00, 0x07, 0x09, 0x02, 0x10, 0x00, 0x11, 0x01, 0x02);
    const message: RequestUpdateMessageDraft22 = {
      type: MessageTypeDraft22.REQUEST_UPDATE,
      requestId: 9n,
      forwardState: false,
      locationFilter: {
        type: LocationFilterTypeDraft22.RELATIVE_START,
        startLocation: { group: 2n, object: 0n },
      },
    };

    it('encodes to the exact spec bytes', () => {
      expect(Draft22MessageCodec.encode(message)).toEqual(wire);
    });

    it('decodes FORWARD and LOCATION_FILTER', () => {
      const [decoded, bytesRead] = Draft22MessageCodec.decode(wire);

      expect(decoded).toEqual(message);
      expect(bytesRead).toBe(wire.length);
    });

    it('leaves FORWARD undefined when omitted (value unchanged)', () => {
      const encoded = Draft22MessageCodec.encode({ ...message, forwardState: undefined });

      const [decoded] = Draft22MessageCodec.decode(encoded);

      expect((decoded as RequestUpdateMessageDraft22).forwardState).toBeUndefined();
    });

    it('decodes TRACK_NAMESPACE_PREFIX as a Track Namespace', () => {
      // reqId=9 | nparams=1 | TRACK_NAMESPACE_PREFIX(0x34) ns(2,"b","c")
      const wireNs = bytes(0x02, 0x00, 0x08, 0x09, 0x01, 0x34, 0x02, 0x01, 0x62, 0x01, 0x63);

      const [decoded, bytesRead] = Draft22MessageCodec.decode(wireNs);
      const d = decoded as RequestUpdateMessageDraft22;

      expect(d.parameters?.get(0x34)).toEqual(bytes(0x02, 0x01, 0x62, 0x01, 0x63));
      expect(bytesRead).toBe(wireNs.length);
      expect(Draft22MessageCodec.encode(d)).toEqual(wireNs);
    });

    it('rejects INCLUDE_PROPERTIES, which REQUEST_UPDATE does not allow', () => {
      const wireBad = bytes(0x02, 0x00, 0x04, 0x09, 0x01, 0x35, 0x01);

      expect(() => Draft22MessageCodec.decode(wireBad)).toThrow(/INCLUDE_PROPERTIES.*REQUEST_UPDATE.*PROTOCOL_VIOLATION/);
    });

    it('refuses to encode a parameter REQUEST_UPDATE does not allow', () => {
      const bad = { ...message, parameters: new Map([[0x35, bytes(0x01)]]) };

      expect(() => Draft22MessageCodec.encode(bad)).toThrow(/INCLUDE_PROPERTIES.*PROTOCOL_VIOLATION/);
    });
  });

  describe('TRACK_STATUS (§9.13)', () => {
    // type | len(9) | reqId=5 | ns(1,"a") | name(1,"t") | nparams=1
    // | INCLUDE_PROPERTIES(0x35)=0
    const wire = bytes(0x0d, 0x00, 0x09, 0x05, 0x01, 0x01, 0x61, 0x01, 0x74, 0x01, 0x35, 0x00);
    const message: TrackStatusMessageDraft22 = {
      type: MessageTypeDraft22.TRACK_STATUS,
      requestId: 5n,
      trackNamespace: ['a'],
      trackName: 't',
      parameters: new Map([[0x35, bytes(0x00)]]),
    };

    it('encodes INCLUDE_PROPERTIES as a uint8', () => {
      expect(Draft22MessageCodec.encode(message)).toEqual(wire);
    });

    it('decodes INCLUDE_PROPERTIES as a uint8', () => {
      const [decoded, bytesRead] = Draft22MessageCodec.decode(wire);

      expect(decoded).toEqual(message);
      expect(bytesRead).toBe(wire.length);
    });

    it('rejects FORWARD, which TRACK_STATUS does not allow', () => {
      const wireBad = bytes(0x0d, 0x00, 0x09, 0x05, 0x01, 0x01, 0x61, 0x01, 0x74, 0x01, 0x10, 0x01);

      expect(() => Draft22MessageCodec.decode(wireBad)).toThrow(/FORWARD.*TRACK_STATUS.*PROTOCOL_VIOLATION/);
    });
  });

  describe('SUBSCRIBE_TRACKS (§9.18)', () => {
    // type | len(11) | reqId=3 | ns(1,"a") | nparams=3
    // | FORWARD=0 | GROUP_ORDER(+0x12)=2 | INCLUDE_PROPERTIES(+0x13)=1
    const wire = bytes(0x51, 0x00, 0x0b, 0x03, 0x01, 0x01, 0x61, 0x03, 0x10, 0x00, 0x12, 0x02, 0x13, 0x01);
    const message: SubscribeTracksMessageDraft22 = {
      type: MessageTypeDraft22.SUBSCRIBE_TRACKS,
      requestId: 3n,
      trackNamespacePrefix: ['a'],
      forwardState: false,
      parameters: new Map([
        [0x22, bytes(0x02)],
        [0x35, bytes(0x01)],
      ]),
    };

    it('encodes every parameter by its own type, not length-prefixed', () => {
      expect(Draft22MessageCodec.encode(message)).toEqual(wire);
    });

    it('decodes FORWARD, GROUP_ORDER and INCLUDE_PROPERTIES', () => {
      const [decoded, bytesRead] = Draft22MessageCodec.decode(wire);

      expect(decoded).toEqual(message);
      expect(bytesRead).toBe(wire.length);
    });

    it('rejects TRACK_NAMESPACE_PREFIX, which is only allowed in REQUEST_UPDATE', () => {
      const wireBad = bytes(0x51, 0x00, 0x09, 0x03, 0x01, 0x01, 0x61, 0x01, 0x34, 0x01, 0x01, 0x62);

      expect(() => Draft22MessageCodec.decode(wireBad)).toThrow(/TRACK_NAMESPACE_PREFIX.*SUBSCRIBE_TRACKS.*PROTOCOL_VIOLATION/);
    });

    it('refuses to encode TRACK_NAMESPACE_PREFIX', () => {
      const bad = { ...message, parameters: new Map([[0x34, bytes(0x01, 0x01, 0x62)]]) };

      expect(() => Draft22MessageCodec.encode(bad)).toThrow(/TRACK_NAMESPACE_PREFIX.*PROTOCOL_VIOLATION/);
    });
  });

  describe('SUBSCRIBE FILL_PARAMETERS (§9.20.15)', () => {
    // type | len(18) | reqId=4 | ns(1,"a") | name(1,"t") | nparams=2
    // | FORWARD=1
    // | FILL_PARAMETERS(+0x13) len=7: nparams=2 (encoded as a separate
    //     message's parameters) | FILL_TIMEOUT(0x0A)=100
    //     | LOCATION_FILTER(+0x17) ABSOLUTE_START 1,0
    const wire = bytes(
      0x03, 0x00, 0x12,
      0x04, 0x01, 0x01, 0x61, 0x01, 0x74, 0x02,
      0x10, 0x01,
      0x13, 0x07, 0x02, 0x0a, 0x64, 0x17, 0x02, 0x01, 0x00,
    );
    const message: SubscribeMessageDraft22 = {
      type: MessageTypeDraft22.SUBSCRIBE,
      requestId: 4n,
      trackNamespace: ['a'],
      trackName: 't',
      forwardState: true,
      fill: {
        fillTimeoutMs: 100n,
        locationFilter: {
          type: LocationFilterTypeDraft22.ABSOLUTE_START,
          startLocation: { group: 1n, object: 0n },
        },
      },
    };

    it('encodes the nested parameter block to the exact spec bytes', () => {
      expect(Draft22MessageCodec.encode(message)).toEqual(wire);
    });

    it('decodes the nested parameter block', () => {
      const [decoded, bytesRead] = Draft22MessageCodec.decode(wire);

      expect(decoded).toEqual(message);
      expect(bytesRead).toBe(wire.length);
    });

    it('roundtrips priority, group order and range filters', () => {
      const full: SubscribeMessageDraft22 = {
        ...message,
        fill: {
          subscriberPriority: 7,
          groupOrder: GroupOrder.DESCENDING,
          rangeFilters: [{ type: RequestParameterDraft22.SUBGROUP_FILTER, setId: 1, ranges: [{ start: 0n, end: 10n }] }],
        },
      };
      const encoded = Draft22MessageCodec.encode(full);

      // ... | FILL_PARAMETERS len=10: nparams=3 | SUBSCRIBER_PRIORITY(0x20)=7
      // | GROUP_ORDER(+2)=2 | SUBGROUP_FILTER(+3) len=3
      expect(Array.from(encoded.slice(-12))).toEqual([
        0x13, 0x0a, 0x03, 0x20, 0x07, 0x02, 0x02, 0x03, 0x03, 0x01, 0x00, 0x0a,
      ]);
      const [decoded] = Draft22MessageCodec.decode(encoded);
      expect(decoded).toEqual(full);
    });

    it('allows a type both in the message and inside FILL_PARAMETERS', () => {
      const both: SubscribeMessageDraft22 = {
        ...message,
        locationFilter: { type: LocationFilterTypeDraft22.NEXT_OBJECT },
      };

      const [decoded] = Draft22MessageCodec.decode(Draft22MessageCodec.encode(both));

      expect(decoded).toEqual(both);
    });

    it('rejects a parameter not listed in Table 7 inside FILL_PARAMETERS', () => {
      // FILL_PARAMETERS len=3: nparams=1 | FORWARD=1
      const wireBad = bytes(
        0x03, 0x00, 0x0c,
        0x04, 0x01, 0x01, 0x61, 0x01, 0x74, 0x01,
        0x23, 0x03, 0x01, 0x10, 0x01,
      );

      expect(() => Draft22MessageCodec.decode(wireBad)).toThrow(/FORWARD.*FILL_PARAMETERS.*PROTOCOL_VIOLATION/);
    });

    it('rejects a nested parameter block that overruns its length', () => {
      // FILL_PARAMETERS len=3 but LOCATION_FILTER ABSOLUTE_START needs 2 more bytes
      const wireBad = bytes(
        0x03, 0x00, 0x0e,
        0x04, 0x01, 0x01, 0x61, 0x01, 0x74, 0x01,
        0x23, 0x03, 0x01, 0x21, 0x02, 0x01, 0x00,
      );

      expect(() => Draft22MessageCodec.decode(wireBad)).toThrow();
    });

    it('rejects bytes left over after the counted parameters', () => {
      // FILL_PARAMETERS len=4: nparams=1 | FILL_TIMEOUT=100 | stray 0x00
      const wireBad = bytes(
        0x03, 0x00, 0x0d,
        0x04, 0x01, 0x01, 0x61, 0x01, 0x74, 0x01,
        0x23, 0x04, 0x01, 0x0a, 0x64, 0x00,
      );

      expect(() => Draft22MessageCodec.decode(wireBad)).toThrow(/FILL_PARAMETERS.*PROTOCOL_VIOLATION/);
    });
  });

  describe('parameter rules (§9.20)', () => {
    // SUBSCRIBE reqId=4 ns(1,"a") name(1,"t") followed by the raw parameter block
    const subscribeWith = (...params: number[]): Uint8Array =>
      bytes(0x03, 0x00, 0x06 + params.length, 0x04, 0x01, 0x01, 0x61, 0x01, 0x74, ...params);

    it('rejects an unknown parameter', () => {
      // nparams=1, type 0x30 is not defined
      const wire = subscribeWith(0x01, 0x30, 0x00);

      expect(() => Draft22MessageCodec.decode(wire)).toThrow(/unknown parameter 0x30.*PROTOCOL_VIOLATION/i);
    });

    it('rejects an unknown parameter in FETCH', () => {
      const wire = bytes(0x16, 0x00, 0x09, 0x04, 0x01, 0x01, 0x61, 0x01, 0x74, 0x01, 0x30, 0x00);

      expect(() => Draft22MessageCodec.decode(wire)).toThrow(/unknown parameter 0x30.*PROTOCOL_VIOLATION/i);
    });

    it('rejects a parameter the message does not allow', () => {
      // RENDEZVOUS_TIMEOUT (0x04) is SUBSCRIBE-only
      const wire = bytes(0x16, 0x00, 0x09, 0x04, 0x01, 0x01, 0x61, 0x01, 0x74, 0x01, 0x04, 0x05);

      expect(() => Draft22MessageCodec.decode(wire)).toThrow(/RENDEZVOUS_TIMEOUT.*FETCH.*PROTOCOL_VIOLATION/);
    });

    it('rejects a duplicate parameter', () => {
      // nparams=2: FORWARD=1, then delta 0 (FORWARD again)
      const wire = subscribeWith(0x02, 0x10, 0x01, 0x00, 0x01);

      expect(() => Draft22MessageCodec.decode(wire)).toThrow(/duplicate.*FORWARD.*PROTOCOL_VIOLATION/i);
    });

    it('rejects INCLUDE_PROPERTIES outside 0 or 1', () => {
      const wire = subscribeWith(0x01, 0x35, 0x02);

      expect(() => Draft22MessageCodec.decode(wire)).toThrow(/INCLUDE_PROPERTIES.*PROTOCOL_VIOLATION/);
    });

    it('rejects a malformed uint8 value on encode', () => {
      const message: SubscribeMessageDraft22 = {
        type: MessageTypeDraft22.SUBSCRIBE,
        requestId: 4n,
        trackNamespace: ['a'],
        trackName: 't',
        forwardState: true,
        parameters: new Map([[0x20, bytes(0x01, 0x02)]]), // SUBSCRIBER_PRIORITY
      };

      expect(() => Draft22MessageCodec.encode(message)).toThrow(/SUBSCRIBER_PRIORITY.*PROTOCOL_VIOLATION/);
    });

    it('frames a varint parameter without a length prefix', () => {
      const message: SubscribeMessageDraft22 = {
        type: MessageTypeDraft22.SUBSCRIBE,
        requestId: 4n,
        trackNamespace: ['a'],
        trackName: 't',
        forwardState: true,
        parameters: new Map([[0x32, bytes(0x07)]]), // NEW_GROUP_REQUEST
      };

      const encoded = Draft22MessageCodec.encode(message);

      // nparams=2 | FORWARD=1 | NEW_GROUP_REQUEST(+0x22)=7
      expect(Array.from(encoded.slice(-5))).toEqual([0x02, 0x10, 0x01, 0x22, 0x07]);
    });

    it('frames an AUTHORIZATION_TOKEN as length-prefixed in FETCH', () => {
      const fetch: FetchMessageDraft22 = {
        type: MessageTypeDraft22.FETCH,
        requestId: 4n,
        trackNamespace: ['a'],
        trackName: 't',
        subscriberPriority: 128,
        groupOrder: GroupOrder.ASCENDING,
        authTokens: [bytes(0x03, 0x00, 0xaa, 0xbb)],
      };

      const [decoded] = Draft22MessageCodec.decode(Draft22MessageCodec.encode(fetch));

      expect((decoded as FetchMessageDraft22).authTokens).toEqual([bytes(0x03, 0x00, 0xaa, 0xbb)]);
      expect((decoded as FetchMessageDraft22).parameters).toBeUndefined();
    });

    it('allows AUTHORIZATION_TOKEN to repeat (§8.9)', () => {
      const message: SubscribeMessageDraft22 = {
        type: MessageTypeDraft22.SUBSCRIBE,
        requestId: 4n,
        trackNamespace: ['a'],
        trackName: 't',
        forwardState: true,
        authTokens: [bytes(0x03, 0x00, 0xaa), bytes(0x03, 0x00, 0xbb, 0xcc)],
      };

      const encoded = Draft22MessageCodec.encode(message);

      // nparams=3 | AUTH(0x03) len 3 USE_VALUE type 0 aa | AUTH (delta 0) len 4 ... | FORWARD(+0x0d)=1
      expect(Array.from(encoded.slice(-14))).toEqual([
        0x03, 0x03, 0x03, 0x03, 0x00, 0xaa, 0x00, 0x04, 0x03, 0x00, 0xbb, 0xcc, 0x0d, 0x01,
      ]);
      const [decoded] = Draft22MessageCodec.decode(encoded);
      expect((decoded as SubscribeMessageDraft22).authTokens).toEqual(message.authTokens);
    });
  });

  describe('namespace requests (§9.14, §9.15)', () => {
    it('accepts AUTHORIZATION_TOKEN in SUBSCRIBE_NAMESPACE', () => {
      // reqId=2 | ns(1,"a") | nparams=1 | AUTHORIZATION_TOKEN(0x03) len=3 USE_VALUE type 0 aa
      const wire = bytes(0x50, 0x00, 0x0a, 0x02, 0x01, 0x01, 0x61, 0x01, 0x03, 0x03, 0x03, 0x00, 0xaa);

      const [decoded, bytesRead] = Draft22MessageCodec.decode(wire);

      expect(decoded).toEqual({
        type: MessageTypeDraft22.SUBSCRIBE_NAMESPACE,
        requestId: 2n,
        trackNamespacePrefix: ['a'],
      });
      expect(bytesRead).toBe(wire.length);
    });

    it('rejects FORWARD in SUBSCRIBE_NAMESPACE', () => {
      const wire = bytes(0x50, 0x00, 0x07, 0x02, 0x01, 0x01, 0x61, 0x01, 0x10, 0x01);

      expect(() => Draft22MessageCodec.decode(wire)).toThrow(/FORWARD.*SUBSCRIBE_NAMESPACE.*PROTOCOL_VIOLATION/);
    });

    it('rejects an unknown parameter in PUBLISH_NAMESPACE', () => {
      const wire = bytes(0x06, 0x00, 0x07, 0x02, 0x01, 0x01, 0x61, 0x01, 0x30, 0x00);

      expect(() => Draft22MessageCodec.decode(wire)).toThrow(/unknown parameter 0x30.*PROTOCOL_VIOLATION/i);
    });
  });

  describe('SUBSCRIBE_OK (§9.7)', () => {
    // type | len(7) | alias=7 | nparams=2 | EXPIRES(0x08)=5 | LARGEST_OBJECT(+1) 2,3
    const wire = bytes(0x04, 0x00, 0x07, 0x07, 0x02, 0x08, 0x05, 0x01, 0x02, 0x03);
    const message = {
      type: MessageTypeDraft18.SUBSCRIBE_OK,
      requestId: 7n,
      trackAlias: 7n,
      largestLocation: { group: 2n, object: 3n },
      expires: 5n,
    };

    it('encodes EXPIRES as a varint and LARGEST_OBJECT as a Location', () => {
      expect(Draft22MessageCodec.encode(message as unknown as ControlMessageDraft22)).toEqual(wire);
    });

    it('decodes EXPIRES and LARGEST_OBJECT', () => {
      const [decoded, bytesRead] = Draft22MessageCodec.decode(wire);

      expect(decoded).toMatchObject(message);
      expect(bytesRead).toBe(wire.length);
    });

    it('rejects FORWARD, which SUBSCRIBE_OK does not allow', () => {
      const wireBad = bytes(0x04, 0x00, 0x04, 0x07, 0x01, 0x10, 0x01);

      expect(() => Draft22MessageCodec.decode(wireBad)).toThrow(/FORWARD.*SUBSCRIBE_OK.*PROTOCOL_VIOLATION/);
    });
  });

  describe('REQUEST_OK (§9.3)', () => {
    // type | len(3) | nparams=1 | EXPIRES(0x08)=10
    const wire = bytes(0x07, 0x00, 0x03, 0x01, 0x08, 0x0a);

    it('encodes EXPIRES as a varint', () => {
      const message = { type: MessageTypeDraft18.REQUEST_OK, requestId: 0n, expires: 10n };

      expect(Draft22MessageCodec.encode(message as unknown as ControlMessageDraft22)).toEqual(wire);
    });

    it('decodes EXPIRES', () => {
      const [decoded] = Draft22MessageCodec.decode(wire);

      expect(decoded).toMatchObject({ type: MessageTypeDraft18.REQUEST_OK, expires: 10n });
    });

    it('rejects INCLUDE_PROPERTIES, which REQUEST_OK does not allow', () => {
      const wireBad = bytes(0x07, 0x00, 0x03, 0x01, 0x35, 0x01);

      expect(() => Draft22MessageCodec.decode(wireBad)).toThrow(/INCLUDE_PROPERTIES.*REQUEST_OK.*PROTOCOL_VIOLATION/);
    });
  });

  describe('FETCH_OK (§9.12)', () => {
    it('decodes with no parameters', () => {
      // type | len(4) | end of track=1 | end location 4,5 | nparams=0
      const wire = bytes(0x18, 0x00, 0x04, 0x01, 0x04, 0x05, 0x00);

      const [decoded] = Draft22MessageCodec.decode(wire);

      expect(decoded).toMatchObject({ endOfTrack: true, endLocation: { group: 4n, object: 5n } });
    });

    it('rejects an End Of Track other than 0 or 1', () => {
      const wire = bytes(0x18, 0x00, 0x04, 0x02, 0x04, 0x05, 0x00);

      expect(() => Draft22MessageCodec.decode(wire)).toThrow(/End Of Track 2.*PROTOCOL_VIOLATION/);
    });

    it('rejects any parameter, since none are defined', () => {
      const wireBad = bytes(0x18, 0x00, 0x06, 0x01, 0x04, 0x05, 0x01, 0x08, 0x01);

      expect(() => Draft22MessageCodec.decode(wireBad)).toThrow(/EXPIRES.*FETCH_OK.*PROTOCOL_VIOLATION/);
    });
  });

  describe('parameter count and location filter limits (§9.20, §9.20.9)', () => {
    const subscribe = (fields: Partial<SubscribeMessageDraft22>): SubscribeMessageDraft22 => ({
      type: MessageTypeDraft22.SUBSCRIBE,
      requestId: 4n,
      trackNamespace: ['a'],
      trackName: 't',
      forwardState: true,
      ...fields,
    });

    it('does not cap the number of parameters at 64', () => {
      const rangeFilters = Array.from({ length: 70 }, (_, setId): RangeFilterDraft22 => ({
        type: RequestParameterDraft22.SUBGROUP_FILTER,
        setId,
        ranges: [{ start: 0n, end: 10n }],
      }));

      const [decoded] = Draft22MessageCodec.decode(Draft22MessageCodec.encode(subscribe({ rangeFilters })));

      expect((decoded as SubscribeMessageDraft22).rangeFilters).toHaveLength(70);
    });

    it('rejects an end Group past 2^64-1', () => {
      const locationFilter = {
        type: LocationFilterTypeDraft22.ABSOLUTE_START_GROUP_END,
        startLocation: { group: (1n << 64n) - 1n, object: 0n },
        endGroupDelta: 1n,
      };

      const wire = Draft22MessageCodec.encode(subscribe({ locationFilter }));

      expect(() => Draft22MessageCodec.decode(wire)).toThrow(/end Group.*PROTOCOL_VIOLATION/);
    });

    it('accepts an end Group of exactly 2^64-1', () => {
      const locationFilter = {
        type: LocationFilterTypeDraft22.ABSOLUTE_RANGE,
        startLocation: { group: (1n << 64n) - 2n, object: 0n },
        endGroupDelta: 1n,
        endObject: 0n,
      };

      const [decoded] = Draft22MessageCodec.decode(Draft22MessageCodec.encode(subscribe({ locationFilter })));

      expect((decoded as SubscribeMessageDraft22).locationFilter).toEqual(locationFilter);
    });
  });

  describe('message type 0x1E (reserved)', () => {
    it('is rejected on decode', () => {
      // formerly PUBLISH_OK: nparams=0
      const wire = bytes(0x1e, 0x00, 0x01, 0x00);

      expect(() => Draft22MessageCodec.decode(wire)).toThrow(/0x1e.*PROTOCOL_VIOLATION/i);
    });
  });

  describe('error code registries', () => {
    it('keeps the draft-22 REQUEST_ERROR codes CONFLICTING_FILTERS and INVALID_FILTER', () => {
      for (const code of [0x35, 0x36]) {
        // code | retry interval=0 | reason length=0
        const wire = bytes(0x05, 0x00, 0x03, code, 0x00, 0x00);

        const [decoded] = Draft22MessageCodec.decode(wire);

        expect((decoded as unknown as { errorCode: number }).errorCode).toBe(code);
      }
    });

    it('maps the draft-18 only PUBLISH_DONE code SUBSCRIPTION_ENDED to INTERNAL_ERROR', () => {
      // status=3 | stream count=0 | reason length=0
      const wire = bytes(0x0b, 0x00, 0x03, 0x03, 0x00, 0x00);

      const [decoded] = Draft22MessageCodec.decode(wire);

      expect((decoded as unknown as { statusCode: bigint }).statusCode).toBe(0n);
    });
  });
});
