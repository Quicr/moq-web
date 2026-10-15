// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Grease codepoints (0x7f * N + 0x9D, up to 2^62-ish) and KVP values up to
 * 2^16-1 bytes must be skipped, never rejected (§8.3, §13).
 */

import { describe, it, expect } from 'vitest';
import { Draft18MessageCodec } from './draft18-message-codec';
import { Draft18StreamCodec } from './draft18-stream-codec';
import { decodeKeyValuePairsToEnd } from './codec-helpers';
import { Draft18BufferReader } from './protocol-codec';
import { MOQTVarInt } from './moqt-varint';
import {
  MessageTypeDraft18,
  SetupOptionDraft18,
  type RequestErrorMessageDraft18,
} from '../messages/types';

const GREASE_ODD_KEY = 0x3f8000000000009dn;
const GREASE_EVEN_KEY = 0x3f8000000000009en;
const SPEC_MAX_VALUE = 0xffff;
const LONG_VALUE = 5000;
const UNKNOWN_ODD_KEY = 0x9d;
const UNKNOWN_EVEN_KEY = 0x9c;

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const vi = (value: number | bigint): Uint8Array => MOQTVarInt.encode(value);

/** A KVP with an odd key: delta | length | bytes */
function oddKvp(delta: bigint, value: Uint8Array): Uint8Array {
  return concat(vi(delta), vi(value.length), value);
}

describe('grease and long KVP values', () => {
  describe('SETUP options', () => {
    function setupBytes(options: Uint8Array): Uint8Array {
      return concat(new Uint8Array([options.length >> 8, options.length & 0xff]), options);
    }

    it('skips a grease option above 2^53', () => {
      const bytes = setupBytes(oddKvp(GREASE_ODD_KEY, new Uint8Array([1, 2, 3])));

      const [message] = Draft18MessageCodec.decodeSetupStream(bytes);

      expect(message.extensions).toBeUndefined();
    });

    it('skips an even grease option above 2^53', () => {
      const bytes = setupBytes(concat(vi(GREASE_EVEN_KEY), vi(7)));

      const [message] = Draft18MessageCodec.decodeSetupStream(bytes);

      expect(message.extensions).toBeUndefined();
    });

    it('keeps decoding options after a grease option', () => {
      const bytes = setupBytes(concat(
        oddKvp(GREASE_ODD_KEY, new Uint8Array([1])),
        // Keys only ascend, so this one is a grease key too.
        oddKvp(2n, new Uint8Array([9])),
      ));

      const [message, read] = Draft18MessageCodec.decodeSetupStream(bytes);

      expect(read).toBe(bytes.length);
      expect(message.extensions).toBeUndefined();
    });

    it('accepts an unknown odd option with a value over 4096 bytes', () => {
      const value = new Uint8Array(LONG_VALUE).fill(7);
      const bytes = setupBytes(oddKvp(BigInt(UNKNOWN_ODD_KEY), value));

      const [message] = Draft18MessageCodec.decodeSetupStream(bytes);

      expect(message.extensions?.get(UNKNOWN_ODD_KEY)).toEqual({ bytes: value });
    });

    it('accepts a MOQT_IMPLEMENTATION option over 4096 bytes', () => {
      const text = 'x'.repeat(LONG_VALUE);
      const value = new TextEncoder().encode(text);
      const bytes = setupBytes(oddKvp(BigInt(SetupOptionDraft18.MOQT_IMPLEMENTATION), value));

      const [message] = Draft18MessageCodec.decodeSetupStream(bytes);

      expect(message.moqtImplementation).toBe(text);
    });

    it('saturates an integer option above 2^53', () => {
      const bytes = setupBytes(concat(vi(SetupOptionDraft18.MAX_AUTH_TOKEN_CACHE_SIZE), vi(1n << 60n)));

      const [message] = Draft18MessageCodec.decodeSetupStream(bytes);

      expect(message.maxAuthTokenCacheSize).toBe(Number.MAX_SAFE_INTEGER);
    });
  });

  describe('REQUEST_ERROR code', () => {
    it('maps a grease code above 2^53 to INTERNAL_ERROR', () => {
      const message = {
        type: MessageTypeDraft18.REQUEST_ERROR,
        requestId: 0n,
        errorCode: GREASE_ODD_KEY as unknown as RequestErrorMessageDraft18['errorCode'],
        retryInterval: 500n,
        reasonPhrase: 'grease',
      } as RequestErrorMessageDraft18;

      const [decoded] = Draft18MessageCodec.decode(Draft18MessageCodec.encode(message));
      const d = decoded as RequestErrorMessageDraft18;

      expect(d.errorCode).toBe(0 /* INTERNAL_ERROR */);
      expect(d.retryInterval).toBe(500n);
    });
  });

  describe('Track Properties', () => {
    it('skips grease properties and keeps known ones', () => {
      const bytes = concat(
        vi(2n), vi(5n), // key 2 (even): varint 5
        oddKvp(GREASE_ODD_KEY - 2n, new Uint8Array([1, 2, 3])),
      );

      const pairs = decodeKeyValuePairsToEnd(new Draft18BufferReader(bytes));

      expect(Array.from(pairs.keys())).toEqual([2]);
    });

    it('accepts a property value of 2^16-1 bytes', () => {
      const value = new Uint8Array(SPEC_MAX_VALUE).fill(3);
      const bytes = oddKvp(BigInt(UNKNOWN_ODD_KEY), value);

      const pairs = decodeKeyValuePairsToEnd(new Draft18BufferReader(bytes));

      expect(pairs.get(UNKNOWN_ODD_KEY)).toEqual(value);
    });

    it('rejects a property value above 2^16-1 bytes', () => {
      const bytes = concat(vi(BigInt(UNKNOWN_ODD_KEY)), vi(SPEC_MAX_VALUE + 1));

      expect(() => decodeKeyValuePairsToEnd(new Draft18BufferReader(bytes))).toThrow();
    });
  });

  describe('Object Properties', () => {
    function header(props: Uint8Array): Uint8Array {
      // Object ID Delta 0 | Properties Length | Properties | Payload Length 0
      return concat(vi(0), vi(props.length), props, vi(0));
    }

    it('skips a grease property above 2^53', () => {
      const bytes = header(concat(
        vi(UNKNOWN_EVEN_KEY), vi(1n),
        oddKvp(GREASE_ODD_KEY - BigInt(UNKNOWN_EVEN_KEY), new Uint8Array([1])),
      ));

      const [decoded, read] = Draft18StreamCodec.decodeObjectHeader(bytes, 0, true);

      expect(read).toBe(bytes.length);
      expect(Array.from(decoded.objectProperties!.keys())).toEqual([UNKNOWN_EVEN_KEY]);
    });

    it('rejects a property that overruns Properties Length (§8.3)', () => {
      // Properties Length 3, but the odd-key property claims 5 value bytes
      const bytes = concat(vi(0), vi(3), vi(1), vi(5), new Uint8Array(5).fill(9), vi(0));

      expect(() => Draft18StreamCodec.decodeObjectHeader(bytes, 0, true)).toThrow(/overruns/);
    });

    it('accepts a property value over 4096 bytes', () => {
      const value = new Uint8Array(LONG_VALUE).fill(5);
      const bytes = header(oddKvp(BigInt(UNKNOWN_ODD_KEY), value));

      const [decoded] = Draft18StreamCodec.decodeObjectHeader(bytes, 0, true);

      expect(decoded.objectProperties!.get(UNKNOWN_ODD_KEY)).toEqual(value);
    });
  });
});
