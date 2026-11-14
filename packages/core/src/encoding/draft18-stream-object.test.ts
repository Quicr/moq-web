// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Subgroup stream objects (draft-18 §11.4.2 / draft-22 §11.3.1).
 *
 * The Object Status field is present whenever Object Payload Length is 0,
 * including a zero-length Normal object.
 */

import { describe, it, expect } from 'vitest';
import { ObjectCodec, withDraft } from './message-codec';
import { ObjectStatus } from '../messages/types';
import { Draft18StreamCodec } from './draft18-stream-codec';
import { MOQTVarInt } from './moqt-varint';

describe.each(['draft-18', 'draft-22'] as const)('stream object Object Status (%s)', (draft) => {
  it('writes Object Status for a zero-length Normal object', () => {
    const encoded = withDraft(draft, () => ObjectCodec.encodeStreamObject(0, new Uint8Array(0)));

    // Object ID Delta 0 | Payload Length 0 | Object Status 0 (Normal)
    expect(Array.from(encoded)).toEqual([0x00, 0x00, 0x00]);
  });

  it('round-trips a zero-length Normal object followed by another object', () => {
    const first = withDraft(draft, () => ObjectCodec.encodeStreamObject(0, new Uint8Array(0)));
    const second = withDraft(draft, () =>
      ObjectCodec.encodeStreamObject(1, new Uint8Array([0xaa]), ObjectStatus.NORMAL, 0),
    );
    const stream = new Uint8Array([...first, ...second]);

    const [id0, payload0, status0, used0] = withDraft(draft, () =>
      ObjectCodec.decodeStreamObject(stream, 0, false, -1),
    );
    const [id1, payload1, status1] = withDraft(draft, () =>
      ObjectCodec.decodeStreamObject(stream, used0, false, id0),
    );

    expect([id0, payload0.length, status0]).toEqual([0, 0, ObjectStatus.NORMAL]);
    expect([id1, Array.from(payload1), status1]).toEqual([1, [0xaa], ObjectStatus.NORMAL]);
  });
});

describe.each(['draft-18', 'draft-22', 'draft-23'] as const)('stream object Properties (%s)', (draft) => {
  it('a subgroup header asked for properties sets PROPERTIES, and each object carries them', () => {
    const [header, hasProperties] = withDraft(draft, () => ObjectCodec.encodeSubgroupHeader(
      { trackAlias: 1n, groupId: 0, subgroupId: 0, publisherPriority: 128, hasProperties: true },
      true,
    ));
    const object = withDraft(draft, () => ObjectCodec.encodeStreamObject(
      3, new Uint8Array([0xaa]), ObjectStatus.NORMAL, -1, hasProperties,
      new Map<number, number | Uint8Array>([[0x40, 300], [0x41, new Uint8Array([1, 2])]]),
    ));
    const [decodedHeader] = Draft18StreamCodec.decodeSubgroupHeader(header, 0);
    const [objectHeader] = Draft18StreamCodec.decodeObjectHeader(object, 0, true);

    expect(hasProperties).toBe(true);
    expect(decodedHeader.hasProperties).toBe(true);
    expect(MOQTVarInt.decode(objectHeader.objectProperties!.get(0x40)!, 0)[0]).toBe(300n);
    expect(Array.from(objectHeader.objectProperties!.get(0x41)!)).toEqual([1, 2]);
  });

  it('a subgroup header not asked for properties leaves PROPERTIES clear', () => {
    const [, hasProperties] = withDraft(draft, () => ObjectCodec.encodeSubgroupHeader(
      { trackAlias: 1n, groupId: 0, subgroupId: 0, publisherPriority: 128 },
      true,
    ));

    expect(hasProperties).toBe(false);
  });
});
