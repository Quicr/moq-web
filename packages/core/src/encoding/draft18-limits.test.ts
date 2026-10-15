// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Size limits the spec puts on the wire for draft-18/22: control message
 * length (16 bits), Track Namespace / Full Track Name, Reason Phrase.
 */

import { describe, it, expect } from 'vitest';
import { Draft18MessageCodec, Draft18CodecError } from './draft18-message-codec';
import { Draft22MessageCodec } from './draft22-message-codec';
import { encodeFramed } from './codec-helpers';
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

const MAX_FULL_TRACK_NAME = 4096;

function subscribeWire(fields: Uint8Array[], name: Uint8Array): Uint8Array {
  return encodeFramed(MessageTypeDraft18.SUBSCRIBE, (w) => {
    w.writeVarInt(1n); // request id
    w.writeVarInt(fields.length);
    for (const field of fields) {
      w.writeVarInt(field.length);
      w.writeBytes(field);
    }
    w.writeVarInt(name.length);
    w.writeBytes(name);
  });
}

function bytesOf(length: number): Uint8Array {
  return new Uint8Array(length).fill(0x61);
}

describe('Track Namespace / Full Track Name limits (§8.7, M-06)', () => {
  it('rejects a zero-length Track Namespace Field on decode', () => {
    const wire = subscribeWire([bytesOf(1), new Uint8Array(0)], bytesOf(1));

    expect(() => Draft18MessageCodec.decode(wire)).toThrow(/Namespace Field length 0/);
  });

  it('rejects a Track Namespace over 4096 bytes on decode', () => {
    const wire = subscribeWire([bytesOf(2000), bytesOf(2000), bytesOf(97)], bytesOf(1));

    expect(() => Draft18MessageCodec.decode(wire)).toThrow(/Namespace length 4097/);
  });

  it('rejects a Full Track Name over 4096 bytes on decode', () => {
    const wire = subscribeWire([bytesOf(4000)], bytesOf(97));

    expect(() => Draft18MessageCodec.decode(wire)).toThrow(/Full Track Name length 4097/);
  });

  it('rejects a Full Track Name over 4096 bytes on draft-22 decode', () => {
    const wire = subscribeWire([bytesOf(4000)], bytesOf(97));
    wire[0] = MessageTypeDraft22.SUBSCRIBE;

    expect(() => Draft22MessageCodec.decode(wire)).toThrow(/Full Track Name length 4097/);
  });

  it('accepts a Full Track Name of exactly 4096 bytes', () => {
    const message: SubscribeMessageDraft18 = {
      type: MessageTypeDraft18.SUBSCRIBE,
      requestId: 1n,
      trackNamespace: ['a'.repeat(4000)],
      trackName: 'b'.repeat(MAX_FULL_TRACK_NAME - 4000),
      forwardState: true,
      filter: SubscriptionFilterDraft18.NEXT_GROUP_START,
    };

    const [decoded] = Draft18MessageCodec.decode(Draft18MessageCodec.encode(message));

    expect((decoded as SubscribeMessageDraft18).trackName).toBe(message.trackName);
  });

  it('refuses to encode a Full Track Name over 4096 bytes', () => {
    const message: SubscribeMessageDraft18 = {
      type: MessageTypeDraft18.SUBSCRIBE,
      requestId: 1n,
      trackNamespace: ['a'.repeat(4000)],
      trackName: 'b'.repeat(97),
      forwardState: true,
      filter: SubscriptionFilterDraft18.NEXT_GROUP_START,
    };

    expect(() => Draft18MessageCodec.encode(message)).toThrow(Draft18CodecError);
  });

  it('refuses to encode an empty Track Namespace Field', () => {
    const message: SubscribeMessageDraft18 = {
      type: MessageTypeDraft18.SUBSCRIBE,
      requestId: 1n,
      trackNamespace: ['a', ''],
      trackName: 't',
      forwardState: true,
      filter: SubscriptionFilterDraft18.NEXT_GROUP_START,
    };

    expect(() => Draft18MessageCodec.encode(message)).toThrow(Draft18CodecError);
  });
});
