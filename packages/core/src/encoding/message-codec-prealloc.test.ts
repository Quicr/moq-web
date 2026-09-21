// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Regression tests for the PreallocBufferWriter wiring inside
 * `MessageCodec.encode`.
 *
 * These lock in three properties introduced by the perf pass:
 *   1. `encode()` returns a fully-owned Uint8Array — mutations must not leak
 *      into subsequent encode calls (would happen if we accidentally handed
 *      back a subarray view over a reused buffer).
 *   2. Repeated encode calls of the same message produce byte-identical
 *      output (deterministic across the pre-allocated / grown buffer path).
 *   3. Messages large enough to exceed the initial capacity still encode
 *      correctly (exercises `ensureCapacity` growth path).
 */

import { describe, it, expect } from 'vitest';
import { MessageCodec } from './message-codec.js';
import {
  MessageType,
  Version,
  SetupParameter,
  type ClientSetupMessage,
  type PublishNamespaceMessage,
} from '../messages/types.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only shim
const asAny = (m: unknown) => m as any;

describe('MessageCodec.encode / PreallocBufferWriter', () => {
  it('returns a fully-owned buffer (mutation isolation)', () => {
    const msg: ClientSetupMessage = {
      type: MessageType.CLIENT_SETUP,
      supportedVersions: [Version.DRAFT_14],
      parameters: new Map<SetupParameter, number | string | Uint8Array>([
        [SetupParameter.PATH, '/moq'],
      ]),
    };

    const first = MessageCodec.encode(asAny(msg));
    // Overwrite every byte of `first` and re-encode: the second encoding
    // must be unaffected by the mutation (regression against returning a
    // subarray of a shared/reused PreallocBufferWriter buffer).
    first.fill(0xaa);
    const second = MessageCodec.encode(asAny(msg));
    expect(second).not.toEqual(first);
    // Ensure `second` doesn't contain the poison byte for its whole length.
    expect(second.every((b) => b === 0xaa)).toBe(false);
  });

  it('is deterministic across successive encodes', () => {
    const msg: ClientSetupMessage = {
      type: MessageType.CLIENT_SETUP,
      supportedVersions: [Version.DRAFT_14],
      parameters: new Map<SetupParameter, number | string | Uint8Array>([
        [SetupParameter.PATH, '/moq/some-longer-path-name-to-vary-length'],
      ]),
    };

    const a = MessageCodec.encode(asAny(msg));
    const b = MessageCodec.encode(asAny(msg));
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('grows the pre-allocated buffer for oversized messages', () => {
    // Force a large payload to exceed the 512-byte initial capacity so the
    // growth path in PreallocBufferWriter is exercised end-to-end.
    const bigNamespace: string[] = [];
    for (let i = 0; i < 20; i++) {
      bigNamespace.push('segment-' + i + '-' + 'x'.repeat(40));
    }
    const msg: PublishNamespaceMessage = {
      type: MessageType.PUBLISH_NAMESPACE,
      namespace: bigNamespace,
      parameters: undefined,
    };

    const encoded = MessageCodec.encode(asAny(msg));
    // Sanity: the encoded frame is well past the initial 512-byte capacity.
    expect(encoded.length).toBeGreaterThan(600);

    // Roundtrip: the decoder must recover the original namespace exactly.
    const [decoded] = MessageCodec.decode(encoded);
    expect(decoded.type).toBe(MessageType.PUBLISH_NAMESPACE);
    // The decoded shape is a PublishNamespaceMessage; verify namespace roundtrips.
    expect((decoded as PublishNamespaceMessage).namespace).toEqual(bigNamespace);
  });
});
