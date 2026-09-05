// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview MSF §14 — MoQ Metrics (moqmetrics) track wiring.
 *
 * Provides:
 *  - Namespace / name helpers (`moq://metrics.moq.arpa/v1/` + resourceID).
 *  - Group ID (millis since epoch) + Object ID layout rules
 *    (Object 0 = capture timestamp + attributes; Object 1+ = per-metric).
 *  - Metric value schemas: Gauge & Counter, each accepting float or int.
 *
 * MSF §14.5 also requires that a metrics track appears in the catalog
 * `publishTracks` array with `packaging="moqmetrics"` and `role="metrics"`.
 * That check lives in {@link ../schemas/track.ts} `TrackSchema` superRefine
 * so it fires wherever the track is parsed.
 */

import { z } from 'zod';

/**
 * Base namespace tuple for MOQMETRICS per {{MOQMETRICS}} §3.
 * A metrics track's full namespace is `[METRICS_NAMESPACE_BASE, resourceId]`.
 */
export const METRICS_NAMESPACE_BASE = 'moq://metrics.moq.arpa/v1/' as const;

/**
 * Granularity levels used as the Track Name — mirror syslog severities:
 * lower number = more critical / always-reported metric.
 */
export enum MetricsGranularity {
  Emergency = 0,
  Alert = 1,
  Critical = 2,
  Error = 3,
  Warning = 4,
  Notice = 5,
  Info = 6,
  Debug = 7,
}

/**
 * Build the metrics-track namespace tuple for a given resource id.
 */
export function metricsNamespace(resourceId: string): [string, string] {
  if (!resourceId) {
    throw new MetricsTrackError(
      'resourceId is required for metrics track namespace'
    );
  }
  return [METRICS_NAMESPACE_BASE, resourceId];
}

/**
 * Encode a metrics-track Track Name.
 *
 * Per MSF §14.3 the Track Name is a single tuple carrying the granularity
 * level. We render it as a stringified integer for JSON-friendly transport;
 * transport layers MAY encode as a single byte if they prefer.
 */
export function encodeMetricsTrackName(level: MetricsGranularity): [string] {
  if (!Number.isInteger(level) || level < 0 || level > 7) {
    throw new MetricsTrackError(
      `granularity must be integer in [0, 7] per MSF §14.3, got ${level}`
    );
  }
  return [String(level)];
}

/**
 * Decode a metrics-track Track Name tuple back into {@link MetricsGranularity}.
 */
export function decodeMetricsTrackName(name: [string]): MetricsGranularity {
  if (!Array.isArray(name) || name.length !== 1) {
    throw new MetricsTrackError('metrics Track Name must be a 1-tuple per MSF §14.3');
  }
  const parsed = Number.parseInt(name[0], 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 7) {
    throw new MetricsTrackError(
      `metrics Track Name tuple element must be in [0, 7], got '${name[0]}'`
    );
  }
  return parsed as MetricsGranularity;
}

/** Maximum value for a 62-bit unsigned integer (matches MOQT varint u62). */
const MAX_U62 = (1n << 62n) - 1n;

/**
 * Compute Group ID (milliseconds since epoch) from a Date or number.
 * Truncated to 62 bits per MOQT object model.
 */
export function metricsGroupIdFromMillis(millis: number): bigint {
  if (!Number.isFinite(millis) || millis < 0) {
    throw new MetricsTrackError(
      `millis must be a non-negative finite number, got ${millis}`
    );
  }
  return BigInt(Math.floor(millis)) & MAX_U62;
}

/**
 * Fixed Object ID conventions from MSF §14.4:
 * - 0 → capture header (nanosecond timestamp + attributes)
 * - ≥1 → individual metric records
 */
export const METRICS_HEADER_OBJECT_ID = 0 as const;

/**
 * MSF §14.2 — Gauge value (spot reading).
 */
export const GaugeSchema = z.object({
  type: z.literal('gauge'),
  /** 64-bit float or integer. Integers are conveyed as JS numbers up to 2^53-1. */
  value: z.number(),
  /** Optional unit hint (RFC 3339-like syntax). */
  unit: z.string().optional(),
});
export type Gauge = z.infer<typeof GaugeSchema>;

/**
 * MSF §14.2 — Counter value (monotonically non-decreasing).
 */
export const CounterSchema = z.object({
  type: z.literal('counter'),
  value: z.number(),
  unit: z.string().optional(),
});
export type Counter = z.infer<typeof CounterSchema>;

/**
 * Metric value union — extend as new value types are registered.
 */
export const MetricValueSchema = z.discriminatedUnion('type', [
  GaugeSchema,
  CounterSchema,
]);
export type MetricValue = z.infer<typeof MetricValueSchema>;

/**
 * Capture-header object payload (Object ID = 0) per MSF §14.4.
 */
export const MetricsHeaderSchema = z
  .object({
    /** Capture timestamp as Unix epoch NANOSECONDS. */
    captureNanos: z.union([z.number(), z.string()]),
    /** Optional attribute set describing the resource. */
    attributes: z.record(z.string()).optional(),
  })
  .passthrough();
export type MetricsHeader = z.infer<typeof MetricsHeaderSchema>;

/**
 * Individual metric record payload (Object ID ≥ 1) per MSF §14.4.
 */
export const MetricRecordSchema = z
  .object({
    /** Metric name. Naming rules mirror OpenTelemetry / Prometheus. */
    name: z.string().min(1),
    /** One of the registered {@link MetricValue} shapes. */
    value: MetricValueSchema,
    /** Optional dimensional attributes overriding the header defaults. */
    attributes: z.record(z.string()).optional(),
  })
  .passthrough();
export type MetricRecord = z.infer<typeof MetricRecordSchema>;

/**
 * Error thrown by metrics-track helpers.
 */
export class MetricsTrackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetricsTrackError';
  }
}
