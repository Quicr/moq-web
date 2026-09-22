// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * SETUP §6.3 MAX_REQUEST_ID — client-side hard cap.
 *
 * Verifies that when a session exhausts its advertised MAX_REQUEST_ID budget,
 * further request-id allocations throw with a typed error rather than
 * overflowing silently or issuing an ID the peer will reject.
 */

import { describe, expect, it, vi } from 'vitest';
import { MOQTransport } from '@moq-web/core';
import { MOQTSession } from './session.js';

interface Priv {
  getNextRequestId: () => number;
}

function makeSession(maxRequestId?: number): MOQTSession {
  const transport = new MOQTransport();
  (transport as unknown as { close: typeof transport.close }).close = vi.fn().mockResolvedValue(undefined);
  if (maxRequestId !== undefined) {
    return new MOQTSession({
      // Pretend to be a worker-mode config to reach the maxRequestId option
      // path. We never call any transport methods here.
      worker: {} as Worker,
      maxRequestId,
    });
  }
  return new MOQTSession(transport);
}

describe('SETUP §6.3 MAX_REQUEST_ID', () => {
  it('exposes the advertised cap via maxAdvertisedRequestId', () => {
    const s = makeSession(42);
    expect(s.maxAdvertisedRequestId).toBe(42);
  });

  it('defaults to 1000 when no cap is configured', () => {
    const s = makeSession();
    expect(s.maxAdvertisedRequestId).toBe(1000);
  });

  it('throws when the request-id counter reaches the cap', () => {
    const s = makeSession(4);
    const priv = s as unknown as Priv;
    // Draft defaults to draft-16/18 in most builds — client uses even IDs
    // stepped by 2. Cap of 4 allows 0, 2 before the third call throws.
    priv.getNextRequestId();
    priv.getNextRequestId();
    expect(() => priv.getNextRequestId()).toThrowError(/request-id cap reached/);
  });
});
