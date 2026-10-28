// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Stream reset error codes on the wire (draft-22 §12.5, draft-18 §3.3.3).
 * RESET_STREAM / STOP_SENDING carry the code via WebTransportError.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { StreamResetErrorCodeDraft18 } from '@moq-web/core';

import { streamResetReason } from './stream-reset-reason.js';
import { Draft18RequestStream } from './session-helpers.js';

describe('streamResetReason', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('falls back to the plain code without WebTransportError', () => {
    expect(streamResetReason(StreamResetErrorCodeDraft18.CANCELLED)).toBe(StreamResetErrorCodeDraft18.CANCELLED);
  });

  it('wraps the code in a WebTransportError when available', () => {
    class FakeWebTransportError {
      constructor(readonly message: string, readonly init: { streamErrorCode: number }) {}
    }
    vi.stubGlobal('WebTransportError', FakeWebTransportError);

    const reason = streamResetReason(StreamResetErrorCodeDraft18.DELIVERY_TIMEOUT) as FakeWebTransportError;

    expect(reason).toBeInstanceOf(FakeWebTransportError);
    expect(reason.init.streamErrorCode).toBe(StreamResetErrorCodeDraft18.DELIVERY_TIMEOUT);
  });

  it('falls back to the single-dictionary constructor Chrome implements', () => {
    class ChromeWebTransportError {
      readonly streamErrorCode: number;
      constructor(init: unknown) {
        if (typeof init !== 'object' || init === null) {
          throw new TypeError("The provided value is not of type 'WebTransportErrorInit'.");
        }
        this.streamErrorCode = (init as { streamErrorCode: number }).streamErrorCode;
      }
    }
    vi.stubGlobal('WebTransportError', ChromeWebTransportError);

    const reason = streamResetReason(StreamResetErrorCodeDraft18.SESSION_CLOSED) as ChromeWebTransportError;

    expect(reason).toBeInstanceOf(ChromeWebTransportError);
    expect(reason.streamErrorCode).toBe(StreamResetErrorCodeDraft18.SESSION_CLOSED);
  });
});

describe('Draft18RequestStream.abort', () => {
  it('passes the code to the receive and send sides', async () => {
    const onCancel = vi.fn();
    const abortFn = vi.fn();
    const readable = new ReadableStream<Uint8Array>({ cancel: onCancel });
    const stream = new Draft18RequestStream({} as never, readable, () => {}, () => {}, abortFn);

    await stream.abort(StreamResetErrorCodeDraft18.CANCELLED);

    expect(onCancel).toHaveBeenCalledWith(StreamResetErrorCodeDraft18.CANCELLED);
    expect(abortFn).toHaveBeenCalledWith(StreamResetErrorCodeDraft18.CANCELLED);
  });
});
