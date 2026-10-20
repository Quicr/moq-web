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
  type PublishDoneMessageDraft18,
  type RequestErrorMessageDraft18,
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

const MAX_REASON_PHRASE = 1024;

function requestErrorWire(reason: Uint8Array): Uint8Array {
  return encodeFramed(MessageTypeDraft18.REQUEST_ERROR, (w) => {
    w.writeVarInt(0n); // error code
    w.writeVarInt(0n); // retry interval
    w.writeVarInt(reason.length);
    w.writeBytes(reason);
  });
}

describe('Reason Phrase limit (§8.5, M-07)', () => {
  it('accepts a 1024-byte reason on decode', () => {
    const [decoded] = Draft18MessageCodec.decode(requestErrorWire(bytesOf(MAX_REASON_PHRASE)));

    expect((decoded as RequestErrorMessageDraft18).reasonPhrase).toHaveLength(MAX_REASON_PHRASE);
  });

  it('rejects a 1025-byte reason on decode', () => {
    expect(() => Draft18MessageCodec.decode(requestErrorWire(bytesOf(MAX_REASON_PHRASE + 1)))).toThrow(
      /Reason Phrase length 1025/,
    );
  });

  it('truncates an oversize REQUEST_ERROR reason on encode', () => {
    const message: RequestErrorMessageDraft18 = {
      type: MessageTypeDraft18.REQUEST_ERROR,
      requestId: 0n,
      errorCode: 0,
      retryInterval: 0n,
      reasonPhrase: 'x'.repeat(5000),
    };

    const [decoded] = Draft18MessageCodec.decode(Draft18MessageCodec.encode(message));

    expect((decoded as RequestErrorMessageDraft18).reasonPhrase).toHaveLength(MAX_REASON_PHRASE);
  });

  it('truncates PUBLISH_DONE on a UTF-8 boundary', () => {
    // 3-byte characters: 1024 bytes would end mid-character
    const message: PublishDoneMessageDraft18 = {
      type: MessageTypeDraft18.PUBLISH_DONE,
      requestId: 0n,
      finalLocation: { group: 0n, object: 0n },
      statusCode: 0n,
      streamCount: 0n,
      reasonPhrase: '€'.repeat(400),
    };

    const [decoded] = Draft18MessageCodec.decode(Draft18MessageCodec.encode(message));
    const reason = (decoded as PublishDoneMessageDraft18).reasonPhrase!;

    expect(reason).not.toContain('\uFFFD');
    expect(new TextEncoder().encode(reason).length).toBeLessThanOrEqual(MAX_REASON_PHRASE);
  });
});

describe('GOAWAY (§9.2)', () => {
  const MAX_GOAWAY_URI = 8192;
  const goAway = (uri: string, requestId?: bigint) => Draft18MessageCodec.encode({
    type: MessageTypeDraft18.GOAWAY,
    newSessionUri: uri,
    timeout: 0n,
    requestId,
  });

  it('accepts a New Session URI up to 8,192 bytes', () => {
    const uri = 'https://relay.example/' + 'a'.repeat(5000);

    expect(Draft18MessageCodec.decode(goAway(uri))[0]).toMatchObject({ newSessionUri: uri });
    expect(() => Draft18MessageCodec.decode(goAway('h'.repeat(MAX_GOAWAY_URI)))).not.toThrow();
  });

  it('rejects a longer New Session URI as a violation', () => {
    expect(() => Draft18MessageCodec.decode(goAway('h'.repeat(MAX_GOAWAY_URI + 1)))).toThrow(Draft18CodecError);
  });

  it('keeps the draft-18 control-stream Request ID', () => {
    expect(Draft18MessageCodec.decode(goAway('', 4n))[0]).toMatchObject({ requestId: 4n });
  });

  it('rejects a Request ID in a draft-22 GOAWAY, which dropped the field', () => {
    expect(() => Draft22MessageCodec.decode(goAway('', 4n))).toThrow(Draft18CodecError);
    expect(Draft22MessageCodec.decode(goAway(''))[0]).toMatchObject({ timeout: 0n });
  });
});
