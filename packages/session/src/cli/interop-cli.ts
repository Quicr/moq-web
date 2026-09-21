// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview moq-web interop CLI
 *
 * Headless entry point used by `scripts/interop-harness.sh` (and the
 * `.github/workflows/interop.yml` matrix) to drive a moq-web
 * `UnifiedSession` from the command line in the publisher or subscriber
 * role.
 *
 * Usage:
 *   moq-web-interop --role subscriber \
 *                   --url https://127.0.0.1:4443/moq \
 *                   --namespace moq-web/interop \
 *                   --track cell-moq-rs-publisher \
 *                   --object-count 10 \
 *                   --duration 5
 *
 * Exit codes:
 *   0  success (subscriber received --object-count objects, or publisher
 *      completed --duration seconds worth of sends without error).
 *   1  scenario failure (timeout waiting for objects, connect error,
 *      out-of-order delivery, etc.).
 *   2  usage / setup failure (bad flags, no WebTransport in host).
 *
 * ## Browser-only note
 *
 * `UnifiedSession` depends on the `WebTransport` global, which plain Node
 * does not expose today. Running this CLI under a stock `node` binary
 * therefore falls back to a stub that prints an actionable error and
 * exits with code 2. In CI the runner is expected to provide a Node
 * WebTransport adapter (e.g. by importing `@fails-components/webtransport`
 * as a polyfill in a wrapper script, or via a headless browser launcher).
 *
 * The CLI intentionally does NOT import a specific adapter so this
 * package stays browser-first and dependency-light. The interop workflow
 * either substitutes a wrapper that installs a global `WebTransport`
 * before invoking this CLI, or drives the CLI through a headless browser
 * (Playwright / puppeteer) that already has WebTransport.
 */

import {
  SubscriptionFilter,
  GroupOrder,
  type TrackNamespace,
} from '@moq-web/core';
import { UnifiedSession } from '../unified-session.js';

// -----------------------------------------------------------------------------
// Argument parsing (small hand-rolled parser to keep the package dep-free)
// -----------------------------------------------------------------------------

export interface CliArgs {
  role: 'publisher' | 'subscriber';
  url: string;
  namespace: string;
  track: string;
  objectCount: number;
  duration: number;
  help: boolean;
}

export interface ParseResult {
  args?: CliArgs;
  error?: string;
  help?: boolean;
}

const USAGE = `moq-web-interop — headless publisher/subscriber for MoQ interop testing

Usage:
  moq-web-interop --role <publisher|subscriber> --url <wt://...> \\
                  --namespace <ns> --track <name> \\
                  [--object-count N] [--duration N]

Flags:
  --role         'publisher' or 'subscriber' (required)
  --url          WebTransport URL of the peer / relay (required)
  --namespace    Track namespace (slash- or dot-separated tuple; required)
  --track        Track name (required)
  --object-count Objects to publish or expect (default: 10)
  --duration     Publisher run time in seconds; hard cap for subscriber too
                 (default: 5)
  --help, -h     Print this message and exit 0

Object log format (one per line to stdout):
  OBJECT groupId=<u64> objectId=<u64> bytes=<n>

Exit codes:
  0  success
  1  scenario failure
  2  usage or setup failure
`;

export function parseArgs(argv: readonly string[]): ParseResult {
  const args: Partial<CliArgs> = {
    objectCount: 10,
    duration: 5,
    help: false,
  };

  let i = 0;
  while (i < argv.length) {
    const flag = argv[i];
    if (flag === '--help' || flag === '-h') {
      return { help: true };
    }
    // Every remaining flag takes exactly one value.
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      return { error: `flag ${flag} requires a value` };
    }
    switch (flag) {
      case '--role':
        if (value !== 'publisher' && value !== 'subscriber') {
          return { error: `--role must be 'publisher' or 'subscriber', got '${value}'` };
        }
        args.role = value;
        break;
      case '--url':
        args.url = value;
        break;
      case '--namespace':
        args.namespace = value;
        break;
      case '--track':
        args.track = value;
        break;
      case '--object-count': {
        const n = Number.parseInt(value, 10);
        if (!Number.isFinite(n) || n <= 0) {
          return { error: `--object-count must be a positive integer, got '${value}'` };
        }
        args.objectCount = n;
        break;
      }
      case '--duration': {
        const n = Number.parseInt(value, 10);
        if (!Number.isFinite(n) || n <= 0) {
          return { error: `--duration must be a positive integer, got '${value}'` };
        }
        args.duration = n;
        break;
      }
      default:
        return { error: `unknown flag: ${flag}` };
    }
    i += 2;
  }

  const required: Array<keyof CliArgs> = ['role', 'url', 'namespace', 'track'];
  for (const key of required) {
    if (args[key] === undefined) {
      return { error: `missing required flag: --${String(key).replace(/([A-Z])/g, '-$1').toLowerCase()}` };
    }
  }

  return { args: args as CliArgs };
}

