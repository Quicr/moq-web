// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { describe, it, expect } from 'vitest';
import { Draft22MessageCodec } from './draft22-message-codec';
import { MOQTVarInt } from './moqt-varint';
import {
  MessageTypeDraft18,
  MessageTypeDraft22,
  Version,
  SubscriptionFilterDraft18,
  type ClientSetupMessageDraft18,
  type ServerSetupMessageDraft18,
  type SubscribeMessageDraft18,
  type PublishSkippedMessageDraft22,
  type PublishStateNotifyMessageDraft22,
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

  describe('Delegation to Draft18MessageCodec', () => {
    it('roundtrips SUBSCRIBE through Draft22MessageCodec', () => {
      const message: SubscribeMessageDraft18 = {
        type: MessageTypeDraft18.SUBSCRIBE,
        requestId: 1n,
        trackNamespace: ['ns1', 'ns2'],
        trackName: 'audio',
        forwardState: true,
        filter: SubscriptionFilterDraft18.NEXT_GROUP_START,
      };

      // Encode and decode via Draft22MessageCodec
      const encoded = Draft22MessageCodec.encode(message as any);
      const [decoded, bytesRead] = Draft22MessageCodec.decode(encoded);

      // SUBSCRIBE type value is the same in draft-18 and draft-22
      expect(decoded.type).toBe(MessageTypeDraft18.SUBSCRIBE);
      const d = decoded as unknown as SubscribeMessageDraft18;
      expect(d.requestId).toBe(1n);
      expect(d.trackNamespace).toEqual(['ns1', 'ns2']);
      expect(d.trackName).toBe('audio');
      expect(d.forwardState).toBe(true);
      expect(d.filter).toBe(SubscriptionFilterDraft18.NEXT_GROUP_START);
      expect(bytesRead).toBe(encoded.length);
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

  describe('LOCATION_FILTER (draft-22 §9.20.9)', () => {
    it('roundtrips SUBSCRIBE with NONE filter (0x00)', () => {
      const message: SubscribeMessageDraft18 = {
        type: MessageTypeDraft18.SUBSCRIBE,
        requestId: 10n,
        trackNamespace: ['ns'],
        trackName: 'track',
        forwardState: true,
        filter: 0x00, // LocationFilterTypeDraft22.NONE
      };

      const encoded = Draft22MessageCodec.encode(message as any);
      const [decoded] = Draft22MessageCodec.decode(encoded);
      const d = decoded as unknown as SubscribeMessageDraft18;
      expect(d.filter).toBe(0x00);
    });

    it('roundtrips SUBSCRIBE with RELATIVE_START filter (0x01)', () => {
      const message: SubscribeMessageDraft18 = {
        type: MessageTypeDraft18.SUBSCRIBE,
        requestId: 11n,
        trackNamespace: ['ns'],
        trackName: 'track',
        forwardState: true,
        filter: 0x01, // RELATIVE_START
        startLocation: { group: 3n, object: 0n },
      };

      const encoded = Draft22MessageCodec.encode(message as any);
      const [decoded] = Draft22MessageCodec.decode(encoded);
      const d = decoded as unknown as SubscribeMessageDraft18;
      expect(d.filter).toBe(0x01);
      expect(d.startLocation?.group).toBe(3n);
    });

    it('roundtrips SUBSCRIBE with ABSOLUTE_START filter (0x02)', () => {
      const message: SubscribeMessageDraft18 = {
        type: MessageTypeDraft18.SUBSCRIBE,
        requestId: 12n,
        trackNamespace: ['ns'],
        trackName: 'track',
        forwardState: true,
        filter: 0x02, // ABSOLUTE_START
        startLocation: { group: 10n, object: 5n },
      };

      const encoded = Draft22MessageCodec.encode(message as any);
      const [decoded] = Draft22MessageCodec.decode(encoded);
      const d = decoded as unknown as SubscribeMessageDraft18;
      expect(d.filter).toBe(0x02);
      expect(d.startLocation?.group).toBe(10n);
      expect(d.startLocation?.object).toBe(5n);
    });

    it('roundtrips SUBSCRIBE with ABSOLUTE_RANGE filter (0x04)', () => {
      const message: SubscribeMessageDraft18 = {
        type: MessageTypeDraft18.SUBSCRIBE,
        requestId: 14n,
        trackNamespace: ['ns'],
        trackName: 'track',
        forwardState: true,
        filter: 0x04, // ABSOLUTE_RANGE
        startLocation: { group: 10n, object: 0n },
        endGroupDelta: 5n,
      };

      const encoded = Draft22MessageCodec.encode(message as any);
      const [decoded] = Draft22MessageCodec.decode(encoded);
      const d = decoded as unknown as SubscribeMessageDraft18;
      expect(d.filter).toBe(0x04);
      expect(d.startLocation?.group).toBe(10n);
      expect(d.endGroupDelta).toBe(5n);
    });

    it('roundtrips SUBSCRIBE with NEXT_OBJECT filter (0x05)', () => {
      const message: SubscribeMessageDraft18 = {
        type: MessageTypeDraft18.SUBSCRIBE,
        requestId: 15n,
        trackNamespace: ['ns'],
        trackName: 'track',
        forwardState: true,
        filter: 0x05, // NEXT_OBJECT
      };

      const encoded = Draft22MessageCodec.encode(message as any);
      const [decoded] = Draft22MessageCodec.decode(encoded);
      const d = decoded as unknown as SubscribeMessageDraft18;
      expect(d.filter).toBe(0x05);
    });
  });

  describe('INCLUDE_PROPERTIES parameter', () => {
    it('roundtrips SUBSCRIBE with INCLUDE_PROPERTIES=1 in parameters', () => {
      const params = new Map<number, Uint8Array>();
      params.set(0x35, new Uint8Array([1])); // INCLUDE_PROPERTIES = 1

      const message: SubscribeMessageDraft18 = {
        type: MessageTypeDraft18.SUBSCRIBE,
        requestId: 20n,
        trackNamespace: ['ns'],
        trackName: 'track',
        forwardState: true,
        filter: 0x05,
        parameters: params,
      };

      const encoded = Draft22MessageCodec.encode(message as any);
      const [decoded] = Draft22MessageCodec.decode(encoded);
      const d = decoded as unknown as SubscribeMessageDraft18;
      expect(d.parameters?.get(0x35)).toEqual(new Uint8Array([1]));
    });
  });

  describe('Range filter parameters', () => {
    it('roundtrips SUBSCRIBE with SUBGROUP_FILTER in parameters', () => {
      const rangeData = new Uint8Array([0x01, 0x00, 0x0A]); // SetID=1, range data
      const params = new Map<number, Uint8Array>();
      params.set(0x25, rangeData); // SUBGROUP_FILTER

      const message: SubscribeMessageDraft18 = {
        type: MessageTypeDraft18.SUBSCRIBE,
        requestId: 30n,
        trackNamespace: ['ns'],
        trackName: 'track',
        forwardState: true,
        filter: 0x05,
        parameters: params,
      };

      const encoded = Draft22MessageCodec.encode(message as any);
      const [decoded] = Draft22MessageCodec.decode(encoded);
      const d = decoded as unknown as SubscribeMessageDraft18;
      expect(d.parameters?.get(0x25)).toEqual(rangeData);
    });
  });
});
