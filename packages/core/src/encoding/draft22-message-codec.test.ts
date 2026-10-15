// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { describe, it, expect } from 'vitest';
import { Draft22MessageCodec } from './draft22-message-codec';
import { MOQTVarInt } from './moqt-varint';
import {
  MessageTypeDraft18,
  MessageTypeDraft22,
  Version,
  GroupOrder,
  LocationFilterTypeDraft22,
  type ClientSetupMessageDraft18,
  type ServerSetupMessageDraft18,
  type SubscribeMessageDraft22,
  type PublishSkippedMessageDraft22,
  type PublishStateNotifyMessageDraft22,
  type FetchMessageDraft22,
} from '../messages/types';
import { ALPN_PROTOCOL } from '../version/constants';

describe('Draft22MessageCodec', () => {
  describe('Version constants', () => {
    it('has correct DRAFT_22 version number', () => {
      expect(Version.DRAFT_22).toBe(0xff000016);
    });

    it('has correct DRAFT_22 ALPN protocol string', () => {
      expect(ALPN_PROTOCOL.DRAFT_22).toBe('moqt-22');
    });
  });

  describe('PUBLISH_SKIPPED', () => {
    it('roundtrips PUBLISH_SKIPPED with namespace suffix and track name', () => {
      const message: PublishSkippedMessageDraft22 = {
        type: MessageTypeDraft22.PUBLISH_SKIPPED,
        trackNamespaceSuffix: ['live', 'stream', 'video'],
        trackName: 'track-001',
      };

      const encoded = Draft22MessageCodec.encode(message);
      const [decoded, bytesRead] = Draft22MessageCodec.decode(encoded);

      expect(decoded.type).toBe(MessageTypeDraft22.PUBLISH_SKIPPED);
      const d = decoded as PublishSkippedMessageDraft22;
      expect(d.trackNamespaceSuffix).toEqual(['live', 'stream', 'video']);
      expect(d.trackName).toBe('track-001');
      expect(bytesRead).toBe(encoded.length);
    });

    it('roundtrips PUBLISH_SKIPPED with empty namespace suffix', () => {
      const message: PublishSkippedMessageDraft22 = {
        type: MessageTypeDraft22.PUBLISH_SKIPPED,
        trackNamespaceSuffix: [],
        trackName: 'some-track',
      };

      const encoded = Draft22MessageCodec.encode(message);
      const [decoded, bytesRead] = Draft22MessageCodec.decode(encoded);

      expect(decoded.type).toBe(MessageTypeDraft22.PUBLISH_SKIPPED);
      const d = decoded as PublishSkippedMessageDraft22;
      expect(d.trackNamespaceSuffix).toEqual([]);
      expect(d.trackName).toBe('some-track');
      expect(bytesRead).toBe(encoded.length);
    });

    it('roundtrips PUBLISH_SKIPPED with single-element namespace suffix', () => {
      const message: PublishSkippedMessageDraft22 = {
        type: MessageTypeDraft22.PUBLISH_SKIPPED,
        trackNamespaceSuffix: ['only'],
        trackName: 'x',
      };

      const encoded = Draft22MessageCodec.encode(message);
      const [decoded] = Draft22MessageCodec.decode(encoded);

      const d = decoded as PublishSkippedMessageDraft22;
      expect(d.trackNamespaceSuffix).toEqual(['only']);
      expect(d.trackName).toBe('x');
    });
  });

  describe('PUBLISH_STATE_NOTIFY', () => {
    it('roundtrips PUBLISH_STATE_NOTIFY with parameters', () => {
      const parameters = new Map<number, Uint8Array>();
      // LARGEST_OBJECT = 0x09 (odd key -> length-prefixed)
      parameters.set(0x09, new Uint8Array([0x00, 0x05]));
      // FORWARD = 0x10 (even key -> varint value)
      parameters.set(0x10, MOQTVarInt.encode(42n));

      const message: PublishStateNotifyMessageDraft22 = {
        type: MessageTypeDraft22.PUBLISH_STATE_NOTIFY,
        parameters,
      };

      const encoded = Draft22MessageCodec.encode(message);
      const [decoded, bytesRead] = Draft22MessageCodec.decode(encoded);

      expect(decoded.type).toBe(MessageTypeDraft22.PUBLISH_STATE_NOTIFY);
      const d = decoded as PublishStateNotifyMessageDraft22;
      expect(d.parameters.size).toBe(2);

      // Odd key (0x09): length-prefixed bytes
      expect(d.parameters.get(0x09)).toEqual(new Uint8Array([0x00, 0x05]));

      // Even key (0x10): varint bytes - decode to verify value
      const forwardBytes = d.parameters.get(0x10);
      expect(forwardBytes).toBeDefined();
      const [forwardValue] = MOQTVarInt.decode(forwardBytes!);
      expect(forwardValue).toBe(42n);

      expect(bytesRead).toBe(encoded.length);
    });

    it('roundtrips PUBLISH_STATE_NOTIFY with empty parameters', () => {
      const message: PublishStateNotifyMessageDraft22 = {
        type: MessageTypeDraft22.PUBLISH_STATE_NOTIFY,
        parameters: new Map(),
      };

      const encoded = Draft22MessageCodec.encode(message);
      const [decoded, bytesRead] = Draft22MessageCodec.decode(encoded);

      expect(decoded.type).toBe(MessageTypeDraft22.PUBLISH_STATE_NOTIFY);
      const d = decoded as PublishStateNotifyMessageDraft22;
      expect(d.parameters.size).toBe(0);
      expect(bytesRead).toBe(encoded.length);
    });

    it('roundtrips PUBLISH_STATE_NOTIFY with single even-key parameter', () => {
      const parameters = new Map<number, Uint8Array>();
      parameters.set(0x02, MOQTVarInt.encode(100n));

      const message: PublishStateNotifyMessageDraft22 = {
        type: MessageTypeDraft22.PUBLISH_STATE_NOTIFY,
        parameters,
      };

      const encoded = Draft22MessageCodec.encode(message);
      const [decoded] = Draft22MessageCodec.decode(encoded);

      const d = decoded as PublishStateNotifyMessageDraft22;
      expect(d.parameters.size).toBe(1);
      const [val] = MOQTVarInt.decode(d.parameters.get(0x02)!);
      expect(val).toBe(100n);
    });
  });

  describe('Setup stream encode/decode', () => {
    it('roundtrips encodeSetupStream / decodeSetupStream', () => {
      const message: ClientSetupMessageDraft18 = {
        type: MessageTypeDraft18.CLIENT_SETUP,
        path: '/moq-test',
      };

      const encoded = Draft22MessageCodec.encodeSetupStream(message);
      const [decoded, bytesRead] = Draft22MessageCodec.decodeSetupStream(encoded);

      const d = decoded as ServerSetupMessageDraft18;
      expect(d.type).toBe(MessageTypeDraft18.SERVER_SETUP);
      expect(d.path).toBe('/moq-test');
      expect(bytesRead).toBe(encoded.length);
    });

    it('roundtrips setup stream with no options', () => {
      const message: ClientSetupMessageDraft18 = {
        type: MessageTypeDraft18.CLIENT_SETUP,
      };

      const encoded = Draft22MessageCodec.encodeSetupStream(message);
      const [decoded] = Draft22MessageCodec.decodeSetupStream(encoded);

      expect(decoded.type).toBe(MessageTypeDraft18.SERVER_SETUP);
    });

    it('roundtrips setup stream with MAX_FILTER_RANGES and MAX_REQUEST_UPDATES', () => {
      const message: ClientSetupMessageDraft18 = {
        type: MessageTypeDraft18.CLIENT_SETUP,
        maxFilterRanges: 16,
        maxRequestUpdates: 4,
      };

      const encoded = Draft22MessageCodec.encodeSetupStream(message);
      const [decoded] = Draft22MessageCodec.decodeSetupStream(encoded);

      expect(decoded.maxFilterRanges).toBe(16);
      expect(decoded.maxRequestUpdates).toBe(4);
    });

    it('roundtrips setup with only MAX_FILTER_RANGES', () => {
      const message: ClientSetupMessageDraft18 = {
        type: MessageTypeDraft18.CLIENT_SETUP,
        maxFilterRanges: 8,
      };

      const encoded = Draft22MessageCodec.encodeSetupStream(message);
      const [decoded] = Draft22MessageCodec.decodeSetupStream(encoded);

      expect(decoded.maxFilterRanges).toBe(8);
      expect(decoded.maxRequestUpdates).toBeUndefined();
    });
  });

  describe('SUBSCRIBE (draft-22 §9.7)', () => {
    const baseSubscribe = (): SubscribeMessageDraft22 => ({
      type: MessageTypeDraft22.SUBSCRIBE,
      requestId: 4n,
      trackNamespace: ['a'],
      trackName: 't',
      forwardState: true,
    });

    const roundtrip = (message: SubscribeMessageDraft22): SubscribeMessageDraft22 => {
      const encoded = Draft22MessageCodec.encode(message);
      const [decoded, bytesRead] = Draft22MessageCodec.decode(encoded);
      expect(bytesRead).toBe(encoded.length);
      return decoded as SubscribeMessageDraft22;
    };

    it('encodes ABSOLUTE_START to the exact spec bytes', () => {
      const message: SubscribeMessageDraft22 = {
        ...baseSubscribe(),
        locationFilter: {
          type: LocationFilterTypeDraft22.ABSOLUTE_START,
          startLocation: { group: 3n, object: 1n },
        },
      };

      // type | len(13) | reqId | ns(1,"a") | name(1,"t") | nparams
      // | FORWARD(0x10)=1 | LOCATION_FILTER(+1) 2,3,1
      const expected = new Uint8Array([
        0x03, 0x00, 0x0d,
        0x04, 0x01, 0x01, 0x61, 0x01, 0x74, 0x02,
        0x10, 0x01,
        0x11, 0x02, 0x03, 0x01,
      ]);

      expect(Draft22MessageCodec.encode(message)).toEqual(expected);
    });

    it('roundtrips each LOCATION_FILTER type', () => {
      const filters: NonNullable<SubscribeMessageDraft22['locationFilter']>[] = [
        { type: LocationFilterTypeDraft22.NONE },
        { type: LocationFilterTypeDraft22.RELATIVE_START, startLocation: { group: 3n, object: 0n } },
        { type: LocationFilterTypeDraft22.ABSOLUTE_START, startLocation: { group: 10n, object: 5n } },
        {
          type: LocationFilterTypeDraft22.ABSOLUTE_START_GROUP_END,
          startLocation: { group: 10n, object: 2n },
          endGroupDelta: 5n,
        },
        {
          type: LocationFilterTypeDraft22.ABSOLUTE_RANGE,
          startLocation: { group: 10n, object: 0n },
          endGroupDelta: 5n,
          endObject: 7n,
        },
        { type: LocationFilterTypeDraft22.NEXT_OBJECT },
      ];

      for (const locationFilter of filters) {
        const message = { ...baseSubscribe(), locationFilter };
        expect(roundtrip(message)).toEqual(message);
      }
    });

    it('decodes an absent LOCATION_FILTER as undefined (unfiltered)', () => {
      const decoded = roundtrip(baseSubscribe());

      expect(decoded.locationFilter).toBeUndefined();
    });

    it('sends FORWARD=0 when forwardState is false', () => {
      const message: SubscribeMessageDraft22 = { ...baseSubscribe(), forwardState: false };

      const encoded = Draft22MessageCodec.encode(message);

      // nparams=1 | FORWARD(0x10)=0
      expect(Array.from(encoded.slice(-3))).toEqual([0x01, 0x10, 0x00]);
      const decoded = roundtrip(message);
      expect(decoded.forwardState).toBe(false);
      expect(decoded.parameters).toBeUndefined();
    });

    it('rejects a FORWARD value outside 0 or 1', () => {
      const encoded = Draft22MessageCodec.encode(baseSubscribe());
      // nparams=1 | FORWARD(0x10)=2
      encoded[encoded.length - 1] = 0x02;

      expect(() => Draft22MessageCodec.decode(encoded)).toThrow(/FORWARD/);
    });

    it('roundtrips INCLUDE_PROPERTIES=1 in parameters', () => {
      const message: SubscribeMessageDraft22 = {
        ...baseSubscribe(),
        parameters: new Map([[0x35, new Uint8Array([1])]]), // INCLUDE_PROPERTIES = 1
      };

      expect(roundtrip(message).parameters?.get(0x35)).toEqual(new Uint8Array([1]));
    });

    it('roundtrips SUBGROUP_FILTER in parameters', () => {
      const rangeData = new Uint8Array([0x01, 0x00, 0x0A]); // SetID=1, range data
      const message: SubscribeMessageDraft22 = {
        ...baseSubscribe(),
        parameters: new Map([[0x25, rangeData]]), // SUBGROUP_FILTER
      };

      expect(roundtrip(message).parameters?.get(0x25)).toEqual(rangeData);
    });
  });

  describe('FETCH (draft-22 §9.11)', () => {
    const baseFetch = (): FetchMessageDraft22 => ({
      type: MessageTypeDraft22.FETCH,
      requestId: 4n,
      trackNamespace: ['a'],
      trackName: 't',
      subscriberPriority: 128,
      groupOrder: GroupOrder.ASCENDING,
    });

    it('encodes ABSOLUTE_RANGE to the exact spec bytes', () => {
      const message: FetchMessageDraft22 = {
        ...baseFetch(),
        locationFilter: {
          type: LocationFilterTypeDraft22.ABSOLUTE_RANGE,
          startLocation: { group: 1n, object: 0n },
          endGroupDelta: 2n,
          endObject: 5n,
        },
      };

      // type | len(16) | reqId | ns(1,"a") | name(1,"t") | nparams
      // | SUBSCRIBER_PRIORITY(0x20)=128 | LOCATION_FILTER(+1) 4,1,0,2,5 | GROUP_ORDER(+1)=1
      const expected = new Uint8Array([
        0x16, 0x00, 0x11,
        0x04, 0x01, 0x01, 0x61, 0x01, 0x74, 0x03,
        0x20, 0x80,
        0x01, 0x04, 0x01, 0x00, 0x02, 0x05,
        0x01, 0x01,
      ]);

      expect(Draft22MessageCodec.encode(message)).toEqual(expected);
    });

    it('roundtrips ABSOLUTE_RANGE', () => {
      const message: FetchMessageDraft22 = {
        ...baseFetch(),
        subscriberPriority: 7,
        groupOrder: GroupOrder.DESCENDING,
        locationFilter: {
          type: LocationFilterTypeDraft22.ABSOLUTE_RANGE,
          startLocation: { group: 10n, object: 3n },
          endGroupDelta: 4n,
          endObject: 9n,
        },
      };

      const encoded = Draft22MessageCodec.encode(message);
      const [decoded, bytesRead] = Draft22MessageCodec.decode(encoded);

      expect(bytesRead).toBe(encoded.length);
      expect(decoded).toEqual(message);
    });

    it('roundtrips ABSOLUTE_START_GROUP_END', () => {
      const message: FetchMessageDraft22 = {
        ...baseFetch(),
        locationFilter: {
          type: LocationFilterTypeDraft22.ABSOLUTE_START_GROUP_END,
          startLocation: { group: 2n, object: 1n },
          endGroupDelta: 3n,
        },
      };

      const [decoded] = Draft22MessageCodec.decode(Draft22MessageCodec.encode(message));

      expect(decoded).toEqual(message);
    });

    it('roundtrips without a location filter', () => {
      const message = baseFetch();

      const [decoded] = Draft22MessageCodec.decode(Draft22MessageCodec.encode(message));
      const d = decoded as FetchMessageDraft22;

      expect(d.locationFilter).toBeUndefined();
      expect(d).toEqual(message);
    });

    it('roundtrips FILL_TIMEOUT', () => {
      const message: FetchMessageDraft22 = { ...baseFetch(), fillTimeoutMs: 1500n };

      const [decoded] = Draft22MessageCodec.decode(Draft22MessageCodec.encode(message));

      expect((decoded as FetchMessageDraft22).fillTimeoutMs).toBe(1500n);
    });

    it('applies defaults when priority and group order are omitted', () => {
      const bytes = new Uint8Array([0x16, 0x00, 0x07, 0x04, 0x01, 0x01, 0x61, 0x01, 0x74, 0x00]);

      const [decoded] = Draft22MessageCodec.decode(bytes);
      const d = decoded as FetchMessageDraft22;

      expect(d.subscriberPriority).toBe(128);
      expect(d.groupOrder).toBe(GroupOrder.ASCENDING);
    });

    it('rejects an invalid GROUP_ORDER on decode', () => {
      const bytes = new Uint8Array([
        0x16, 0x00, 0x09,
        0x04, 0x01, 0x01, 0x61, 0x01, 0x74, 0x01,
        0x22, 0x03,
      ]);

      expect(() => Draft22MessageCodec.decode(bytes)).toThrow(/GROUP_ORDER/);
    });

    it('rejects an invalid group order on encode', () => {
      const message = { ...baseFetch(), groupOrder: 3 as GroupOrder };

      expect(() => Draft22MessageCodec.encode(message)).toThrow(/GROUP_ORDER/);
    });

    it('rejects an unknown location filter type on decode', () => {
      const bytes = new Uint8Array([
        0x16, 0x00, 0x0A,
        0x04, 0x01, 0x01, 0x61, 0x01, 0x74, 0x01,
        0x21, 0x09, 0x00,
      ]);

      expect(() => Draft22MessageCodec.decode(bytes)).toThrow(/LOCATION_FILTER/);
    });
  });
});