/**
 * Split a namespace string into the tuple form the codec expects. Accepts
 * either `foo/bar/baz` or `foo.bar.baz` (both are common on the wire) and
 * returns `['foo', 'bar', 'baz']` as a `TrackNamespace`.
 */
export function parseNamespace(input: string): TrackNamespace {
  const parts = input.split(/[/.]/).filter((p) => p.length > 0);
  if (parts.length === 0) {
    throw new Error(`namespace must have at least one component: '${input}'`);
  }
  return parts;
}

// -----------------------------------------------------------------------------
// Roles
// -----------------------------------------------------------------------------

/**
 * Subscriber role: connect, subscribe, log one line per object received.
 * Resolves once {@link CliArgs.objectCount} objects have arrived. Rejects
 * if the deadline (--duration + 5s slack) fires first.
 */
export async function runSubscriber(
  args: CliArgs,
  session: UnifiedSession,
  // eslint-disable-next-line no-console
  logger: (line: string) => void = console.log,
): Promise<void> {
  const subscription = await session.subscribe({
    trackNamespace: parseNamespace(args.namespace),
    trackName: args.track,
    filter: SubscriptionFilter.LATEST_GROUP,
    groupOrder: GroupOrder.ASCENDING,
    subscriberPriority: 128,
  });

  // Deadline = duration + 5s slack so slow publishers don't spuriously fail.
  const deadlineMs = (args.duration + 5) * 1000;
  const start = Date.now();

  let received = 0;
  const iterator = subscription.objects[Symbol.asyncIterator]();

  while (received < args.objectCount) {
    const remaining = deadlineMs - (Date.now() - start);
    if (remaining <= 0) {
      await subscription.unsubscribe().catch(() => undefined);
      throw new Error(
        `timeout after ${deadlineMs}ms — received ${received}/${args.objectCount} objects`,
      );
    }

    const nextPromise = iterator.next();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      timeoutId = setTimeout(() => resolve('timeout'), remaining);
    });

    const winner = await Promise.race([nextPromise, timeoutPromise]);
    if (timeoutId !== undefined) clearTimeout(timeoutId);

    if (winner === 'timeout') {
      await subscription.unsubscribe().catch(() => undefined);
      throw new Error(
        `timeout after ${deadlineMs}ms — received ${received}/${args.objectCount} objects`,
      );
    }

    if (winner.done) {
      break;
    }

    const obj = winner.value;
    received++;
    logger(`OBJECT groupId=${obj.groupId} objectId=${obj.objectId} bytes=${obj.payload.length}`);
  }

  await subscription.unsubscribe().catch(() => undefined);

  if (received < args.objectCount) {
    throw new Error(
      `stream closed after ${received}/${args.objectCount} objects`,
    );
  }
}

/**
 * Publisher role: connect, publish a track, emit --object-count objects
 * spread evenly across --duration seconds. Resolves after the last object
 * has been sent.
 */
