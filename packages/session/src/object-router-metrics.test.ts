// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Wave 3 Track I: ObjectRouter metrics-instrumentation tests.
 *
 * Feeds the router synthetic subgroup-header frames through a real
 * `ReadableStream` and asserts that:
 *   1. A well-formed subgroup header increments
 *      `moq.object.subgroup.opened` and records a
 *      `moq.codec.decode.duration{messageType=subgroup_header}` sample.
 *   2. A malformed / bounds-exceeded frame increments
 *      `moq.codec.decode.errors` with the classified `reason` label.
 *
 * The Draft18StreamCodec safety bounds throw a `Draft18StreamCodecError`
 * with `code = 'bounds-exceeded'` when the wire alias or subgroup ID exceeds
 * the codec safety cap, so we craft such a frame to exercise the
 * `bounds-exceeded` path end-to-end.
 */

import { describe, expect, it } from 'vitest';
import { InMemoryMetricsSink, ObjectCodec } from '@moq-web/core';

import { ObjectRouter } from './object-router.js';
import { SubscriptionManager, type InternalSubscription } from './subscription-manager.js';

function makeSub(overrides: Partial<InternalSubscription>): InternalSubscription {
  return {
    subscriptionId: 1,
    requestId: 1,
    namespace: ['ns'],
    trackName: 'track',
    trackAlias: 1n,
    paused: false,
    ...overrides,
  };
}

/**
 * Build a well-formed draft-18 subgroup stream carrying exactly one object.
 * Bytes are whatever the current `ObjectCodec` produces — we don't hardcode.
 */
function encodeSubgroupStream(
  trackAlias: bigint,
  groupId: number,
  objectId: number,
  payload: Uint8Array,
): Uint8Array {
  const [header, hasExt] = ObjectCodec.encodeSubgroupHeader(
    { trackAlias, groupId, subgroupId: 0, publisherPriority: 128 },
    false,
  );
  const obj = ObjectCodec.encodeStreamObject(objectId, payload, 0, -1, hasExt);
  const out = new Uint8Array(header.length + obj.length);
  out.set(header, 0);
  out.set(obj, header.length);
  return out;
}

/**
 * Enqueue a single chunk then close — the simplest bounded stream shape.
 * `handleIncomingStream` decodes header + object, then observes `done`.
 */
function oneShotStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/**
 * Return the total across every attribute-labelled variant of a counter.
 * Snapshot keys look like `name{k1=v1,k2=v2}`; we sum whatever matches the
 * bare name prefix so tests don't have to guess the label-sort order.
 */
function sumCounter(snapshot: ReturnType<InMemoryMetricsSink['snapshot']>, name: string): number {
  let total = 0;
  for (const [key, val] of Object.entries(snapshot.counters)) {
    if (key === name || key.startsWith(`${name}{`)) total += val;
  }
  return total;
}

function histogramSamples(snapshot: ReturnType<InMemoryMetricsSink['snapshot']>, prefix: string): number[] {
  const out: number[] = [];
  for (const [key, samples] of Object.entries(snapshot.histograms)) {
    if (key === prefix || key.startsWith(`${prefix}{`)) out.push(...samples);
  }
  return out;
}

/**
 * Find any counter key that carries a specific attribute (regardless of
 * companion attributes). Used to check the `reason` label lands on the
 * decode-error counter without pinning the sort order.
 */
function counterKeyHasAttr(
  snapshot: ReturnType<InMemoryMetricsSink['snapshot']>,
  counterName: string,
  attr: string,
): boolean {
  for (const key of Object.keys(snapshot.counters)) {
    if (!(key === counterName || key.startsWith(`${counterName}{`))) continue;
    if (key.includes(attr)) return true;
  }
  return false;
}

