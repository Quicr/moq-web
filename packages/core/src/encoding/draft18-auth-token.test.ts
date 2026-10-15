// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Authorization Token structure for draft-18/22 (§8.9): every integer is a
 * MOQT vi64, not a QUIC varint.
 */

import { describe, it, expect } from 'vitest';
import { Draft18CodecError } from './draft18-message-codec';
import {
  AuthTokenAliasType,
  decodeDraft18AuthToken,
  encodeDraft18AuthToken,
} from './codec-helpers';

const C4M_TYPE = 0x63346d;

describe('Draft-18/22 Authorization Token (§8.9)', () => {
  it('encodes USE_VALUE with vi64 Token Type', () => {
    const encoded = encodeDraft18AuthToken({
      aliasType: AuthTokenAliasType.USE_VALUE,
      tokenType: C4M_TYPE,
      tokenValue: new Uint8Array([1, 2]),
    });

    expect(Array.from(encoded)).toEqual([0x03, 0xe0, 0x63, 0x34, 0x6d, 0x01, 0x02]);
  });

  it('round-trips REGISTER', () => {
    const token = {
      aliasType: AuthTokenAliasType.REGISTER,
      tokenAlias: 300,
      tokenType: C4M_TYPE,
      tokenValue: new Uint8Array([9, 8, 7]),
    };

    expect(decodeDraft18AuthToken(encodeDraft18AuthToken(token))).toEqual(token);
  });

  it('treats alias type 0 as DELETE: alias only', () => {
    const encoded = encodeDraft18AuthToken({ aliasType: AuthTokenAliasType.DELETE, tokenAlias: 5 });

    expect(Array.from(encoded)).toEqual([0x00, 0x05]);
    expect(decodeDraft18AuthToken(encoded)).toEqual({ aliasType: 0, tokenAlias: 5 });
  });

  it('round-trips USE_ALIAS', () => {
    const encoded = encodeDraft18AuthToken({ aliasType: AuthTokenAliasType.USE_ALIAS, tokenAlias: 5 });

    expect(decodeDraft18AuthToken(encoded)).toEqual({ aliasType: 2, tokenAlias: 5 });
  });

  it('rejects an unknown alias type', () => {
    expect(() => decodeDraft18AuthToken(new Uint8Array([0x04]))).toThrow(Draft18CodecError);
  });

  it('rejects trailing bytes after DELETE and USE_ALIAS', () => {
    expect(() => decodeDraft18AuthToken(new Uint8Array([0x00, 0x05, 0x01]))).toThrow(Draft18CodecError);
    expect(() => decodeDraft18AuthToken(new Uint8Array([0x02, 0x05, 0x01]))).toThrow(Draft18CodecError);
  });

  it('rejects a truncated structure', () => {
    expect(() => decodeDraft18AuthToken(new Uint8Array([0x03]))).toThrow(Draft18CodecError);
    expect(() => decodeDraft18AuthToken(new Uint8Array([]))).toThrow(Draft18CodecError);
  });
});
