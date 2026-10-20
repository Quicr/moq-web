// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Every draft-18 request message that may carry an AUTHORIZATION_TOKEN
 * (§10.2.2) exposes it in `parameters`, so the session can apply the Token
 * rules of §8.9 to all of them.
 */

import { describe, it, expect } from 'vitest';
import { Draft18MessageCodec } from './draft18-message-codec';
import { AuthTokenAliasType, encodeDraft18AuthToken } from './codec-helpers';
import { MessageTypeDraft18, RequestParameterDraft18 } from '../messages/types';

const token = encodeDraft18AuthToken({
  aliasType: AuthTokenAliasType.USE_VALUE,
  tokenType: 7,
  tokenValue: new Uint8Array([1, 2]),
});
const parameters = new Map([[RequestParameterDraft18.AUTHORIZATION_TOKEN, token]]);

describe.each([
  ['TRACK_STATUS', { type: MessageTypeDraft18.TRACK_STATUS, requestId: 1n, trackNamespace: ['ns'], trackName: 't' }],
  ['SUBSCRIBE_NAMESPACE', { type: MessageTypeDraft18.SUBSCRIBE_NAMESPACE, requestId: 1n, trackNamespacePrefix: ['ns'] }],
  ['PUBLISH_NAMESPACE', { type: MessageTypeDraft18.PUBLISH_NAMESPACE, requestId: 1n, trackNamespacePrefix: ['ns'] }],
])('%s', (_name, message) => {
  it('roundtrips an AUTHORIZATION_TOKEN', () => {
    const [decoded] = Draft18MessageCodec.decode(Draft18MessageCodec.encode({ ...message, parameters } as never));

    expect((decoded as { parameters?: Map<number, Uint8Array> }).parameters).toEqual(parameters);
  });

  it('has no parameters without one', () => {
    const [decoded] = Draft18MessageCodec.decode(Draft18MessageCodec.encode(message as never));

    expect((decoded as { parameters?: Map<number, Uint8Array> }).parameters).toBeUndefined();
  });
});
