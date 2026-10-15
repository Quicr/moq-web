// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * The peer's control stream (draft-22 §6.3, §9, §9.2): its SETUP, then
 * framed messages. GOAWAY is the only one allowed; anything else, or a message
 * whose body disagrees with its Length, closes the session.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  MOQTransport,
  MessageTypeDraft18,
  SessionErrorCodeDraft18,
  type ControlMessageDraft18,
} from '@moq-web/core';

import { MOQTSession } from './session.js';
import type { GoAwayEvent } from '@moq-web/core';

type Draft = 'draft-18' | 'draft-22';

const GOAWAY_URI = 'https://new.example/moq';
const GOAWAY_TIMEOUT_MS = 5000n;
const UNKNOWN_MESSAGE_TYPE = 0x7e;
/** SETUP (0x2F00) as a vi64 */
const SETUP_TYPE_VARINT = Uint8Array.of(0xaf, 0x00);

interface Internals {
  codec: {
    encodeControlMessage: (m: unknown) => Uint8Array;
    encodeSetupStream: (m: unknown) => Uint8Array;
  };
  handleSetupMessage: (data: Uint8Array) => void;
}

function makeSession(draft: Draft) {
  const transport = new MOQTransport({ draft });
  (transport as unknown as { close: typeof transport.close }).close = vi.fn().mockResolvedValue(undefined);
  const session = new MOQTSession(transport);
  const internals = session as unknown as Internals;
  const close = vi.spyOn(session, 'close').mockResolvedValue(undefined);
  const goaways: GoAwayEvent[] = [];
  session.on('goaway', (e) => goaways.push(e as GoAwayEvent));

  const serverSetup = internals.codec.encodeSetupStream({ type: MessageTypeDraft18.CLIENT_SETUP });
  const goAway = internals.codec.encodeControlMessage({
    type: MessageTypeDraft18.GOAWAY,
    newSessionUri: GOAWAY_URI,
    timeout: GOAWAY_TIMEOUT_MS,
  } as ControlMessageDraft18);

  return { session, internals, close, goaways, serverSetup, goAway };
}

function concat(...chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }

  return out;
}

describe.each(['draft-18', 'draft-22'] as const)('control stream after SETUP (%s)', (draft) => {
  it('delivers a GOAWAY that follows SETUP in a later chunk', () => {
    const { session, internals, serverSetup, goAway, goaways, close } = makeSession(draft);

    internals.handleSetupMessage(serverSetup);
    internals.handleSetupMessage(goAway);

    expect(goaways).toHaveLength(1);
    expect(goaways[0].newSessionUri).toBe(GOAWAY_URI);
    expect(session.pendingMigrationUri).toBe(GOAWAY_URI);
    expect(close).not.toHaveBeenCalled();
  });

  it('delivers a GOAWAY that arrives in the same chunk as SETUP', () => {
    const { internals, serverSetup, goAway, goaways } = makeSession(draft);

    internals.handleSetupMessage(concat(serverSetup, goAway));

    expect(goaways).toHaveLength(1);
  });

  it('delivers a GOAWAY split across chunks', () => {
    const { internals, serverSetup, goAway, goaways } = makeSession(draft);

    internals.handleSetupMessage(serverSetup);
    internals.handleSetupMessage(goAway.subarray(0, 3));
    expect(goaways).toHaveLength(0);
    internals.handleSetupMessage(goAway.subarray(3));

    expect(goaways).toHaveLength(1);
  });

  it('closes with PROTOCOL_VIOLATION on a second SETUP', () => {
    const { internals, serverSetup, close } = makeSession(draft);

    internals.handleSetupMessage(serverSetup);
    internals.handleSetupMessage(concat(SETUP_TYPE_VARINT, serverSetup));

    expect(close).toHaveBeenCalledWith(expect.objectContaining({ code: SessionErrorCodeDraft18.PROTOCOL_VIOLATION }));
  });

  it('closes with PROTOCOL_VIOLATION on a request message', () => {
    const { internals, serverSetup, close } = makeSession(draft);

    internals.handleSetupMessage(serverSetup);
    internals.handleSetupMessage(internals.codec.encodeControlMessage({
      type: MessageTypeDraft18.REQUEST_OK,
      requestId: 1n,
    }));

    expect(close).toHaveBeenCalledWith(expect.objectContaining({ code: SessionErrorCodeDraft18.PROTOCOL_VIOLATION }));
  });

  it('closes with PROTOCOL_VIOLATION on an unknown message type', () => {
    const { internals, serverSetup, close } = makeSession(draft);

    internals.handleSetupMessage(serverSetup);
    internals.handleSetupMessage(Uint8Array.of(UNKNOWN_MESSAGE_TYPE, 0, 0));

    expect(close).toHaveBeenCalledWith(expect.objectContaining({ code: SessionErrorCodeDraft18.PROTOCOL_VIOLATION }));
  });

  it('closes with PROTOCOL_VIOLATION on a GOAWAY body that disagrees with its Length', () => {
    const { internals, serverSetup, close, goaways } = makeSession(draft);

    internals.handleSetupMessage(serverSetup);
    internals.handleSetupMessage(Uint8Array.of(MessageTypeDraft18.GOAWAY, 0, 1, 0));

    expect(goaways).toHaveLength(0);
    expect(close).toHaveBeenCalledWith(expect.objectContaining({ code: SessionErrorCodeDraft18.PROTOCOL_VIOLATION }));
  });
});

