// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Draft-18 §10.2 Message Parameters: unknown, disallowed or duplicated
 * parameters and out-of-range values close the session (PROTOCOL_VIOLATION).
 */

import { describe, it, expect } from 'vitest';
import { Draft18MessageCodec } from './draft18-message-codec';
import { encodeFramed, encodeString, encodeTrackNamespace } from './codec-helpers';
import { Draft18BufferWriter } from './protocol-codec';
import {
  MessageTypeDraft18,
  RequestParameterDraft18,
  SubscriptionFilterDraft18,
  type RequestUpdateMessageDraft18,
  type SubscribeMessageDraft18,
} from '../messages/types';

const P = RequestParameterDraft18;

/** One parameter: delta from the previous type, then its raw value bytes */
type Param = [delta: number, value: number[]];

function subscribeWire(params: Param[]): Uint8Array {
  return encodeFramed(MessageTypeDraft18.SUBSCRIBE, (w) => {
    w.writeVarInt(1n);
    encodeTrackNamespace(w, ['a']);
    encodeString(w, 't');
    writeParams(w, params);
  });
}

function writeParams(w: Draft18BufferWriter, params: Param[]): void {
  w.writeVarInt(params.length);
  for (const [delta, value] of params) {
    w.writeVarInt(delta);
    w.writeBytes(new Uint8Array(value));
  }
}

