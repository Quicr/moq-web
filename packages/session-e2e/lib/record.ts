// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * What a test checks, with which inputs, and what it saw, for the interop
 * report (lib/report-reporter.ts). Kept on the test's `task.meta`, which
 * Vitest hands to reporters. Record `observed` before the assertions so a
 * failing test still reports what it saw.
 *
 *   it('...', async ({ task }) => {
 *     record(task, { expected: 'every object arrives in order', inputs: { objects: 20 } });
 *     ...
 *     record(task, { observed: { received: received.length } });
 *     expect(received).toHaveLength(20);
 *   });
 */

export interface E2eRecord {
  /** The expected outcome, in a sentence */
  expected?: string;
  /** Parameters the test chose: namespaces, counts, options */
  inputs?: Record<string, unknown>;
  /** What the test saw */
  observed?: Record<string, unknown>;
}

/** A Vitest task: the test's `task` from its context */
interface Recordable {
  meta: object;
}

/** Values that survive JSON: bigint as a string, bytes as their length, errors as their message */
function plain(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (value instanceof Uint8Array) {
    return `${value.byteLength} bytes`;
  }
  if (value instanceof Error) {
    return value.message;
  }
  if (Array.isArray(value)) {
    return value.map(plain);
  }
  if (value instanceof Map) {
    return Object.fromEntries([...value].map(([k, v]) => [String(k), plain(v)]));
  }
  if (value instanceof Set) {
    return [...value].map(plain);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
  }

  return value;
}

/** Merge into the test's record; later fields of the same name win */
export function record(task: Recordable, fields: E2eRecord): void {
  const meta = task.meta as { e2e?: E2eRecord };
  const current = meta.e2e ?? {};
  meta.e2e = {
    expected: fields.expected ?? current.expected,
    inputs: { ...current.inputs, ...(plain(fields.inputs) as Record<string, unknown> | undefined) },
    observed: { ...current.observed, ...(plain(fields.observed) as Record<string, unknown> | undefined) },
  };
}
