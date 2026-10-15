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
