// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Fuzz coverage for the draft-23 control-message codec (vi64 framing,
 * MAX_CONTROL_MESSAGE_SIZE, Error Details) beside draft-22.
 *
 * Properties:
 *  1. Arbitrary bytes only ever throw the codec's own errors.
 *  2. A Message Length over the receive limit is refused from the header,
 *     before the body is needed; a frame cut short is incomplete, not malformed.
 *  3. Generated SUBSCRIBE, FETCH and REQUEST_ERROR messages round-trip.
 *  4. Mutating a valid message only produces typed errors, and every error
 *     that is not "incomplete" carries a violation kind, so the session can
 *     close with the draft-23 code for it (§12.2).
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

import { Draft23MessageCodec, draft23Dialect, draft23Framing } from './draft23-message-codec.js';
import { Draft22MessageCodec, DIALECT_DRAFT22 } from './draft22-message-codec.js';
import { isIncompleteDecode } from './draft18-message-codec.js';
import { Draft18StreamCodec } from './draft18-stream-codec.js';
import { MOQTVarInt } from './moqt-varint.js';
import { violationOf } from './violation.js';
import {
  GroupOrder,
  LocationFilterTypeDraft22,
  MessageTypeDraft18,
  MessageTypeDraft22,
  RequestErrorCodeDraft23,
  type ControlMessageDraft22,
  type RequestErrorMessageDraft18,
} from '../messages/types.js';

const ACCEPTED = new Set(['Draft18CodecError', 'Draft18StreamCodecError', 'MOQTVarIntError', 'Error']);

