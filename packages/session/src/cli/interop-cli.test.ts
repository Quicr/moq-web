// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Unit tests for the moq-web interop CLI argument parser and top-level
 * dispatch. These tests deliberately do NOT drive a real UnifiedSession
 * (that requires a WebTransport polyfill or a browser) — they cover the
 * pieces that run before we open the transport.
 */

import { describe, expect, it } from 'vitest';

import { parseArgs, parseNamespace, runCli } from './interop-cli.js';

describe('parseArgs', () => {
  const base = [
    '--role', 'subscriber',
    '--url', 'https://127.0.0.1:4443/moq',
    '--namespace', 'moq-web/interop',
    '--track', 'cell-a',
  ];

  it('parses the minimum required flags with defaults for count/duration', () => {
    const r = parseArgs(base);
    expect(r.error).toBeUndefined();
    expect(r.args).toEqual({
      role: 'subscriber',
      url: 'https://127.0.0.1:4443/moq',
      namespace: 'moq-web/interop',
      track: 'cell-a',
      objectCount: 10,
      duration: 5,
      help: false,
    });
  });

  it('honours --object-count and --duration overrides', () => {
    const r = parseArgs([...base, '--object-count', '42', '--duration', '30']);
    expect(r.args?.objectCount).toBe(42);
    expect(r.args?.duration).toBe(30);
  });

  it('rejects invalid --role', () => {
    const r = parseArgs(['--role', 'observer', '--url', 'x', '--namespace', 'x', '--track', 'x']);
    expect(r.error).toMatch(/--role/);
  });

  it('rejects non-positive --object-count', () => {
    const r = parseArgs([...base, '--object-count', '0']);
    expect(r.error).toMatch(/--object-count/);
  });

  it('rejects a flag without a value', () => {
    const r = parseArgs(['--role']);
    expect(r.error).toMatch(/requires a value/);
  });

  it('rejects unknown flags', () => {
    const r = parseArgs([...base, '--turbo', 'yes']);
    expect(r.error).toMatch(/unknown flag/);
  });

  it('flags missing required arguments', () => {
    const r = parseArgs(['--role', 'publisher', '--url', 'x', '--namespace', 'x']);
    expect(r.error).toMatch(/missing required flag/);
  });

  it('recognises --help', () => {
    const r = parseArgs(['--help']);
    expect(r.help).toBe(true);
  });
});

describe('parseNamespace', () => {
  it('splits slash-separated tuples', () => {
    expect(parseNamespace('moq-web/interop/cell-a')).toEqual(['moq-web', 'interop', 'cell-a']);
  });

  it('splits dot-separated tuples', () => {
    expect(parseNamespace('moq-web.interop.cell-a')).toEqual(['moq-web', 'interop', 'cell-a']);
  });

  it('ignores empty components from leading/trailing separators', () => {
    expect(parseNamespace('/moq-web/interop/')).toEqual(['moq-web', 'interop']);
  });

  it('throws on empty input', () => {
    expect(() => parseNamespace('')).toThrow();
    expect(() => parseNamespace('///')).toThrow();
  });
});

describe('runCli — dispatch guards', () => {
  it('prints usage and exits 0 for --help', async () => {
    const lines: string[] = [];
    const result = await runCli(['--help'], {
      hasWebTransport: false,
      logger: (l) => lines.push(l),
      errorLogger: () => undefined,
    });
    expect(result.code).toBe(0);
    expect(lines.some((l) => /Usage:/.test(l))).toBe(true);
  });

  it('exits 2 on usage error before touching the transport', async () => {
    const result = await runCli(['--role', 'nope'], {
      hasWebTransport: true,
      logger: () => undefined,
      errorLogger: () => undefined,
      connect: async () => {
        throw new Error('connect should not be called on usage error');
      },
    });
    expect(result.code).toBe(2);
  });

  it('exits 2 when WebTransport is unavailable', async () => {
    const result = await runCli(
      [
        '--role', 'subscriber',
        '--url', 'https://x/moq',
        '--namespace', 'ns',
        '--track', 't',
      ],
      {
        hasWebTransport: false,
        logger: () => undefined,
        errorLogger: () => undefined,
      },
    );
    expect(result.code).toBe(2);
    expect(result.message).toMatch(/WebTransport/);
  });

  it('exits 1 when connect() rejects', async () => {
    const result = await runCli(
      [
        '--role', 'subscriber',
        '--url', 'https://x/moq',
        '--namespace', 'ns',
        '--track', 't',
      ],
      {
        hasWebTransport: true,
        logger: () => undefined,
        errorLogger: () => undefined,
        connect: async () => {
          throw new Error('boom');
        },
      },
    );
    expect(result.code).toBe(1);
    expect(result.message).toMatch(/boom/);
  });
});
