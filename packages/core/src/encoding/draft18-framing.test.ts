// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Draft-18/22 §9 framing: only a message cut short by the end of the buffer is
 * "incomplete". A body that disagrees with its Length is a PROTOCOL_VIOLATION
 * the receiver must be able to tell apart (Review C-01).
 */

import { describe, it, expect } from 'vitest';
import { Draft18MessageCodec, Draft18CodecError, isIncompleteDecode } from './draft18-message-codec';
import { Draft22MessageCodec } from './draft22-message-codec';
import { MessageTypeDraft18 } from '../messages/types';

const SUBSCRIBE_OK = MessageTypeDraft18.SUBSCRIBE_OK;
const RESERVED_TYPE = 0x1e;

function frame(type: number, body: number[]): Uint8Array {
  return Uint8Array.from([type, 0, body.length, ...body]);
}

function catchError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected a throw');
}

describe.each([
  ['draft-18', (b: Uint8Array) => Draft18MessageCodec.decode(b)],
  ['draft-22', (b: Uint8Array) => Draft22MessageCodec.decode(b)],
])('control message framing (%s)', (_name, decode) => {
  it('reports a missing header as incomplete', () => {
    expect(isIncompleteDecode(catchError(() => decode(Uint8Array.of(SUBSCRIBE_OK))))).toBe(true);
    expect(isIncompleteDecode(catchError(() => decode(new Uint8Array(0))))).toBe(true);
  });

  it('reports a missing body as incomplete', () => {
    const partial = Uint8Array.of(SUBSCRIBE_OK, 0, 4, 1);
    expect(isIncompleteDecode(catchError(() => decode(partial)))).toBe(true);
  });

  it('treats a body shorter than its fields as a violation', () => {
    const err = catchError(() => decode(frame(SUBSCRIBE_OK, [1])));
    expect(err).toBeInstanceOf(Draft18CodecError);
    expect(isIncompleteDecode(err)).toBe(false);
  });

  it('treats trailing body bytes as a violation', () => {
    const err = catchError(() => decode(frame(MessageTypeDraft18.REQUEST_OK, [0, 0, 9, 9])));
    expect(err).toBeInstanceOf(Draft18CodecError);
    expect(isIncompleteDecode(err)).toBe(false);
  });

  it('treats an unknown message type as a violation', () => {
    const err = catchError(() => decode(frame(RESERVED_TYPE, [])));
    expect(err).toBeInstanceOf(Draft18CodecError);
    expect(isIncompleteDecode(err)).toBe(false);
  });
});

describe('SETUP framing', () => {
  it('reports a short body as a violation, a missing body as incomplete', () => {
    const missing = catchError(() => Draft18MessageCodec.decodeSetupStream(Uint8Array.of(0, 5, 1)));
    expect(isIncompleteDecode(missing)).toBe(true);

    // Option key delta 2 (varint value) with its value cut off by the Length.
    const short = catchError(() => Draft18MessageCodec.decodeSetupStream(Uint8Array.of(0, 1, 2)));
    expect(short).toBeInstanceOf(Draft18CodecError);
    expect(isIncompleteDecode(short)).toBe(false);
  });
});
