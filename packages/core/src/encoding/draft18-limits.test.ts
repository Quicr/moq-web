// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Size limits the spec puts on the wire for draft-18/22: control message
 * length (16 bits), Track Namespace / Full Track Name, Reason Phrase.
 */

import { describe, it, expect } from 'vitest';
import { Draft18MessageCodec, Draft18CodecError } from './draft18-message-codec';
import { Draft22MessageCodec } from './draft22-message-codec';
import {
  MessageTypeDraft18,
  MessageTypeDraft22,
  RequestParameterDraft18,
  SubscriptionFilterDraft18,
  type ClientSetupMessageDraft18,
  type SubscribeMessageDraft18,
  type SubscribeMessageDraft22,
} from '../messages/types';

const MAX_CONTROL_MESSAGE_BODY = 0xffff;
const MAX_TOKEN_LENGTH = 16000;

describe('control message length (§9, M-05)', () => {
  const oversize = new Uint8Array(MAX_CONTROL_MESSAGE_BODY + 1).fill(7);

  it('refuses to frame a body longer than 2^16-1', () => {
    const message: SubscribeMessageDraft18 = {
      type: MessageTypeDraft18.SUBSCRIBE,
      requestId: 1n,
      trackNamespace: ['ns'],
      trackName: 't',
      forwardState: true,
      filter: SubscriptionFilterDraft18.NEXT_GROUP_START,
      parameters: new Map([[RequestParameterDraft18.AUTHORIZATION_TOKEN, oversize]]),
    };

    expect(() => Draft18MessageCodec.encode(message)).toThrow(Draft18CodecError);
  });

  it('refuses to frame an oversize draft-22 body', () => {
    const message: SubscribeMessageDraft22 = {
      type: MessageTypeDraft22.SUBSCRIBE,
      requestId: 1n,
      trackNamespace: ['ns'],
      trackName: 't',
      forwardState: true,
      // Each token is within its own bound; together they overflow the message
      authTokens: Array.from({ length: 5 }, () => new Uint8Array(MAX_TOKEN_LENGTH)),
    };

    expect(() => Draft22MessageCodec.encode(message)).toThrow(Draft18CodecError);
  });

  it('refuses an oversize SETUP', () => {
    const message: ClientSetupMessageDraft18 = {
      type: MessageTypeDraft18.CLIENT_SETUP,
      authToken: oversize,
    };

    expect(() => Draft18MessageCodec.encodeSetupStream(message)).toThrow(Draft18CodecError);
  });
});
