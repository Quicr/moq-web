// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Fuzz coverage for protocol-codec.ts primitives (Wave 2 Track G).
 *
 * The shared reader/writer scaffolding lives in `protocol-codec.ts`:
 *  - `Draft18BufferReader` / `Draft18BufferWriter` (MOQT varint round-tripping)
 *  - `Draft18Codec` / `Draft16Codec` (encode/decode of namespaces, full track
 *    names, varints, key/value pairs)
 *
 * We fuzz the codec seam here rather than reaching directly into the message
 * codecs so that any regression at the primitive layer surfaces cleanly.
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

import {
  Draft18BufferReader,
  Draft18BufferWriter,
  getProtocolCodecForVersion,
} from './protocol-codec.js';
import { MOQTVarInt, MOQTVarIntError } from './moqt-varint.js';
import { VarInt, VarIntError } from './varint.js';
import { Version, type TrackNamespace, type FullTrackName } from '../messages/types.js';

const ACCEPTED_ERROR_NAMES = new Set([
  'MOQTVarIntError',
  'VarIntError',
  'Draft18CodecError',
  'Draft18StreamCodecError',
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

const draft18 = getProtocolCodecForVersion(Version.DRAFT_18);
const draft16 = getProtocolCodecForVersion(Version.DRAFT_16);

// -----------------------------------------------------------------------------
// Arbitraries
// -----------------------------------------------------------------------------

const arbAsciiString = (max: number): fc.Arbitrary<string> =>
  fc.string({ minLength: 0, maxLength: max, unit: 'grapheme-ascii' });

const arbBigintU62 = (max = 0xffff_ffffn): fc.Arbitrary<bigint> =>
  fc.bigInt({ min: 0n, max });

const arbTrackNamespace: fc.Arbitrary<TrackNamespace> = fc.array(arbAsciiString(64), {
  minLength: 1,
  maxLength: 4,
});

const arbFullTrackName: fc.Arbitrary<FullTrackName> = fc.record({
  namespace: arbTrackNamespace,
  trackName: arbAsciiString(64),
});

// -----------------------------------------------------------------------------
// 1. Draft18BufferReader tolerates arbitrary bytes
// -----------------------------------------------------------------------------

describe('protocol-codec fuzz — Draft18BufferReader', () => {
  it('readVarInt / readVarIntNumber / readByte / readBytes never crash', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 0, maxLength: 256 }),
        fc.array(
          fc.oneof(
            fc.constant('vi' as const),
            fc.constant('vin' as const),
            fc.constant('byte' as const),
            fc.integer({ min: 0, max: 64 }).map((n) => ({ kind: 'bytes' as const, n })),
          ),
          { minLength: 0, maxLength: 8 },
        ),
        (bytes, ops) => {
          const reader = new Draft18BufferReader(bytes);
          for (const op of ops) {
            try {
              if (op === 'vi') reader.readVarInt();
              else if (op === 'vin') reader.readVarIntNumber();
              else if (op === 'byte') reader.readByte();
              else reader.readBytes(op.n);
            } catch (e) {
              assertAcceptableDecodeError(e, `Draft18BufferReader op=${JSON.stringify(op)}`);
              break;
            }
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it('varint round-trips (Draft18BufferWriter → Draft18BufferReader)', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: MOQT_VARINT_MAX_TESTED }), (value) => {
        const w = new Draft18BufferWriter();
        w.writeVarInt(value);
        const r = new Draft18BufferReader(w.toUint8Array());
        expect(r.readVarInt()).toBe(value);
      }),
      { numRuns: 500 },
    );
  });
});

// MOQT varints are defined up to 2^64-1; keep the fuzz value bounded so tests
// remain fast and always fit in bigint arithmetic on the decode side.
const MOQT_VARINT_MAX_TESTED = 0xffff_ffff_ffff_ffn;

// -----------------------------------------------------------------------------
// 2. MOQTVarInt / VarInt tolerate arbitrary bytes
// -----------------------------------------------------------------------------

