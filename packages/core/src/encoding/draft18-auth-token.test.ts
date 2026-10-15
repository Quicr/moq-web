// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Authorization Token structure for draft-18/22 (§8.9): every integer is a
 * MOQT vi64, not a QUIC varint.
 */

import { describe, it, expect } from 'vitest';
import { Draft18CodecError, Draft18MessageCodec } from './draft18-message-codec';
import { Draft22MessageCodec } from './draft22-message-codec';
import {
  MessageTypeDraft18,
  MessageTypeDraft22,
  RequestParameterDraft18,
  SubscriptionFilterDraft18,
  type SubscribeMessageDraft18,
  type SubscribeMessageDraft22,
} from '../messages/types';
import {
  AUTH_TOKEN_FORMAT_ERROR,
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

  describe('receiver duties (§8.9)', () => {
    const malformed = new Uint8Array([0x09]); // alias type 9 is undefined

    it('flags an undecodable Token as a KEY_VALUE_FORMATTING_ERROR', () => {
      try {
        decodeDraft18AuthToken(malformed);
        expect.unreachable();
      } catch (error) {
        expect((error as Draft18CodecError).code).toBe(AUTH_TOKEN_FORMAT_ERROR);
      }
    });

    it('rejects an undecodable Token in a draft-18 request parameter', () => {
      const message: SubscribeMessageDraft18 = {
        type: MessageTypeDraft18.SUBSCRIBE,
        requestId: 1n,
        trackNamespace: ['a'],
        trackName: 't',
        forwardState: true,
        filter: SubscriptionFilterDraft18.NEXT_GROUP_START,
        parameters: new Map([[RequestParameterDraft18.AUTHORIZATION_TOKEN, malformed]]),
      };

      expect(() => Draft18MessageCodec.decode(Draft18MessageCodec.encode(message))).toThrow(
        expect.objectContaining({ code: AUTH_TOKEN_FORMAT_ERROR }),
      );
    });

    it('rejects an undecodable Token in a draft-22 request', () => {
      const message: SubscribeMessageDraft22 = {
        type: MessageTypeDraft22.SUBSCRIBE,
        requestId: 1n,
        trackNamespace: ['a'],
        trackName: 't',
        forwardState: true,
        authTokens: [malformed],
      };

      expect(() => Draft22MessageCodec.decode(Draft22MessageCodec.encode(message))).toThrow(
        expect.objectContaining({ code: AUTH_TOKEN_FORMAT_ERROR }),
      );
    });
  });
});
