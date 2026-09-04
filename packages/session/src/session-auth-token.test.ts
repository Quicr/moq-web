// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Draft-18 §10.2.2 AUTHORIZATION_TOKEN request-parameter wiring.
 *
 * SUBSCRIBE and FETCH accept a per-request `authToken` in the caller-facing
 * options bag. These tests capture the encoded request bytes and confirm the
 * codec-decoded parameter map carries the token payload verbatim, so a peer
 * can validate the token via `MessageCodec.decodeAuthorizationToken()`.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  Draft18MessageCodec,
  IS_DRAFT_18,
  MessageCodec,
  MOQTransport,
  MessageTypeDraft18,
  RequestParameterDraft18,
  type ControlMessageDraft18,
  type FetchMessageDraft18,
  type SubscribeMessageDraft18,
} from '@moq-web/core';

import { MOQTSession } from './session.js';

function makeReadySession(): MOQTSession {
  const transport = new MOQTransport();
  (transport as unknown as { close: typeof transport.close }).close = vi.fn().mockResolvedValue(undefined);
  const session = new MOQTSession(transport);
  (session as unknown as { _state: string })._state = 'ready';
  return session;
}

function stubSendAndCapture(session: MOQTSession, response?: Partial<ControlMessageDraft18>): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  const ok: ControlMessageDraft18 = (response as ControlMessageDraft18) ?? ({
    type: MessageTypeDraft18.SUBSCRIBE_OK,
    requestId: 0n,
    trackAlias: 0n,
    largestLocation: { group: 0n, object: 0n },
  } as unknown as ControlMessageDraft18);
  (session as unknown as {
    sendRequestAndWaitResponse: (bytes: Uint8Array, id: number) => Promise<ControlMessageDraft18>;
  }).sendRequestAndWaitResponse = async (bytes) => {
    chunks.push(bytes);
    return ok;
  };
  return chunks;
}

describe.skipIf(!IS_DRAFT_18)('draft-18 §10.2.2 AUTHORIZATION_TOKEN wiring', () => {
  it('propagates SubscribeOptions.authToken into the SUBSCRIBE parameter map', async () => {
    const session = makeReadySession();
    const chunks = stubSendAndCapture(session, {
      type: MessageTypeDraft18.SUBSCRIBE_OK,
      requestId: 0n,
      trackAlias: 0n,
      largestLocation: { group: 0n, object: 0n },
    } as unknown as ControlMessageDraft18);

    const tokenBytes = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]);

    // Invoke the draft-18-specific send path directly.
    await (session as unknown as {
      subscribeDraft18: (
        requestId: number,
        namespace: string[],
        trackName: string,
        trackAlias: bigint,
        options: { authToken: { tokenBytes: Uint8Array; tokenType?: number } },
      ) => Promise<void>;
    }).subscribeDraft18(0, ['ns'], 'track', 0n, {
      authToken: { tokenBytes, tokenType: 0x63346d },
    });

    expect(chunks.length).toBeGreaterThan(0);
    const [decoded] = Draft18MessageCodec.decode(chunks[0]);
    const m = decoded as SubscribeMessageDraft18;
    const paramBytes = m.parameters!.get(RequestParameterDraft18.AUTHORIZATION_TOKEN);
    expect(paramBytes).toBeDefined();

    const token = MessageCodec.decodeAuthorizationToken(paramBytes!);
    expect(token.aliasType).toBe(3); // USE_VALUE
    expect(token.tokenType).toBe(0x63346d);
    expect(token.tokenValue).toEqual(tokenBytes);
  });

  it('propagates FetchOptions.authToken into the FETCH parameter map', async () => {
    const session = makeReadySession();
    const chunks = stubSendAndCapture(session, {
      type: MessageTypeDraft18.FETCH_OK,
      requestId: 0n,
      endOfTrack: false,
      endLocation: { group: 0n, object: 0n },
    } as unknown as ControlMessageDraft18);

    const tokenBytes = new Uint8Array([0x11, 0x22]);

    await (session as unknown as {
      fetchDraft18: (
        requestId: number,
        namespace: string[],
        trackName: string,
        range: { startGroup: number; startObject: number; endGroup: number; endObject: number },
        options: { authToken: { tokenBytes: Uint8Array; tokenType?: number } },
      ) => Promise<void>;
    }).fetchDraft18(0, ['ns'], 'track', { startGroup: 0, startObject: 0, endGroup: 1, endObject: 0 }, {
      authToken: { tokenBytes },
    });

    expect(chunks.length).toBeGreaterThan(0);
    const [decoded] = Draft18MessageCodec.decode(chunks[0]);
    const m = decoded as FetchMessageDraft18;
    const paramBytes = m.parameters!.get(RequestParameterDraft18.AUTHORIZATION_TOKEN);
    expect(paramBytes).toBeDefined();
    const token = MessageCodec.decodeAuthorizationToken(paramBytes!);
    expect(token.tokenValue).toEqual(tokenBytes);
  });

  it('omits AUTHORIZATION_TOKEN when SubscribeOptions.authToken is not provided', async () => {
    const session = makeReadySession();
    const chunks = stubSendAndCapture(session);

    await (session as unknown as {
      subscribeDraft18: (
        requestId: number,
        namespace: string[],
        trackName: string,
        trackAlias: bigint,
        options?: object,
      ) => Promise<void>;
    }).subscribeDraft18(0, ['ns'], 'track', 0n, {});

    const [decoded] = Draft18MessageCodec.decode(chunks[0]);
    const m = decoded as SubscribeMessageDraft18;
    expect(m.parameters?.get(RequestParameterDraft18.AUTHORIZATION_TOKEN)).toBeUndefined();
  });
});
