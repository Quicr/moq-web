// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Unit tests for the MOQT_IMPLEMENTATION SetupOption (draft-22 §9.1.5,
 * draft-18 §10.3.1.5): an endpoint SHOULD send one unless configured not to.
 * The client sends `moq-web` by default; callers can replace it, or send
 * none, via `MOQTSession.setImplementationString(...)` before `setup()`.
 *
 * We drive setup() through a stubbed sendControl to capture the encoded
 * CLIENT_SETUP bytes and inspect the decoded options.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  Draft18MessageCodec,
  MOQTransport,
  type ServerSetupMessageDraft18,
  DEFAULT_DRAFT,
} from '@moq-web/core';

import { MOQTSession } from './session.js';


const IS_DRAFT_18 = DEFAULT_DRAFT === 'draft-18';
interface SessionInternals {
  _state: string;
  _implementationString?: string;
  doSendControl: (data: Uint8Array) => Promise<void>;
  waitForServerSetupDraft18: () => Promise<void>;
}

function makeSession(): { session: MOQTSession; internals: SessionInternals; controlBytes: Uint8Array[] } {
  const transport = new MOQTransport();
  (transport as unknown as { close: typeof transport.close }).close = vi.fn().mockResolvedValue(undefined);
  const session = new MOQTSession(transport);

  const controlBytes: Uint8Array[] = [];
  const internals = session as unknown as SessionInternals;
  internals.doSendControl = async (data: Uint8Array) => { controlBytes.push(data); };
  // Short-circuit the SERVER_SETUP wait so setup() resolves without a real
  // handshake.
  internals.waitForServerSetupDraft18 = async () => undefined;

  return { session, internals, controlBytes };
}

// The setup stream carries the same KVP-based SETUP frame in both directions;
// draft-18 uses one message type per direction but the wire body is identical,
// so decoding a CLIENT_SETUP with the (typed as ServerSetupMessage) decoder is
// safe and lets us assert on the round-tripped MOQT_IMPLEMENTATION field.
function decodeSetup(bytes: Uint8Array): ServerSetupMessageDraft18 {
  return Draft18MessageCodec.decodeSetupStream(bytes)[0];
}

describe.skipIf(!IS_DRAFT_18)('draft-18 MOQT_IMPLEMENTATION', () => {
  it('sends moq-web in CLIENT_SETUP by default', async () => {
    const { session, controlBytes } = makeSession();

    await session.setup();

    expect(controlBytes.length).toBeGreaterThan(0);
    // The setup stream omits the message-type prefix, so decode returns the
    // codec's SERVER_SETUP shape regardless of direction.
    const decoded = decodeSetup(controlBytes[0]);
    expect(decoded.moqtImplementation).toBe('moq-web');
  });

  it('sends the configured implementation string instead', async () => {
    const { session, controlBytes } = makeSession();

    session.setImplementationString('cats-and-dogs 4.2.0');
    await session.setup();

    const decoded = decodeSetup(controlBytes[0]);
    expect(decoded.moqtImplementation).toBe('cats-and-dogs 4.2.0');
  });

  it('setImplementationString(undefined) sends none', async () => {
    const { session, controlBytes } = makeSession();

    session.setImplementationString('will-be-cleared');
    session.setImplementationString(undefined);
    await session.setup();

    expect(decodeSetup(controlBytes[0]).moqtImplementation).toBeUndefined();
  });

  it('rejects an empty string (caller should pass undefined to disable)', () => {
    const { session } = makeSession();
    expect(() => session.setImplementationString('')).toThrow(/non-empty/);
  });

  it('rejects setImplementationString() after setup() has moved past "none"', async () => {
    const { session } = makeSession();
    await session.setup();
    expect(() => session.setImplementationString('too-late')).toThrow(/after setup\(\)/);
  });
});
