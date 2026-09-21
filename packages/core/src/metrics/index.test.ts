// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryMetricsSink, NoopMetricsSink } from './index.js';

describe('NoopMetricsSink', () => {
  it('accepts calls without throwing', () => {
    const sink = new NoopMetricsSink();
    expect(() => sink.counter('foo')).not.toThrow();
    expect(() => sink.counter('foo', 5, { a: 'b' })).not.toThrow();
    expect(() => sink.gauge('bar', 7)).not.toThrow();
    expect(() => sink.histogram('baz', 42, { c: 'd' })).not.toThrow();
  });
});

describe('InMemoryMetricsSink', () => {
  let sink: InMemoryMetricsSink;

  beforeEach(() => {
    sink = new InMemoryMetricsSink();
  });

  it('accumulates counters with default delta 1', () => {
    sink.counter('moq.session.state_transition');
    sink.counter('moq.session.state_transition');
    sink.counter('moq.session.state_transition');
    expect(sink.counterTotals()).toEqual({
      'moq.session.state_transition': 3,
    });
  });

  it('accumulates counters with explicit delta', () => {
    sink.counter('moq.bytes.sent', 500);
    sink.counter('moq.bytes.sent', 250);
    expect(sink.counterTotals()).toEqual({ 'moq.bytes.sent': 750 });
  });

  it('coerces non-positive counter deltas to 1', () => {
    sink.counter('moq.calls', 0);
    sink.counter('moq.calls', -10);
    expect(sink.counterTotals()['moq.calls']).toBe(2);
  });

  it('keeps separate buckets per attribute combination', () => {
    sink.counter('moq.session.close', 1, { reason: 'no_error' });
    sink.counter('moq.session.close', 1, { reason: 'no_error' });
    sink.counter('moq.session.close', 1, { reason: 'timeout' });
    const totals = sink.counterTotals();
    expect(totals['moq.session.close{reason=no_error}']).toBe(2);
    expect(totals['moq.session.close{reason=timeout}']).toBe(1);
  });

  it('produces a stable key regardless of attribute insertion order', () => {
    sink.counter('m', 1, { b: '2', a: '1' });
    sink.counter('m', 1, { a: '1', b: '2' });
    expect(sink.counterTotals()['m{a=1,b=2}']).toBe(2);
  });

  it('records gauges as last-write-wins', () => {
    sink.gauge('moq.queue.depth', 5);
    sink.gauge('moq.queue.depth', 3);
    sink.gauge('moq.queue.depth', 7);
    expect(sink.snapshot().gauges['moq.queue.depth']).toBe(7);
  });

  it('stores histogram samples as raw arrays', () => {
    sink.histogram('moq.rtt', 100);
    sink.histogram('moq.rtt', 120);
    sink.histogram('moq.rtt', 90);
    const snap = sink.snapshot();
    expect(snap.histograms['moq.rtt']).toEqual([100, 120, 90]);
  });

  it('snapshot returns independent copies', () => {
    sink.counter('c', 1);
    sink.histogram('h', 1);
    const snap = sink.snapshot();
    sink.counter('c', 1);
    sink.histogram('h', 2);
    expect(snap.counters['c']).toBe(1);
    expect(snap.histograms['h']).toEqual([1]);
  });

  it('reset clears all state', () => {
    sink.counter('c', 5);
    sink.gauge('g', 10);
    sink.histogram('h', 1);
    sink.reset();
    const snap = sink.snapshot();
    expect(snap.counters).toEqual({});
    expect(snap.gauges).toEqual({});
    expect(snap.histograms).toEqual({});
  });
});
