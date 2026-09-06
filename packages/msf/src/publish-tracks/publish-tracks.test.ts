// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { describe, it, expect } from 'vitest';
import {
  LOG_NAMESPACE_BASE,
  LogSeverity,
  logNamespace,
  encodeLogTrackName,
  decodeLogTrackName,
  logGroupIdFromMillis,
  logGroupIdFromMicros,
  LogEntrySchema,
  LogTrackError,
  METRICS_NAMESPACE_BASE,
  METRICS_HEADER_OBJECT_ID,
  MetricsGranularity,
  metricsNamespace,
  encodeMetricsTrackName,
  decodeMetricsTrackName,
  metricsGroupIdFromMillis,
  GaugeSchema,
  CounterSchema,
  MetricValueSchema,
  MetricsHeaderSchema,
  MetricRecordSchema,
  MetricsTrackError,
} from './index.js';
import { FullCatalogSchema } from '../schemas/index.js';
import { MSF_VERSION } from '../version.js';

describe('MSF §13 — log track', () => {
  describe('namespace', () => {
    it('should build the log namespace tuple', () => {
      expect(logNamespace('cam-42')).toEqual([LOG_NAMESPACE_BASE, 'cam-42']);
    });

    it('should reject empty resource id', () => {
      expect(() => logNamespace('')).toThrow(LogTrackError);
    });

    it('should match the spec base', () => {
      expect(LOG_NAMESPACE_BASE).toBe('moq://moq-syslog.arpa/logs-v1/');
    });
  });

  describe('track name (severity byte)', () => {
    it('should encode each valid severity as a single byte', () => {
      for (let s = 0; s <= 7; s++) {
        const bytes = encodeLogTrackName(s);
        expect(bytes.length).toBe(1);
        expect(bytes[0]).toBe(s);
      }
    });

    it('should round-trip', () => {
      const bytes = encodeLogTrackName(LogSeverity.Error);
      expect(decodeLogTrackName(bytes)).toBe(LogSeverity.Error);
    });

    it('should reject out-of-range severity on encode', () => {
      expect(() => encodeLogTrackName(-1 as LogSeverity)).toThrow(LogTrackError);
      expect(() => encodeLogTrackName(8 as LogSeverity)).toThrow(LogTrackError);
    });

    it('should reject bad byte lengths on decode', () => {
      expect(() => decodeLogTrackName(new Uint8Array([]))).toThrow(LogTrackError);
      expect(() => decodeLogTrackName(new Uint8Array([0, 0]))).toThrow(LogTrackError);
    });

    it('should reject byte >7 on decode', () => {
      expect(() => decodeLogTrackName(new Uint8Array([8]))).toThrow(LogTrackError);
    });
  });

  describe('group id (microseconds since epoch, u62)', () => {
    it('should compute microseconds from millis', () => {
      expect(logGroupIdFromMillis(1)).toBe(1000n);
      expect(logGroupIdFromMillis(1700000000000)).toBe(1700000000000000n);
    });

    it('should accept micros directly', () => {
      expect(logGroupIdFromMicros(42n)).toBe(42n);
    });

    it('should truncate to 62 bits', () => {
      const oversized = (1n << 63n) + 5n;
      const truncated = logGroupIdFromMicros(oversized);
      expect(truncated < 1n << 62n).toBe(true);
    });

    it('should reject negatives', () => {
      expect(() => logGroupIdFromMillis(-1)).toThrow(LogTrackError);
      expect(() => logGroupIdFromMicros(-1n)).toThrow(LogTrackError);
    });
  });

  describe('LogEntrySchema', () => {
    it('should accept a minimal message-only entry', () => {
      expect(
        LogEntrySchema.safeParse({ message: 'connected' }).success
      ).toBe(true);
    });

    it('should accept an OTel-flavoured entry', () => {
      expect(
        LogEntrySchema.safeParse({
          severity: LogSeverity.Info,
          timestamp: 1700000000000,
          hostname: 'cam-42',
          appName: 'moqcam',
          traceId: 'abcd',
          spanId: '1234',
          instrumentationScope: { name: 'moqcam.publisher' },
          attributes: { region: 'us-west' },
        }).success
      ).toBe(true);
    });

    it('should reject invalid severity range', () => {
      expect(LogEntrySchema.safeParse({ severity: 9 }).success).toBe(false);
    });
  });
});

