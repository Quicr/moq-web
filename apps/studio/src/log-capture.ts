/**
 * In-memory capture of structured log entries for debugging relay issues.
 *
 * A saved DevTools console log flattens payloads to "Object", which hides
 * request IDs, track names and error codes. This keeps the last MAX_ENTRIES
 * entries as JSON-safe records; from the console:
 *   moqDumpLogs()   — download them as moq-log-<time>.json
 *   moqLogs()       — return them as an array
 */

import { Logger, LogLevel, type LogEntry } from '@moq-web/core';

const MAX_ENTRIES = 5000;
const MAX_STRING = 2000;

interface CapturedEntry {
  t: string;
  level: string;
  ns: string;
  msg: string;
  data?: unknown;
  error?: Record<string, unknown>;
}

declare global {
  interface Window {
    moqDumpLogs?: () => void;
    moqLogs?: () => CapturedEntry[];
  }
}

const entries: CapturedEntry[] = [];

function jsonSafe(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_k, v: unknown) => {
    if (typeof v === 'bigint') return v.toString();
    if (v instanceof Uint8Array) return `<${v.byteLength} bytes>`;
    if (typeof v === 'string' && v.length > MAX_STRING) return `${v.slice(0, MAX_STRING)}…(${v.length})`;
    return v;
  }) ?? 'null');
}

function errorFields(err: unknown): Record<string, unknown> | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as Record<string, unknown> & Error;
  return jsonSafe({
    name: e.name,
    message: e.message,
    source: e.source,
    streamErrorCode: e.streamErrorCode,
  }) as Record<string, unknown>;
}

function capture(entry: LogEntry): void {
  let data: unknown;
  let error = errorFields(entry.error);
  try {
    // Some call sites pass an Error-like (e.g. WebTransportError) as data.
    if (entry.data instanceof Error) error ??= errorFields(entry.data);
    else if (entry.data !== undefined) data = jsonSafe(entry.data);
  } catch {
    data = '<unserializable>';
  }
  entries.push({
    t: new Date(entry.timestamp).toISOString(),
    level: LogLevel[entry.level] ?? String(entry.level),
    ns: entry.namespace,
    msg: entry.message,
    ...(data !== undefined ? { data } : {}),
    ...(error ? { error } : {}),
  });
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
}

export function installLogCapture(): void {
  Logger.setHandler(capture);
  window.moqLogs = () => entries.slice();
  window.moqDumpLogs = () => {
    const blob = new Blob([JSON.stringify(entries, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `moq-log-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
}
