// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Metrics sink abstraction for MOQT operations
 *
 * Provides a minimal, provider-agnostic metrics API that MOQT internals can
 * emit against without depending on any specific vendor SDK. Consumers wire a
 * concrete sink (OpenTelemetry / Prometheus / StatsD adapter) once at session
 * construction and library code calls `counter/gauge/histogram` uniformly.
 *
 * The design goals are intentionally narrow:
 * - Zero allocations on the fast path when metrics are disabled
 *   (use `NoopMetricsSink`).
 * - Attribute maps are optional; when omitted a single global bucket is used.
 * - `InMemoryMetricsSink` provides an inspectable in-process implementation
 *   for tests, `getDiagnostics()`, and small deployments that don't want an
 *   external metrics pipeline.
 *
 * TODO(post-merge): once Track A/B/C have landed, wire additional
 * instrumentation points that this Wave1 Track D scope intentionally left
 * untouched:
 *   - `moq.transport.stream.opened` / `moq.transport.stream.reset` counters
 *     inside `packages/session/src/workers/transport-worker.ts` (Track B).
 *   - `moq.encoding.frame.encoded_bytes` histogram inside
 *     `packages/core/src/encoding/**` (Tracks A/B).
 *   - `moq.subscribe.gap_detected` counter inside `unified-session.ts`
 *     (Track C).
 *   - `moq.publish.object_bytes` histogram at `sendObjectViaStream()` /
 *     `sendObjectWithGOP()` — currently emitted only via publish-stats event.
 *   - `moq.session.reconnect.attempts` counter once the shared
 *     `ReconnectPolicy` from `@moq-web/session` is adopted by autoMigrate.
 *
 * @example
 * ```typescript
 * import { NoopMetricsSink, InMemoryMetricsSink } from '@moq-web/core';
 *
 * // Default: no metrics.
 * const sink = new NoopMetricsSink();
 * sink.counter('moq.session.state_transition', 1, { to: 'ready' });
 *
 * // In tests / diagnostics:
 * const inMemory = new InMemoryMetricsSink();
 * inMemory.counter('moq.session.close', 1, { reason: 'no-error' });
 * console.log(inMemory.snapshot()); // { 'moq.session.close': 1 }
 * ```
 */

/**
 * Attribute map attached to a metric emission. Keys and values are strings so
 * the sink can render them as OpenTelemetry attributes, Prometheus labels, or
 * StatsD tags without further coercion.
 */
export type MetricAttributes = Record<string, string>;

/**
 * Sink for MOQT-level metrics. Implementations MUST be safe to call from any
 * thread/worker and MUST NOT throw — errors inside a sink are swallowed by
 * the library to protect the fast path.
 */
export interface MetricsSink {
  /**
   * Monotonically increasing counter (events happened).
   *
   * @param name  Metric name (dot-separated, e.g. `moq.session.state_transition`)
   * @param value Positive delta to add (default `1`). Non-positive values are
   *              treated as `1` by well-behaved implementations to keep the
   *              contract "counter", not "gauge".
   * @param attrs Optional label map. Omit for the global (unlabeled) bucket.
   */
  counter(name: string, value?: number, attrs?: MetricAttributes): void;

  /**
   * Instantaneous gauge value (last-write-wins). Use for "current queue
   * depth", "connected subscribers", etc.
   */
  gauge(name: string, value: number, attrs?: MetricAttributes): void;

  /**
   * Distribution observation (durations, sizes). Sinks may aggregate into
   * histograms, summaries, or forward raw samples — the caller shouldn't
   * assume any specific bucketization.
   */
  histogram(name: string, value: number, attrs?: MetricAttributes): void;
}

/**
 * Default implementation. All methods are no-ops. Use this when metrics
 * collection isn't wanted or hasn't been configured — the fast path is a
 * single dispatched call with no allocations.
 */
export class NoopMetricsSink implements MetricsSink {
  counter(_name: string, _value?: number, _attrs?: MetricAttributes): void {
    /* no-op */
  }
  gauge(_name: string, _value: number, _attrs?: MetricAttributes): void {
    /* no-op */
  }
  histogram(_name: string, _value: number, _attrs?: MetricAttributes): void {
    /* no-op */
  }
}

/**
 * Snapshot of counter/gauge state at a point in time. Histogram values are
 * stored as raw sample arrays so consumers can compute percentiles or
 * forward the samples to an external aggregator.
 */
export interface MetricsSnapshot {
  /** Counter totals keyed by `name{k1=v1,k2=v2}` (attrs sorted). */
  counters: Record<string, number>;
  /** Last observed gauge value keyed the same way. */
  gauges: Record<string, number>;
  /** Raw histogram samples keyed the same way. */
  histograms: Record<string, number[]>;
}

function buildKey(name: string, attrs?: MetricAttributes): string {
  if (!attrs) return name;
  const keys = Object.keys(attrs);
  if (keys.length === 0) return name;
  keys.sort();
  let out = name + '{';
  for (let i = 0; i < keys.length; i++) {
    if (i > 0) out += ',';
    const k = keys[i];
    out += `${k}=${attrs[k]}`;
  }
  return out + '}';
}

/**
 * In-memory sink useful for tests and `session.getDiagnostics()`. Retains
 * counter totals, last-write gauges, and raw histogram samples. NOT designed
 * for high-cardinality production use — every unique attribute combination
 * allocates a distinct key.
 */
export class InMemoryMetricsSink implements MetricsSink {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly histograms = new Map<string, number[]>();

  counter(name: string, value: number = 1, attrs?: MetricAttributes): void {
    const delta = value > 0 ? value : 1;
    const key = buildKey(name, attrs);
    this.counters.set(key, (this.counters.get(key) ?? 0) + delta);
  }

  gauge(name: string, value: number, attrs?: MetricAttributes): void {
    const key = buildKey(name, attrs);
    this.gauges.set(key, value);
  }

  histogram(name: string, value: number, attrs?: MetricAttributes): void {
    const key = buildKey(name, attrs);
    let bucket = this.histograms.get(key);
    if (!bucket) {
      bucket = [];
      this.histograms.set(key, bucket);
    }
    bucket.push(value);
  }

  /**
   * Read all counter totals as a plain object. Convenience wrapper for
   * `session.getDiagnostics()` which returns `Record<string, number>`.
   */
  counterTotals(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, v] of this.counters) out[k] = v;
    return out;
  }

  /**
   * Full point-in-time snapshot. Returned objects are fresh copies, safe to
   * hand to callers or serialize.
   */
  snapshot(): MetricsSnapshot {
    const snapshot: MetricsSnapshot = {
      counters: this.counterTotals(),
      gauges: {},
      histograms: {},
    };
    for (const [k, v] of this.gauges) snapshot.gauges[k] = v;
    for (const [k, v] of this.histograms) snapshot.histograms[k] = v.slice();
    return snapshot;
  }

  /** Wipe all recorded state. Useful between test cases. */
  reset(): void {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
  }
}
