// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview MSF §13 — MoQ Log (moqlog) track wiring.
 *
 * Provides:
 *  - Namespace / name helpers (`moq://moq-syslog.arpa/logs-v1/` + resourceID).
 *  - Group ID (microseconds since epoch) + Object ID formatting.
 *  - Log severity level enum (0=Emergency … 7=Debug).
 *  - Zod schema for log-entry payloads modelled after {{MOQLOG}} §4.
 *
 * The MSF spec (§13.5) also mandates that a log track is declared in the
 * catalog `publishTracks` array with `packaging="moqlog"` and `role="log"`.
 * That structural check lives in {@link ../schemas/track.ts} `TrackSchema`
 * superRefine so it fires for every log track parsed anywhere.
 */

import { z } from 'zod';

/**
 * Base namespace tuple for MOQLOG per {{MOQLOG}} §3.
 * A log track's full namespace is `[LOG_NAMESPACE_BASE, resourceId]`.
 */
export const LOG_NAMESPACE_BASE = 'moq://moq-syslog.arpa/logs-v1/' as const;

/**
 * Syslog-style severity levels used as the log Track Name.
 * The Track Name is a single-byte binary priority in [0, 7].
 */
export enum LogSeverity {
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
 * Build the log-track namespace tuple for a given resource id.
 *
 * @example
 * ```ts
 * logNamespace('cam-42') // → ['moq://moq-syslog.arpa/logs-v1/', 'cam-42']
 * ```
 */
export function logNamespace(resourceId: string): [string, string] {
  if (!resourceId) {
    throw new LogTrackError('resourceId is required for log track namespace');
  }
  return [LOG_NAMESPACE_BASE, resourceId];
}

/**
 * Encode a log-track Track Name.
 *
 * Per MSF §13.3 the Track Name is a single byte holding the severity level.
 */
export function encodeLogTrackName(severity: LogSeverity): Uint8Array {
  if (!Number.isInteger(severity) || severity < 0 || severity > 7) {
    throw new LogTrackError(
      `severity must be integer in [0, 7] per MSF §13.3, got ${severity}`
    );
  }
  return new Uint8Array([severity]);
}

/**
 * Decode a log-track Track Name byte into its {@link LogSeverity} value.
 */
export function decodeLogTrackName(bytes: Uint8Array): LogSeverity {
  if (bytes.length !== 1) {
    throw new LogTrackError(
      `log Track Name must be exactly 1 byte per MSF §13.3, got ${bytes.length}`
    );
  }
  const v = bytes[0];
  if (v > 7) {
    throw new LogTrackError(
      `severity byte must be in [0, 7] per MSF §13.3, got ${v}`
    );
  }
  return v as LogSeverity;
}

/**
 * Group ID / Object ID pair for a log entry per MSF §13.4.
 *
 * - `groupId` = capture timestamp in **microseconds** since Unix epoch,
 *   truncated to 62 bits.
 * - `objectId` = 0 for the first entry at a given microsecond; increments
 *   for further entries in the same microsecond.
 */
export interface LogLocation {
  groupId: bigint;
  objectId: number;
}

/** Maximum value for a 62-bit unsigned integer. */
const MAX_U62 = (1n << 62n) - 1n;

/**
 * Compute Group ID (microseconds since epoch, u62) from milliseconds.
 */
export function logGroupIdFromMillis(millis: number): bigint {
  if (!Number.isFinite(millis) || millis < 0) {
    throw new LogTrackError(`millis must be a non-negative finite number, got ${millis}`);
  }
  const micros = BigInt(Math.floor(millis)) * 1000n;
  return micros & MAX_U62;
}

/**
 * Compute Group ID (microseconds since epoch, u62) from BigInt microseconds.
 */
export function logGroupIdFromMicros(micros: bigint): bigint {
  if (micros < 0n) {
    throw new LogTrackError('micros must be non-negative');
  }
  return micros & MAX_U62;
}

/**
 * Zod schema for MOQLOG payload objects (Section 4 of {{MOQLOG}}).
 *
 * Every entry is a JSON document. Fields are optional per the underlying draft
 * but at minimum a `message` or structured `body` is expected.
 * Extra fields (OpenTelemetry `TraceID`, `SpanID`, `InstrumentationScope`,
 * `Attributes`) are passthrough.
 */
export const LogEntrySchema = z
  .object({
    /** RFC 5424-style severity (0 Emergency … 7 Debug). */
    severity: z.number().int().min(0).max(7).optional(),
    /** ISO-8601 or epoch-ms capture timestamp. */
    timestamp: z.union([z.string(), z.number()]).optional(),
    /** Origin host. */
    hostname: z.string().optional(),
    /** Application/service name. */
    appName: z.string().optional(),
    /** Emitting process id or logical worker id. */
    procId: z.string().optional(),
    /** Message id (categorization). */
    msgId: z.string().optional(),
    /** Free-form log message. */
    message: z.string().optional(),
    /** OpenTelemetry trace id (hex). */
    traceId: z.string().optional(),
    /** OpenTelemetry span id (hex). */
    spanId: z.string().optional(),
    /** OpenTelemetry instrumentation scope. */
    instrumentationScope: z
      .object({
        name: z.string(),
        version: z.string().optional(),
      })
      .passthrough()
      .optional(),
    /** Optional structured attributes. */
    attributes: z.record(z.unknown()).optional(),
  })
  .passthrough();

export type LogEntry = z.infer<typeof LogEntrySchema>;

/**
 * Error thrown by log-track helpers.
 */
export class LogTrackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LogTrackError';
  }
}
