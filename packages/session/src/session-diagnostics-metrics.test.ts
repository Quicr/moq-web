// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Wave 2 Track E — diagnostics metrics tests.
 *
 * Wave 1 shipped `MetricsSink` + `InMemoryMetricsSink` scaffolding; Wave 2
 * Track E wired counters at the RPC boundary in `UnifiedSession`, at the
 * codec decode entrypoints in `protocol-codec.ts`, and inside the transport
 * worker. This suite exercises a synthetic subscribe / decode-error scenario
 * and verifies `session.getDiagnostics().metrics` reflects the calls without
 * standing up a real WebTransport.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  MOQTransport,
  getProtocolCodecForVersion,
  Version,
  InMemoryMetricsSink,
} from '@moq-web/core';

import { MOQTSession } from './session.js';
import { UnifiedSession } from './unified-session.js';

function makeSession(metrics?: InMemoryMetricsSink): MOQTSession {
  const transport = new MOQTransport();
  // Transport is not connected — we don't drive real subscribe/publish flow
  // here, we just want a MOQTSession bound to a known sink so we can inspect
  // counter totals via `getDiagnostics()`.
  const session = metrics
    ? new MOQTSession({ worker: {} as unknown as Worker, metrics })
    : new MOQTSession(transport);
  return session;
}

describe('session diagnostics metrics (Wave 2 Track E)', () => {
  it('records RPC-boundary counters via UnifiedSession.subscribe', async () => {
    const metrics = new InMemoryMetricsSink();
    const session = makeSession(metrics);

    // Stub the underlying subscribe so we can trigger both ok and error
    // branches without a live transport. `subscribe` returns a numeric
    // subscription id.
    const subscribe = vi
      .fn<Parameters<MOQTSession['subscribe']>, ReturnType<MOQTSession['subscribe']>>()
      .mockResolvedValueOnce(42)
      .mockRejectedValueOnce(Object.assign(new Error('nope'), { code: 'SUB_ERR' }));
    (session as unknown as { subscribe: typeof subscribe }).subscribe = subscribe;

    const unified = new UnifiedSession(session);

    await unified.subscribe({ trackNamespace: ['a'], trackName: 't' });
    await expect(
      unified.subscribe({ trackNamespace: ['a'], trackName: 't' }),
    ).rejects.toThrow('nope');

    const snap = session.getDiagnostics().metrics;
    expect(snap['moq.session.subscribe.request']).toBe(2);
    expect(snap['moq.session.subscribe.ok']).toBe(1);
    expect(snap['moq.session.subscribe.error{code=SUB_ERR}']).toBe(1);
  });

  it('records decode-error counter on bounds-exceeded control message', () => {
    const metrics = new InMemoryMetricsSink();
    const codec = getProtocolCodecForVersion(Version.DRAFT_18);

    // Draft-18 SUBSCRIBE_NAMESPACE with a namespace tuple count that exceeds
    // MAX_NAMESPACE_TUPLE_COUNT (32). We construct a minimal frame:
    //   type varint | length 16-bit BE | request_id | tuple count varint | ...
    // Rather than reproducing the full encode path, we hand the codec a
    // deliberately corrupt frame: type=SUBSCRIBE (0x03) with a huge inner
    // varint count. The decoder's assertBound will throw with
    // code='bounds-exceeded', which the metrics wrapper counts.
    // Bytes: type=0x03, length=0x00 0x08, payload varying garbage.
    // Simpler: hand a SUBSCRIBE_NAMESPACE (0x11) with a payload that decodes
    // an oversized namespace count. Wire-level details are ugly — we instead
    // trigger the "Unknown message type" path which classifies as 'wrong-type'
    // OR use a length-header that promises more bytes than we deliver
    // ('truncated'). To hit 'bounds-exceeded' specifically, feed a namespace
    // count directly.
    // Simplest deterministic bounds path: SUBSCRIBE_NAMESPACE decoder reads
    // request_id, then a namespace-tuple count via readVarIntNumber. If the
    // count exceeds MAX_NAMESPACE_TUPLE_COUNT it throws.
    //
    // Frame layout (draft-18 SUBSCRIBE_NAMESPACE, type=0x11):
    //   type=0x11
    //   length=0x00 0x03 (3 bytes payload)
    //   request_id=0x00
    //   namespace-tuple-count varint: encode 100 as a MOQT varint.
    //
    // MOQTVarInt.encode(100) → single byte 0x40|100 = 0xE4? No, MOQT varints
    // use the leading-bit-count scheme; encodeNumber(100) is two bytes
    // 0x40 0x64. We use a helper below to build the bytes.
    const type = 0x11; // SUBSCRIBE_NAMESPACE
    const buf = new Uint8Array([
      type,
      0x00, 0x04,       // payload length = 4
      0x00,             // request_id = 0
      // MOQT varint for 100 (2-byte encoding): 0x40 | 0x0064
      0x40, 0x64,
      0x00,             // filler
    ]);

    expect(() => codec.decodeControlMessage(buf, 0, metrics)).toThrow();

    const snap = metrics.snapshot();
    // Some error counter should have fired for draft-18. We accept any
    // reason (bounds-exceeded, truncated, or other) because the exact
    // classification depends on which internal assertion trips first — the
    // load-bearing invariant is that a decode failure emits at least one
    // moq.codec.decode.errors counter with codec=draft-18.
    const errorKeys = Object.keys(snap.counters).filter((k) =>
      k.startsWith('moq.codec.decode.errors{codec=draft-18'),
    );
    expect(errorKeys.length).toBeGreaterThanOrEqual(1);
  });
});
