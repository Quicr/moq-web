// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Draft18RequestStream.readMessage: framing across chunk boundaries, the
 * receive limit (draft-23 §9, §9.1.8), and buffer reuse safety.
 */

import { describe, expect, it } from 'vitest';
import {
  createProtocolCodec,
  encodeDraft18AuthToken,
  AuthTokenAliasType,
  MessageTypeDraft22,
  MOQTVarInt,
  Version,
  violationOf,
  type IProtocolCodec,
  type SubscribeMessageDraft22,
} from '@moq-web/core';

import { Draft18RequestStream, RequestStreamEnded } from './session-helpers.js';

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(chunks[i++]);
      } else {
        controller.close();
      }
    },
  });
}

function readerFor(codec: IProtocolCodec, chunks: Uint8Array[]): Draft18RequestStream {
  return new Draft18RequestStream(codec, streamOf(chunks), () => {}, () => {}, () => {});
}

function split(bytes: Uint8Array, size: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) {
    out.push(bytes.slice(i, i + size));
  }
  return out;
}

const subscribe = (requestId: bigint, trackName = 'video', authTokens?: Uint8Array[]): SubscribeMessageDraft22 => ({
  type: MessageTypeDraft22.SUBSCRIBE,
  requestId,
  trackNamespace: ['live'],
  trackName,
  forwardState: true,
  authTokens,
});

describe.each([
  ['draft-22', Version.DRAFT_22],
  ['draft-23', Version.DRAFT_23],
] as const)('Draft18RequestStream.readMessage (%s)', (_draft, version) => {
  it('reads messages split at every byte', async () => {
    const codec = createProtocolCodec(version);
    const bytes = codec.encodeControlMessage(subscribe(2n));
    const stream = readerFor(codec, split(bytes, 1));

    const message = (await stream.readMessage()) as unknown as SubscribeMessageDraft22;
    expect(message.requestId).toBe(2n);
    await expect(stream.readMessage()).rejects.toBeInstanceOf(RequestStreamEnded);
  });

  it('reads several messages coalesced into one chunk, then one split across chunks', async () => {
    const codec = createProtocolCodec(version);
    const a = codec.encodeControlMessage(subscribe(2n));
    const b = codec.encodeControlMessage(subscribe(4n));
    const c = codec.encodeControlMessage(subscribe(6n));
    const joined = new Uint8Array([...a, ...b, ...c.subarray(0, 3)]);
    const stream = readerFor(codec, [joined, c.subarray(3)]);

    const ids: bigint[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(((await stream.readMessage()) as unknown as SubscribeMessageDraft22).requestId);
    }
    expect(ids).toEqual([2n, 4n, 6n]);
  });

  it('never overwrites bytes a returned message may still view', async () => {
    const codec = createProtocolCodec(version);
    const token = encodeDraft18AuthToken({
      aliasType: AuthTokenAliasType.USE_VALUE,
      tokenType: 1,
      tokenValue: new Uint8Array([1, 2, 3, 4]),
    });
    const first = codec.encodeControlMessage(subscribe(2n, 'a', [token]));
    const second = codec.encodeControlMessage(subscribe(4n, 'b', [new Uint8Array(token).fill(9, 3)]));
    // The first message ends mid-chunk so the second is appended after it
    const stream = readerFor(codec, [new Uint8Array([...first, ...second.subarray(0, 2)]), ...split(second.subarray(2), 3)]);

    const one = (await stream.readMessage()) as unknown as SubscribeMessageDraft22;
    const before = Array.from(one.authTokens![0]);
    await stream.readMessage();
    expect(Array.from(one.authTokens![0])).toEqual(before);
  });

  it('surfaces a malformed body as a violation, not as an incomplete read', async () => {
    const codec = createProtocolCodec(version);
    const bytes = codec.encodeControlMessage(subscribe(2n));
    // Truncate the parameter block inside a complete frame: shrink the length to cut the last byte
    const lengthField = version === Version.DRAFT_23 ? 1 : 2;
    const header = bytes.subarray(0, 1 + lengthField);
    const body = bytes.subarray(1 + lengthField, bytes.length - 1);
    const frame = version === Version.DRAFT_23
      ? new Uint8Array([header[0], body.length, ...body])
      : new Uint8Array([header[0], 0, body.length, ...body]);

    await expect(readerFor(codec, [frame]).readMessage()).rejects.toSatisfy((err: unknown) => violationOf(err) !== undefined);
  });
});

describe('Draft18RequestStream receive limit (draft-23 §9.1.8)', () => {
  it('refuses an oversize length before reading the body', async () => {
    const codec = createProtocolCodec(Version.DRAFT_23);
    // Header claims 1 MiB; no body follows. The reader must fail without waiting for it.
    const header = new Uint8Array([0x03, ...MOQTVarInt.encode(1 << 20)]);
    const stream = readerFor(codec, [header]);

    await expect(stream.readMessage()).rejects.toSatisfy((err: unknown) => violationOf(err) === 'field-length');
  });

  it('reads a 64+ KiB message in small chunks once the limit is raised', async () => {
    const codec = createProtocolCodec(Version.DRAFT_23);
    codec.setControlMessageLimits({ maxSendLength: 1 << 20, maxReceiveLength: 1 << 20 });
    const token = encodeDraft18AuthToken({
      aliasType: AuthTokenAliasType.USE_VALUE,
      tokenType: 1,
      tokenValue: new Uint8Array(16000).fill(5),
    });
    const bytes = codec.encodeControlMessage(subscribe(2n, 'v', Array.from({ length: 5 }, () => token)));
    expect(bytes.length).toBeGreaterThan(0xffff);

    const message = (await readerFor(codec, split(bytes, 1024)).readMessage()) as unknown as SubscribeMessageDraft22;
    expect(message.authTokens).toHaveLength(5);
  });
});