describe.each(['draft-18', 'draft-22'] as const)('received GOAWAY (%s)', (draft) => {
  const incoming = (session: unknown) => session as unknown as {
    handleIncomingGoAwayDraft18: (m: unknown, streamRequestId?: bigint) => void;
  };
  const goAway = { type: MessageTypeDraft18.GOAWAY, newSessionUri: GOAWAY_URI, timeout: GOAWAY_TIMEOUT_MS };
  const protocolViolation = expect.objectContaining({ code: SessionErrorCodeDraft18.PROTOCOL_VIOLATION });

  it('closes the session on a second GOAWAY on the control stream', () => {
    const { session, close, goaways } = makeSession(draft);

    incoming(session).handleIncomingGoAwayDraft18(goAway);
    expect(close).not.toHaveBeenCalled();
    incoming(session).handleIncomingGoAwayDraft18(goAway);

    expect(close).toHaveBeenCalledWith(protocolViolation);
    expect(goaways).toHaveLength(1);
  });

  it('closes the session on a second GOAWAY on one request stream, but allows one per stream', () => {
    const { session, close } = makeSession(draft);

    incoming(session).handleIncomingGoAwayDraft18(goAway, 0n);
    incoming(session).handleIncomingGoAwayDraft18(goAway, 2n);
    expect(close).not.toHaveBeenCalled();
    incoming(session).handleIncomingGoAwayDraft18(goAway, 0n);

    expect(close).toHaveBeenCalledWith(protocolViolation);
  });

  it('closes the session with INVALID_REQUEST_ID on a Request ID of the wrong parity (d18 §10.4)', () => {
    const { session, close } = makeSession(draft);

    incoming(session).handleIncomingGoAwayDraft18({ ...goAway, requestId: 3n });

    expect(close).toHaveBeenCalledWith(expect.objectContaining({ code: SessionErrorCodeDraft18.INVALID_REQUEST_ID }));
  });

  it('accepts a New Session URI of 5,000 bytes', async () => {
    const { internals, session, goaways } = makeSession(draft);
    const uri = 'https://relay.example/' + 'a'.repeat(5000);
    internals.handleSetupMessage(internals.codec.encodeSetupStream({ type: MessageTypeDraft18.CLIENT_SETUP }));

    internals.handleSetupMessage(internals.codec.encodeControlMessage({ ...goAway, newSessionUri: uri }));

    expect(goaways[0].newSessionUri).toBe(uri);
    expect(session.pendingMigrationUri).toBe(uri);
  });
});

