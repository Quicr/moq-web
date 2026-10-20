// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * The peer's control stream on draft-18/22 (d22 §6.3): it must stay open for
 * the session's lifetime, so a FIN or reset while connected is reported.
 */

import { describe, expect, it } from 'vitest';

import { MOQTransport } from './transport.js';

interface Internals {
  _state: string;
  localCloseInitiated: boolean;
  setupReader?: ReadableStreamDefaultReader<Uint8Array>;
  startSetupListener: (initial: Uint8Array) => void;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function listen(localCloseInitiated = false) {
  const transport = new MOQTransport({ draft: 'draft-22' });
  const internals = transport as unknown as Internals;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  internals._state = 'connected';
  internals.localCloseInitiated = localCloseInitiated;
  internals.setupReader = new ReadableStream<Uint8Array>({ start: (c) => { controller = c; } }).getReader();
  const ended: Array<{ reset: boolean }> = [];
  transport.on('setup-stream-ended', (e) => ended.push(e));
  internals.startSetupListener(new Uint8Array(0));

  return { controller, ended };
}

describe('control stream end', () => {
  it('is reported as a FIN', async () => {
    const { controller, ended } = listen();

    controller.close();
    await tick();

    expect(ended).toEqual([{ reset: false }]);
  });

  it('is reported as a reset', async () => {
    const { controller, ended } = listen();

    controller.error(new Error('RESET_STREAM'));
    await tick();

    expect(ended).toEqual([{ reset: true }]);
  });

  it('is not reported once we are closing the session ourselves', async () => {
    const { controller, ended } = listen(true);

    controller.error(new Error('session closed'));
    await tick();

    expect(ended).toEqual([]);
  });
});
