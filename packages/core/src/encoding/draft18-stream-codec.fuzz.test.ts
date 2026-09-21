// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Fuzz coverage for Draft18StreamCodec (Wave 2 Track G).
 *
 * Targets:
 *  - `decodeObjectHeader`
 *  - `decodeObjectDatagram`
 *  - `decodeFetchObject`
 *  - `decodeProperties` (exercised via decodeObjectHeader / decodeObjectDatagram)
 *
 * Properties tested:
 *  1. Arbitrary bytes never trigger raw TypeError/RangeError.
 *  2. Length mutations on the Properties Length field must trip the
 *     MAX_PROPERTIES_LENGTH bound.
 *  3. Round-trip identity for representative encoded shapes.
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

import {
  Draft18StreamCodec,
  Draft18StreamCodecError,
  MAX_PROPERTIES_LENGTH,
} from './draft18-stream-codec.js';
import { Draft18BufferWriter } from './protocol-codec.js';
import { MOQTVarInt } from './moqt-varint.js';
import {
  FetchSubgroupMode,
  SubgroupIdModeDraft18,
  type SubgroupHeaderDraft18,
  type ObjectHeaderDraft18,
  type ObjectDatagramDraft18,
  type FetchObjectDraft18,
} from '../messages/types.js';

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const ACCEPTED_ERROR_NAMES = new Set([
  'Draft18CodecError',
  'Draft18StreamCodecError',
  'MOQTVarIntError',
  'VarIntError',
  'Error',
]);

function assertAcceptableDecodeError(err: unknown, ctx: string): void {
  if (!(err instanceof Error)) {
    throw new Error(`${ctx}: threw non-Error value: ${String(err)}`);
  }
  if (!ACCEPTED_ERROR_NAMES.has(err.name)) {
    throw new Error(`${ctx}: threw disallowed error type '${err.name}': ${err.message}`);
  }
}

const arbBigintU62 = (max = 0xffff_ffffn): fc.Arbitrary<bigint> =>
  fc.bigInt({ min: 0n, max });

// -----------------------------------------------------------------------------
// 1. Arbitrary bytes never blow up decoders
// -----------------------------------------------------------------------------

describe('Draft18StreamCodec fuzz — arbitrary bytes', () => {
  it('decodeObjectHeader (hasProperties=true) is safe on garbage', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 512 }), (bytes) => {
        try {
          Draft18StreamCodec.decodeObjectHeader(bytes, 0, true);
        } catch (e) {
          assertAcceptableDecodeError(e, 'decodeObjectHeader(hasProps=true)');
        }
      }),
      { numRuns: 500 },
    );
  });

  it('decodeObjectHeader (hasProperties=false) is safe on garbage', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 256 }), (bytes) => {
        try {
          Draft18StreamCodec.decodeObjectHeader(bytes, 0, false);
        } catch (e) {
          assertAcceptableDecodeError(e, 'decodeObjectHeader(hasProps=false)');
        }
      }),
      { numRuns: 500 },
    );
  });

  it('decodeObjectDatagram is safe on garbage', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 512 }), (bytes) => {
        try {
          Draft18StreamCodec.decodeObjectDatagram(bytes);
        } catch (e) {
          assertAcceptableDecodeError(e, 'decodeObjectDatagram');
        }
      }),
      { numRuns: 500 },
    );
  });

  it('decodeFetchObject is safe on garbage', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 512 }), (bytes) => {
        try {
          Draft18StreamCodec.decodeFetchObject(bytes);
        } catch (e) {
          assertAcceptableDecodeError(e, 'decodeFetchObject');
        }
      }),
      { numRuns: 500 },
    );
  });

  it('decodeSubgroupHeader is safe on garbage', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 128 }), (bytes) => {
        try {
          Draft18StreamCodec.decodeSubgroupHeader(bytes);
        } catch (e) {
          assertAcceptableDecodeError(e, 'decodeSubgroupHeader');
        }
      }),
      { numRuns: 500 },
    );
  });

  it('decodeFetchHeader is safe on garbage', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 64 }), (bytes) => {
        try {
          Draft18StreamCodec.decodeFetchHeader(bytes);
        } catch (e) {
          assertAcceptableDecodeError(e, 'decodeFetchHeader');
        }
      }),
      { numRuns: 500 },
    );
  });
});