export async function runPublisher(
  args: CliArgs,
  session: UnifiedSession,
  // eslint-disable-next-line no-console
  logger: (line: string) => void = console.log,
): Promise<void> {
  const publication = await session.publish({
    trackNamespace: parseNamespace(args.namespace),
    trackName: args.track,
    publisherPriority: 128,
    groupOrder: GroupOrder.ASCENDING,
  });

  const totalMs = args.duration * 1000;
  const intervalMs = Math.max(1, Math.floor(totalMs / args.objectCount));

  for (let i = 0; i < args.objectCount; i++) {
    // Fixed-size ASCII payload so peer implementations can diff bytes.
    const payload = new TextEncoder().encode(`moq-web/interop/object-${i}`);
    await publication.sendObject({
      groupId: 0n,
      subgroupId: 0n,
      objectId: BigInt(i),
      payload,
    });
    logger(`OBJECT groupId=0 objectId=${i} bytes=${payload.length}`);

    if (i < args.objectCount - 1) {
      await sleep(intervalMs);
    }
  }

  await publication.done().catch(() => undefined);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// -----------------------------------------------------------------------------
// Entry point
// -----------------------------------------------------------------------------

/**
 * Result of {@link runCli}. Kept as a plain object so unit tests can
 * assert on the exit code without hooking `process.exit`.
 */
export interface RunResult {
  code: 0 | 1 | 2;
  message?: string;
}

/**
 * High-level entry point. Parses argv, does the browser-capability guard,
 * dials the URL, and runs the appropriate role. Returns an exit code and
 * an optional message; the CLI shim below turns that into a real
 * `process.exit()`.
 */
export async function runCli(
  argv: readonly string[],
  deps: {
    hasWebTransport?: boolean;
    logger?: (line: string) => void;
    errorLogger?: (line: string) => void;
    connect?: (url: string) => Promise<UnifiedSession>;
  } = {},
): Promise<RunResult> {
  const errorLogger = deps.errorLogger ?? console.error;
  // eslint-disable-next-line no-console
  const logger = deps.logger ?? console.log;

  const parsed = parseArgs(argv);
  if (parsed.help) {
    logger(USAGE);
    return { code: 0 };
  }
  if (parsed.error) {
    errorLogger(parsed.error);
    errorLogger('');
    errorLogger(USAGE);
    return { code: 2, message: parsed.error };
  }
  const args = parsed.args!;

  const hasWt = deps.hasWebTransport ?? typeof WebTransport !== 'undefined';
  if (!hasWt) {
    const msg =
      'WebTransport is not available in this runtime. Run this CLI in a ' +
      'browser context (e.g. via Playwright) or invoke it through a Node ' +
      'wrapper that installs a WebTransport polyfill globally before ' +
      'requiring @moq-web/session.';
    errorLogger(msg);
    return { code: 2, message: msg };
  }

  let session: UnifiedSession;
  try {
    session = await (deps.connect ?? UnifiedSession.connect)(args.url);
  } catch (err) {
    const msg = `failed to connect to ${args.url}: ${(err as Error).message}`;
    errorLogger(msg);
    return { code: 1, message: msg };
  }

  try {
    if (args.role === 'subscriber') {
      await runSubscriber(args, session, logger);
    } else {
      await runPublisher(args, session, logger);
    }
    return { code: 0 };
  } catch (err) {
    const msg = `scenario failed: ${(err as Error).message}`;
    errorLogger(msg);
    return { code: 1, message: msg };
  }
}

// Standalone entry: only fire when invoked as `node interop-cli.js`. The
// harness uses this via the `moq-web-interop` bin shim wired up in
// packages/session/package.json. `process.argv[1]` may be a non-normalized
// path (bin shims often stitch in `..` segments), so resolve both sides to
// real paths before comparing.
const isDirectRun = await (async () => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const meta = import.meta as any;
    if (typeof meta?.url !== 'string') return false;
    const invoked = process.argv[1];
    if (!invoked) return false;
    const { fileURLToPath } = await import('node:url');
    const { realpathSync } = await import('node:fs');
    const metaPath = fileURLToPath(meta.url);
    const invokedResolved = (() => {
      try {
        return realpathSync(invoked);
      } catch {
        return invoked;
      }
    })();
    return metaPath === invokedResolved;
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  runCli(process.argv.slice(2)).then((result) => {
    process.exit(result.code);
  }).catch((err) => {
    console.error(`unexpected error: ${(err as Error).stack ?? err}`);
    process.exit(1);
  });
}
