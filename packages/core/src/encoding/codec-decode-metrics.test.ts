// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Wave 2 Track E — codec decode-metrics tests.
 *
 * Verifies that `IProtocolCodec.decodeControlMessage` emits
 * `moq.codec.decode.errors{codec,reason}` when the decoder throws, and
 * `moq.codec.decode.duration{codec,messageType}` on the happy path.
 */

import { describe, it, expect } from 'vitest';
import {
  getProtocolCodecForVersion,
  Version,
  InMemoryMetricsSink,
  Draft18MessageCodec,
  MessageTypeDraft18,
  Draft18BufferWriter,
  MOQTVarInt,
} from '../index.js';

/** Wrap a payload with a draft-18 control-message envelope (type + 16-bit length). */
function frame(type: MessageTypeDraft18, payload: Uint8Array): Uint8Array {
  const typeBytes = MOQTVarInt.encode(type);
  const out = new Uint8Array(typeBytes.length + 2 + payload.length);
  out.set(typeBytes, 0);
  out[typeBytes.length] = (payload.length >> 8) & 0xff;
  out[typeBytes.length + 1] = payload.length & 0xff;
  out.set(payload, typeBytes.length + 2);
  return out;
}

describe('codec decode metrics (Wave 2 Track E)', () => {
  it('increments moq.codec.decode.errors{reason=bounds-exceeded} on a bounds-exceeded frame', () => {
    const metrics = new InMemoryMetricsSink();
    const codec = getProtocolCodecForVersion(Version.DRAFT_18);

    // Build a PUBLISH_NAMESPACE frame whose namespace-tuple count exceeds
    // MAX_NAMESPACE_TUPLE_COUNT (32). This is the shortest reliable path to
    // trigger `assertBound(... 'bounds-exceeded')` inside the draft-18 codec.
    const payload = new Draft18BufferWriter();
    payload.writeVarInt(0n); // request_id
    payload.writeVarInt(100n); // namespace tuple count — well above 32
    const buf = frame(MessageTypeDraft18.PUBLISH_NAMESPACE, payload.toUint8Array());

    expect(() => codec.decodeControlMessage(buf, 0, metrics)).toThrow();

    const snap = metrics.snapshot();
    // Assert the bounds-exceeded counter fired for draft-18.
    expect(snap.counters['moq.codec.decode.errors{codec=draft-18,reason=bounds-exceeded}']).toBe(
      1,
    );
    // And there was no successful decode duration sample.
    expect(Object.keys(snap.histograms)).toHaveLength(0);
  });

  it('records moq.codec.decode.duration on successful decode', () => {
    const metrics = new InMemoryMetricsSink();
    const codec = getProtocolCodecForVersion(Version.DRAFT_18);

    // Encode a valid draft-18 GOAWAY (empty new_session_uri) so we have a
    // frame that decodes cleanly, then feed it back through the metrics-aware
    // decoder.
    const encoded = Draft18MessageCodec.encode({
      type: MessageTypeDraft18.GOAWAY,
      newSessionUri: '',
      timeout: 0n,
    });

    const [msg] = codec.decodeControlMessage(encoded, 0, metrics);
    expect(msg.type).toBe(MessageTypeDraft18.GOAWAY);

    const snap = metrics.snapshot();
    const durationKeys = Object.keys(snap.histograms).filter((k) =>
      k.startsWith('moq.codec.decode.duration{codec=draft-18'),
    );
    expect(durationKeys.length).toBeGreaterThanOrEqual(1);
    expect(snap.counters['moq.codec.decode.errors{codec=draft-18,reason=bounds-exceeded}']).toBeUndefined();
  });
});