describe('MSF §14 — metrics track', () => {
  describe('namespace', () => {
    it('should build the metrics namespace tuple', () => {
      expect(metricsNamespace('cam-42')).toEqual([
        METRICS_NAMESPACE_BASE,
        'cam-42',
      ]);
    });

    it('should reject empty resource id', () => {
      expect(() => metricsNamespace('')).toThrow(MetricsTrackError);
    });

    it('should match the spec base', () => {
      expect(METRICS_NAMESPACE_BASE).toBe('moq://metrics.moq.arpa/v1/');
    });
  });

  describe('track name', () => {
    it('should encode each valid granularity as a 1-tuple string', () => {
      for (let g = 0; g <= 7; g++) {
        const t = encodeMetricsTrackName(g);
        expect(t.length).toBe(1);
        expect(t[0]).toBe(String(g));
      }
    });

    it('should round-trip', () => {
      const t = encodeMetricsTrackName(MetricsGranularity.Info);
      expect(decodeMetricsTrackName(t)).toBe(MetricsGranularity.Info);
    });

    it('should reject out-of-range level on encode', () => {
      expect(() => encodeMetricsTrackName(-1 as MetricsGranularity)).toThrow(
        MetricsTrackError
      );
      expect(() => encodeMetricsTrackName(9 as MetricsGranularity)).toThrow(
        MetricsTrackError
      );
    });

    it('should reject bad decode inputs', () => {
      expect(() => decodeMetricsTrackName(['abc'] as [string])).toThrow(
        MetricsTrackError
      );
      expect(() => decodeMetricsTrackName([] as unknown as [string])).toThrow(
        MetricsTrackError
      );
    });
  });

  describe('group id (millis since epoch)', () => {
    it('should return BigInt millis', () => {
      expect(metricsGroupIdFromMillis(1700000000000)).toBe(1700000000000n);
    });

    it('should reject negatives', () => {
      expect(() => metricsGroupIdFromMillis(-1)).toThrow(MetricsTrackError);
    });
  });

  describe('metric values', () => {
    it('should accept gauge with float value', () => {
      expect(
        GaugeSchema.safeParse({ type: 'gauge', value: 3.14, unit: 'ms' }).success
      ).toBe(true);
    });

    it('should accept counter with integer', () => {
      expect(CounterSchema.safeParse({ type: 'counter', value: 42 }).success).toBe(
        true
      );
    });

    it('MetricValueSchema discriminates on type', () => {
      expect(
        MetricValueSchema.safeParse({ type: 'gauge', value: 1 }).success
      ).toBe(true);
      expect(
        MetricValueSchema.safeParse({ type: 'histogram', value: 1 }).success
      ).toBe(false);
    });
  });

  describe('payload objects', () => {
    it('MetricsHeaderSchema requires captureNanos', () => {
      expect(
        MetricsHeaderSchema.safeParse({ captureNanos: '1700000000000000000' })
          .success
      ).toBe(true);
      expect(MetricsHeaderSchema.safeParse({}).success).toBe(false);
    });

    it('MetricRecordSchema requires name and value', () => {
      expect(
        MetricRecordSchema.safeParse({
          name: 'buffer.ms',
          value: { type: 'gauge', value: 250 },
        }).success
      ).toBe(true);
      expect(
        MetricRecordSchema.safeParse({
          value: { type: 'gauge', value: 250 },
        }).success
      ).toBe(false);
    });

    it('header object id is 0', () => {
      expect(METRICS_HEADER_OBJECT_ID).toBe(0);
    });
  });
});

describe('MSF §13/§14 — catalog structural rules', () => {
  const baseCatalog = {
    version: MSF_VERSION,
    tracks: [],
    generatedAt: 1700000000000,
  } as const;

  it('should reject moqlog track declared under `tracks`', () => {
    const res = FullCatalogSchema.safeParse({
      ...baseCatalog,
      tracks: [
        {
          name: 'log-0',
          packaging: 'moqlog',
          isLive: true,
          role: 'log',
        },
      ],
    });
    expect(res.success).toBe(false);
  });

  it('should accept moqlog track declared under `publishTracks`', () => {
    const res = FullCatalogSchema.safeParse({
      ...baseCatalog,
      publishTracks: [
        {
          name: 'log-0',
          packaging: 'moqlog',
          isLive: true,
          role: 'log',
        },
      ],
    });
    expect(res.success).toBe(true);
  });

  it('should reject moqlog track with wrong role', () => {
    const res = FullCatalogSchema.safeParse({
      ...baseCatalog,
      publishTracks: [
        {
          name: 'log-0',
          packaging: 'moqlog',
          isLive: true,
          role: 'metrics',
        },
      ],
    });
    expect(res.success).toBe(false);
  });

  it('should reject moqmetrics track declared under `tracks`', () => {
    const res = FullCatalogSchema.safeParse({
      ...baseCatalog,
      tracks: [
        {
          name: 'metrics-0',
          packaging: 'moqmetrics',
          isLive: true,
          role: 'metrics',
        },
      ],
    });
    expect(res.success).toBe(false);
  });

  it('should accept moqmetrics track declared under `publishTracks`', () => {
    const res = FullCatalogSchema.safeParse({
      ...baseCatalog,
      publishTracks: [
        {
          name: 'metrics-0',
          packaging: 'moqmetrics',
          isLive: true,
          role: 'metrics',
        },
      ],
    });
    expect(res.success).toBe(true);
  });

  it('should reject moqmetrics track with wrong role', () => {
    const res = FullCatalogSchema.safeParse({
      ...baseCatalog,
      publishTracks: [
        {
          name: 'metrics-0',
          packaging: 'moqmetrics',
          isLive: true,
          role: 'log',
        },
      ],
    });
    expect(res.success).toBe(false);
  });
});