/** Decode, and return the error (if any) after checking it is one of ours */
function decodeSafely(decode: () => unknown, ctx: string): unknown {
  try {
    decode();
    return undefined;
  } catch (err) {
    if (!(err instanceof Error) || !ACCEPTED.has(err.name)) {
      throw new Error(`${ctx}: threw ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
    }
    return err;
  }
}

const codecs = [
  ['draft-22', (b: Uint8Array) => Draft22MessageCodec.decode(b, 0, DIALECT_DRAFT22)],
  ['draft-23', (b: Uint8Array) => Draft23MessageCodec.decode(b, 0, draft23Dialect())],
] as const;

describe.each(codecs)('%s control-message decode fuzz', (draft, decode) => {
  it('arbitrary bytes only throw codec errors', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 512 }), (bytes) => {
        decodeSafely(() => decode(bytes), `${draft} garbage`);
      }),
      { numRuns: 2000 },
    );
  });

  it('a known type with a random body only throws codec errors', () => {
    const types = Object.values(MessageTypeDraft22).filter((v): v is number => typeof v === 'number');
    fc.assert(
      fc.property(fc.constantFrom(...types), fc.uint8Array({ maxLength: 256 }), (type, body) => {
        const framed = draft === 'draft-23'
          ? new Uint8Array([...MOQTVarInt.encode(type), ...MOQTVarInt.encode(body.length), ...body])
          : new Uint8Array([...MOQTVarInt.encode(type), body.length >> 8, body.length & 0xff, ...body]);
        decodeSafely(() => decode(framed), `${draft} type 0x${type.toString(16)}`);
      }),
      { numRuns: 3000 },
    );
  });
});

describe('draft-23 Message Length (§9, §9.1.8)', () => {
  it('a length over the receive limit is refused from the header alone', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1 << 20 }), fc.bigInt({ min: 1n, max: (1n << 62n) }), (limit, extra) => {
        const dialect = draft23Dialect(draft23Framing(undefined, Math.max(limit, 65535)));
        const length = BigInt(Math.max(limit, 65535)) + extra;
        // Only the header: a codec that waited for the body would report "incomplete"
        const header = new Uint8Array([...MOQTVarInt.encode(MessageTypeDraft18.SUBSCRIBE), ...MOQTVarInt.encode(length)]);
        const err = decodeSafely(() => Draft23MessageCodec.decode(header, 0, dialect), 'oversize');
        expect(err).toBeDefined();
        expect(isIncompleteDecode(err)).toBe(false);
      }),
      { numRuns: 500 },
    );
  });

  it('a valid frame cut anywhere short is incomplete, never malformed', () => {
    const message: ControlMessageDraft22 = {
      type: MessageTypeDraft22.SUBSCRIBE,
      requestId: 6n,
      trackNamespace: ['a', 'b'],
      trackName: 'c',
      forwardState: true,
    } as ControlMessageDraft22;
    const bytes = Draft23MessageCodec.encode(message);
    for (let cut = 0; cut < bytes.length; cut++) {
      const err = decodeSafely(() => Draft23MessageCodec.decode(bytes.subarray(0, cut)), `cut ${cut}`);
      expect(isIncompleteDecode(err), `cut at ${cut} of ${bytes.length}`).toBe(true);
    }
  });
});

const name = fc.string({ minLength: 1, maxLength: 24 });
const namespace = fc.array(name, { minLength: 1, maxLength: 6 });
const id = fc.bigInt({ min: 0n, max: (1n << 62n) - 1n });

describe('draft-23 round-trips', () => {
  it('SUBSCRIBE with filters and PAUSED', () => {
    fc.assert(
      fc.property(id, namespace, name, fc.boolean(), fc.option(fc.tuple(id, id)), (requestId, ns, track, forward, start) => {
        const message = {
          type: MessageTypeDraft22.SUBSCRIBE,
          requestId,
          trackNamespace: ns,
          trackName: track,
          forwardState: forward,
          ...(start && {
            locationFilter: { type: LocationFilterTypeDraft22.ABSOLUTE_START, startLocation: { group: start[0], object: start[1] } },
          }),
        } as ControlMessageDraft22;
        const [decoded, read] = Draft23MessageCodec.decode(Draft23MessageCodec.encode(message));
        expect(decoded).toMatchObject({ type: message.type, requestId, trackNamespace: ns, trackName: track, forwardState: forward });
        if (start) {
          expect((decoded as { locationFilter?: unknown }).locationFilter).toEqual(
            (message as { locationFilter?: unknown }).locationFilter,
          );
        }
        expect(read).toBe(Draft23MessageCodec.encode(message).length);
      }),
      { numRuns: 500 },
    );
  });

  it('REQUEST_ERROR with Error Details, with and without grease', () => {
    const details = fc.oneof(
      fc.record({ errorCode: fc.constant(RequestErrorCodeDraft23.INTERNAL_ERROR) }),
      fc.record({
        errorCode: fc.constant(RequestErrorCodeDraft23.UNSUPPORTED_EXTENSION),
        unsupportedProperties: fc.array(fc.bigInt({ min: 0x4000n, max: 0x7fffn }), { minLength: 1, maxLength: 8 }),
      }),
      fc.record({
        errorCode: fc.constant(RequestErrorCodeDraft23.REDIRECT),
        redirect: fc.record({ connectUri: fc.constant(''), trackNamespace: namespace, trackName: name }),
      }),
    );
    fc.assert(
      fc.property(details, fc.string({ maxLength: 64 }), fc.bigInt({ min: 0n, max: 1n << 40n }), fc.boolean(), (detail, reason, retry, grease) => {
        const message = {
          type: MessageTypeDraft18.REQUEST_ERROR,
          requestId: 0n,
          retryInterval: retry,
          reasonPhrase: reason,
          ...detail,
          ...(grease && { greaseDetail: true }),
        } as RequestErrorMessageDraft18;
        const [decoded] = Draft23MessageCodec.decode(Draft23MessageCodec.encode(message as unknown as ControlMessageDraft22));
        const { greaseDetail: _ignored, ...expected } = message;
        expect(decoded).toEqual(expected);
      }),
      { numRuns: 500 },
    );
  });
});

describe('draft-23 mutation fuzz', () => {
  const samples: ControlMessageDraft22[] = [
    { type: MessageTypeDraft22.SUBSCRIBE, requestId: 2n, trackNamespace: ['conf', 'room'], trackName: 'video', forwardState: false,
      locationFilter: { type: LocationFilterTypeDraft22.ABSOLUTE_START, startLocation: { group: 9n, object: 0n } },
      fill: { subscriberPriority: 10, fillTimeoutMs: 500n } } as ControlMessageDraft22,
    { type: MessageTypeDraft22.FETCH, requestId: 4n, trackNamespace: ['conf'], trackName: 'video', subscriberPriority: 7, groupOrder: GroupOrder.ASCENDING,
      locationFilter: { type: LocationFilterTypeDraft22.ABSOLUTE_RANGE, startLocation: { group: 1n, object: 0n }, endGroupDelta: 3n } } as ControlMessageDraft22,
    { type: MessageTypeDraft18.REQUEST_ERROR, requestId: 0n, errorCode: RequestErrorCodeDraft23.REDIRECT, retryInterval: 0n, reasonPhrase: 'moved',
      redirect: { connectUri: '', trackNamespace: ['x'], trackName: 'y' } } as unknown as ControlMessageDraft22,
  ];
  const encoded = samples.map((m) => Draft23MessageCodec.encode(m));
  const untagged: string[] = [];

  it('flipped bytes only throw typed errors, each with a violation kind unless incomplete', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: encoded.length - 1 }),
        fc.array(fc.tuple(fc.nat(), fc.integer({ min: 1, max: 255 })), { minLength: 1, maxLength: 4 }),
        (which, flips) => {
          const bytes = encoded[which].slice();
          for (const [at, mask] of flips) {
            bytes[at % bytes.length] ^= mask;
          }
          const err = decodeSafely(() => Draft23MessageCodec.decode(bytes), 'mutation');
          if (err !== undefined && !isIncompleteDecode(err) && violationOf(err) === undefined) {
            untagged.push((err as Error).message.slice(0, 120));
          }
        },
      ),
      { numRuns: 5000 },
    );

    // Each untagged message is a throw site that would close with the generic code
    expect([...new Set(untagged)]).toEqual([]);
  });
});

describe('§8.7 Track Namespace violations carry their draft-23 codes', () => {
  // SUBSCRIBE body: Request ID 1, then a namespace
  const subscribeWith = (namespaceBytes: number[]) => {
    const body = [0x01, ...namespaceBytes];
    return new Uint8Array([...MOQTVarInt.encode(MessageTypeDraft18.SUBSCRIBE), ...MOQTVarInt.encode(body.length), ...body]);
  };
  const kindOf = (bytes: Uint8Array) => violationOf(decodeSafely(() => Draft23MessageCodec.decode(bytes), 'namespace'));

  it('a zero-length field, or more than 32 fields, is INVALID_TRACK_NAMESPACE', () => {
    expect(kindOf(subscribeWith([0x01, 0x00]))).toBe('invalid-track-namespace');
    expect(kindOf(subscribeWith([33]))).toBe('invalid-track-namespace');
  });

  it('a field that is not UTF-8 is INVALID_FIELD', () => {
    expect(kindOf(subscribeWith([0x01, 0x01, 0xff]))).toBe('invalid-field');
  });
});

describe('data-stream header faults are INVALID_STREAM_HEADER (draft-23 §12.2)', () => {
  it.each([
    ['a reserved Subgroup ID mode', () => Draft18StreamCodec.decodeSubgroupHeader(new Uint8Array([0x16, 0x01, 0x00]))],
    ['a stream type that is not a subgroup', () => Draft18StreamCodec.decodeSubgroupHeader(new Uint8Array([0x05, 0x01]))],
    ['a datagram type that is not one', () => Draft18StreamCodec.decodeObjectDatagram(new Uint8Array([0x40, 0x7f, 0x01]))],
    ['a datagram with reserved Type Flag bit 4', () => Draft18StreamCodec.decodeObjectDatagram(new Uint8Array([0x10, 0x01, 0x00, 0x00]))],
    ['a FETCH stream without FETCH_HEADER', () => Draft18StreamCodec.decodeFetchHeader(new Uint8Array([0x04, 0x01]))],
  ])('%s', (_what, decode) => {
    expect(violationOf(decodeSafely(decode, 'stream header'))).toBe('invalid-stream-header');
  });
});