// -----------------------------------------------------------------------------
// 2. Length-prefix mutations must trip the properties-length bound
// -----------------------------------------------------------------------------

describe('Draft18StreamCodec fuzz — properties length mutation', () => {
  it('decodeObjectHeader: propsLength > MAX_PROPERTIES_LENGTH throws bounds error', () => {
    fc.assert(
      fc.property(fc.integer({ min: MAX_PROPERTIES_LENGTH + 1, max: 1_000_000 }), (n) => {
        const w = new Draft18BufferWriter();
        w.writeVarInt(0n); // objectIdDelta
        w.writeVarInt(BigInt(n)); // exploded propsLength
        const bytes = w.toUint8Array();
        expect(() => Draft18StreamCodec.decodeObjectHeader(bytes, 0, true)).toThrow(
          Draft18StreamCodecError,
        );
      }),
      { numRuns: 25 },
    );
  });

  it('decodeObjectDatagram: propsLength > MAX_PROPERTIES_LENGTH throws bounds error', () => {
    fc.assert(
      fc.property(fc.integer({ min: MAX_PROPERTIES_LENGTH + 1, max: 1_000_000 }), (n) => {
        const w = new Draft18BufferWriter();
        // Type = PROPERTIES(0x01) | ZERO_OBJECT_ID(0x04) | DEFAULT_PRIORITY(0x08) = 0x0d
        w.writeVarInt(0x0dn);
        w.writeVarInt(0n); // trackAlias
        w.writeVarInt(0n); // groupId
        // objectId omitted (ZERO_OBJECT_ID), priority omitted (DEFAULT_PRIORITY)
        w.writeVarInt(BigInt(n)); // exploded propsLength
        const bytes = w.toUint8Array();
        expect(() => Draft18StreamCodec.decodeObjectDatagram(bytes)).toThrow(
          Draft18StreamCodecError,
        );
      }),
      { numRuns: 25 },
    );
  });

  it('decodeFetchObject: propsLength > MAX_PROPERTIES_LENGTH throws bounds error', () => {
    fc.assert(
      fc.property(fc.integer({ min: MAX_PROPERTIES_LENGTH + 1, max: 1_000_000 }), (n) => {
        const w = new Draft18BufferWriter();
        // Flags: subgroupMode=ZERO(0) | PROPERTIES(0x20) = 0x20; no deltas, priority, etc.
        w.writeVarInt(0x20n);
        w.writeVarInt(BigInt(n)); // exploded propsLength
        const bytes = w.toUint8Array();
        expect(() => Draft18StreamCodec.decodeFetchObject(bytes)).toThrow(
          Draft18StreamCodecError,
        );
      }),
      { numRuns: 25 },
    );
  });
});

// -----------------------------------------------------------------------------
// 3. Round-trip identity for representative shapes
// -----------------------------------------------------------------------------

