// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { describe, it, expect } from 'vitest';
import { Draft18MessageCodec, Draft18CodecError } from './draft18-message-codec';
import { MOQTVarInt } from './moqt-varint';
import {
  MessageTypeDraft18,
  Version,
  GroupOrder,
  FetchTypeDraft18,
  RequestParameterDraft18,
  TrackPropertyDraft18,
  SubscriptionFilterDraft18,
  type ClientSetupMessageDraft18,
  type ServerSetupMessageDraft18,
  type SubscribeMessageDraft18,
  type SubscribeOkMessageDraft18,
  type PublishMessageDraft18,
  type PublishDoneMessageDraft18,
  type RequestErrorMessageDraft18,
  type RequestOkMessageDraft18,
  type RequestUpdateMessageDraft18,
  type FetchMessageDraft18,
  type FetchOkMessageDraft18,
  type GoAwayMessageDraft18,
  type TrackStatusMessageDraft18,
  type PublishNamespaceMessageDraft18,
  type SubscribeNamespaceMessageDraft18,
  type NamespaceMessageDraft18,
  type NamespaceDoneMessageDraft18,
  type SubscribeTracksMessageDraft18,
  type PublishBlockedMessageDraft18,
} from '../messages/types';

describe('Draft18MessageCodec', () => {
  describe('SETUP', () => {
    it('roundtrips empty SETUP (WebTransport, no options)', () => {
      const message: ClientSetupMessageDraft18 = {
        type: MessageTypeDraft18.CLIENT_SETUP,
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded, bytesRead] = Draft18MessageCodec.decode(encoded);

      expect(decoded.type).toBe(MessageTypeDraft18.SERVER_SETUP);
      expect(bytesRead).toBe(encoded.length);
    });

    it('roundtrips SETUP with options', () => {
      const message: ClientSetupMessageDraft18 = {
        type: MessageTypeDraft18.CLIENT_SETUP,
        path: '/moq',
        authority: 'relay.example.com',
        maxAuthTokenCacheSize: 100,
        authToken: new Uint8Array([1, 2, 3, 4]),
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded, bytesRead] = Draft18MessageCodec.decode(encoded);

      const d = decoded as ServerSetupMessageDraft18;
      expect(d.type).toBe(MessageTypeDraft18.SERVER_SETUP);
      expect(d.path).toBe('/moq');
      expect(d.authority).toBe('relay.example.com');
      expect(d.maxAuthTokenCacheSize).toBe(100);
      expect(bytesRead).toBe(encoded.length);
    });
  });

  describe('SETUP decode', () => {
    it('decodes SETUP with path option', () => {
      const message: ClientSetupMessageDraft18 = {
        type: MessageTypeDraft18.CLIENT_SETUP,
        path: '/test',
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);

      const d = decoded as ServerSetupMessageDraft18;
      expect(d.type).toBe(MessageTypeDraft18.SERVER_SETUP);
      expect(d.selectedVersion).toBe(Version.DRAFT_18);
      expect(d.path).toBe('/test');
    });
  });

  // §3.2 SETUP extension advertisement — even keys carry varints; odd keys
  // carry length-prefixed bytes. Unknown keys must round-trip losslessly.
  describe('SETUP extensions (§3.2)', () => {
    it('roundtrips a varint extension on an even key', () => {
      const message: ClientSetupMessageDraft18 = {
        type: MessageTypeDraft18.CLIENT_SETUP,
        extensions: new Map([[0x40, { varint: 12345n }]]),
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);

      const d = decoded as ServerSetupMessageDraft18;
      expect(d.extensions).toBeDefined();
      const value = d.extensions!.get(0x40);
      expect(value).toEqual({ varint: 12345n });
    });

    it('roundtrips a bytes extension on an odd key', () => {
      const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
      const message: ClientSetupMessageDraft18 = {
        type: MessageTypeDraft18.CLIENT_SETUP,
        extensions: new Map([[0x41, { bytes: payload }]]),
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);

      const d = decoded as ServerSetupMessageDraft18;
      const value = d.extensions!.get(0x41);
      expect(value).toBeDefined();
      expect((value as { bytes: Uint8Array }).bytes).toEqual(payload);
    });

    it('roundtrips SETUP with known options AND extensions together', () => {
      const message: ClientSetupMessageDraft18 = {
        type: MessageTypeDraft18.CLIENT_SETUP,
        path: '/moq',
        moqtImplementation: 'moq-web-test',
        extensions: new Map<number, { varint: bigint } | { bytes: Uint8Array }>([
          [0x40, { varint: 42n }],
          [0x41, { bytes: new Uint8Array([1, 2, 3]) }],
        ]),
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);

      const d = decoded as ServerSetupMessageDraft18;
      expect(d.path).toBe('/moq');
      // moqtImplementation is skipped on the response side (it's a client hint),
      // but the extensions map must contain both custom keys.
      expect(d.extensions?.get(0x40)).toEqual({ varint: 42n });
      expect((d.extensions?.get(0x41) as { bytes: Uint8Array }).bytes).toEqual(
        new Uint8Array([1, 2, 3]),
      );
    });

    it('rejects extension keys that collide with reserved SetupOptions', () => {
      const message: ClientSetupMessageDraft18 = {
        type: MessageTypeDraft18.CLIENT_SETUP,
        // 0x01 is PATH — must not be usable as a custom extension.
        extensions: new Map([[0x01, { bytes: new Uint8Array([0]) }]]),
      };
      expect(() => Draft18MessageCodec.encode(message)).toThrow(/reserved/);
    });

    it('rejects parity mismatch (varint on odd key)', () => {
      const message: ClientSetupMessageDraft18 = {
        type: MessageTypeDraft18.CLIENT_SETUP,
        extensions: new Map([[0x41, { varint: 1n }]]),
      };
      expect(() => Draft18MessageCodec.encode(message)).toThrow(/parity/);
    });

    it('rejects parity mismatch (bytes on even key)', () => {
      const message: ClientSetupMessageDraft18 = {
        type: MessageTypeDraft18.CLIENT_SETUP,
        extensions: new Map([[0x40, { bytes: new Uint8Array([0]) }]]),
      };
      expect(() => Draft18MessageCodec.encode(message)).toThrow(/parity/);
    });

    it('decoder returns undefined extensions when peer sent none', () => {
      const message: ClientSetupMessageDraft18 = {
        type: MessageTypeDraft18.CLIENT_SETUP,
        path: '/only-known',
      };
      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);
      expect((decoded as ServerSetupMessageDraft18).extensions).toBeUndefined();
    });
  });

  describe('SUBSCRIBE', () => {
    it('roundtrips basic SUBSCRIBE', () => {
      const message: SubscribeMessageDraft18 = {
        type: MessageTypeDraft18.SUBSCRIBE,
        requestId: 1n,
        trackNamespace: ['conference', 'room-123'],
        trackName: 'video',
        forwardState: true,
        filter: SubscriptionFilterDraft18.NEXT_GROUP_START,
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);

      const d = decoded as SubscribeMessageDraft18;
      expect(d.type).toBe(MessageTypeDraft18.SUBSCRIBE);
      expect(d.requestId).toBe(1n);
      expect(d.trackNamespace).toEqual(['conference', 'room-123']);
      expect(d.trackName).toBe('video');
      expect(d.forwardState).toBe(true);
      expect(d.filter).toBe(SubscriptionFilterDraft18.NEXT_GROUP_START);
    });

    it('roundtrips SUBSCRIBE with ABSOLUTE_RANGE filter', () => {
      const message: SubscribeMessageDraft18 = {
        type: MessageTypeDraft18.SUBSCRIBE,
        requestId: 42n,
        trackNamespace: ['ns'],
        trackName: 'track',
        forwardState: false,
        filter: SubscriptionFilterDraft18.ABSOLUTE_RANGE,
        startLocation: { group: 10n, object: 5n },
        endGroupDelta: 100n,
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);

      const d = decoded as SubscribeMessageDraft18;
      expect(d.filter).toBe(SubscriptionFilterDraft18.ABSOLUTE_RANGE);
      expect(d.startLocation).toEqual({ group: 10n, object: 5n });
      expect(d.endGroupDelta).toBe(100n);
    });

    it('roundtrips SUBSCRIBE with §10.2 delivery-timeout parameters', () => {
      const params = new Map<number, Uint8Array>([
        [RequestParameterDraft18.SUBGROUP_DELIVERY_TIMEOUT, MOQTVarInt.encode(2000n)],
        [RequestParameterDraft18.OBJECT_DELIVERY_TIMEOUT, MOQTVarInt.encode(200n)],
        [RequestParameterDraft18.FILL_TIMEOUT, MOQTVarInt.encode(750n)],
        [RequestParameterDraft18.RENDEZVOUS_TIMEOUT, MOQTVarInt.encode(1500n)],
      ]);
      const message: SubscribeMessageDraft18 = {
        type: MessageTypeDraft18.SUBSCRIBE,
        requestId: 7n,
        trackNamespace: ['ns'],
        trackName: 'track',
        forwardState: true,
        filter: SubscriptionFilterDraft18.NEXT_GROUP_START,
        parameters: params,
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);
      const d = decoded as SubscribeMessageDraft18;
      const p = d.parameters!;
      expect(Number(MOQTVarInt.decode(p.get(RequestParameterDraft18.SUBGROUP_DELIVERY_TIMEOUT)!)[0])).toBe(2000);
      expect(Number(MOQTVarInt.decode(p.get(RequestParameterDraft18.OBJECT_DELIVERY_TIMEOUT)!)[0])).toBe(200);
      expect(Number(MOQTVarInt.decode(p.get(RequestParameterDraft18.FILL_TIMEOUT)!)[0])).toBe(750);
      expect(Number(MOQTVarInt.decode(p.get(RequestParameterDraft18.RENDEZVOUS_TIMEOUT)!)[0])).toBe(1500);
    });
  });

  describe('SUBSCRIBE_OK', () => {
    it('roundtrips SUBSCRIBE_OK', () => {
      const message: SubscribeOkMessageDraft18 = {
        type: MessageTypeDraft18.SUBSCRIBE_OK,
        requestId: 1n,
        trackAlias: 1n,
        largestLocation: { group: 100n, object: 50n },
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);

      const d = decoded as SubscribeOkMessageDraft18;
      expect(d.type).toBe(MessageTypeDraft18.SUBSCRIBE_OK);
      expect(d.trackAlias).toBe(1n);
      expect(d.largestLocation).toEqual({ group: 100n, object: 50n });
    });
  });

  describe('PUBLISH', () => {
    it('roundtrips PUBLISH', () => {
      const message: PublishMessageDraft18 = {
        type: MessageTypeDraft18.PUBLISH,
        requestId: 5n,
        trackAlias: 12345n,
        trackNamespace: ['pub', 'ns'],
        trackName: 'audio',
        forwardState: true,
        largestLocation: { group: 0n, object: 0n },
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);

      const d = decoded as PublishMessageDraft18;
      expect(d.type).toBe(MessageTypeDraft18.PUBLISH);
      expect(d.requestId).toBe(5n);
      expect(d.trackAlias).toBe(12345n);
      expect(d.trackNamespace).toEqual(['pub', 'ns']);
      expect(d.trackName).toBe('audio');
      expect(d.forwardState).toBe(true);
    });

    it('roundtrips PUBLISH with §12 track properties', () => {
      const props = new Map<number, Uint8Array>([
        [TrackPropertyDraft18.SUBGROUP_DELIVERY_TIMEOUT, MOQTVarInt.encode(2000n)],
        [TrackPropertyDraft18.MAX_CACHE_DURATION, MOQTVarInt.encode(60000n)],
        [TrackPropertyDraft18.DEFAULT_PUBLISHER_PRIORITY, MOQTVarInt.encode(96n)],
      ]);
      const message: PublishMessageDraft18 = {
        type: MessageTypeDraft18.PUBLISH,
        requestId: 6n,
        trackAlias: 99n,
        trackNamespace: ['pub'],
        trackName: 'v',
        forwardState: true,
        largestLocation: { group: 0n, object: 0n },
        trackProperties: props,
      };
      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);
      const d = decoded as PublishMessageDraft18;
      const p = d.trackProperties!;
      expect(Number(MOQTVarInt.decode(p.get(TrackPropertyDraft18.SUBGROUP_DELIVERY_TIMEOUT)!)[0])).toBe(2000);
      expect(Number(MOQTVarInt.decode(p.get(TrackPropertyDraft18.MAX_CACHE_DURATION)!)[0])).toBe(60000);
      expect(Number(MOQTVarInt.decode(p.get(TrackPropertyDraft18.DEFAULT_PUBLISHER_PRIORITY)!)[0])).toBe(96);
    });
  });

  describe('REQUEST_ERROR', () => {
    it('roundtrips REQUEST_ERROR (non-redirect)', () => {
      const message: RequestErrorMessageDraft18 = {
        type: MessageTypeDraft18.REQUEST_ERROR,
        requestId: 0n,
        errorCode: 3,
        retryInterval: 1000n,
        reasonPhrase: 'Track not found',
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);

      const d = decoded as RequestErrorMessageDraft18;
      expect(d.type).toBe(MessageTypeDraft18.REQUEST_ERROR);
      expect(d.errorCode).toBe(3);
      expect(d.retryInterval).toBe(1000n);
      expect(d.reasonPhrase).toBe('Track not found');
      expect(d.redirect).toBeUndefined();
    });

    it('roundtrips REQUEST_ERROR with REDIRECT structure (spec §10.6.1)', () => {
      const message: RequestErrorMessageDraft18 = {
        type: MessageTypeDraft18.REQUEST_ERROR,
        requestId: 0n,
        errorCode: 0x34, // REDIRECT
        retryInterval: 0n,
        reasonPhrase: 'Try elsewhere',
        redirect: {
          connectUri: 'moqt://other.example.com/moq',
          trackNamespace: ['pub', 'ns'],
          trackName: 'audio',
        },
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);

      const d = decoded as RequestErrorMessageDraft18;
      expect(d.errorCode).toBe(0x34);
      expect(d.redirect).toEqual({
        connectUri: 'moqt://other.example.com/moq',
        trackNamespace: ['pub', 'ns'],
        trackName: 'audio',
      });
    });

    it('encodes REDIRECT with empty connect URI and track name (same-URI redirect)', () => {
      const message: RequestErrorMessageDraft18 = {
        type: MessageTypeDraft18.REQUEST_ERROR,
        requestId: 0n,
        errorCode: 0x34,
        retryInterval: 0n,
        reasonPhrase: '',
        redirect: {
          connectUri: '',
          trackNamespace: [],
          trackName: '',
        },
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);

      const d = decoded as RequestErrorMessageDraft18;
      expect(d.redirect).toEqual({
        connectUri: '',
        trackNamespace: [],
        trackName: '',
      });
    });

    it('throws when REDIRECT error code has no redirect payload', () => {
      const message: RequestErrorMessageDraft18 = {
        type: MessageTypeDraft18.REQUEST_ERROR,
        requestId: 0n,
        errorCode: 0x34,
        retryInterval: 0n,
        reasonPhrase: 'oops',
      };

      expect(() => Draft18MessageCodec.encode(message)).toThrow(/REDIRECT/);
    });
  });

  describe('REQUEST_OK', () => {
    it('roundtrips REQUEST_OK without expires', () => {
      const message: RequestOkMessageDraft18 = {
        type: MessageTypeDraft18.REQUEST_OK,
        requestId: 0n,
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);

      const d = decoded as RequestOkMessageDraft18;
      expect(d.type).toBe(MessageTypeDraft18.REQUEST_OK);
    });

    it('roundtrips REQUEST_OK with expires', () => {
      const message: RequestOkMessageDraft18 = {
        type: MessageTypeDraft18.REQUEST_OK,
        requestId: 0n,
        expires: 3600n,
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);

      const d = decoded as RequestOkMessageDraft18;
      expect(d.expires).toBe(3600n);
    });

    it('roundtrips REQUEST_OK with largestLocation (§10.2.9 LARGEST_OBJECT)', () => {
      const message: RequestOkMessageDraft18 = {
        type: MessageTypeDraft18.REQUEST_OK,
        requestId: 0n,
        largestLocation: { group: 42n, object: 7n },
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);

      const d = decoded as RequestOkMessageDraft18;
      expect(d.type).toBe(MessageTypeDraft18.REQUEST_OK);
      expect(d.largestLocation).toEqual({ group: 42n, object: 7n });
    });

    it('roundtrips REQUEST_OK with both expires and largestLocation', () => {
      const message: RequestOkMessageDraft18 = {
        type: MessageTypeDraft18.REQUEST_OK,
        requestId: 0n,
        expires: 300n,
        largestLocation: { group: 100n, object: 3n },
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);

      const d = decoded as RequestOkMessageDraft18;
      expect(d.expires).toBe(300n);
      expect(d.largestLocation).toEqual({ group: 100n, object: 3n });
    });

    it('leaves largestLocation undefined when omitted on the wire', () => {
      const message: RequestOkMessageDraft18 = {
        type: MessageTypeDraft18.REQUEST_OK,
        requestId: 0n,
        expires: 60n,
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);

      const d = decoded as RequestOkMessageDraft18;
      expect(d.largestLocation).toBeUndefined();
    });
  });

  describe('FETCH', () => {
    it('roundtrips STANDALONE fetch (type 0x1) with track name', () => {
      const message: FetchMessageDraft18 = {
        type: MessageTypeDraft18.FETCH,
        requestId: 20n,
        fetchType: FetchTypeDraft18.STANDALONE,
        joiningFlag: false,
        trackNamespace: ['fetch', 'ns'],
        trackName: 'history',
        subscriberPriority: 128,
        groupOrder: GroupOrder.ASCENDING,
        startLocation: { group: 0n, object: 0n },
        endLocation: { group: 100n, object: 50n },
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);

      const d = decoded as FetchMessageDraft18;
      expect(d.type).toBe(MessageTypeDraft18.FETCH);
      expect(d.fetchType).toBe(FetchTypeDraft18.STANDALONE);
      expect(d.joiningFlag).toBe(false);
      expect(d.trackNamespace).toEqual(['fetch', 'ns']);
      expect(d.trackName).toBe('history');
      expect(d.startLocation).toEqual({ group: 0n, object: 0n });
      expect(d.endLocation).toEqual({ group: 100n, object: 50n });
    });

    it('roundtrips JOINING_RELATIVE fetch (type 0x2)', () => {
      const message: FetchMessageDraft18 = {
        type: MessageTypeDraft18.FETCH,
        requestId: 21n,
        fetchType: FetchTypeDraft18.JOINING_RELATIVE,
        joiningFlag: true,
        subscribeRequestId: 5n,
        joiningStart: 3n,
        subscriberPriority: 64,
        groupOrder: GroupOrder.DESCENDING,
        startLocation: { group: 0n, object: 0n },
        endLocation: { group: 0n, object: 0n },
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);

      const d = decoded as FetchMessageDraft18;
      expect(d.fetchType).toBe(FetchTypeDraft18.JOINING_RELATIVE);
      expect(d.joiningFlag).toBe(true);
      expect(d.subscribeRequestId).toBe(5n);
      expect(d.joiningStart).toBe(3n);
      expect(d.trackNamespace).toBeUndefined();
      expect(d.trackName).toBeUndefined();
    });

    it('roundtrips JOINING_ABSOLUTE fetch (type 0x3)', () => {
      const message: FetchMessageDraft18 = {
        type: MessageTypeDraft18.FETCH,
        requestId: 22n,
        fetchType: FetchTypeDraft18.JOINING_ABSOLUTE,
        joiningFlag: true,
        subscribeRequestId: 7n,
        joiningStart: 42n,
        subscriberPriority: 128,
        groupOrder: GroupOrder.ASCENDING,
        startLocation: { group: 0n, object: 0n },
        endLocation: { group: 0n, object: 0n },
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);

      const d = decoded as FetchMessageDraft18;
      expect(d.fetchType).toBe(FetchTypeDraft18.JOINING_ABSOLUTE);
      expect(d.joiningFlag).toBe(true);
      expect(d.subscribeRequestId).toBe(7n);
      expect(d.joiningStart).toBe(42n);
      expect(d.trackNamespace).toBeUndefined();
      expect(d.trackName).toBeUndefined();
    });

    it('writes distinct wire bytes for JOINING_RELATIVE (0x2) vs JOINING_ABSOLUTE (0x3)', () => {
      const base: Omit<FetchMessageDraft18, 'fetchType'> = {
        type: MessageTypeDraft18.FETCH,
        requestId: 30n,
        joiningFlag: true,
        subscribeRequestId: 1n,
        joiningStart: 0n,
        subscriberPriority: 128,
        groupOrder: GroupOrder.ASCENDING,
        startLocation: { group: 0n, object: 0n },
        endLocation: { group: 0n, object: 0n },
      };
      const rel = Draft18MessageCodec.encode({ ...base, fetchType: FetchTypeDraft18.JOINING_RELATIVE });
      const abs = Draft18MessageCodec.encode({ ...base, fetchType: FetchTypeDraft18.JOINING_ABSOLUTE });

      // Same length, differ only in the FetchType byte.
      expect(rel.length).toBe(abs.length);
      const diffs: number[] = [];
      for (let i = 0; i < rel.length; i++) {
        if (rel[i] !== abs[i]) diffs.push(i);
      }
      expect(diffs.length).toBe(1);
      expect(rel[diffs[0]!]).toBe(0x02);
      expect(abs[diffs[0]!]).toBe(0x03);
    });

    it('rejects invalid fetch type (protocol violation)', () => {
      // Encode two variants of the same JOINING FETCH — one relative, one absolute —
      // and diff them to locate the fetchType byte. Then patch a fresh copy with an
      // invalid fetchType (0x7) and expect decode to throw.
      const base: Omit<FetchMessageDraft18, 'fetchType'> = {
        type: MessageTypeDraft18.FETCH,
        requestId: 100n,
        joiningFlag: true,
        subscribeRequestId: 1n,
        joiningStart: 0n,
        subscriberPriority: 128,
        groupOrder: GroupOrder.ASCENDING,
        startLocation: { group: 0n, object: 0n },
        endLocation: { group: 0n, object: 0n },
      };
      const rel = Draft18MessageCodec.encode({ ...base, fetchType: FetchTypeDraft18.JOINING_RELATIVE });
      const abs = Draft18MessageCodec.encode({ ...base, fetchType: FetchTypeDraft18.JOINING_ABSOLUTE });
      let fetchTypeIdx = -1;
      for (let i = 0; i < rel.length; i++) {
        if (rel[i] !== abs[i]) { fetchTypeIdx = i; break; }
      }
      expect(fetchTypeIdx).toBeGreaterThanOrEqual(0);
      expect(rel[fetchTypeIdx]).toBe(0x02);

      const bad = new Uint8Array(rel);
      bad[fetchTypeIdx] = 0x07;
      expect(() => Draft18MessageCodec.decode(bad)).toThrow(Draft18CodecError);
    });

    it('roundtrips FETCH with subscriber delivery-timeout parameters', () => {
      const params = new Map<number, Uint8Array>([
        [RequestParameterDraft18.SUBGROUP_DELIVERY_TIMEOUT, MOQTVarInt.encode(500n)],
        [RequestParameterDraft18.OBJECT_DELIVERY_TIMEOUT, MOQTVarInt.encode(50n)],
        [RequestParameterDraft18.FILL_TIMEOUT, MOQTVarInt.encode(250n)],
        [RequestParameterDraft18.RENDEZVOUS_TIMEOUT, MOQTVarInt.encode(1000n)],
      ]);
      const message: FetchMessageDraft18 = {
        type: MessageTypeDraft18.FETCH,
        requestId: 60n,
        fetchType: FetchTypeDraft18.STANDALONE,
        joiningFlag: false,
        trackNamespace: ['ns'],
        trackName: 't',
        subscriberPriority: 128,
        groupOrder: GroupOrder.ASCENDING,
        startLocation: { group: 0n, object: 0n },
        endLocation: { group: 10n, object: 5n },
        parameters: params,
      };
      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);
      const d = decoded as FetchMessageDraft18;
      const decodedParams = d.parameters!;
      expect(Number(MOQTVarInt.decode(decodedParams.get(RequestParameterDraft18.SUBGROUP_DELIVERY_TIMEOUT)!)[0])).toBe(500);
      expect(Number(MOQTVarInt.decode(decodedParams.get(RequestParameterDraft18.OBJECT_DELIVERY_TIMEOUT)!)[0])).toBe(50);
      expect(Number(MOQTVarInt.decode(decodedParams.get(RequestParameterDraft18.FILL_TIMEOUT)!)[0])).toBe(250);
      expect(Number(MOQTVarInt.decode(decodedParams.get(RequestParameterDraft18.RENDEZVOUS_TIMEOUT)!)[0])).toBe(1000);
    });

    it('encodeFetch throws when joining without subscribeRequestId', () => {
      const msg: FetchMessageDraft18 = {
        type: MessageTypeDraft18.FETCH,
        requestId: 50n,
        fetchType: FetchTypeDraft18.JOINING_RELATIVE,
        joiningFlag: true,
        subscriberPriority: 128,
        groupOrder: GroupOrder.ASCENDING,
        startLocation: { group: 0n, object: 0n },
        endLocation: { group: 0n, object: 0n },
      };
      expect(() => Draft18MessageCodec.encode(msg)).toThrow(/subscribeRequestId/);
    });
  });

  describe('FETCH_OK', () => {
    it('roundtrips FETCH_OK', () => {
      const message: FetchOkMessageDraft18 = {
        type: MessageTypeDraft18.FETCH_OK,
        requestId: 20n,
        endOfTrack: true,
        endLocation: { group: 100n, object: 50n },
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);

      const d = decoded as FetchOkMessageDraft18;
      expect(d.type).toBe(MessageTypeDraft18.FETCH_OK);
      expect(d.endOfTrack).toBe(true);
      expect(d.endLocation).toEqual({ group: 100n, object: 50n });
    });
  });

  describe('GOAWAY', () => {
    it('roundtrips GOAWAY without URI (control stream)', () => {
      const message: GoAwayMessageDraft18 = {
        type: MessageTypeDraft18.GOAWAY,
        timeout: 5000n,
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);

      expect(decoded.type).toBe(MessageTypeDraft18.GOAWAY);
      const d = decoded as GoAwayMessageDraft18;
      expect(d.newSessionUri).toBeUndefined();
      expect(d.timeout).toBe(5000n);
      expect(d.requestId).toBeUndefined();
    });

    it('roundtrips GOAWAY with URI (control stream)', () => {
      const message: GoAwayMessageDraft18 = {
        type: MessageTypeDraft18.GOAWAY,
        newSessionUri: 'moqt://new-relay.example.com/moq',
        timeout: 10000n,
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);

      const d = decoded as GoAwayMessageDraft18;
      expect(d.newSessionUri).toBe('moqt://new-relay.example.com/moq');
      expect(d.timeout).toBe(10000n);
      expect(d.requestId).toBeUndefined();
    });

    it('roundtrips GOAWAY with Request ID (request stream)', () => {
      const message: GoAwayMessageDraft18 = {
        type: MessageTypeDraft18.GOAWAY,
        timeout: 2000n,
        requestId: 42n,
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);

      const d = decoded as GoAwayMessageDraft18;
      expect(d.newSessionUri).toBeUndefined();
      expect(d.timeout).toBe(2000n);
      expect(d.requestId).toBe(42n);
    });
  });

  describe('TRACK_STATUS', () => {
    it('roundtrips TRACK_STATUS', () => {
      const message: TrackStatusMessageDraft18 = {
        type: MessageTypeDraft18.TRACK_STATUS,
        requestId: 30n,
        trackNamespace: ['status', 'ns'],
        trackName: 'check',
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);

      const d = decoded as TrackStatusMessageDraft18;
      expect(d.type).toBe(MessageTypeDraft18.TRACK_STATUS);
      expect(d.requestId).toBe(30n);
      expect(d.trackNamespace).toEqual(['status', 'ns']);
      expect(d.trackName).toBe('check');
    });
  });

  describe('large values', () => {
    it('handles large request IDs', () => {
      const message: SubscribeMessageDraft18 = {
        type: MessageTypeDraft18.SUBSCRIBE,
        requestId: 0xFFFFFFFFFFFFFFFFn, // Max uint64
        trackNamespace: ['ns'],
        trackName: 'track',
        forwardState: true,
        filter: SubscriptionFilterDraft18.NEXT_GROUP_START,
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);

      expect((decoded as SubscribeMessageDraft18).requestId).toBe(0xFFFFFFFFFFFFFFFFn);
    });

    it('handles large track aliases', () => {
      const message: PublishMessageDraft18 = {
        type: MessageTypeDraft18.PUBLISH,
        requestId: 1n,
        trackAlias: 0x123456789ABCDEFn,
        trackNamespace: ['ns'],
        trackName: 'track',
        forwardState: true,
        largestLocation: { group: 0n, object: 0n },
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);

      expect((decoded as PublishMessageDraft18).trackAlias).toBe(0x123456789ABCDEFn);
    });
  });

  describe('unicode', () => {
    it('handles unicode track names', () => {
      const message: SubscribeMessageDraft18 = {
        type: MessageTypeDraft18.SUBSCRIBE,
        requestId: 1n,
        trackNamespace: ['会议', '房间-123'],
        trackName: '视频轨道',
        forwardState: true,
        filter: SubscriptionFilterDraft18.NEXT_GROUP_START,
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);

      const d = decoded as SubscribeMessageDraft18;
      expect(d.trackNamespace).toEqual(['会议', '房间-123']);
      expect(d.trackName).toBe('视频轨道');
    });
  });

  describe('PUBLISH_DONE', () => {
    it('roundtrips basic PUBLISH_DONE', () => {
      const message: PublishDoneMessageDraft18 = {
        type: MessageTypeDraft18.PUBLISH_DONE,
        requestId: 0n,
        finalLocation: { group: 0n, object: 0n },
        statusCode: 0n,
        streamCount: 5n,
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);

      const d = decoded as PublishDoneMessageDraft18;
      expect(d.type).toBe(MessageTypeDraft18.PUBLISH_DONE);
      expect(d.statusCode).toBe(0n);
      expect(d.streamCount).toBe(5n);
      expect(d.reasonPhrase).toBeUndefined();
    });

    it('roundtrips PUBLISH_DONE with reason', () => {
      const message: PublishDoneMessageDraft18 = {
        type: MessageTypeDraft18.PUBLISH_DONE,
        requestId: 0n,
        finalLocation: { group: 0n, object: 0n },
        statusCode: 1n,
        streamCount: 10n,
        reasonPhrase: 'End of stream',
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);

      const d = decoded as PublishDoneMessageDraft18;
      expect(d.reasonPhrase).toBe('End of stream');
      expect(d.statusCode).toBe(1n);
      expect(d.streamCount).toBe(10n);
    });
  });

  describe('REQUEST_UPDATE', () => {
    it('roundtrips basic REQUEST_UPDATE', () => {
      const message: RequestUpdateMessageDraft18 = {
        type: MessageTypeDraft18.REQUEST_UPDATE,
        requestId: 4n,
        forwardState: true,
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);

      const d = decoded as RequestUpdateMessageDraft18;
      expect(d.type).toBe(MessageTypeDraft18.REQUEST_UPDATE);
      expect(d.requestId).toBe(4n);
      expect(d.forwardState).toBe(true);
    });

    it('roundtrips REQUEST_UPDATE with a different request ID', () => {
      const message: RequestUpdateMessageDraft18 = {
        type: MessageTypeDraft18.REQUEST_UPDATE,
        requestId: 3n,
        forwardState: true,
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);

      const d = decoded as RequestUpdateMessageDraft18;
      expect(d.requestId).toBe(3n);
      expect(d.forwardState).toBe(true);
    });

    it('roundtrips REQUEST_UPDATE with forwardState=false (pause)', () => {
      const message: RequestUpdateMessageDraft18 = {
        type: MessageTypeDraft18.REQUEST_UPDATE,
        requestId: 1n,
        forwardState: false,
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);

      const d = decoded as RequestUpdateMessageDraft18;
      expect(d.type).toBe(MessageTypeDraft18.REQUEST_UPDATE);
      expect(d.requestId).toBe(1n);
      expect(d.forwardState).toBe(false);
    });
  });

  describe('PUBLISH_NAMESPACE', () => {
    it('roundtrips basic PUBLISH_NAMESPACE', () => {
      const message: PublishNamespaceMessageDraft18 = {
        type: MessageTypeDraft18.PUBLISH_NAMESPACE,
        requestId: 1n,
        trackNamespacePrefix: ['conference', 'room-123'],
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);

      const d = decoded as PublishNamespaceMessageDraft18;
      expect(d.type).toBe(MessageTypeDraft18.PUBLISH_NAMESPACE);
      expect(d.requestId).toBe(1n);
      expect(d.trackNamespacePrefix).toEqual(['conference', 'room-123']);
    });

    it('roundtrips PUBLISH_NAMESPACE with empty parameters', () => {
      const message: PublishNamespaceMessageDraft18 = {
        type: MessageTypeDraft18.PUBLISH_NAMESPACE,
        requestId: 2n,
        trackNamespacePrefix: ['ns'],
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);

      const d = decoded as PublishNamespaceMessageDraft18;
      expect(d.requestId).toBe(2n);
      expect(d.trackNamespacePrefix).toEqual(['ns']);
    });
  });

  describe('SUBSCRIBE_NAMESPACE', () => {
    it('roundtrips basic SUBSCRIBE_NAMESPACE', () => {
      const message: SubscribeNamespaceMessageDraft18 = {
        type: MessageTypeDraft18.SUBSCRIBE_NAMESPACE,
        requestId: 3n,
        trackNamespacePrefix: ['media'],
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);

      const d = decoded as SubscribeNamespaceMessageDraft18;
      expect(d.type).toBe(MessageTypeDraft18.SUBSCRIBE_NAMESPACE);
      expect(d.requestId).toBe(3n);
      expect(d.trackNamespacePrefix).toEqual(['media']);
    });
  });

  describe('NAMESPACE', () => {
    it('roundtrips basic NAMESPACE', () => {
      const message: NamespaceMessageDraft18 = {
        type: MessageTypeDraft18.NAMESPACE,
        trackNamespace: ['conference', 'room-456', 'video'],
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);

      const d = decoded as NamespaceMessageDraft18;
      expect(d.type).toBe(MessageTypeDraft18.NAMESPACE);
      expect(d.trackNamespace).toEqual(['conference', 'room-456', 'video']);
    });

    it('roundtrips NAMESPACE with parameters', () => {
      const params = new Map<number, Uint8Array>();
      params.set(0x00, new Uint8Array([5]));

      const message: NamespaceMessageDraft18 = {
        type: MessageTypeDraft18.NAMESPACE,
        trackNamespace: ['ns'],
        trackNamespaceParameters: params,
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);

      const d = decoded as NamespaceMessageDraft18;
      expect(d.trackNamespaceParameters).toBeDefined();
    });
  });

  describe('NAMESPACE_DONE', () => {
    it('roundtrips NAMESPACE_DONE', () => {
      const message: NamespaceDoneMessageDraft18 = {
        type: MessageTypeDraft18.NAMESPACE_DONE,
        finalNamespace: ['conference', 'room-789'],
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);

      const d = decoded as NamespaceDoneMessageDraft18;
      expect(d.type).toBe(MessageTypeDraft18.NAMESPACE_DONE);
      expect(d.finalNamespace).toEqual(['conference', 'room-789']);
    });
  });

  describe('SUBSCRIBE_TRACKS', () => {
    it('roundtrips basic SUBSCRIBE_TRACKS', () => {
      const message: SubscribeTracksMessageDraft18 = {
        type: MessageTypeDraft18.SUBSCRIBE_TRACKS,
        requestId: 5n,
        trackNamespacePrefix: ['media', 'video'],
        forwardState: true,
        filter: SubscriptionFilterDraft18.NEXT_GROUP_START,
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);

      const d = decoded as SubscribeTracksMessageDraft18;
      expect(d.type).toBe(MessageTypeDraft18.SUBSCRIBE_TRACKS);
      expect(d.requestId).toBe(5n);
      expect(d.trackNamespacePrefix).toEqual(['media', 'video']);
      expect(d.forwardState).toBe(true);
      expect(d.filter).toBe(SubscriptionFilterDraft18.NEXT_GROUP_START);
    });

    it('roundtrips SUBSCRIBE_TRACKS with different prefix', () => {
      const message: SubscribeTracksMessageDraft18 = {
        type: MessageTypeDraft18.SUBSCRIBE_TRACKS,
        requestId: 6n,
        trackNamespacePrefix: ['conference', 'room-1'],
        forwardState: true,
        filter: SubscriptionFilterDraft18.NEXT_GROUP_START,
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);

      const d = decoded as SubscribeTracksMessageDraft18;
      expect(d.requestId).toBe(6n);
      expect(d.trackNamespacePrefix).toEqual(['conference', 'room-1']);
    });
  });

  describe('PUBLISH_BLOCKED', () => {
    it('roundtrips PUBLISH_BLOCKED', () => {
      const message: PublishBlockedMessageDraft18 = {
        type: MessageTypeDraft18.PUBLISH_BLOCKED,
        trackAlias: 999n,
      };

      const encoded = Draft18MessageCodec.encode(message);
      const [decoded] = Draft18MessageCodec.decode(encoded);

      const d = decoded as PublishBlockedMessageDraft18;
      expect(d.type).toBe(MessageTypeDraft18.PUBLISH_BLOCKED);
      expect(d.trackAlias).toBe(999n);
    });
  });

  // ==========================================================================
  // Byte-level golden regression tests.
  //
  // These fix the exact on-wire output for canonical messages so any accidental
  // change to type IDs, field ordering, framing, or varint layout will fail.
  // Byte layouts are derived directly from draft-18 §10 message format tables
  // and §1.4.1 (MOQT varints).
  // ==========================================================================
  describe('golden bytes (§10 wire format)', () => {
    it('GOAWAY control-stream with empty URI and zero timeout (§10.4)', () => {
      // Framing: Type=0x10 (vi) | Length=2 (16-bit BE) | UriLen=0 (vi) | Timeout=0 (vi)
      const expected = new Uint8Array([0x10, 0x00, 0x02, 0x00, 0x00]);
      const encoded = Draft18MessageCodec.encode({
        type: MessageTypeDraft18.GOAWAY,
        timeout: 0n,
      });
      expect(Array.from(encoded)).toEqual(Array.from(expected));
    });

    it('GOAWAY control-stream with URI "/v2" and timeout=5000 (§10.4)', () => {
      // Type=0x10 | Length=6 | UriLen=3 | "/v2" | Timeout=5000 (14-bit vi = 0x93 0x88)
      const expected = new Uint8Array([
        0x10, 0x00, 0x06,
        0x03, 0x2f, 0x76, 0x32,
        0x93, 0x88,
      ]);
      const encoded = Draft18MessageCodec.encode({
        type: MessageTypeDraft18.GOAWAY,
        newSessionUri: '/v2',
        timeout: 5000n,
      });
      expect(Array.from(encoded)).toEqual(Array.from(expected));
    });

    it('GOAWAY request-stream includes trailing Request ID (§10.4)', () => {
      // Type=0x10 | Length=3 | UriLen=0 | Timeout=0 | RequestID=42
      const expected = new Uint8Array([0x10, 0x00, 0x03, 0x00, 0x00, 0x2a]);
      const encoded = Draft18MessageCodec.encode({
        type: MessageTypeDraft18.GOAWAY,
        timeout: 0n,
        requestId: 42n,
      });
      expect(Array.from(encoded)).toEqual(Array.from(expected));
    });

    it('REQUEST_OK with no parameters (§10.9)', () => {
      // Type=0x07 | Length=1 | NumParams=0
      const expected = new Uint8Array([0x07, 0x00, 0x01, 0x00]);
      const encoded = Draft18MessageCodec.encode({
        type: MessageTypeDraft18.REQUEST_OK,
        requestId: 0n,
      });
      expect(Array.from(encoded)).toEqual(Array.from(expected));
    });

    it('PUBLISH_BLOCKED with small track alias (§10.19)', () => {
      // Type=0x0F | Length=1 | TrackAlias=5 (vi)
      const expected = new Uint8Array([0x0f, 0x00, 0x01, 0x05]);
      const encoded = Draft18MessageCodec.encode({
        type: MessageTypeDraft18.PUBLISH_BLOCKED,
        trackAlias: 5n,
      });
      expect(Array.from(encoded)).toEqual(Array.from(expected));
    });

    it('MOQT varint uses leading-1s (14-bit form) — 5000 = 0x93 0x88', () => {
      // Regression guard against reintroducing QUIC varints for MOQT framing.
      // 5000 in QUIC varint would be 0x53 0x88; MOQT uses 0x93 0x88.
      const encoded = Draft18MessageCodec.encode({
        type: MessageTypeDraft18.GOAWAY,
        timeout: 5000n,
      });
      // After type(0x10), length(0x00 0x02), UriLen(0x00), the timeout starts at index 4.
      expect(encoded[4]).toBe(0x93);
      expect(encoded[5]).toBe(0x88);
    });
  });
});
