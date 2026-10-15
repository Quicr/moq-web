// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * §8.9 receiver duties for a session that advertises no token cache
 * (MAX_AUTH_TOKEN_CACHE_SIZE 0): an undecodable Token closes the session with
 * KEY_VALUE_FORMATTING_ERROR, and registering an Alias closes it with
 * AUTH_TOKEN_CACHE_OVERFLOW.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  AuthTokenAliasType,
  encodeDraft18AuthToken,
  MOQTransport,
  MessageTypeDraft18,
  SessionErrorCodeDraft18,
  type ControlMessageDraft18,
} from '@moq-web/core';

import { MOQTSession } from './session.js';

const TOKEN_TYPE = 0;
const TOKEN_ALIAS = 1;
const REQUEST_ID = 3n;

interface Internals {
  _state: string;
  codec: { encodeControlMessage: (m: unknown) => Uint8Array };
  announcedNamespaces: Map<string, unknown>;
  processIncomingBidiStream: (s: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }) => Promise<void>;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe.each(['draft-18', 'draft-22'] as const)('%s incoming Authorization Tokens (§8.9)', (draft) => {
  async function receiveSubscribe(token: Uint8Array): Promise<ReturnType<typeof vi.fn>> {
    const transport = new MOQTransport({ draft });
    (transport as unknown as { close: typeof transport.close }).close = vi.fn().mockResolvedValue(undefined);
    const session = new MOQTSession(transport);
    const internals = session as unknown as Internals;
    internals._state = 'ready';
    internals.announcedNamespaces.set('ns', { namespace: ['ns'], options: {}, subscribers: new Map() });
    const close = vi.fn().mockResolvedValue(undefined);
    session.close = close;

    const message = {
      type: MessageTypeDraft18.SUBSCRIBE,
      requestId: REQUEST_ID,
      trackNamespace: ['ns'],
      trackName: 't',
      forwardState: true,
      ...(draft === 'draft-22'
        ? { authTokens: [token] }
        : { parameters: new Map([[0x03, token]]) }),
    } as unknown as ControlMessageDraft18;
    const readable = new ReadableStream<Uint8Array>({
      start: (controller) => controller.enqueue(internals.codec.encodeControlMessage(message)),
    });
    const writable = new WritableStream<Uint8Array>();

    await internals.processIncomingBidiStream({ readable, writable });
    await tick();

    return close;
  }

  it('closes with KEY_VALUE_FORMATTING_ERROR on an undecodable Token', async () => {
    const close = await receiveSubscribe(new Uint8Array([0x09]));

    expect(close).toHaveBeenCalledWith(
      expect.objectContaining({ code: SessionErrorCodeDraft18.KEY_VALUE_FORMATTING_ERROR }),
    );
  });

  it('closes with AUTH_TOKEN_CACHE_OVERFLOW when a Token registers an Alias', async () => {
    const token = encodeDraft18AuthToken({
      aliasType: AuthTokenAliasType.REGISTER,
      tokenAlias: TOKEN_ALIAS,
      tokenType: TOKEN_TYPE,
      tokenValue: new Uint8Array([1]),
    });

    const close = await receiveSubscribe(token);

    expect(close).toHaveBeenCalledWith(
      expect.objectContaining({ code: SessionErrorCodeDraft18.AUTH_TOKEN_CACHE_OVERFLOW }),
    );
  });

  it('does not close for a USE_VALUE Token', async () => {
    const token = encodeDraft18AuthToken({
      aliasType: AuthTokenAliasType.USE_VALUE,
      tokenType: TOKEN_TYPE,
      tokenValue: new Uint8Array([1]),
    });

    const close = await receiveSubscribe(token);

    expect(close).not.toHaveBeenCalled();
  });
});