describe('Draft18StreamCodec fuzz — round-trip identity', () => {
  it('encodeObjectHeader → decodeObjectHeader (no properties)', () => {
    fc.assert(
      fc.property(
        fc.record({
          objectIdDelta: arbBigintU62(),
          payloadLength: arbBigintU62(0xff_ffffn),
        }),
        ({ objectIdDelta, payloadLength }) => {
          const header: ObjectHeaderDraft18 = { objectIdDelta, payloadLength };
          const encoded = Draft18StreamCodec.encodeObjectHeader(header, false);
          const [decoded, bytesRead] = Draft18StreamCodec.decodeObjectHeader(encoded, 0, false);
          expect(bytesRead).toBe(encoded.length);
          expect(decoded.objectIdDelta).toBe(objectIdDelta);
          expect(decoded.payloadLength).toBe(payloadLength);
          expect(decoded.objectProperties).toBeUndefined();
        },
      ),
      { numRuns: 200 },
    );
  });

  it('encodeObjectDatagram → decodeObjectDatagram (default priority, zero object id, no props)', () => {
    fc.assert(
      fc.property(
        fc.record({
          trackAlias: arbBigintU62(),
          groupId: arbBigintU62(),
          payload: fc.uint8Array({ minLength: 0, maxLength: 128 }),
        }),
        ({ trackAlias, groupId, payload }) => {
          const dgram: ObjectDatagramDraft18 = { trackAlias, groupId, payload };
          const encoded = Draft18StreamCodec.encodeObjectDatagram(dgram);
          const [decoded] = Draft18StreamCodec.decodeObjectDatagram(encoded);
          expect(decoded.trackAlias).toBe(trackAlias);
          expect(decoded.groupId).toBe(groupId);
          expect(decoded.objectId).toBe(0n);
          expect(decoded.payload).toBeDefined();
          expect(Array.from(decoded.payload!)).toEqual(Array.from(payload));
        },
      ),
      { numRuns: 200 },
    );
  });

  it('encodeObjectDatagram → decodeObjectDatagram (explicit priority + objectId)', () => {
    fc.assert(
      fc.property(
        fc.record({
          trackAlias: arbBigintU62(),
          groupId: arbBigintU62(),
          // Non-zero to force objectId to be written on the wire.
          objectId: fc.bigInt({ min: 1n, max: 0xff_ffffn }),
          publisherPriority: fc.integer({ min: 0, max: 255 }),
          payload: fc.uint8Array({ minLength: 0, maxLength: 128 }),
        }),
        ({ trackAlias, groupId, objectId, publisherPriority, payload }) => {
          const dgram: ObjectDatagramDraft18 = {
            trackAlias,
            groupId,
            objectId,
            publisherPriority,
            payload,
          };
          const encoded = Draft18StreamCodec.encodeObjectDatagram(dgram);
          const [decoded] = Draft18StreamCodec.decodeObjectDatagram(encoded);
          expect(decoded.trackAlias).toBe(trackAlias);
          expect(decoded.groupId).toBe(groupId);
          expect(decoded.objectId).toBe(objectId);
          expect(decoded.publisherPriority).toBe(publisherPriority);
          expect(Array.from(decoded.payload!)).toEqual(Array.from(payload));
        },
      ),
      { numRuns: 200 },
    );
  });

  it('encodeFetchObject → decodeFetchObject (subgroupMode=ZERO, no optional fields)', () => {
    fc.assert(
      fc.property(
        fc.record({
          payloadLength: arbBigintU62(0xff_ffffn),
        }),
        ({ payloadLength }) => {
          const obj: FetchObjectDraft18 = {
            subgroupMode: FetchSubgroupMode.ZERO,
            payloadLength,
          };
          const encoded = Draft18StreamCodec.encodeFetchObject(obj);
          const [decoded] = Draft18StreamCodec.decodeFetchObject(encoded);
          expect(decoded.subgroupMode).toBe(FetchSubgroupMode.ZERO);
          expect(decoded.payloadLength).toBe(payloadLength);
          expect(decoded.groupIdDelta).toBeUndefined();
          expect(decoded.objectIdDelta).toBeUndefined();
        },
      ),
      { numRuns: 200 },
    );
  });

  it('encodeFetchObject → decodeFetchObject (with deltas and priority)', () => {
    fc.assert(
      fc.property(
        fc.record({
          groupIdDelta: arbBigintU62(0xffffn),
          objectIdDelta: arbBigintU62(0xffffn),
          publisherPriority: fc.integer({ min: 0, max: 255 }),
          payloadLength: arbBigintU62(0xff_ffffn),
        }),
        ({ groupIdDelta, objectIdDelta, publisherPriority, payloadLength }) => {
          const obj: FetchObjectDraft18 = {
            subgroupMode: FetchSubgroupMode.ZERO,
            groupIdDelta,
            objectIdDelta,
            publisherPriority,
            payloadLength,
          };
          const encoded = Draft18StreamCodec.encodeFetchObject(obj);
          const [decoded] = Draft18StreamCodec.decodeFetchObject(encoded);
          expect(decoded.groupIdDelta).toBe(groupIdDelta);
          expect(decoded.objectIdDelta).toBe(objectIdDelta);
          expect(decoded.publisherPriority).toBe(publisherPriority);
          expect(decoded.payloadLength).toBe(payloadLength);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('encodeSubgroupHeader → decodeSubgroupHeader (EXPLICIT mode, explicit priority)', () => {
    fc.assert(
      fc.property(
        fc.record({
          trackAlias: arbBigintU62(),
          groupId: arbBigintU62(),
          subgroupId: arbBigintU62(),
          publisherPriority: fc.integer({ min: 0, max: 255 }),
        }),
        ({ trackAlias, groupId, subgroupId, publisherPriority }) => {
          const header: SubgroupHeaderDraft18 = {
            trackAlias,
            groupId,
            subgroupIdMode: SubgroupIdModeDraft18.EXPLICIT,
            subgroupId,
            publisherPriority,
          };
          const encoded = Draft18StreamCodec.encodeSubgroupHeader(header);
          const [decoded] = Draft18StreamCodec.decodeSubgroupHeader(encoded);
          expect(decoded.trackAlias).toBe(trackAlias);
          expect(decoded.groupId).toBe(groupId);
          expect(decoded.subgroupIdMode).toBe(SubgroupIdModeDraft18.EXPLICIT);
          expect(decoded.subgroupId).toBe(subgroupId);
          expect(decoded.publisherPriority).toBe(publisherPriority);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('encodeFetchHeader → decodeFetchHeader', () => {
    fc.assert(
      fc.property(arbBigintU62(), (requestId) => {
        const encoded = Draft18StreamCodec.encodeFetchHeader(requestId);
        const [decoded, bytesRead] = Draft18StreamCodec.decodeFetchHeader(encoded);
        expect(bytesRead).toBe(encoded.length);
        expect(decoded.requestId).toBe(requestId);
      }),
      { numRuns: 200 },
    );
  });
});

// -----------------------------------------------------------------------------
// 4. Properties (decodeProperties via decodeObjectHeader hasProperties=true)
// -----------------------------------------------------------------------------

describe('Draft18StreamCodec fuzz — decodeProperties via ObjectHeader', () => {
  it('properties block round-trips with well-formed even+odd keys', () => {
    // Even keys (varint values) and odd keys (length-prefixed bytes) at
    // moderate sizes; delta-encoded so we sort by key.
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 0, max: 63 }), { minLength: 0, maxLength: 4 }).chain((keys) =>
          fc.tuple(
            fc.constant([...keys].sort((a, b) => a - b)),
            fc.array(fc.uint8Array({ minLength: 0, maxLength: 8 }), {
              minLength: keys.length,
              maxLength: keys.length,
            }),
          ),
        ),
        ([sortedKeys, values]) => {
          // Build a properties Map: even keys must be varint-encoded values,
          // odd keys are raw bytes. Use small byte payloads to stay well
          // under MAX_PROPERTY_VALUE_LENGTH.
          const props = new Map<number, Uint8Array>();
          for (let i = 0; i < sortedKeys.length; i++) {
            const key = sortedKeys[i];
            if (key % 2 === 0) {
              // Encode a small varint value for even keys — codec expects
              // the value bytes to already BE a varint on the wire.
              props.set(key, MOQTVarInt.encode(BigInt(values[i][0] ?? 0)));
            } else {
              props.set(key, values[i]);
            }
          }

          const header: ObjectHeaderDraft18 = {
            objectIdDelta: 0n,
            objectProperties: props,
            payloadLength: 0n,
          };

          const encoded = Draft18StreamCodec.encodeObjectHeader(header, true);
          if (props.size === 0) {
            // Encoder writes propsLength=0; decoder skips the props block.
            const [decoded] = Draft18StreamCodec.decodeObjectHeader(encoded, 0, true);
            expect(decoded.objectProperties).toBeUndefined();
            return;
          }
          const [decoded] = Draft18StreamCodec.decodeObjectHeader(encoded, 0, true);
          expect(decoded.objectProperties).toBeDefined();
          expect(decoded.objectProperties!.size).toBe(props.size);
          for (const [k, v] of props) {
            expect(decoded.objectProperties!.has(k)).toBe(true);
            expect(Array.from(decoded.objectProperties!.get(k)!)).toEqual(Array.from(v));
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
