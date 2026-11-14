// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * An unknown Message Parameter closes the session.
 *
 * Message Parameters are not greased: every one must be defined in the
 * negotiated version, and an endpoint that receives an unknown one MUST close
 * the session with INVALID_PARAMETER (draft-23 §9.2; PROTOCOL_VIOLATION
 * before draft-23). The test builds a TRACK_STATUS with our codec, adds one
 * parameter of undefined type 0x3C, checks our own decoder rejects only that
 * parameter, and sends it on a request stream of its own. Draft-22 and later.
 */

import {
  MessageTypeDraft18,
  MOQTVarInt,
  SessionErrorCodeDraft22,
  SessionErrorCodeDraft23,
  type ControlMessageDraft18,
} from '@moq-web/core';
import { afterEach, describe, expect, it } from 'vitest';

import { isDraft22, isDraft23, Trace, within } from '../lib/flow.js';
import { record } from '../lib/record.js';
import { makeSession, type SessionHandle } from '../lib/session-factory.js';
import { resolveProfile, makeNamespace, type Profile } from '../lib/profile.js';
import chatStream from '../profiles/chat-stream.json';

/** No draft defines Message Parameter 0x3C */
const UNKNOWN_PARAMETER = 0x3c;

interface Internals {
  codec: {
    encodeControlMessage(message: unknown): Uint8Array;
    decodeControlMessage(bytes: Uint8Array): [ControlMessageDraft18, number];
  };
  getNextRequestId(): number;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }

  return out;
}

/**
 * `message` with one more parameter. The message ends in its parameter list
 * and has none, so its last byte is the count 0. Draft-23 frames the length
 * as a vi64, earlier drafts as 16 bits.
 */
function withUnknownParameter(message: Uint8Array): Uint8Array {
  const [type, typeBytes] = MOQTVarInt.decode(message, 0);
  const [length, lengthBytes] = isDraft23
    ? MOQTVarInt.decode(message, typeBytes)
    : [BigInt((message[typeBytes]! << 8) | message[typeBytes + 1]!), 2];
  const body = message.subarray(typeBytes + lengthBytes);
  if (Number(length) !== body.length || body.at(-1) !== 0) {
    throw new Error('TRACK_STATUS does not end in an empty parameter list');
  }
  const newBody = concat(body.subarray(0, -1), MOQTVarInt.encode(1n), MOQTVarInt.encode(BigInt(UNKNOWN_PARAMETER)), MOQTVarInt.encode(1n));
  const newLength = isDraft23
    ? MOQTVarInt.encode(BigInt(newBody.length))
    : new Uint8Array([newBody.length >> 8, newBody.length & 0xff]);

  return concat(MOQTVarInt.encode(type), newLength, newBody);
}

describe.skipIf(!isDraft22)('Unknown Message Parameter', () => {
  let handles: SessionHandle[] = [];

  afterEach(async () => {
    for (const h of handles) await h.close();
    handles = [];
  });

  it('a TRACK_STATUS carrying parameter 0x3C makes the relay close the session', async ({ task }) => {
    const profile = resolveProfile(chatStream as Profile);
    const namespace = makeNamespace(profile, 'unknown-param');
    const wanted = isDraft23 ? SessionErrorCodeDraft23.INVALID_PARAMETER : SessionErrorCodeDraft22.PROTOCOL_VIOLATION;
    const trace = new Trace();
    trace.expect('session-terminated');
    record(task, {
      flow: [
        'Peer: connects (CLIENT_SETUP / SERVER_SETUP)',
        'Peer: encodes TRACK_STATUS for ns/t with our codec, then appends Message Parameter 0x3C = 1 (undefined in every draft)',
        'Check: our own decoder rejects the message for parameter 0x3C and nothing else',
        'Peer: sends it on a new bidi request stream',
        `Relay: must close the session with ${isDraft23 ? 'INVALID_PARAMETER (0x305, draft-23 §9.2)' : 'PROTOCOL_VIOLATION (0x3)'}`,
        'Check: the session is closed within 5 s with that code',
      ],
      expected: `The relay closes the session within 5 s with ${isDraft23 ? 'INVALID_PARAMETER (0x305)' : 'PROTOCOL_VIOLATION (0x3)'}`,
      inputs: { message: 'TRACK_STATUS', track: `${namespace.join('/')}/t`, unknownParameter: '0x3c = 1' },
    });
    const peer = await makeSession(profile);
    handles.push(peer);
    trace.attach('Peer', peer.session);
    const internals = peer.session as unknown as Internals;

    const plain = internals.codec.encodeControlMessage({
      type: MessageTypeDraft18.TRACK_STATUS,
      requestId: BigInt(internals.getNextRequestId()),
      trackNamespace: namespace,
      trackName: 't',
    });
    const bad = withUnknownParameter(plain);
    // Our own decoder must reject it for the parameter and nothing else
    expect(() => internals.codec.decodeControlMessage(bad)).toThrow(/unknown parameter 0x3c/i);

    const terminated = new Promise<{ code: number; reason: string }>((resolve) => {
      peer.session.on('session-terminated', (evt) => resolve({ code: evt.code, reason: evt.reason }));
    });
    const stream = await peer.transport.createBidirectionalStream();
    const writer = stream.writable.getWriter();
    await writer.write(bad);
    writer.releaseLock();

    let outcome: { code?: number; reason: string };
    try {
      outcome = await within(terminated, 5_000, 'session close');
    } catch (err) {
      outcome = { reason: (err as Error).message };
    }
    trace.print(`code=${outcome.code} reason=${outcome.reason}`);
    record(task, {
      observed: { closeCode: outcome.code === undefined ? 'session still open' : `0x${outcome.code.toString(16)}`, reason: outcome.reason, trace: trace.lines },
    });

    expect(outcome.code, outcome.reason).toBe(wanted);
  });
});
