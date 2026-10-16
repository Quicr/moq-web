// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * §8.9 receiver duties for a session that advertises no token cache
 * (MAX_AUTH_TOKEN_CACHE_SIZE 0): an undecodable Token closes the session with
 * KEY_VALUE_FORMATTING_ERROR, registering an Alias closes it with
 * AUTH_TOKEN_CACHE_OVERFLOW, and so does a USE_ALIAS or DELETE of an Alias,
 * which cannot exist (UNKNOWN_AUTH_TOKEN_ALIAS). They apply to the Tokens of
 * every request message, of a REQUEST_UPDATE and of the SETUP options.
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

const TOKEN_VALUE = new Uint8Array([1]);

function tokenOf(aliasType: AuthTokenAliasType): Uint8Array {
  const aliased = aliasType !== AuthTokenAliasType.USE_VALUE;
  const hasValue = aliasType === AuthTokenAliasType.REGISTER || aliasType === AuthTokenAliasType.USE_VALUE;

  return encodeDraft18AuthToken({
    aliasType,
    ...(aliased ? { tokenAlias: TOKEN_ALIAS } : {}),
    ...(hasValue ? { tokenType: TOKEN_TYPE, tokenValue: TOKEN_VALUE } : {}),
  });
}

const closeCodeFor: Array<[string, AuthTokenAliasType, SessionErrorCodeDraft18 | undefined]> = [
  ['REGISTER', AuthTokenAliasType.REGISTER, SessionErrorCodeDraft18.AUTH_TOKEN_CACHE_OVERFLOW],
  ['USE_ALIAS', AuthTokenAliasType.USE_ALIAS, SessionErrorCodeDraft18.UNKNOWN_AUTH_TOKEN_ALIAS],
  ['DELETE', AuthTokenAliasType.DELETE, SessionErrorCodeDraft18.UNKNOWN_AUTH_TOKEN_ALIAS],
  ['USE_VALUE', AuthTokenAliasType.USE_VALUE, undefined],
];

function sessionFor(draft: 'draft-18' | 'draft-22') {
  const transport = new MOQTransport({ draft });
  (transport as unknown as { close: typeof transport.close }).close = vi.fn().mockResolvedValue(undefined);
  const session = new MOQTSession(transport);
  const internals = session as unknown as Internals;
  internals._state = 'ready';
  internals.announcedNamespaces.set('ns', { namespace: ['ns'], options: {}, subscribers: new Map() });
  const close = vi.fn().mockResolvedValue(undefined);
  session.close = close;

  return { session, internals, close };
}

function withToken(draft: 'draft-18' | 'draft-22', message: object, token: Uint8Array): ControlMessageDraft18 {
  const carried = draft === 'draft-22' ? { authTokens: [token] } : { parameters: new Map([[0x03, token]]) };

  return { ...message, ...carried } as unknown as ControlMessageDraft18;
}

const requestsCarryingTokens: Array<[string, object]> = [
  ['SUBSCRIBE', { type: MessageTypeDraft18.SUBSCRIBE, requestId: REQUEST_ID, trackNamespace: ['ns'], trackName: 't', forwardState: true }],
  ['PUBLISH', { type: MessageTypeDraft18.PUBLISH, requestId: REQUEST_ID, trackAlias: 9n, trackNamespace: ['ns'], trackName: 't', forwardState: true }],
  ['TRACK_STATUS', { type: MessageTypeDraft18.TRACK_STATUS, requestId: REQUEST_ID, trackNamespace: ['ns'], trackName: 't' }],
  ['SUBSCRIBE_NAMESPACE', { type: MessageTypeDraft18.SUBSCRIBE_NAMESPACE, requestId: REQUEST_ID, trackNamespacePrefix: ['ns'] }],
  ['PUBLISH_NAMESPACE', { type: MessageTypeDraft18.PUBLISH_NAMESPACE, requestId: REQUEST_ID, trackNamespacePrefix: ['ns'] }],
  ['SUBSCRIBE_TRACKS', { type: MessageTypeDraft18.SUBSCRIBE_TRACKS, requestId: REQUEST_ID, trackNamespacePrefix: ['ns'], forwardState: true }],
];

describe.each(['draft-18', 'draft-22'] as const)('%s Authorization Token Aliases in requests (§8.9)', (draft) => {
  describe.each(requestsCarryingTokens)('%s', (_name, request) => {
    it.each(closeCodeFor)('%s', async (_alias, aliasType, code) => {
      const { internals, close } = sessionFor(draft);
      const message = withToken(draft, request, tokenOf(aliasType));
      const readable = new ReadableStream<Uint8Array>({
        start: (controller) => controller.enqueue(internals.codec.encodeControlMessage(message)),
      });

      await internals.processIncomingBidiStream({ readable, writable: new WritableStream<Uint8Array>() });
      await tick();

      if (code === undefined) {
        expect(close).not.toHaveBeenCalled();
      } else {
        expect(close).toHaveBeenCalledWith(expect.objectContaining({ code }));
      }
    });
  });

  it.each(closeCodeFor.slice(1, 3))('a REQUEST_UPDATE with %s closes the session', async (_alias, aliasType, code) => {
    const { internals, close } = sessionFor(draft);
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const readable = new ReadableStream<Uint8Array>({
      start: (c) => {
        controller = c;
        c.enqueue(internals.codec.encodeControlMessage({
          type: MessageTypeDraft18.SUBSCRIBE,
          requestId: REQUEST_ID,
          trackNamespace: ['ns'],
          trackName: 't',
          forwardState: true,
          ...(draft === 'draft-18' ? { filter: 1 } : {}),
        }));
      },
    });
    await internals.processIncomingBidiStream({ readable, writable: new WritableStream<Uint8Array>() });

    controller.enqueue(internals.codec.encodeControlMessage(withToken(
      draft,
      { type: MessageTypeDraft18.REQUEST_UPDATE, requestId: REQUEST_ID + 2n, forwardState: true },
      tokenOf(aliasType),
    )));
    await tick();

    expect(close).toHaveBeenCalledWith(expect.objectContaining({ code }));
  });
});

describe.each(['draft-18', 'draft-22'] as const)('%s Authorization Token in the SETUP options (§9.1.4)', (draft) => {
  /** The server's SETUP, carrying `token`, arrives on its setup stream. */
  async function receiveSetup(token: Uint8Array) {
    const { internals, close } = sessionFor(draft);
    const setup = { type: MessageTypeDraft18.CLIENT_SETUP, authToken: token };
    (internals as unknown as { handleSetupMessage: (d: Uint8Array) => void }).handleSetupMessage(
      (internals as unknown as { codec: { encodeSetupStream: (m: unknown) => Uint8Array } }).codec.encodeSetupStream(setup),
    );
    await tick();

    return close;
  }

  it.each(closeCodeFor.filter(([name]) => name !== 'REGISTER'))('%s', async (_alias, aliasType, code) => {
    const close = await receiveSetup(tokenOf(aliasType));

    if (code === undefined) {
      expect(close).not.toHaveBeenCalled();
    } else {
      expect(close).toHaveBeenCalledWith(expect.objectContaining({ code }));
    }
  });

  it('treats a REGISTER as USE_VALUE rather than overflowing the cache', async () => {
    const close = await receiveSetup(tokenOf(AuthTokenAliasType.REGISTER));

    expect(close).not.toHaveBeenCalled();
  });
});