describe('protocol-codec fuzz — MOQTVarInt & VarInt primitives', () => {
  it('MOQTVarInt.decode never throws an unexpected error', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 32 }), (bytes) => {
        try {
          MOQTVarInt.decode(bytes, 0);
        } catch (e) {
          assertAcceptableDecodeError(e, 'MOQTVarInt.decode');
        }
      }),
      { numRuns: 1000 },
    );
  });

  it('MOQTVarInt.decodeNumber never throws an unexpected error', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 32 }), (bytes) => {
        try {
          MOQTVarInt.decodeNumber(bytes, 0);
        } catch (e) {
          assertAcceptableDecodeError(e, 'MOQTVarInt.decodeNumber');
        }
      }),
      { numRuns: 1000 },
    );
  });

  it('VarInt.decode (QUIC) never throws an unexpected error', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 32 }), (bytes) => {
        try {
          VarInt.decode(bytes, 0);
        } catch (e) {
          assertAcceptableDecodeError(e, 'VarInt.decode');
        }
      }),
      { numRuns: 1000 },
    );
  });

  it('MOQTVarInt round-trips (bigint)', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: MOQT_VARINT_MAX_TESTED }), (value) => {
        const bytes = MOQTVarInt.encode(value);
        const [decoded, bytesRead] = MOQTVarInt.decode(bytes, 0);
        expect(decoded).toBe(value);
        expect(bytesRead).toBe(bytes.length);
      }),
      { numRuns: 1000 },
    );
  });

  it('MOQTVarInt.encode rejects negatives with a typed error', () => {
    expect(() => MOQTVarInt.encode(-1n)).toThrow(MOQTVarIntError);
  });

  it('VarInt.encode rejects negatives with a typed error', () => {
    expect(() => VarInt.encode(-1)).toThrow(VarIntError);
  });
});

// -----------------------------------------------------------------------------
// 3. Protocol codec: namespace, fullTrackName, KVP round-trips
// -----------------------------------------------------------------------------

describe('protocol-codec fuzz — Draft18 codec round-trips', () => {
  it('encodeNamespace → decodeNamespace round-trips', () => {
    fc.assert(
      fc.property(arbTrackNamespace, (ns) => {
        const encoded = draft18.encodeNamespace(ns);
        const [decoded, bytesRead] = draft18.decodeNamespace(encoded);
        expect(bytesRead).toBe(encoded.length);
        expect(decoded).toEqual(ns);
      }),
      { numRuns: 300 },
    );
  });

  it('encodeFullTrackName → decodeFullTrackName round-trips', () => {
    fc.assert(
      fc.property(arbFullTrackName, (ftn) => {
        const encoded = draft18.encodeFullTrackName(ftn);
        const [decoded, bytesRead] = draft18.decodeFullTrackName(encoded);
        expect(bytesRead).toBe(encoded.length);
        expect(decoded.namespace).toEqual(ftn.namespace);
        expect(decoded.trackName).toBe(ftn.trackName);
      }),
      { numRuns: 300 },
    );
  });

  it('encodeVarInt / decodeVarInt round-trip', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: MOQT_VARINT_MAX_TESTED }), (value) => {
        const encoded = draft18.encodeVarInt(value);
        const [decoded, bytesRead] = draft18.decodeVarInt(encoded);
        expect(bytesRead).toBe(encoded.length);
        expect(decoded).toBe(value);
      }),
      { numRuns: 500 },
    );
  });

  it('decodeNamespace on garbage never crashes', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 256 }), (bytes) => {
        try {
          draft18.decodeNamespace(bytes);
        } catch (e) {
          assertAcceptableDecodeError(e, 'draft18.decodeNamespace');
        }
      }),
      { numRuns: 500 },
    );
  });

  it('decodeFullTrackName on garbage never crashes', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 256 }), (bytes) => {
        try {
          draft18.decodeFullTrackName(bytes);
        } catch (e) {
          assertAcceptableDecodeError(e, 'draft18.decodeFullTrackName');
        }
      }),
      { numRuns: 500 },
    );
  });
});

describe('protocol-codec fuzz — Draft16 codec round-trips', () => {
  it('draft-16 encodeNamespace → decodeNamespace round-trips (QUIC varints)', () => {
    fc.assert(
      fc.property(arbTrackNamespace, (ns) => {
        const encoded = draft16.encodeNamespace(ns);
        const [decoded, bytesRead] = draft16.decodeNamespace(encoded);
        expect(bytesRead).toBe(encoded.length);
        expect(decoded).toEqual(ns);
      }),
      { numRuns: 300 },
    );
  });

  it('draft-16 encodeVarInt → decodeVarInt round-trips', () => {
    fc.assert(
      // QUIC varints max out at 2^62 - 1
      fc.property(fc.bigInt({ min: 0n, max: (1n << 62n) - 1n }), (value) => {
        const encoded = draft16.encodeVarInt(value);
        const [decoded, bytesRead] = draft16.decodeVarInt(encoded);
        expect(bytesRead).toBe(encoded.length);
        expect(decoded).toBe(value);
      }),
      { numRuns: 500 },
    );
  });

  it('draft-16 decodeNamespace on garbage never crashes', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 256 }), (bytes) => {
        try {
          draft16.decodeNamespace(bytes);
        } catch (e) {
          assertAcceptableDecodeError(e, 'draft16.decodeNamespace');
        }
      }),
      { numRuns: 500 },
    );
  });
});
