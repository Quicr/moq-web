// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Unit tests for the draft-18 §15.10 error-code plumbing on session close and
 * publication-stream reset paths.
 *
 * The session's close/reset primitives forward numeric codes down to the
 * underlying WebTransport `close({ closeCode })` and `writer.abort(reason)`.
 * Because those layers are hard to fake in Node, we spy on the transport's
 * `close` method and on the writer captured by `activeVideoStreams`.
 */

import { describe, it, expect, vi } from 'vitest';
import { MOQTransport, SessionErrorCodeDraft18, StreamResetErrorCodeDraft18 } from '@moq-web/core';

import { MOQTSession } from './session.js';

// Type-narrow helper to poke at private state without polluting the public API.
type PrivateSession = MOQTSession & {
  activeVideoStreams: Map<string, {
    writer?: WritableStreamDefaultWriter<Uint8Array>;
    streamId?: number;
    groupId: number;
    objectCount: number;
    previousObjectId: number;
    hasExtensions: boolean;
  }>;
};

function makeSession(): { session: MOQTSession; transport: MOQTransport; closeSpy: ReturnType<typeof vi.fn> } {
  const transport = new MOQTransport();
  const closeSpy = vi.fn().mockResolvedValue(undefined);
  // Replace the transport close with a spy so we can assert the plumbed code/reason
  // without opening a real WebTransport handle.
  (transport as unknown as { close: typeof transport.close }).close = closeSpy;
  const session = new MOQTSession(transport);
  return { session, transport, closeSpy };
}

describe('session.close(options)', () => {
  it('defaults to SessionErrorCodeDraft18.NO_ERROR when called with no args', async () => {
    const { session, closeSpy } = makeSession();
    await session.close();
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(closeSpy).toHaveBeenCalledWith(SessionErrorCodeDraft18.NO_ERROR, 'Normal closure');
  });

  it('forwards a caller-supplied session termination code', async () => {
    const { session, closeSpy } = makeSession();
    await session.close({
      code: SessionErrorCodeDraft18.PROTOCOL_VIOLATION,
      reason: 'invalid MAX_REQUEST_ID',
    });
    expect(closeSpy).toHaveBeenCalledWith(
      SessionErrorCodeDraft18.PROTOCOL_VIOLATION,
      'invalid MAX_REQUEST_ID',
    );
  });

  it('swallows transport.close() rejections so the session still reaches "none"', async () => {
    const { session, transport } = makeSession();
    (transport as unknown as { close: typeof transport.close }).close =
      vi.fn().mockRejectedValue(new Error('transport already gone'));
    await session.close({ code: SessionErrorCodeDraft18.INTERNAL_ERROR });
    expect(session.state).toBe('none');
  });

  it('accepts every value of the SessionErrorCodeDraft18 enum', async () => {
    for (const code of Object.values(SessionErrorCodeDraft18)) {
      if (typeof code !== 'number') continue;
      const { session, closeSpy } = makeSession();
      await session.close({ code });
      expect(closeSpy).toHaveBeenCalledWith(code, 'Normal closure');
    }
  });
});

describe('session.resetPublicationStream()', () => {
  it('is a no-op when no stream is tracked for the alias', async () => {
    const { session } = makeSession();
    await expect(
      session.resetPublicationStream('missing-alias', StreamResetErrorCodeDraft18.CANCELLED),
    ).resolves.toBeUndefined();
  });

  it('aborts the underlying writer with a code-derived reason string', async () => {
    const { session } = makeSession();
    const abortSpy = vi.fn().mockResolvedValue(undefined);
    const fakeWriter = { abort: abortSpy } as unknown as WritableStreamDefaultWriter<Uint8Array>;
    (session as PrivateSession).activeVideoStreams.set('alias-1', {
      writer: fakeWriter,
      groupId: 7,
      objectCount: 12,
      previousObjectId: 11,
      hasExtensions: false,
    });

    await session.resetPublicationStream('alias-1', StreamResetErrorCodeDraft18.DELIVERY_TIMEOUT);

    expect(abortSpy).toHaveBeenCalledTimes(1);
    const passedReason = abortSpy.mock.calls[0][0] as string;
    expect(passedReason).toContain(String(StreamResetErrorCodeDraft18.DELIVERY_TIMEOUT));
    // Ensures the map entry is drained so a follow-up reset is a no-op.
    expect((session as PrivateSession).activeVideoStreams.has('alias-1')).toBe(false);
  });

  it('forwards a caller-supplied reason string verbatim', async () => {
    const { session } = makeSession();
    const abortSpy = vi.fn().mockResolvedValue(undefined);
    (session as PrivateSession).activeVideoStreams.set('alias-2', {
      writer: { abort: abortSpy } as unknown as WritableStreamDefaultWriter<Uint8Array>,
      groupId: 0,
      objectCount: 0,
      previousObjectId: -1,
      hasExtensions: false,
    });

    await session.resetPublicationStream(
      'alias-2',
      StreamResetErrorCodeDraft18.TOO_FAR_BEHIND,
      'subscriber lagged past 3 groups',
    );

    expect(abortSpy).toHaveBeenCalledWith('subscriber lagged past 3 groups');
  });

  it('does not throw when writer.abort() itself rejects (stream already gone)', async () => {
    const { session } = makeSession();
    const abortSpy = vi.fn().mockRejectedValue(new Error('writer already closed'));
    (session as PrivateSession).activeVideoStreams.set('alias-3', {
      writer: { abort: abortSpy } as unknown as WritableStreamDefaultWriter<Uint8Array>,
      groupId: 0,
      objectCount: 0,
      previousObjectId: -1,
      hasExtensions: false,
    });

    await expect(
      session.resetPublicationStream('alias-3', StreamResetErrorCodeDraft18.INTERNAL_ERROR),
    ).resolves.toBeUndefined();
    expect((session as PrivateSession).activeVideoStreams.has('alias-3')).toBe(false);
  });
});
