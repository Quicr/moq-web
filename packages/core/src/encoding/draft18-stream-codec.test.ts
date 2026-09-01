// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { describe, it, expect } from 'vitest';
import { Draft18StreamCodec, SubgroupFlags, DatagramFlags, FetchObjectFlags } from './draft18-stream-codec';
import { MOQTVarInt } from './moqt-varint';
import {
  StreamTypeDraft18,
  FetchSubgroupMode,
  FetchObjectEndOfRange,
  ObjectStatusDraft18,
  SubgroupIdModeDraft18,
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

  describe('SUBGROUP_HEADER (spec §11.4.2)', () => {
    it('roundtrips EXPLICIT mode with priority and first-object bit', () => {
      const header: SubgroupHeaderDraft18 = {
        trackAlias: 123n,
        groupId: 10n,
        subgroupIdMode: SubgroupIdModeDraft18.EXPLICIT,
        subgroupId: 0n,
        publisherPriority: 128,
        firstObject: true,
      };

      const encoded = Draft18StreamCodec.encodeSubgroupHeader(header);
      // Type byte: BASE(0x10) | EXPLICIT(0x04) | FIRST_OBJECT(0x40) = 0x54
      expect(encoded[0]).toBe(0x54);

      const [decoded, bytesRead] = Draft18StreamCodec.decodeSubgroupHeader(encoded);
      expect(decoded.trackAlias).toBe(123n);
      expect(decoded.groupId).toBe(10n);
      expect(decoded.subgroupId).toBe(0n);
      expect(decoded.subgroupIdMode).toBe(SubgroupIdModeDraft18.EXPLICIT);
      expect(decoded.publisherPriority).toBe(128);
      expect(decoded.firstObject).toBe(true);
      expect(bytesRead).toBe(encoded.length);
    });

    it('roundtrips ZERO mode (subgroup ID field absent, implied 0)', () => {
      const header: SubgroupHeaderDraft18 = {
        trackAlias: 1n,
        groupId: 2n,
        subgroupIdMode: SubgroupIdModeDraft18.ZERO,
        publisherPriority: 64,
        firstObject: true,
      };

      const encoded = Draft18StreamCodec.encodeSubgroupHeader(header);
      // Type byte: BASE(0x10) | ZERO(0x00) | FIRST_OBJECT(0x40) = 0x50
      expect(encoded[0]).toBe(0x50);

      const [decoded] = Draft18StreamCodec.decodeSubgroupHeader(encoded);
      expect(decoded.subgroupIdMode).toBe(SubgroupIdModeDraft18.ZERO);
      expect(decoded.subgroupId).toBe(0n);
    });

    it('roundtrips FIRST_OBJECT_ID mode (subgroup ID field absent, resolved later)', () => {
      const header: SubgroupHeaderDraft18 = {
        trackAlias: 1n,
        groupId: 2n,
        subgroupIdMode: SubgroupIdModeDraft18.FIRST_OBJECT_ID,
        publisherPriority: 64,
        firstObject: true,
      };

      const encoded = Draft18StreamCodec.encodeSubgroupHeader(header);
      const [decoded] = Draft18StreamCodec.decodeSubgroupHeader(encoded);
      expect(decoded.subgroupIdMode).toBe(SubgroupIdModeDraft18.FIRST_OBJECT_ID);
      expect(decoded.subgroupId).toBeUndefined();
    });

    it('encodes DEFAULT_PRIORITY bit when publisherPriority omitted', () => {
      const header: SubgroupHeaderDraft18 = {
        trackAlias: 1n,
        groupId: 2n,
        subgroupIdMode: SubgroupIdModeDraft18.EXPLICIT,
        subgroupId: 3n,
        firstObject: true,
      };
      const encoded = Draft18StreamCodec.encodeSubgroupHeader(header);
      expect((encoded[0] & SubgroupFlags.DEFAULT_PRIORITY) !== 0).toBe(true);
      const [decoded] = Draft18StreamCodec.decodeSubgroupHeader(encoded);
      expect(decoded.publisherPriority).toBeUndefined();
    });

    it('encodes END_OF_GROUP bit', () => {
      const header: SubgroupHeaderDraft18 = {
        trackAlias: 100n,
        groupId: 50n,
        subgroupIdMode: SubgroupIdModeDraft18.EXPLICIT,
        subgroupId: 0n,
        publisherPriority: 128,
        endOfGroup: true,
      };

      const encoded = Draft18StreamCodec.encodeSubgroupHeader(header);
      expect((encoded[0] & SubgroupFlags.END_OF_GROUP) !== 0).toBe(true);
      const [decoded] = Draft18StreamCodec.decodeSubgroupHeader(encoded);
      expect(decoded.endOfGroup).toBe(true);
    });

    it('rejects reserved SUBGROUP_ID_MODE 0b11', () => {
      // Type byte with mode bits = 11: BASE(0x10) | 0b11<<1(0x06) = 0x16
      const bad = new Uint8Array([0x16, 0x01, 0x02, 0x03, 0x80]);
      expect(() => Draft18StreamCodec.decodeSubgroupHeader(bad)).toThrow(/Reserved SUBGROUP_ID_MODE/);
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

  describe('Object Datagram (spec §11.3.1)', () => {
    it('roundtrips object datagram (payload, non-zero object ID, explicit priority)', () => {
      const datagram: ObjectDatagramDraft18 = {
        trackAlias: 100n,
        groupId: 5n,
        objectId: 10n,
        publisherPriority: 128,
        payload: new Uint8Array([1, 2, 3, 4, 5]),
      };

      const encoded = Draft18StreamCodec.encodeObjectDatagram(datagram);
      // Type byte: no PROPERTIES/END_OF_GROUP/ZERO_OBJECT_ID/DEFAULT_PRIORITY/STATUS = 0x00
      expect(encoded[0]).toBe(0x00);

      const [decoded, bytesRead] = Draft18StreamCodec.decodeObjectDatagram(encoded);
      expect(decoded.trackAlias).toBe(100n);
      expect(decoded.groupId).toBe(5n);
      expect(decoded.objectId).toBe(10n);
      expect(decoded.publisherPriority).toBe(128);
      expect(decoded.payload).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
      expect(bytesRead).toBe(encoded.length);
    });

    it('encodes ZERO_OBJECT_ID bit when objectId is zero (or absent)', () => {
      const datagram: ObjectDatagramDraft18 = {
        trackAlias: 1n,
        groupId: 2n,
        publisherPriority: 128,
        payload: new Uint8Array([0xAA]),
      };
      const encoded = Draft18StreamCodec.encodeObjectDatagram(datagram);
      expect((encoded[0] & DatagramFlags.ZERO_OBJECT_ID) !== 0).toBe(true);
      const [decoded] = Draft18StreamCodec.decodeObjectDatagram(encoded);
      expect(decoded.objectId).toBe(0n);
    });

    it('encodes DEFAULT_PRIORITY bit when publisherPriority is absent', () => {
      const datagram: ObjectDatagramDraft18 = {
        trackAlias: 1n,
        groupId: 2n,
        objectId: 3n,
        payload: new Uint8Array([0xAA]),
      };
      const encoded = Draft18StreamCodec.encodeObjectDatagram(datagram);
      expect((encoded[0] & DatagramFlags.DEFAULT_PRIORITY) !== 0).toBe(true);
      const [decoded] = Draft18StreamCodec.decodeObjectDatagram(encoded);
      expect(decoded.publisherPriority).toBeUndefined();
    });

    it('encodes END_OF_GROUP bit', () => {
      const datagram: ObjectDatagramDraft18 = {
        trackAlias: 1n,
        groupId: 2n,
        objectId: 3n,
        publisherPriority: 128,
        endOfGroup: true,
        payload: new Uint8Array([0xAA]),
      };
      const encoded = Draft18StreamCodec.encodeObjectDatagram(datagram);
      expect((encoded[0] & DatagramFlags.END_OF_GROUP) !== 0).toBe(true);
      const [decoded] = Draft18StreamCodec.decodeObjectDatagram(encoded);
      expect(decoded.endOfGroup).toBe(true);
    });

    it('encodes STATUS bit with objectStatus (no payload)', () => {
      const datagram: ObjectDatagramDraft18 = {
        trackAlias: 1n,
        groupId: 2n,
        objectId: 3n,
        publisherPriority: 128,
        objectStatus: ObjectStatusDraft18.END_OF_TRACK,
      };
      const encoded = Draft18StreamCodec.encodeObjectDatagram(datagram);
      expect((encoded[0] & DatagramFlags.STATUS) !== 0).toBe(true);
      const [decoded] = Draft18StreamCodec.decodeObjectDatagram(encoded);
      expect(decoded.objectStatus).toBe(ObjectStatusDraft18.END_OF_TRACK);
      expect(decoded.payload?.length ?? 0).toBe(0);
    });

    it('roundtrips datagram with properties', () => {
      const props = new Map<number, Uint8Array>();
      props.set(1, new Uint8Array([0x01]));

      const datagram: ObjectDatagramDraft18 = {
        trackAlias: 200n,
        groupId: 10n,
        objectId: 20n,
        publisherPriority: 64,
        objectProperties: props,
        payload: new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]),
      };

      const encoded = Draft18StreamCodec.encodeObjectDatagram(datagram);
      expect((encoded[0] & DatagramFlags.PROPERTIES) !== 0).toBe(true);
      const [decoded] = Draft18StreamCodec.decodeObjectDatagram(encoded);
      expect(decoded.objectProperties).toBeDefined();
      expect(decoded.objectProperties!.size).toBe(1);
    });

    it('rejects invalid datagram type (STATUS + END_OF_GROUP is spec-forbidden)', () => {
      // Forbidden combination: 0x22 = STATUS(0x20) + END_OF_GROUP(0x02)
      const bad = new Uint8Array([0x22, 0x01, 0x02, 0x03]);
      expect(() => Draft18StreamCodec.decodeObjectDatagram(bad)).toThrow(/Invalid/);
    });

    it('rejects invalid datagram type outside 0b00X0XXXX form', () => {
      // 0x40 has bit 6 set → invalid form
      const bad = new Uint8Array([0x40, 0x01, 0x02]);
      expect(() => Draft18StreamCodec.decodeObjectDatagram(bad)).toThrow(/Invalid/);
    });
  });

  describe('Fetch Object (spec §11.4.4)', () => {
    it('roundtrips first-object fetch (all deltas present, explicit subgroup)', () => {
      const obj: FetchObjectDraft18 = {
        subgroupMode: FetchSubgroupMode.EXPLICIT,
        groupIdDelta: 5n,
        subgroupId: 0n,
        objectIdDelta: 10n,
        publisherPriority: 128,
        payloadLength: 256n,
      };

      const encoded = Draft18StreamCodec.encodeFetchObject(obj);
      // Expected flag byte: EXPLICIT(0x03) | OBJECT_ID_DELTA(0x04) | GROUP_ID_DELTA(0x08) | PRIORITY(0x10) = 0x1F
      expect(encoded[0]).toBe(0x1f);

      const [decoded, bytesRead] = Draft18StreamCodec.decodeFetchObject(encoded);
      expect(decoded.subgroupMode).toBe(FetchSubgroupMode.EXPLICIT);
      expect(decoded.groupIdDelta).toBe(5n);
      expect(decoded.subgroupId).toBe(0n);
      expect(decoded.objectIdDelta).toBe(10n);
      expect(decoded.publisherPriority).toBe(128);
      expect(decoded.payloadLength).toBe(256n);
      expect(bytesRead).toBe(encoded.length);
    });

    it('encodes bit 0x04 only when object ID delta is provided', () => {
      const obj: FetchObjectDraft18 = {
        subgroupMode: FetchSubgroupMode.ZERO,
        groupIdDelta: 5n,
        publisherPriority: 128,
        payloadLength: 0n,
      };
      const encoded = Draft18StreamCodec.encodeFetchObject(obj);
      expect((encoded[0] & FetchObjectFlags.OBJECT_ID_DELTA) !== 0).toBe(false);
      const [decoded] = Draft18StreamCodec.decodeFetchObject(encoded);
      expect(decoded.objectIdDelta).toBeUndefined();
    });

    it('encodes 0x40 for datagram-mode object', () => {
      const obj: FetchObjectDraft18 = {
        subgroupMode: FetchSubgroupMode.ZERO,
        groupIdDelta: 1n,
        objectIdDelta: 2n,
        publisherPriority: 128,
        payloadLength: 8n,
        datagramMode: true,
      };
      const encoded = Draft18StreamCodec.encodeFetchObject(obj);
      expect((encoded[0] & FetchObjectFlags.DATAGRAM_MODE) !== 0).toBe(true);
      const [decoded] = Draft18StreamCodec.decodeFetchObject(encoded);
      expect(decoded.datagramMode).toBe(true);
    });

    it('roundtrips End of Non-Existent Range marker (0x8C)', () => {
      const obj: FetchObjectDraft18 = {
        subgroupMode: FetchSubgroupMode.ZERO,
        groupIdDelta: 10n,
        objectIdDelta: 20n,
        endOfRange: FetchObjectEndOfRange.NON_EXISTENT,
      };
      const encoded = Draft18StreamCodec.encodeFetchObject(obj);
      const [decoded] = Draft18StreamCodec.decodeFetchObject(encoded);
      expect(decoded.endOfRange).toBe(FetchObjectEndOfRange.NON_EXISTENT);
      expect(decoded.groupIdDelta).toBe(10n);
      expect(decoded.objectIdDelta).toBe(20n);
    });

    it('roundtrips End of Unknown Range marker (0x10C)', () => {
      const obj: FetchObjectDraft18 = {
        subgroupMode: FetchSubgroupMode.ZERO,
        groupIdDelta: 100n,
        objectIdDelta: 200n,
        endOfRange: FetchObjectEndOfRange.UNKNOWN,
      };
      const encoded = Draft18StreamCodec.encodeFetchObject(obj);
      const [decoded] = Draft18StreamCodec.decodeFetchObject(encoded);
      expect(decoded.endOfRange).toBe(FetchObjectEndOfRange.UNKNOWN);
      expect(decoded.groupIdDelta).toBe(100n);
      expect(decoded.objectIdDelta).toBe(200n);
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
        trackAlias: 0xFFFFFFFFFFFFFFFFn,
        groupId: 0n,
        subgroupIdMode: SubgroupIdModeDraft18.EXPLICIT,
        subgroupId: 0n,
        publisherPriority: 0,
        firstObject: true,
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

  // ==========================================================================
  // Byte-level golden regression tests.
  //
  // Byte layouts are derived from draft-18 §11 (data streams) figures. These
  // catch accidental changes to type IDs, flag bit positions, and field order.
  // ==========================================================================
  describe('golden bytes (§11 wire format)', () => {
    it('SUBGROUP_HEADER EXPLICIT mode with explicit priority (§11.4.2 Figure 24)', () => {
      // Type=0x54 [BASE 0x10 | EXPLICIT 0x04 | FIRST_OBJECT 0x40]
      // TrackAlias=1, GroupID=2, SubgroupID=3, PublisherPriority=128
      const expected = new Uint8Array([0x54, 0x01, 0x02, 0x03, 0x80]);
      const encoded = Draft18StreamCodec.encodeSubgroupHeader({
        trackAlias: 1n,
        groupId: 2n,
        subgroupIdMode: SubgroupIdModeDraft18.EXPLICIT,
        subgroupId: 3n,
        publisherPriority: 128,
        firstObject: true,
      });
      expect(Array.from(encoded)).toEqual(Array.from(expected));
    });

    it('SUBGROUP_HEADER ZERO mode omits SubgroupID field, DEFAULT_PRIORITY omits priority (§11.4.2)', () => {
      // Type=0x70 [BASE 0x10 | ZERO 0x00 | DEFAULT_PRIORITY 0x20 | FIRST_OBJECT 0x40]
      // TrackAlias=1, GroupID=2 — no SubgroupID, no PublisherPriority
      const expected = new Uint8Array([0x70, 0x01, 0x02]);
      const encoded = Draft18StreamCodec.encodeSubgroupHeader({
        trackAlias: 1n,
        groupId: 2n,
        subgroupIdMode: SubgroupIdModeDraft18.ZERO,
        firstObject: true,
      });
      expect(Array.from(encoded)).toEqual(Array.from(expected));
    });

    it('OBJECT_DATAGRAM with all flags off (§11.3.1 Figure 23)', () => {
      // Type=0x00 (all flags off) | TrackAlias=1 | GroupID=2 | ObjectID=3 | Priority=128 | Payload
      const expected = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x80, 0xaa, 0xbb]);
      const encoded = Draft18StreamCodec.encodeObjectDatagram({
        trackAlias: 1n,
        groupId: 2n,
        objectId: 3n,
        publisherPriority: 128,
        payload: new Uint8Array([0xaa, 0xbb]),
      });
      expect(Array.from(encoded)).toEqual(Array.from(expected));
    });

    it('OBJECT_DATAGRAM with STATUS bit set (§11.3.1)', () => {
      // Type=0x20 STATUS | TrackAlias=1 | GroupID=2 | ObjectID=3 | Priority=128 | ObjectStatus=0x04 (END_OF_TRACK)
      const expected = new Uint8Array([0x20, 0x01, 0x02, 0x03, 0x80, 0x04]);
      const encoded = Draft18StreamCodec.encodeObjectDatagram({
        trackAlias: 1n,
        groupId: 2n,
        objectId: 3n,
        publisherPriority: 128,
        objectStatus: ObjectStatusDraft18.END_OF_TRACK,
      });
      expect(Array.from(encoded)).toEqual(Array.from(expected));
    });

    it('FETCH_HEADER type is 0x05 (§11.4.4 Figure 26)', () => {
      const encoded = Draft18StreamCodec.encodeFetchHeader(7n);
      // Type=0x05 | RequestID=7
      expect(Array.from(encoded)).toEqual([0x05, 0x07]);
    });

    it('FETCH object flag byte encodes deltas and priority (§11.4.4.1)', () => {
      // Flag byte = EXPLICIT(0x03) | OBJECT_ID_DELTA(0x04) | GROUP_ID_DELTA(0x08) | PRIORITY(0x10) = 0x1F
      // Fields: GroupIDDelta=5, SubgroupID=0, ObjectIDDelta=10, Priority=128, PayloadLength=256 (0x100)
      // PayloadLength 256 = MOQT varint 2-byte form: 0x81 0x00
      const expected = new Uint8Array([0x1f, 0x05, 0x00, 0x0a, 0x80, 0x81, 0x00]);
      const encoded = Draft18StreamCodec.encodeFetchObject({
        subgroupMode: FetchSubgroupMode.EXPLICIT,
        groupIdDelta: 5n,
        subgroupId: 0n,
        objectIdDelta: 10n,
        publisherPriority: 128,
        payloadLength: 256n,
      });
      expect(Array.from(encoded)).toEqual(Array.from(expected));
    });

    it('SETUP stream header is 0x2f00 as 2-byte MOQT varint (0xAF 0x00)', () => {
      // Regression guard against reintroducing single-byte 0x40 SETUP type.
      const encoded = Draft18StreamCodec.encodeSetupStreamHeader();
      expect(Array.from(encoded)).toEqual([0xaf, 0x00]);
    });
  });
});
