// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { describe, it, expect } from 'vitest';
import { Draft18StreamCodec, SubgroupFlags } from './draft18-stream-codec';
import { MOQTVarInt } from './moqt-varint';
import {
  StreamTypeDraft18,
  type SubgroupHeaderDraft18,
  type ObjectHeaderDraft18,
  type ObjectDatagramDraft18,
  type FetchObjectDraft18,
} from '../messages/types';

describe('Draft18StreamCodec', () => {
  describe('isSubgroupHeader', () => {
    it('identifies valid subgroup stream types', () => {
      // Valid: 0x10-0x1F, 0x30-0x3F, 0x50-0x5F, 0x70-0x7F (bit 4 set, bit 7 clear)
      expect(Draft18StreamCodec.isSubgroupHeader(0x10)).toBe(true);
      expect(Draft18StreamCodec.isSubgroupHeader(0x14)).toBe(true);
      expect(Draft18StreamCodec.isSubgroupHeader(0x30)).toBe(true);
      expect(Draft18StreamCodec.isSubgroupHeader(0x50)).toBe(true);
      expect(Draft18StreamCodec.isSubgroupHeader(0x70)).toBe(true);
      expect(Draft18StreamCodec.isSubgroupHeader(0x7F)).toBe(true);
    });

    it('rejects non-subgroup stream types', () => {
      expect(Draft18StreamCodec.isSubgroupHeader(0x00)).toBe(false);
      expect(Draft18StreamCodec.isSubgroupHeader(0x05)).toBe(false); // FETCH_HEADER
      expect(Draft18StreamCodec.isSubgroupHeader(0x2f00)).toBe(false); // SETUP
    });
  });

  describe('SUBGROUP_HEADER', () => {
    it('roundtrips basic subgroup header', () => {
      const header: SubgroupHeaderDraft18 = {
        streamType: SubgroupFlags.BASE_TYPE,
        trackAlias: 123n,
        groupId: 10n,
        subgroupId: 0n,
        publisherPriority: 128,
      };

      const encoded = Draft18StreamCodec.encodeSubgroupHeader(header);
      const [decoded, bytesRead] = Draft18StreamCodec.decodeSubgroupHeader(encoded);

      expect(decoded.trackAlias).toBe(123n);
      expect(decoded.groupId).toBe(10n);
      expect(decoded.subgroupId).toBe(0n);
      expect(decoded.publisherPriority).toBe(128);
      expect(decoded.firstObject).toBe(0n);
      expect(bytesRead).toBe(encoded.length);
    });

    it('roundtrips subgroup header with FIRST_OBJECT bit unset (non-zero first object)', () => {
      const header: SubgroupHeaderDraft18 = {
        streamType: 0,
        trackAlias: 456n,
        groupId: 20n,
        subgroupId: 5n,
        publisherPriority: 64,
        firstObject: 100n,
      };

      const encoded = Draft18StreamCodec.encodeSubgroupHeader(header);
      const [decoded] = Draft18StreamCodec.decodeSubgroupHeader(encoded);

      // FIRST_OBJECT bit not set means firstObject is undefined (not first published)
      expect(decoded.firstObject).toBeUndefined();
      // Verify FIRST_OBJECT bit is NOT set in stream type
      expect(decoded.streamType & SubgroupFlags.FIRST_OBJECT).toBe(0);
    });

    it('roundtrips subgroup header with all flags', () => {
      const header: SubgroupHeaderDraft18 = {
        streamType: SubgroupFlags.BASE_TYPE,
        trackAlias: 789n,
        groupId: 30n,
        subgroupId: 2n,
        publisherPriority: 255,
      };

      const encoded = Draft18StreamCodec.encodeSubgroupHeader(header);
      const [decoded] = Draft18StreamCodec.decodeSubgroupHeader(encoded);

      expect(decoded.trackAlias).toBe(789n);
      expect(decoded.groupId).toBe(30n);
      expect(decoded.subgroupId).toBe(2n);
      expect(decoded.publisherPriority).toBe(255);
      // FIRST_OBJECT bit set because firstObject is undefined (defaults to 0)
      expect(decoded.streamType & SubgroupFlags.FIRST_OBJECT).toBe(SubgroupFlags.FIRST_OBJECT);
    });

    it('roundtrips subgroup header with END_OF_GROUP flag', () => {
      const header: SubgroupHeaderDraft18 = {
        streamType: SubgroupFlags.END_OF_GROUP,
        trackAlias: 100n,
        groupId: 50n,
        subgroupId: 0n,
        publisherPriority: 128,
      };

      const encoded = Draft18StreamCodec.encodeSubgroupHeader(header);
      const [decoded] = Draft18StreamCodec.decodeSubgroupHeader(encoded);

      expect(decoded.streamType & SubgroupFlags.END_OF_GROUP).toBe(SubgroupFlags.END_OF_GROUP);
    });
  });

  describe('FETCH_HEADER', () => {
    it('roundtrips fetch header', () => {
      const requestId = 42n;

      const encoded = Draft18StreamCodec.encodeFetchHeader(requestId);
      const [decoded, bytesRead] = Draft18StreamCodec.decodeFetchHeader(encoded);

      expect(decoded.requestId).toBe(42n);
      expect(bytesRead).toBe(encoded.length);
    });

    it('roundtrips fetch header with large request ID', () => {
      const requestId = 0xFFFFFFFFFFFFn;

      const encoded = Draft18StreamCodec.encodeFetchHeader(requestId);
      const [decoded] = Draft18StreamCodec.decodeFetchHeader(encoded);

      expect(decoded.requestId).toBe(requestId);
    });
  });

  describe('Object Header', () => {
    it('roundtrips basic object header', () => {
      const header: ObjectHeaderDraft18 = {
        objectIdDelta: 1n,
        payloadLength: 1024n,
      };

      const encoded = Draft18StreamCodec.encodeObjectHeader(header);
      const [decoded, bytesRead] = Draft18StreamCodec.decodeObjectHeader(encoded);

      expect(decoded.objectIdDelta).toBe(1n);
      expect(decoded.payloadLength).toBe(1024n);
      expect(decoded.objectProperties).toBeUndefined();
      expect(bytesRead).toBe(encoded.length);
    });

    it('roundtrips object header with properties', () => {
      const props = new Map<number, Uint8Array>();
      props.set(0, MOQTVarInt.encode(0)); // NORMAL status

      const header: ObjectHeaderDraft18 = {
        objectIdDelta: 5n,
        objectProperties: props,
        payloadLength: 512n,
      };

      const encoded = Draft18StreamCodec.encodeObjectHeader(header, true);
      const [decoded] = Draft18StreamCodec.decodeObjectHeader(encoded, 0, true);

      expect(decoded.objectProperties).toBeDefined();
      expect(decoded.objectProperties!.size).toBe(1);
      expect(decoded.payloadLength).toBe(512n);
    });

    it('roundtrips object header with zero delta', () => {
      const header: ObjectHeaderDraft18 = {
        objectIdDelta: 0n,
        payloadLength: 0n,
      };

      const encoded = Draft18StreamCodec.encodeObjectHeader(header);
      const [decoded] = Draft18StreamCodec.decodeObjectHeader(encoded);

      expect(decoded.objectIdDelta).toBe(0n);
      expect(decoded.payloadLength).toBe(0n);
    });
  });

  describe('Object Datagram', () => {
    it('roundtrips object datagram', () => {
      const datagram: ObjectDatagramDraft18 = {
        trackAlias: 100n,
        groupId: 5n,
        objectId: 10n,
        publisherPriority: 128,
        payload: new Uint8Array([1, 2, 3, 4, 5]),
      };

      const encoded = Draft18StreamCodec.encodeObjectDatagram(datagram);
      const [decoded, bytesRead] = Draft18StreamCodec.decodeObjectDatagram(encoded);

      expect(decoded.trackAlias).toBe(100n);
      expect(decoded.groupId).toBe(5n);
      expect(decoded.objectId).toBe(10n);
      expect(decoded.publisherPriority).toBe(128);
      expect(decoded.payload).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
      expect(bytesRead).toBe(encoded.length);
    });

    it('roundtrips datagram with properties', () => {
      const props = new Map<number, Uint8Array>();
      props.set(1, new Uint8Array([0x01])); // Forwarding preference: subgroup

      const datagram: ObjectDatagramDraft18 = {
        trackAlias: 200n,
        groupId: 10n,
        objectId: 20n,
        publisherPriority: 64,
        objectProperties: props,
        payload: new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]),
      };

      const encoded = Draft18StreamCodec.encodeObjectDatagram(datagram);
      const [decoded] = Draft18StreamCodec.decodeObjectDatagram(encoded);

      expect(decoded.objectProperties).toBeDefined();
      expect(decoded.objectProperties!.size).toBe(1);
    });
  });

  describe('Fetch Object', () => {
    it('roundtrips fetch object', () => {
      const obj: FetchObjectDraft18 = {
        endOfFetch: false,
        groupId: 5n,
        subgroupId: 0n,
        objectId: 10n,
        publisherPriority: 128,
        payloadLength: 256n,
      };

      const encoded = Draft18StreamCodec.encodeFetchObject(obj);
      const [decoded, bytesRead] = Draft18StreamCodec.decodeFetchObject(encoded);

      expect(decoded.endOfFetch).toBe(false);
      expect(decoded.groupId).toBe(5n);
      expect(decoded.subgroupId).toBe(0n);
      expect(decoded.objectId).toBe(10n);
      expect(decoded.publisherPriority).toBe(128);
      expect(decoded.payloadLength).toBe(256n);
      expect(bytesRead).toBe(encoded.length);
    });

    it('roundtrips fetch object with END_OF_FETCH flag', () => {
      const obj: FetchObjectDraft18 = {
        endOfFetch: true,
        groupId: 100n,
        subgroupId: 5n,
        objectId: 50n,
        publisherPriority: 255,
        payloadLength: 0n,
      };

      const encoded = Draft18StreamCodec.encodeFetchObject(obj);
      const [decoded] = Draft18StreamCodec.decodeFetchObject(encoded);

      expect(decoded.endOfFetch).toBe(true);
    });
  });

  describe('Setup Stream Header', () => {
    it('encodes setup stream header correctly', () => {
      const encoded = Draft18StreamCodec.encodeSetupStreamHeader();
      const [streamType, bytesRead] = Draft18StreamCodec.decodeSetupStreamHeader(encoded);

      expect(streamType).toBe(StreamTypeDraft18.SETUP);
      expect(streamType).toBe(0x2f00);
      expect(bytesRead).toBe(encoded.length);
    });
  });

  describe('large values', () => {
    it('handles large track aliases', () => {
      const header: SubgroupHeaderDraft18 = {
        streamType: SubgroupFlags.BASE_TYPE,
        trackAlias: 0xFFFFFFFFFFFFFFFFn,
        groupId: 0n,
        subgroupId: 0n,
        publisherPriority: 0,
      };

      const encoded = Draft18StreamCodec.encodeSubgroupHeader(header);
      const [decoded] = Draft18StreamCodec.decodeSubgroupHeader(encoded);

      expect(decoded.trackAlias).toBe(0xFFFFFFFFFFFFFFFFn);
    });

    it('handles large payload lengths', () => {
      const header: ObjectHeaderDraft18 = {
        objectIdDelta: 0n,
        payloadLength: 0xFFFFFFFFFFFFFFFFn,
      };

      const encoded = Draft18StreamCodec.encodeObjectHeader(header);
      const [decoded] = Draft18StreamCodec.decodeObjectHeader(encoded);

      expect(decoded.payloadLength).toBe(0xFFFFFFFFFFFFFFFFn);
    });
  });
});
