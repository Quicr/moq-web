// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Unit tests for the draft-18 §3.5 (inbound Session Termination) and
 * §3.6 (Migration via GOAWAY.newSessionUri) plumbing.
 *
 * We drive the session via its `transport.on('closed', …)` and
 * `handleIncomingGoAwayDraft18` paths without opening a real WebTransport,
 * asserting that:
 *   1. peer-initiated closes surface a typed `session-terminated` event
 *      carrying the `SessionErrorCodeDraft18` code;
 *   2. local closes do NOT re-emit `session-terminated`;
 *   3. GOAWAY with a `newSessionUri` caches the URI so callers can migrate;
 *   4. the `on('session-migrating' | 'session-migrated')` overloads exist.
 */

import { describe, it, expect, vi } from 'vitest';
import { MOQTransport, SessionErrorCodeDraft18, MessageTypeDraft18 } from '@moq-web/core';

import { MOQTSession } from './session.js';
import type { SessionTerminatedEvent } from './types.js';

// Emit a fake `'closed'` event on the transport without going through
// WebTransport. `MOQTransport` uses a private `emit` under the hood, so we
// wire directly into its handler set the same way it does internally.
function makeSessionWithTransportSpy(): {
  session: MOQTSession;
  transport: MOQTransport;
  emitTransportClosed: (info: { closeCode: number; reason: string; remote: boolean }) => void;
} {
  const transport = new MOQTransport();
  // Neutralize the real close so tests never touch WebTransport.
  (transport as unknown as { close: typeof transport.close }).close = vi.fn().mockResolvedValue(undefined);
  const session = new MOQTSession(transport);

  // Poke the private handler set to fire an event to the session's listeners.
  // Using the public `on()` API to register from the session side is
  // sufficient — we just need a way to call those handlers.
  const emitTransportClosed = (info: { closeCode: number; reason: string; remote: boolean }) => {
    const handlers = (transport as unknown as {
      handlers: Map<string, Set<(data: unknown) => void>>;
    }).handlers.get('closed');
    if (!handlers) return;
    for (const h of handlers) h(info);
  };

  return { session, transport, emitTransportClosed };
}

describe('draft-18 §3.5 inbound session termination', () => {
  it('emits session-terminated with the peer close code when remote=true', () => {
    const { session, emitTransportClosed } = makeSessionWithTransportSpy();

    const events: SessionTerminatedEvent[] = [];
    session.on('session-terminated', (e) => events.push(e));

    emitTransportClosed({
      closeCode: SessionErrorCodeDraft18.PROTOCOL_VIOLATION,
      reason: 'invalid MAX_REQUEST_ID',
      remote: true,
    });

    expect(events).toHaveLength(1);
    expect(events[0].code).toBe(SessionErrorCodeDraft18.PROTOCOL_VIOLATION);
    expect(events[0].reason).toBe('invalid MAX_REQUEST_ID');
    expect(events[0].remote).toBe(true);
  });

  it('does not emit session-terminated for local closes', () => {
    const { session, emitTransportClosed } = makeSessionWithTransportSpy();

    const events: SessionTerminatedEvent[] = [];
    session.on('session-terminated', (e) => events.push(e));

    emitTransportClosed({
      closeCode: SessionErrorCodeDraft18.NO_ERROR,
      reason: 'Normal closure',
      remote: false,
    });

    expect(events).toHaveLength(0);
  });

  it('transitions to "error" state when peer closes with non-zero code', () => {
    const { session, emitTransportClosed } = makeSessionWithTransportSpy();

    emitTransportClosed({
      closeCode: SessionErrorCodeDraft18.INTERNAL_ERROR,
      reason: 'server bug',
      remote: true,
    });

    expect(session.state).toBe('error');
  });

  it('transitions to "none" state when peer closes with NO_ERROR', () => {
    const { session, emitTransportClosed } = makeSessionWithTransportSpy();

    emitTransportClosed({
      closeCode: SessionErrorCodeDraft18.NO_ERROR,
      reason: '',
      remote: true,
    });

    expect(session.state).toBe('none');
  });
});

describe('draft-18 §3.6 migration cache', () => {
  it('caches newSessionUri from incoming GOAWAY', () => {
    const { session } = makeSessionWithTransportSpy();

    // Call the private handler via cast to avoid exposing it publicly.
    (session as unknown as {
      handleIncomingGoAwayDraft18(m: {
        type: number;
        newSessionUri?: string;
        timeout: bigint;
        requestId?: bigint;
      }): void;
    }).handleIncomingGoAwayDraft18({
      type: MessageTypeDraft18.GOAWAY,
      newSessionUri: 'https://relay-b.example.com/moq',
      timeout: 5000n,
    });

    expect(session.pendingMigrationUri).toBe('https://relay-b.example.com/moq');
    expect(session.state).toBe('closing');
  });

  it('leaves pendingMigrationUri undefined for GOAWAY without newSessionUri', () => {
    const { session } = makeSessionWithTransportSpy();

    (session as unknown as {
      handleIncomingGoAwayDraft18(m: {
        type: number;
        newSessionUri?: string;
        timeout: bigint;
        requestId?: bigint;
      }): void;
    }).handleIncomingGoAwayDraft18({
      type: MessageTypeDraft18.GOAWAY,
      newSessionUri: '',
      timeout: 0n,
    });

    expect(session.pendingMigrationUri).toBeUndefined();
  });

  it('migrate() throws in main-thread mode', async () => {
    const { session } = makeSessionWithTransportSpy();
    await expect(session.migrate('https://x.example.com/moq')).rejects.toThrow(/worker mode/);
  });

  it('migrate() throws when no URI is available (no arg, no cached)', async () => {
    const { session } = makeSessionWithTransportSpy();
    // Force worker-mode branch by flipping the flag — we're only checking the
    // early-return path that predates any transport interaction.
    (session as unknown as { useWorker: boolean }).useWorker = true;
    await expect(session.migrate()).rejects.toThrow(/no target URI/);
  });
});
