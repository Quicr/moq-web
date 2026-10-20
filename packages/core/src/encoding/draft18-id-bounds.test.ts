// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Group and Object IDs are vi64 (up to 2^64-1) and are now carried as bigint
 * through the public API. Values above 2^53-1 are accepted (not truncated).
 * Subgroup IDs and accumulated stream objectId deltas still use number
 * (they stay below 2^53-1 in practice) and throw on overflow.
 */

import { describe, it, expect } from 'vitest';
import { ObjectCodec, withDraft } from './message-codec';
import { Draft18StreamCodec } from './draft18-stream-codec';
import { MOQTVarIntError } from './moqt-varint';

const UNSAFE_ID = (1n << 60n) + 1n;
const MAX_SAFE_ID = BigInt(Number.MAX_SAFE_INTEGER);

describe('Draft-18/22 Group/Object IDs beyond 2^53-1', () => {
  it('accepts a subgroup header Group ID above 2^53-1 as bigint', () => {
    const header = Draft18StreamCodec.encodeSubgroupHeader({ trackAlias: 1n, groupId: UNSAFE_ID, subgroupId: 0n });

    const [decoded] = withDraft('draft-18', () => ObjectCodec.decodeSubgroupHeader(header));
    expect(decoded.groupId).toBe(UNSAFE_ID);
  });

  it('accepts a subgroup header Group ID of 2^53-1 as bigint', () => {
    const header = Draft18StreamCodec.encodeSubgroupHeader({ trackAlias: 1n, groupId: MAX_SAFE_ID, subgroupId: 0n });

    const [decoded] = withDraft('draft-18', () => ObjectCodec.decodeSubgroupHeader(header));
    expect(decoded.groupId).toBe(MAX_SAFE_ID);
  });

  it('rejects a subgroup header Subgroup ID that would round (subgroupId is still number)', () => {
    const header = Draft18StreamCodec.encodeSubgroupHeader({ trackAlias: 1n, groupId: 1n, subgroupId: UNSAFE_ID });

    expect(() => withDraft('draft-18', () => ObjectCodec.decodeSubgroupHeader(header))).toThrow(MOQTVarIntError);
  });

  it('accepts a datagram Group ID or Object ID above 2^53-1 as bigint', () => {
    const datagram = Draft18StreamCodec.encodeObjectDatagram({ trackAlias: 1n, groupId: UNSAFE_ID, objectId: UNSAFE_ID, payload: new Uint8Array([1]) });

    const [decoded] = withDraft('draft-18', () => ObjectCodec.decodeDatagramHeader(datagram));
    expect(decoded.groupId).toBe(UNSAFE_ID);
    expect(decoded.objectId).toBe(UNSAFE_ID);
  });

  it('rejects an Object ID delta that would round (accumulated stream objectId is still number)', () => {
    const object = Draft18StreamCodec.encodeObjectHeader({ objectIdDelta: UNSAFE_ID, payloadLength: 0n });

    expect(() => withDraft('draft-18', () => ObjectCodec.decodeStreamObject(object, 0, false, -1))).toThrow(
      MOQTVarIntError,
    );
  });

  it('rejects an accumulated Object ID past 2^53-1 (stream objectId is still number)', () => {
    const object = Draft18StreamCodec.encodeObjectHeader({ objectIdDelta: 5n, payloadLength: 0n });

    expect(() =>
      withDraft('draft-18', () => ObjectCodec.decodeStreamObject(object, 0, false, Number.MAX_SAFE_INTEGER - 2)),
    ).toThrow(MOQTVarIntError);
  });
});
