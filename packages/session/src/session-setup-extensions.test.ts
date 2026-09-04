// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Unit tests for the draft-18 §3.2 SETUP extension advertisement API on
 * `MOQTSession`. We verify:
 *   1. `setClientExtensions()` stores extensions and rejects mutation after
 *      `setup()` has started;
 *   2. peer extensions from SERVER_SETUP land in `session.peerExtensions`;
 *   3. the codec round-trips a session-provided extension map through the
 *      encoded SETUP payload (surface test — the codec itself is covered
 *      exhaustively in draft18-message-codec.test.ts).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  Draft18MessageCodec,
  MOQTransport,
  MessageTypeDraft18,
  SetupOptionDraft18,
  type ClientSetupMessageDraft18,
  type ControlMessageDraft18,
  type ServerSetupMessageDraft18,
  type SetupExtensionValue,
} from '@moq-web/core';

import { MOQTSession } from './session.js';

function makeSession(): MOQTSession {
  const transport = new MOQTransport();
  (transport as unknown as { close: typeof transport.close }).close = vi.fn().mockResolvedValue(undefined);
  return new MOQTSession(transport);
}

describe('draft-18 §3.2 setClientExtensions()', () => {
  it('stores the extension map so it can flow into CLIENT_SETUP', () => {
    const session = makeSession();
    const ext = new Map<number, SetupExtensionValue>([
      [0x40, { varint: 42n }],
      [0x41, { bytes: new TextEncoder().encode('cluster-a') }],
    ]);

    session.setClientExtensions(ext);

    // Extensions are private, but the codec round-trip below confirms they
    // reach the wire.
    expect((session as unknown as { _clientExtensions?: Map<number, SetupExtensionValue> })._clientExtensions).toBe(ext);
  });

  it('rejects setClientExtensions() after setup() has moved past "none"', () => {
    const session = makeSession();
    (session as unknown as { _state: string })._state = 'setup';

    expect(() =>
      session.setClientExtensions(new Map([[0x40, { varint: 1n }]])),
    ).toThrow(/after setup\(\)/);
  });

  it('accepts undefined to clear previously registered extensions', () => {
    const session = makeSession();
    session.setClientExtensions(new Map([[0x40, { varint: 1n }]]));
    session.setClientExtensions(undefined);
    expect((session as unknown as { _clientExtensions?: unknown })._clientExtensions).toBeUndefined();
  });

  it('extensions round-trip through Draft18MessageCodec.encodeSetupStream', () => {
    const ext = new Map<number, SetupExtensionValue>([
      [0x40, { varint: 42n }],
      [0x41, { bytes: new Uint8Array([0xde, 0xad, 0xbe, 0xef]) }],
    ]);

    // Mirror what session.setup() constructs for the outgoing CLIENT_SETUP.
    const clientSetup: ClientSetupMessageDraft18 = {
      type: MessageTypeDraft18.CLIENT_SETUP,
      moqtImplementation: 'moq-web 0.1.0',
      extensions: ext,
    };
    const bytes = Draft18MessageCodec.encodeSetupStream(clientSetup);
    const [decoded] = Draft18MessageCodec.decodeSetupStream(bytes);

    expect(decoded.extensions).toBeDefined();
    expect(decoded.extensions!.size).toBe(2);
    const evenKey = decoded.extensions!.get(0x40);
    const oddKey = decoded.extensions!.get(0x41);
    expect(evenKey && 'varint' in evenKey && evenKey.varint).toBe(42n);
    expect(oddKey && 'bytes' in oddKey).toBe(true);
    if (oddKey && 'bytes' in oddKey) {
      expect(Array.from(oddKey.bytes)).toEqual([0xde, 0xad, 0xbe, 0xef]);
    }
  });

  it('rejects a client extension key that collides with a reserved SetupOption', () => {
    const session = makeSession();
    session.setClientExtensions(
      new Map<number, SetupExtensionValue>([
        // PATH is reserved — the codec must refuse to encode it as an extension.
        [SetupOptionDraft18.PATH, { bytes: new TextEncoder().encode('/moq') }],
      ]),
    );

    const clientSetup: ClientSetupMessageDraft18 = {
      type: MessageTypeDraft18.CLIENT_SETUP,
      moqtImplementation: 'moq-web 0.1.0',
      extensions: (session as unknown as { _clientExtensions: Map<number, SetupExtensionValue> })._clientExtensions,
    };
    expect(() => Draft18MessageCodec.encodeSetupStream(clientSetup)).toThrow(/reserved/i);
  });
});

describe('draft-18 §3.2 peerExtensions', () => {
  it('is undefined before SERVER_SETUP arrives', () => {
    const session = makeSession();
    expect(session.peerExtensions).toBeUndefined();
  });

  it('captures the extension map when SERVER_SETUP is processed', () => {
    const session = makeSession();

    // Drive the private setup-message handler with a synthetic SERVER_SETUP.
    const serverSetup: ServerSetupMessageDraft18 = {
      type: MessageTypeDraft18.SERVER_SETUP,
      selectedVersion: 0xff00_0012,
      extensions: new Map<number, SetupExtensionValue>([
        [0x50, { varint: 7n }],
        [0x51, { bytes: new TextEncoder().encode('relay-x') }],
      ]),
    };

    // waitForServerSetupDraft18() is private and installs `onSetupMessage`
    // synchronously — kick it off, then feed the message directly.
    const p = (session as unknown as {
      waitForServerSetupDraft18(): Promise<void>;
    }).waitForServerSetupDraft18();
    const handler = (session as unknown as {
      onSetupMessage?: (m: ControlMessageDraft18) => void;
    }).onSetupMessage!;
    handler(serverSetup);

    return p.then(() => {
      expect(session.peerExtensions).toBeDefined();
      expect(session.peerExtensions!.size).toBe(2);
      const v = session.peerExtensions!.get(0x50);
      expect(v && 'varint' in v && v.varint).toBe(7n);
    });
  });

  it('stays undefined when SERVER_SETUP carries no extensions', () => {
    const session = makeSession();
    const serverSetup: ServerSetupMessageDraft18 = {
      type: MessageTypeDraft18.SERVER_SETUP,
      selectedVersion: 0xff00_0012,
    };
    const p = (session as unknown as {
      waitForServerSetupDraft18(): Promise<void>;
    }).waitForServerSetupDraft18();
    const handler = (session as unknown as {
      onSetupMessage?: (m: ControlMessageDraft18) => void;
    }).onSetupMessage!;
    handler(serverSetup);

    return p.then(() => {
      expect(session.peerExtensions).toBeUndefined();
    });
  });
});
