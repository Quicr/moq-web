// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * GOAWAY and migration (draft-22 §9.2, §6.2.1, §6.6.1): an empty New Session
 * URI means the current one, a moqt URI is connected to as https, and a
 * GOAWAY we send ends the session with GOAWAY_TIMEOUT if requests outlive
 * its Timeout.
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import { MOQTransport, MessageTypeDraft18, SessionErrorCodeDraft18, type GoAwayEvent } from '@moq-web/core';

import { MOQTSession } from './session.js';

const CURRENT_URL = 'https://relay.example/moq';
const TIMEOUT_MS = 50n;

interface Internals {
  _lastConnectUrl?: string;
  useWorker: boolean;
  activeRequestStreams: Map<bigint, unknown>;
  handleIncomingGoAwayDraft18: (m: unknown) => void;
  doSendControl: (b: Uint8Array) => Promise<void>;
}

function makeSession() {
  const transport = new MOQTransport({ draft: 'draft-22' });
  (transport as unknown as { close: typeof transport.close }).close = vi.fn().mockResolvedValue(undefined);
  const session = new MOQTSession(transport);
  (session as unknown as { _state: string })._state = 'ready';
  const internals = session as unknown as Internals;
  internals._lastConnectUrl = CURRENT_URL;
  internals.doSendControl = async () => {};
  const goaways: GoAwayEvent[] = [];
  session.on('goaway', (e) => goaways.push(e));

  return { session, internals, goaways };
}

const goAway = (newSessionUri: string) => ({ type: MessageTypeDraft18.GOAWAY, newSessionUri, timeout: 0n });

afterEach(() => {
  vi.useRealTimers();
});

describe('received GOAWAY URI', () => {
  it('is the current URI when empty', () => {
    const { session, internals, goaways } = makeSession();

    internals.handleIncomingGoAwayDraft18(goAway(''));

    expect(session.pendingMigrationUri).toBe(CURRENT_URL);
    expect(goaways[0].newSessionUri).toBeUndefined();
  });

  it('is connected to as https when it is a moqt URI', () => {
    const { session, internals, goaways } = makeSession();

    internals.handleIncomingGoAwayDraft18(goAway('moqt://new.example/moq'));

    expect(session.pendingMigrationUri).toBe('https://new.example/moq');
    expect(goaways[0].newSessionUri).toBe('https://new.example/moq');
  });
});

describe('migrate()', () => {
  it('reconnects to the current URI when no other is known', async () => {
    const { session, internals } = makeSession();
    internals.useWorker = true;
    vi.spyOn(session, 'close').mockResolvedValue(undefined);
    const connect = vi.spyOn(session, 'connect').mockResolvedValue(undefined);
    vi.spyOn(session, 'setup').mockResolvedValue(undefined);

    await session.migrate();

    expect(connect).toHaveBeenCalledWith(CURRENT_URL);
  });

  it('connects to a moqt URI as https', async () => {
    const { session, internals } = makeSession();
    internals.useWorker = true;
    vi.spyOn(session, 'close').mockResolvedValue(undefined);
    const connect = vi.spyOn(session, 'connect').mockResolvedValue(undefined);
    vi.spyOn(session, 'setup').mockResolvedValue(undefined);

    await session.migrate('moqt://new.example/moq');

    expect(connect).toHaveBeenCalledWith('https://new.example/moq');
  });
});

describe('our GOAWAY Timeout', () => {
  it('closes the session with GOAWAY_TIMEOUT while requests are open', async () => {
    vi.useFakeTimers();
    const { session, internals } = makeSession();
    const close = vi.spyOn(session, 'close').mockResolvedValue(undefined);
    internals.activeRequestStreams.set(0n, {});

    await session.goAway(undefined, TIMEOUT_MS);
    vi.advanceTimersByTime(Number(TIMEOUT_MS));

    expect(close).toHaveBeenCalledWith(expect.objectContaining({ code: SessionErrorCodeDraft18.GOAWAY_TIMEOUT }));
  });

  it('leaves the session alone once no request is open', async () => {
    vi.useFakeTimers();
    const { session } = makeSession();
    const close = vi.spyOn(session, 'close').mockResolvedValue(undefined);

    await session.goAway(undefined, TIMEOUT_MS);
    vi.advanceTimersByTime(Number(TIMEOUT_MS));

    expect(close).not.toHaveBeenCalled();
  });
});
