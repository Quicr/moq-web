// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import type { StreamResetErrorCodeDraft18 } from '@moq-web/core';

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

  return new WebTransportError('', { streamErrorCode: code });
}