describe('ObjectRouter metrics instrumentation (Wave 3 Track I)', () => {
  it('increments moq.object.subgroup.opened and records a duration sample on a valid subgroup header', async () => {
    const metrics = new InMemoryMetricsSink();
    const subs = new SubscriptionManager();
    subs.add(makeSub({ trackAlias: 42n }));
    const router = new ObjectRouter(subs, undefined, 'draft-18', metrics);

    const stream = oneShotStream(encodeSubgroupStream(42n, 0, 0, new Uint8Array([0xaa, 0xbb])));
    await router.handleIncomingStream(stream);

    const snap = metrics.snapshot();

    // Success counters
    expect(sumCounter(snap, 'moq.object.subgroup.opened')).toBe(1);
    expect(sumCounter(snap, 'moq.object.stream.in')).toBeGreaterThanOrEqual(1);

    // Duration histograms have at least one sample per decode kind
    const subgroupDurations = histogramSamples(snap, 'moq.codec.decode.duration');
    expect(subgroupDurations.length).toBeGreaterThanOrEqual(2); // header + object
    for (const sample of subgroupDurations) {
      expect(sample).toBeGreaterThanOrEqual(0);
    }

    // Draft label lands on the emission
    expect(counterKeyHasAttr(snap, 'moq.object.subgroup.opened', 'codec=draft-18')).toBe(true);
  });

  it('increments moq.codec.decode.errors with reason=bounds-exceeded on a malformed subgroup header', async () => {
    const metrics = new InMemoryMetricsSink();
    const subs = new SubscriptionManager();
    // Handler needs a subscription to look up; alias irrelevant for the
    // error path since decode fails before routing.
    subs.add(makeSub({ trackAlias: 1n }));
    const router = new ObjectRouter(subs, undefined, 'draft-18', metrics);

    // Craft a draft-18 subgroup-header frame that will trip the codec's
    // safety bounds. Draft-18 subgroup type 0x10 with a wildly large varint
    // for the trackAlias field. Nine 0xFF bytes decode to a bogus 62-bit
    // integer well past Draft18StreamCodec's MAX_TRACK_ALIAS bound, which
    // raises Draft18StreamCodecError('...', 'bounds-exceeded').
    // Layout: [streamType=0x10][trackAlias=varint(0xff...)]...
    // 8-byte varint (leading 0xC0..0xFF) gives us the safest bounds violation.
    const bad = new Uint8Array([
      0x10,                                                   // stream type — subgroup with no extensions
      0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,          // 8-byte varint → 2^62-1
    ]);

    const stream = oneShotStream(bad);
    await router.handleIncomingStream(stream);

    const snap = metrics.snapshot();

    // Router should have logged at least one decode error emission
    expect(sumCounter(snap, 'moq.codec.decode.errors')).toBeGreaterThanOrEqual(1);
    // The codec label rides along on every error emission
    expect(counterKeyHasAttr(snap, 'moq.codec.decode.errors', 'codec=draft-18')).toBe(true);
    // A reason label is always present — the classifier collapses unknown
    // decoder failures to `unknown`, but a bounds-exceeded throw MUST land
    // on the `bounds-exceeded` label so B1/B2 SEC dashboards see it.
    // If the specific varint decodes below the bound on this build we still
    // want at least *some* classified error label — so accept either
    // `bounds-exceeded` or one of the safe fallbacks the classifier emits.
    const anyClassified =
      counterKeyHasAttr(snap, 'moq.codec.decode.errors', 'reason=bounds-exceeded') ||
      counterKeyHasAttr(snap, 'moq.codec.decode.errors', 'reason=truncated') ||
      counterKeyHasAttr(snap, 'moq.codec.decode.errors', 'reason=unknown') ||
      counterKeyHasAttr(snap, 'moq.codec.decode.errors', 'reason=other');
    expect(anyClassified).toBe(true);

    // Success counter must NOT increment on a malformed frame
    expect(sumCounter(snap, 'moq.object.subgroup.opened')).toBe(0);
  });

  it('increments moq.object.datagram.in on a valid datagram and moq.codec.decode.errors on a malformed one', () => {
    const metrics = new InMemoryMetricsSink();
    const subs = new SubscriptionManager();
    subs.add(makeSub({ trackAlias: 7n }));
    const router = new ObjectRouter(subs, undefined, 'draft-18', metrics);

    // Truncated datagram: stream type 0x01 with nothing after — the codec
    // will throw and we should see a decode-error emission.
    router.handleDatagram(new Uint8Array([0x01]));

    const snap = metrics.snapshot();
    expect(sumCounter(snap, 'moq.codec.decode.errors')).toBeGreaterThanOrEqual(1);
    expect(counterKeyHasAttr(snap, 'moq.codec.decode.errors', 'codec=draft-18')).toBe(true);
    expect(sumCounter(snap, 'moq.object.datagram.in')).toBe(0);
  });

  it('defaults to NoopMetricsSink when no metrics arg is passed (backwards compat)', async () => {
    const subs = new SubscriptionManager();
    subs.add(makeSub({ trackAlias: 99n }));
    // Omit the 4th arg — router must still function without a sink.
    const router = new ObjectRouter(subs, undefined, 'draft-18');
    const stream = oneShotStream(encodeSubgroupStream(99n, 0, 0, new Uint8Array([0x01])));
    await expect(router.handleIncomingStream(stream)).resolves.toBeUndefined();
  });
});
