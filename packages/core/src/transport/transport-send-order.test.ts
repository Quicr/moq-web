// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Stream priorities (d22 §5.1.2, d18 §7.2): the control streams are sent
 * first, then the bidi request streams, then objects.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { MOQTransport } from './transport.js';
import { SendOrder } from './send-order.js';

type StreamOptions = { sendOrder?: number } | undefined;

class StubWebTransport {
  static last: StubWebTransport;
  uniOptions: StreamOptions[] = [];
  bidiOptions: StreamOptions[] = [];
  ready = Promise.resolve();
  closed = new Promise<never>(() => {});
  datagrams = { readable: new ReadableStream<Uint8Array>(), writable: new WritableStream<Uint8Array>() };
  incomingUnidirectionalStreams = new ReadableStream({});
  incomingBidirectionalStreams = new ReadableStream({});

  constructor() {
    StubWebTransport.last = this;
  }

  async createUnidirectionalStream(options?: StreamOptions) {
    this.uniOptions.push(options);
    return new WritableStream<Uint8Array>();
  }

  async createBidirectionalStream(options?: StreamOptions) {
    this.bidiOptions.push(options);
    return { readable: new ReadableStream<Uint8Array>({}), writable: new WritableStream<Uint8Array>() };
  }

  close() {}
}

async function connected(draft: 'draft-22') {
  vi.stubGlobal('WebTransport', StubWebTransport);
  const transport = new MOQTransport({ draft });
  await transport.connect('https://relay.test');

  return { transport, stub: StubWebTransport.last };
}

describe('stream priorities', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends the draft-22 setup stream before everything else', async () => {
    const { stub } = await connected('draft-22');

    expect(stub.uniOptions[0]).toEqual({ sendOrder: SendOrder.CONTROL });
  });

  it('sends request streams after the control stream and before objects', async () => {
    const { transport, stub } = await connected('draft-22');

    await transport.createRequestStream();

    expect(stub.bidiOptions[0]).toEqual({ sendOrder: SendOrder.REQUEST });
    expect(SendOrder.REQUEST).toBeLessThan(SendOrder.CONTROL);
    expect(SendOrder.REQUEST).toBeGreaterThan(2 ** 52);
  });
});
