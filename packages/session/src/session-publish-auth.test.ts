// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * PublishOptions.authToken goes out in the PUBLISH (draft-22 §9.20.2, draft-18
 * §10.2.2), as a Token structure of vi64s with the value inline.
 */

import { describe, it, expect } from 'vitest';
import {
  AuthTokenAliasType,
  Draft18MessageCodec,
  Draft22MessageCodec,
  MessageTypeDraft18,
  RequestParameterDraft18,
  decodeDraft18AuthToken,
  type PublishMessageDraft18,
  type PublishMessageDraft22,
} from '@moq-web/core';

import { makeSession, type Draft } from './__tests__/incoming-peer.js';

const TOKEN_TYPE = 0x63346d;
const tokenBytes = new Uint8Array([0xaa, 0xbb]);
const expected = { aliasType: AuthTokenAliasType.USE_VALUE, tokenType: TOKEN_TYPE, tokenValue: tokenBytes };

async function sentPublish(draft: Draft, authToken?: { tokenBytes: Uint8Array; tokenType: number }) {
  const { session } = makeSession(draft);
  const sent: Uint8Array[] = [];
  (session as unknown as { sendRequestAndWaitResponse: unknown }).sendRequestAndWaitResponse = async (bytes: Uint8Array) => {
    sent.push(bytes);
    return { type: MessageTypeDraft18.REQUEST_OK, requestId: 0n };
  };

  await session.publish(['ns'], 't', { authToken });

  return (draft === 'draft-18' ? Draft18MessageCodec : Draft22MessageCodec).decode(sent[0])[0];
}

describe('PUBLISH authorization', () => {
  it('draft-18 carries the token in the AUTHORIZATION_TOKEN parameter', async () => {
    const publish = await sentPublish('draft-18', { tokenBytes, tokenType: TOKEN_TYPE }) as PublishMessageDraft18;

    expect(decodeDraft18AuthToken(publish.parameters!.get(RequestParameterDraft18.AUTHORIZATION_TOKEN)!)).toEqual(expected);
  });

  it('draft-22 carries it in authTokens', async () => {
    const publish = await sentPublish('draft-22', { tokenBytes, tokenType: TOKEN_TYPE }) as PublishMessageDraft22;

    expect(publish.authTokens).toHaveLength(1);
    expect(decodeDraft18AuthToken(publish.authTokens![0])).toEqual(expected);
  });

  it.each(['draft-18', 'draft-22'] as const)('%s sends none without PublishOptions.authToken', async (draft) => {
    const publish = await sentPublish(draft) as { parameters?: Map<number, Uint8Array>; authTokens?: Uint8Array[] };

    expect(publish.parameters?.has(RequestParameterDraft18.AUTHORIZATION_TOKEN)).toBeFalsy();
    expect(publish.authTokens).toBeUndefined();
  });
});
