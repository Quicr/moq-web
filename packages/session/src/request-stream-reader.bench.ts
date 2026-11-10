// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview A large draft-23 control message arriving in small chunks.
 * The reader learns the frame size from the header and copies each byte at
 * most O(1) times, so time grows linearly with message size.
 *
 * Run: `pnpm --filter @moq-web/session exec vitest bench --run src/request-stream-reader.bench.ts`
 */

import { bench, describe } from 'vitest';
import {
  AuthTokenAliasType,
  createProtocolCodec,
  encodeDraft18AuthToken,
  MessageTypeDraft22,
  Version,
} from '@moq-web/core';

import { Draft18RequestStream } from './session-helpers.js';

function message(tokens: number): Uint8Array {
  const codec = createProtocolCodec(Version.DRAFT_23);
  codec.setControlMessageLimits({ maxSendLength: 1 << 22 });
  const token = encodeDraft18AuthToken({
    aliasType: AuthTokenAliasType.USE_VALUE,
    tokenType: 1,
    tokenValue: new Uint8Array(16000),
  });
  return codec.encodeControlMessage({
    type: MessageTypeDraft22.SUBSCRIBE,
    requestId: 2n,
    trackNamespace: ['live'],
    trackName: 'v',
    forwardState: true,
    authTokens: Array.from({ length: tokens }, () => token),
  });
}

async function read(bytes: Uint8Array, chunkSize: number): Promise<void> {
  const codec = createProtocolCodec(Version.DRAFT_23);
  codec.setControlMessageLimits({ maxReceiveLength: 1 << 22 });
  let offset = 0;
  const readable = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.subarray(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
  await new Draft18RequestStream(codec, readable, () => {}, () => {}, () => {}).readMessage();
}

const small = message(4);
const large = message(64);

describe('request stream: large control message in 1 KiB chunks', () => {
  bench(`${Math.round(small.length / 1024)} KiB`, async () => {
    await read(small, 1024);
  });
  bench(`${Math.round(large.length / 1024)} KiB`, async () => {
    await read(large, 1024);
  });
});
