// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Unit tests for draft-18 §14 grease normalization at the session layer.
 *
 * §14 requires receivers to treat unknown values in the Session Termination,
 * REQUEST_ERROR, PUBLISH_DONE, and Stream Reset registries as INTERNAL_ERROR.
 * The codec-level tests cover REQUEST_ERROR / PUBLISH_DONE. Here we assert
 * the Session Termination path: a peer close with a grease code MUST surface
 * on `session-terminated` as INTERNAL_ERROR (0x1), not the raw grease value.
 */

import { describe, it, expect, vi } from 'vitest';
import { IS_DRAFT_18, MOQTransport, SessionErrorCodeDraft18 } from '@moq-web/core';

import { MOQTSession } from './session.js';
import type { SessionTerminatedEvent } from './types.js';

interface SessionInternals {
  handleTransportClosed: (info: { closeCode: number; reason: string; remote: boolean }) => void;
  handleError: (err: Error) => void;
  setState: (s: string) => void;
}

function makeSession(): { session: MOQTSession; internals: SessionInternals } {
  const transport = new MOQTransport();
  (transport as unknown as { close: typeof transport.close }).close = vi.fn().mockResolvedValue(undefined);
  const session = new MOQTSession(transport);
  const internals = session as unknown as SessionInternals;
  // Prevent the elevate-to-error path from throwing during the test — we only
  // care about the emitted event's code field, not the subsequent state
  // transition side-effects.
  internals.handleError = vi.fn();
  return { session, internals };
}

describe.skipIf(!IS_DRAFT_18)('draft-18 §14 grease normalization at session boundary', () => {
  it('normalizes a grease-range peer close code to INTERNAL_ERROR on session-terminated', () => {
    const { session, internals } = makeSession();

    const events: SessionTerminatedEvent[] = [];
    session.on('session-terminated', (e: unknown) => { events.push(e as SessionTerminatedEvent); });

    // 0x9d is the first draft-18 §14 grease value.
    internals.handleTransportClosed({ closeCode: 0x9d, reason: 'grease', remote: true });

    expect(events).toHaveLength(1);
    expect(events[0].code).toBe(SessionErrorCodeDraft18.INTERNAL_ERROR);
    expect(events[0].remote).toBe(true);
    expect(events[0].reason).toBe('grease');
  });

  it('passes a known Session Termination code through unchanged', () => {
    const { session, internals } = makeSession();

    const events: SessionTerminatedEvent[] = [];
    session.on('session-terminated', (e: unknown) => { events.push(e as SessionTerminatedEvent); });

    internals.handleTransportClosed({
      closeCode: SessionErrorCodeDraft18.PROTOCOL_VIOLATION,
      reason: 'bad message',
      remote: true,
    });

    expect(events).toHaveLength(1);
    expect(events[0].code).toBe(SessionErrorCodeDraft18.PROTOCOL_VIOLATION);
  });

  it('normalizes a non-grease unknown code to INTERNAL_ERROR too', () => {
    // §14 receiver rule applies to any unknown code, not just codes matching
    // the arithmetic grease pattern.
    const { session, internals } = makeSession();

    const events: SessionTerminatedEvent[] = [];
    session.on('session-terminated', (e: unknown) => { events.push(e as SessionTerminatedEvent); });

    // 0xff is not a defined SessionErrorCodeDraft18 member (enum tops out at
    // 0x1a) and is not on the grease progression — still MUST be treated as
    // INTERNAL_ERROR.
    internals.handleTransportClosed({ closeCode: 0xff, reason: 'unknown-code', remote: true });

    expect(events[0].code).toBe(SessionErrorCodeDraft18.INTERNAL_ERROR);
  });

  it('leaves 0 (NO_ERROR) untouched — a clean close', () => {
    const { session, internals } = makeSession();

    const events: SessionTerminatedEvent[] = [];
    session.on('session-terminated', (e: unknown) => { events.push(e as SessionTerminatedEvent); });

    internals.handleTransportClosed({ closeCode: 0, reason: '', remote: true });

    expect(events[0].code).toBe(SessionErrorCodeDraft18.NO_ERROR);
  });
});