describe('draft-18 §10.2 parameter validation (M-08)', () => {
  it('rejects an unknown parameter', () => {
    // 0x0C is not defined
    expect(() => Draft18MessageCodec.decode(subscribeWire([[0x0c, [0x01]]]))).toThrow(
      /Unknown parameter 0xc.*PROTOCOL_VIOLATION/,
    );
  });

  it('rejects a parameter the message may not carry', () => {
    // EXPIRES is for SUBSCRIBE_OK, PUBLISH and REQUEST_OK
    expect(() => Draft18MessageCodec.decode(subscribeWire([[P.EXPIRES, [0x05]]]))).toThrow(
      /EXPIRES not allowed in SUBSCRIBE.*PROTOCOL_VIOLATION/,
    );
  });

  it('rejects a duplicated parameter', () => {
    const wire = subscribeWire([[P.FORWARD, [0x01]], [0, [0x01]]]);

    expect(() => Draft18MessageCodec.decode(wire)).toThrow(/Duplicate parameter FORWARD.*PROTOCOL_VIOLATION/);
  });

  it('allows AUTHORIZATION_TOKEN to repeat', () => {
    const wire = subscribeWire([[P.AUTHORIZATION_TOKEN, [0x03, 0x03, 0x00, 0xaa]], [0, [0x03, 0x03, 0x00, 0xbb]]]);

    expect(() => Draft18MessageCodec.decode(wire)).not.toThrow();
  });

  it('rejects TRACK_NAMESPACE_PREFIX in SUBSCRIBE_TRACKS (REQUEST_UPDATE only, §10.2.14)', () => {
    const wire = encodeFramed(MessageTypeDraft18.SUBSCRIBE_TRACKS, (w) => {
      w.writeVarInt(1n);
      encodeTrackNamespace(w, ['a']);
      w.writeVarInt(1);
      w.writeVarInt(P.TRACK_NAMESPACE_PREFIX);
      encodeTrackNamespace(w, ['a', 'b']);
    });

    expect(() => Draft18MessageCodec.decode(wire)).toThrow(/TRACK_NAMESPACE_PREFIX not allowed in SUBSCRIBE_TRACKS/);
  });

  it('reads TRACK_NAMESPACE_PREFIX in REQUEST_UPDATE as a Track Namespace (§10.2.14)', () => {
    const wire = encodeFramed(MessageTypeDraft18.REQUEST_UPDATE, (w) => {
      w.writeVarInt(3n);
      w.writeVarInt(1);
      w.writeVarInt(P.TRACK_NAMESPACE_PREFIX);
      encodeTrackNamespace(w, ['a', 'b']);
    });

    const [decoded] = Draft18MessageCodec.decode(wire);

    const prefix = (decoded as RequestUpdateMessageDraft18).parameters?.get(P.TRACK_NAMESPACE_PREFIX);
    const expected = new Draft18BufferWriter();
    encodeTrackNamespace(expected, ['a', 'b']);
    expect(prefix).toEqual(expected.toUint8Array());
  });

  it('rejects FORWARD outside 0..1', () => {
    expect(() => Draft18MessageCodec.decode(subscribeWire([[P.FORWARD, [0x02]]]))).toThrow(/FORWARD.*PROTOCOL_VIOLATION/);
  });

  it('rejects GROUP_ORDER outside 1..2', () => {
    for (const value of [0x00, 0x03]) {
      expect(() => Draft18MessageCodec.decode(subscribeWire([[P.GROUP_ORDER, [value]]]))).toThrow(
        /GROUP_ORDER.*PROTOCOL_VIOLATION/,
      );
    }
  });

  it('rejects an unknown filter type', () => {
    const wire = subscribeWire([[P.SUBSCRIPTION_FILTER, [0x01, 0x09]]]);

    expect(() => Draft18MessageCodec.decode(wire)).toThrow(/filter type 9.*PROTOCOL_VIOLATION/);
  });

  it('treats an omitted filter as unfiltered (AbsoluteStart {0, 0})', () => {
    const [decoded] = Draft18MessageCodec.decode(subscribeWire([]));
    const message = decoded as SubscribeMessageDraft18;

    expect(message.filter).toBe(SubscriptionFilterDraft18.ABSOLUTE_START);
    expect(message.startLocation).toEqual({ group: 0n, object: 0n });
  });

  it('rejects an AbsoluteRange whose end Group exceeds 2^64-1', () => {
    // Filter: type 4 | start group 2^64-1 (0xFF + 8 bytes) | start object 0 | end delta 1
    const filter = [0x04, 0xff, ...new Array(8).fill(0xff), 0x00, 0x01];
    const wire = subscribeWire([[P.SUBSCRIPTION_FILTER, [filter.length, ...filter]]]);

    expect(() => Draft18MessageCodec.decode(wire)).toThrow(/end Group.*PROTOCOL_VIOLATION/);
  });

  it('rejects a duplicated parameter in REQUEST_UPDATE', () => {
    const wire = encodeFramed(MessageTypeDraft18.REQUEST_UPDATE, (w) => {
      w.writeVarInt(1n);
      writeParams(w, [[P.FORWARD, [0x01]], [0, [0x00]]]);
    });

    expect(() => Draft18MessageCodec.decode(wire)).toThrow(/Duplicate parameter FORWARD/);
  });

  it('rejects an unexpected parameter in PUBLISH_NAMESPACE', () => {
    const wire = encodeFramed(MessageTypeDraft18.PUBLISH_NAMESPACE, (w) => {
      w.writeVarInt(1n);
      encodeTrackNamespace(w, ['a']);
      writeParams(w, [[P.FORWARD, [0x01]]]);
    });

    expect(() => Draft18MessageCodec.decode(wire)).toThrow(/FORWARD not allowed in PUBLISH_NAMESPACE/);
  });

  it('rejects GROUP_ORDER 0 in FETCH', () => {
    const wire = encodeFramed(MessageTypeDraft18.FETCH, (w) => {
      w.writeVarInt(1n);
      w.writeVarInt(1n); // standalone
      encodeTrackNamespace(w, ['a']);
      encodeString(w, 't');
      for (const value of [0n, 0n, 1n, 0n]) {
        w.writeVarInt(value);
      }
      writeParams(w, [[P.GROUP_ORDER, [0x00]]]);
    });

    expect(() => Draft18MessageCodec.decode(wire)).toThrow(/GROUP_ORDER.*PROTOCOL_VIOLATION/);
  });
});