describe.each(['draft-18', 'draft-22'] as const)('peer control stream end (%s)', (draft) => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('closes the session with PROTOCOL_VIOLATION (d22 §6.3)', async () => {
    const { session, close } = makeSession(draft);
    (session as unknown as { _state: string })._state = 'ready';
    const transport = (session as unknown as { transport: MOQTransport }).transport;
    (session as unknown as { setupTransportHandlers: () => void }).setupTransportHandlers();

    (transport as unknown as { emit: (e: string, d: unknown) => void }).emit('setup-stream-ended', { reset: false });
    await settle();

    expect(close).toHaveBeenCalledWith(expect.objectContaining({ code: SessionErrorCodeDraft18.PROTOCOL_VIOLATION }));
  });

  it('is ignored once the session is over', async () => {
    const { session, close } = makeSession(draft);
    const transport = (session as unknown as { transport: MOQTransport }).transport;
    (session as unknown as { setupTransportHandlers: () => void }).setupTransportHandlers();

    (transport as unknown as { emit: (e: string, d: unknown) => void }).emit('setup-stream-ended', { reset: true });
    await settle();

    expect(close).not.toHaveBeenCalled();
  });
});

describe.each(['draft-18', 'draft-22'] as const)('server SETUP (%s)', (draft) => {
  it.each([
    ['PATH', { path: '/x' }, SessionErrorCodeDraft18.INVALID_PATH],
    ['AUTHORITY', { authority: 'relay.example' }, SessionErrorCodeDraft18.INVALID_AUTHORITY],
  ])('closes the session when it carries %s', (_name, options, code) => {
    const { internals, close, session } = makeSession(draft);
    const delivered = vi.fn();
    (session as unknown as { onSetupMessage: unknown }).onSetupMessage = delivered;

    internals.handleSetupMessage(internals.codec.encodeSetupStream({ type: MessageTypeDraft18.CLIENT_SETUP, ...options }));

    expect(close).toHaveBeenCalledWith(expect.objectContaining({ code }));
    expect(delivered).not.toHaveBeenCalled();
  });
});

describe.each(['draft-18', 'draft-22'] as const)('malformed request stream message (%s)', (draft) => {
  const MALFORMED_SUBSCRIBE_OK = Uint8Array.of(MessageTypeDraft18.SUBSCRIBE_OK, 0, 1, 0);

  function streamOf(bytes: Uint8Array) {
    const readable = new ReadableStream<Uint8Array>({
      start: (c) => {
        c.enqueue(bytes);
      },
    });

    return { readable, writable: new WritableStream<Uint8Array>() };
  }

  it('closes the session when a peer request has a body shorter than its fields', async () => {
    const { internals, close } = makeSession(draft);
    const process = (internals as unknown as {
      processIncomingBidiStream: (s: ReturnType<typeof streamOf>) => Promise<void>;
    }).processIncomingBidiStream.bind(internals);

    await process(streamOf(Uint8Array.of(MessageTypeDraft18.SUBSCRIBE, 0, 1, 0)));

    expect(close).toHaveBeenCalledWith(expect.objectContaining({ code: SessionErrorCodeDraft18.PROTOCOL_VIOLATION }));
  });

  it('closes the session when our request gets a body shorter than its fields', async () => {
    const { session, internals, close } = makeSession(draft);
    (session as unknown as { _state: string })._state = 'ready';
    (session as unknown as { transport: { createRequestStream: unknown } }).transport.createRequestStream =
      vi.fn().mockResolvedValue(streamOf(MALFORMED_SUBSCRIBE_OK));
    const send = (internals as unknown as {
      sendRequestAndWaitResponse: (b: Uint8Array, id: bigint, kind: string) => Promise<unknown>;
    }).sendRequestAndWaitResponse.bind(internals);

    await send(Uint8Array.of(0), 0n, 'subscribe').catch(() => {});

    expect(close).toHaveBeenCalledWith(expect.objectContaining({ code: SessionErrorCodeDraft18.PROTOCOL_VIOLATION }));
  });
});
