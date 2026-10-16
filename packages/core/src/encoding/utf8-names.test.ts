// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Track Namespace fields and Track Names are bytes on the wire (draft-22
 * §2.4.1), but this client carries them as strings, so they must be UTF-8.
 * Bytes that are not are refused as a malformed message instead of being
 * mangled into U+FFFD, which would make two different names equal and one
 * name unaddressable.
 */

import { describe, it, expect } from 'vitest';
import { Draft18CodecError, Draft18MessageCodec } from './draft18-message-codec';
import { Draft22MessageCodec } from './draft22-message-codec';
import { MessageTypeDraft18, SubscriptionFilterDraft18 } from '../messages/types';

const NOT_UTF8 = [0xff, 0xfe];

const codecs = [
  ['draft-18', Draft18MessageCodec],
  ['draft-22', Draft22MessageCodec],
] as const;

/** Encode `message`, then overwrite the two bytes of `marker` with `bytes`. */
function withBytes(encoded: Uint8Array, marker: string, bytes: number[]): Uint8Array {
  const patched = new Uint8Array(encoded);
  const at = patched.findIndex((_, i) => marker.split('').every((c, j) => patched[i + j] === c.charCodeAt(0)));
  expect(at).toBeGreaterThanOrEqual(0);
  bytes.forEach((byte, i) => {
    patched[at + i] = byte;
  });

  return patched;
}

describe.each(codecs)('names off the wire (%s)', (_draft, codec) => {
  const subscribe = (trackNamespace: string[], trackName: string) => ({
    type: MessageTypeDraft18.SUBSCRIBE,
    requestId: 1n,
    trackNamespace,
    trackName,
    forwardState: true,
    filter: SubscriptionFilterDraft18.NEXT_GROUP_START,
  });

  it('decodes multi-byte UTF-8 names', () => {
    const [decoded] = codec.decode(codec.encode(subscribe(['会议', 'room'], 'видео') as never));

    expect(decoded).toMatchObject({ trackNamespace: ['会议', 'room'], trackName: 'видео' });
  });

  it('refuses a Track Name that is not UTF-8', () => {
    const wire = withBytes(codec.encode(subscribe(['ns'], 'zz') as never), 'zz', NOT_UTF8);

    expect(() => codec.decode(wire)).toThrow(Draft18CodecError);
    expect(() => codec.decode(wire)).toThrow(/PROTOCOL_VIOLATION/);
  });

  it('refuses a Track Namespace field that is not UTF-8', () => {
    const wire = withBytes(codec.encode(subscribe(['zz'], 't') as never), 'zz', NOT_UTF8);

    expect(() => codec.decode(wire)).toThrow(Draft18CodecError);
  });

  it('refuses a namespace prefix that is not UTF-8', () => {
    const message = { type: MessageTypeDraft18.SUBSCRIBE_NAMESPACE, requestId: 1n, trackNamespacePrefix: ['zz'] };
    const wire = withBytes(codec.encode(message as never), 'zz', NOT_UTF8);

    expect(() => codec.decode(wire)).toThrow(Draft18CodecError);
  });
});
