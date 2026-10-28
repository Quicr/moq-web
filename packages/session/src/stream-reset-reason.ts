// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { StreamResetErrorCodeDraft18 } from '@moq-web/core';

/**
 * Build the reason for `writer.abort()` (RESET_STREAM) or `reader.cancel()`
 * (STOP_SENDING) so the error code reaches the wire (draft-22 §12.5,
 * draft-18 §3.3.3). WebTransport carries it in a WebTransportError; without
 * one (tests, non-WebTransport runtimes) the plain code stands in.
 */
export function streamResetReason(code: StreamResetErrorCodeDraft18): unknown {
  if (typeof WebTransportError === 'undefined') {
    return code;
  }

  try {
    return new WebTransportError('', { streamErrorCode: code });
  } catch {
    // Chrome implements the older single-dictionary constructor
    // (`new WebTransportError({ streamErrorCode })`) and throws on the
    // spec's (message, options) form.
    const LegacyCtor = WebTransportError as unknown as new (init: { streamErrorCode: number }) => unknown;
    return new LegacyCtor({ streamErrorCode: code });
  }
}

/**
 * The Stream Reset Code a `reader.cancel()` / `writer.abort()` reason carries:
 * the inverse of {@link streamResetReason}. A reason without one is CANCELLED.
 */
export function streamResetCode(reason: unknown): number {
  if (typeof reason === 'number') {
    return reason;
  }

  const code = (reason as { streamErrorCode?: unknown } | null | undefined)?.streamErrorCode;
  return typeof code === 'number' ? code : StreamResetErrorCodeDraft18.CANCELLED;
}
