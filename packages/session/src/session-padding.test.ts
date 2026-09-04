// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Draft-18 §11.5 padding coverage.
 *
 *   • §11.5.1 Padding Stream: `sendPaddingStream(n)` opens a unidirectional
 *     stream whose first varint is the PADDING type (0x132B3E28) followed
 *     by `n` zero bytes, then closes the stream.
 *   • §11.5.2 Padding Datagram: `sendPaddingDatagram(n)` writes a datagram
 *     whose first varint is the PADDING type (0x132B3E29) followed by `n`
 *     zero bytes.
 *   • Receiver-side padding datagrams are silently dropped by the datagram
 *     manager — no `object` event fires.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  DatagramManager,
  IS_DRAFT_18,
  MOQTransport,
  MOQTVarInt,
  StreamTypeDraft18,
  DatagramTypeDraft18,
} from '@moq-web/core';

import { MOQTSession } from './session.js';

type StreamInfoLike = {
  writer?: WritableStreamDefaultWriter<Uint8Array>;
  streamId?: number;
};

interface PrivateSession {
  doCreateStream: () => Promise<StreamInfoLike>;
  doWriteStream: (info: StreamInfoLike, data: Uint8Array, close?: boolean) => Promise<void>;
  doSendDatagram: (data: Uint8Array) => Promise<void>;
}

function makeSession(): MOQTSession {
  const transport = new MOQTransport();
  (transport as unknown as { close: typeof transport.close }).close = vi.fn().mockResolvedValue(undefined);
  return new MOQTSession(transport);
}

describe.skipIf(!IS_DRAFT_18)('draft-18 §11.5.1 padding stream (publisher)', () => {
  it('writes the PADDING stream-type varint followed by N zero bytes, then closes', async () => {
    const session = makeSession();
    const priv = session as unknown as PrivateSession;

    const streamInfo: StreamInfoLike = { streamId: 1 };
    priv.doCreateStream = vi.fn().mockResolvedValue(streamInfo);
    const writeSpy = vi.fn().mockResolvedValue(undefined);
    priv.doWriteStream = writeSpy;

    await session.sendPaddingStream(16);

    expect(priv.doCreateStream).toHaveBeenCalledTimes(1);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const [, payload, close] = writeSpy.mock.calls[0] as [StreamInfoLike, Uint8Array, boolean];
    expect(close).toBe(true);

    // First bytes are the varint of 0x132B3E28
    const expectedType = MOQTVarInt.encode(BigInt(StreamTypeDraft18.PADDING));
    expect(payload.subarray(0, expectedType.length)).toEqual(expectedType);
    // Rest are 16 zero bytes.
    expect(payload.length).toBe(expectedType.length + 16);
    for (let i = expectedType.length; i < payload.length; i++) {
      expect(payload[i]).toBe(0);
    }
  });

  it('accepts 0 bytes (just the type prefix, still closes the stream)', async () => {
    const session = makeSession();
    const priv = session as unknown as PrivateSession;
    priv.doCreateStream = vi.fn().mockResolvedValue({ streamId: 2 });
    const writeSpy = vi.fn().mockResolvedValue(undefined);
    priv.doWriteStream = writeSpy;

    await session.sendPaddingStream(0);

    const [, payload, close] = writeSpy.mock.calls[0] as [StreamInfoLike, Uint8Array, boolean];
    expect(close).toBe(true);
    const expectedType = MOQTVarInt.encode(BigInt(StreamTypeDraft18.PADDING));
    expect(payload).toEqual(expectedType);
  });

  it('rejects negative or non-integer byte counts', async () => {
    const session = makeSession();
    await expect(session.sendPaddingStream(-1)).rejects.toBeInstanceOf(RangeError);
    await expect(session.sendPaddingStream(3.5)).rejects.toBeInstanceOf(RangeError);
  });
});

describe.skipIf(!IS_DRAFT_18)('draft-18 §11.5.2 padding datagram (publisher)', () => {
  it('sends a datagram with the PADDING type varint followed by N zero bytes', async () => {
    const session = makeSession();
    const priv = session as unknown as PrivateSession;
    const sendSpy = vi.fn().mockResolvedValue(undefined);
    priv.doSendDatagram = sendSpy;

    await session.sendPaddingDatagram(32);

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const [payload] = sendSpy.mock.calls[0] as [Uint8Array];

    const expectedType = MOQTVarInt.encode(BigInt(DatagramTypeDraft18.PADDING));
    expect(payload.subarray(0, expectedType.length)).toEqual(expectedType);
    expect(payload.length).toBe(expectedType.length + 32);
    for (let i = expectedType.length; i < payload.length; i++) {
      expect(payload[i]).toBe(0);
    }
  });

  it('sends only the type varint when bytes=0', async () => {
    const session = makeSession();
    const priv = session as unknown as PrivateSession;
    const sendSpy = vi.fn().mockResolvedValue(undefined);
    priv.doSendDatagram = sendSpy;

    await session.sendPaddingDatagram(0);

    const [payload] = sendSpy.mock.calls[0] as [Uint8Array];
    const expectedType = MOQTVarInt.encode(BigInt(DatagramTypeDraft18.PADDING));
    expect(payload).toEqual(expectedType);
  });

  it('rejects invalid byte counts', async () => {
    const session = makeSession();
    await expect(session.sendPaddingDatagram(-5)).rejects.toBeInstanceOf(RangeError);
    await expect(session.sendPaddingDatagram(NaN)).rejects.toBeInstanceOf(RangeError);
  });
});

describe.skipIf(!IS_DRAFT_18)('draft-18 §11.5.2 padding datagram (receiver)', () => {
  it('DatagramManager drops padding datagrams silently (no object event)', () => {
    const transport = new MOQTransport();
    // Manually stub the datagram source — start() attaches to transport.on('datagram').
    // Using a fresh manager plus direct call to the private handler mirrors how the
    // real datagram listener would deliver bytes.
    const manager = new DatagramManager(transport);

    let objectEmits = 0;
    let errorEmits = 0;
    manager.on('object', () => { objectEmits++; });
    manager.on('error', () => { errorEmits++; });

    const typeBytes = MOQTVarInt.encode(BigInt(DatagramTypeDraft18.PADDING));
    const padding = new Uint8Array(typeBytes.length + 20);
    padding.set(typeBytes);

    // Reach into the private handler — the wire path is `transport.emit('datagram', bytes)`,
    // which lands in this method.
    (manager as unknown as { handleDatagram: (b: Uint8Array) => void })
      .handleDatagram(padding);

    expect(objectEmits).toBe(0);
    expect(errorEmits).toBe(0);
    // Stats still count the received datagram — it just wasn't surfaced as an object.
    expect(manager.getStats().received).toBe(1);
  });
});
