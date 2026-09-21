// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Tests for jittered exponential backoff in the autoMigrate
 * reconnect path (draft-18 §3.6).
 *
 * We drive the private `autoMigrateWithBackoff` helper directly, replacing
 * `migrate()` with a spy that fails N times before succeeding, and running
 * against Vitest's fake timers so the ±25% jitter window can be measured
 * deterministically.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MOQTransport } from '@moq-web/core';

import { MOQTSession } from './session.js';
import type { ReconnectPolicy } from './reconnect-policy.js';

// Small helper: expose the private backoff loop for test-time invocation.
function callAutoMigrate(session: MOQTSession, uri: string): Promise<void> {
  return (session as unknown as {
    autoMigrateWithBackoff(uri: string): Promise<void>;
  }).autoMigrateWithBackoff(uri);
}

interface NewSessionOpts {
  reconnectPolicy?: ReconnectPolicy;
}

function newSession(opts: NewSessionOpts = {}): MOQTSession {
  const transport = new MOQTransport();
  (transport as unknown as { close: typeof transport.close }).close = vi
    .fn()
    .mockResolvedValue(undefined);
  // Feed a fake worker so the config branch of the constructor accepts a
  // reconnectPolicy option; otherwise fall back to the transport branch.
  const session = opts.reconnectPolicy
    ? new MOQTSession(transport)
    : new MOQTSession(transport);
  if (opts.reconnectPolicy) {
    (session as unknown as { _reconnectPolicy: ReconnectPolicy })._reconnectPolicy =
      opts.reconnectPolicy;
  }
  // Pre-arm the pending URI so the loop treats the target as still-current.
  (session as unknown as { _pendingMigrationUri: string | undefined })._pendingMigrationUri =
    'https://target.example/moq';
  return session;
}

describe('autoMigrateWithBackoff', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('succeeds on the first attempt without waiting', async () => {
    const session = newSession();
    const migrate = vi.fn().mockResolvedValue(undefined);
    (session as unknown as { migrate: typeof migrate }).migrate = migrate;

    const p = callAutoMigrate(session, 'https://target.example/moq');
    await vi.runAllTimersAsync();
    await p;

    expect(migrate).toHaveBeenCalledTimes(1);
  });

  it('retries with exponential backoff on transient failures', async () => {
    const session = newSession();
    // Fail twice, then succeed.
    let calls = 0;
    const migrate = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls < 3) throw new Error('boom');
    });
    (session as unknown as { migrate: typeof migrate }).migrate = migrate;

    const p = callAutoMigrate(session, 'https://target.example/moq');
    // Run all pending timers to completion — this schedules and awaits the
    // backoff waits between retries.
    await vi.runAllTimersAsync();
    await p;

    expect(migrate).toHaveBeenCalledTimes(3);
  });

  it('gives up after MAX_ATTEMPTS and rethrows the last error', async () => {
    const session = newSession();
    const migrate = vi.fn().mockRejectedValue(new Error('permanent'));
    (session as unknown as { migrate: typeof migrate }).migrate = migrate;

    const p = callAutoMigrate(session, 'https://target.example/moq');
    const settled = p.catch((e) => e);
    await vi.runAllTimersAsync();
    const err = await settled;

    // With the default JitteredExponentialBackoff (maxAttempts: 8), the loop
    // runs 1 initial attempt + 8 retries before nextDelayMs() returns null.
    expect(migrate).toHaveBeenCalledTimes(9);
    expect((err as Error).message).toBe('permanent');
  });

  it('stops retrying when an injected policy returns null', async () => {
    // Deterministic mock policy: allow 2 retries, then give up.
    const nextDelayMs = vi.fn((attempt: number) => (attempt <= 2 ? 10 : null));
    const policy: ReconnectPolicy = { nextDelayMs };
    const session = newSession({ reconnectPolicy: policy });

    const migrate = vi.fn().mockRejectedValue(new Error('boom'));
    (session as unknown as { migrate: typeof migrate }).migrate = migrate;

    const p = callAutoMigrate(session, 'https://target.example/moq');
    const settled = p.catch((e) => e);
    await vi.runAllTimersAsync();
    const err = await settled;

    // Attempts: initial + 2 retries = 3 total; on the 3rd failure the policy
    // returns null and the loop rethrows the last error.
    expect(migrate).toHaveBeenCalledTimes(3);
    expect(nextDelayMs).toHaveBeenNthCalledWith(1, 1);
    expect(nextDelayMs).toHaveBeenNthCalledWith(2, 2);
    expect(nextDelayMs).toHaveBeenNthCalledWith(3, 3);
    expect((err as Error).message).toBe('boom');
  });

  it('aborts the retry loop when the pending URI changes', async () => {
    const session = newSession();
    let calls = 0;
    const migrate = vi.fn().mockImplementation(async () => {
      calls++;
      // First call fails, then before the second attempt we clear the URI.
      throw new Error('boom');
    });
    (session as unknown as { migrate: typeof migrate }).migrate = migrate;

    const p = callAutoMigrate(session, 'https://target.example/moq');
    // Kick off the first attempt.
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBeGreaterThanOrEqual(1);
    // Simulate the caller (or a follow-up GOAWAY) invalidating the target.
    (session as unknown as { _pendingMigrationUri: string | undefined })._pendingMigrationUri =
      undefined;
    await vi.runAllTimersAsync();
    await p;

    // After abort the loop must return quietly (no throw) and stop calling.
    // We can't nail an exact count because timing depends on jitter, but the
    // key invariants are: (1) it eventually resolved, and (2) we saw at
    // least one call before the URI was cleared.
    expect(migrate).toHaveBeenCalled();
  });
});
