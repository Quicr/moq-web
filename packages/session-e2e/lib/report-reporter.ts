// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Writes one JSON file per run for the interop report page. For each test
 * file, its title and description (the header comment); for each test, its
 * line in the file, state and duration, the steps it takes, what it expected, its inputs and what it observed
 * (lib/record.ts) and, for a failure, the error and the last log lines the
 * test printed. The file goes to a public branch, so the auth token is
 * redacted and every text is capped.
 *
 * Enabled by `E2E_REPORT=<path>` (see vitest.browser.config.ts).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import type { UserConsoleLog } from 'vitest';
import type { Reporter, TestCase, TestModule } from 'vitest/node';

import type { E2eRecord } from './record.js';

/** Log calls kept per failed test, newest last */
const LOG_LINES = 150;
/** Longest log call kept */
const LINE_CHARS = 600;
/** Longest error message kept */
const ERROR_CHARS = 4000;
/** Longest recorded input or observed value, as JSON */
const RECORD_CHARS = 2000;

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

export interface ReportTest {
  file: string;
  /** The describe blocks and the test title, joined by ' > ' */
  name: string;
  /** Line of the test in its file, for a link to the source */
  line?: number;
  state: 'passed' | 'failed' | 'skipped';
  durationMs: number;
  flow?: string[];
  expected?: string;
  inputs?: Record<string, unknown>;
  observed?: Record<string, unknown>;
  error?: string;
  logs?: string[];
}

export interface ReportTestFile {
  /** The header comment's first line */
  title: string;
  /** The rest of the header comment */
  description: string;
}

export interface ReportFile {
  relayUrl: string;
  draft: string;
  startedAt: string;
  finishedAt: string;
  counts: { passed: number; failed: number; skipped: number };
  /** Errors outside any test, such as a file that failed to load */
  errors: string[];
  files: Record<string, ReportTestFile>;
  tests: ReportTest[];
}

function redactor(secrets: string[]): (text: string) => string {
  const present = secrets.filter((s) => s.length >= 8);
  return (text) => present.reduce((out, s) => out.split(s).join('[redacted]'), text);
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** The first doc comment after the license header, split into title and description */
function headerOf(path: string): ReportTestFile {
  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch {
    return { title: '', description: '' };
  }
  const comment = /\/\*\*([\s\S]*?)\*\//.exec(source)?.[1] ?? '';
  const lines = comment.split('\n').map((line) => line.replace(/^\s*\* ?/, '').trimEnd());
  while (lines.length > 0 && lines[0]!.trim() === '') {
    lines.shift();
  }
  const [title = '', ...rest] = lines;

  return { title: title.trim(), description: rest.join('\n').trim() };
}

export class ReportReporter implements Reporter {
  private readonly logs = new Map<string, string[]>();
  private readonly startedAt = new Date().toISOString();
  private readonly redact = redactor([process.env.MOQ_AUTH_TOKEN ?? '']);
  private root = process.cwd();

  constructor(private readonly outPath: string) {}

  onInit(ctx: { config: { root: string } }): void {
    this.root = ctx.config.root;
  }

  onUserConsoleLog(log: UserConsoleLog): void {
    if (!log.taskId) {
      return;
    }
    // One log call per line: a logger's multi-line JSON fields fold onto it
    const line = log.content.replace(ANSI, '').split('\n').map((part) => part.trim()).filter(Boolean).join(' ');
    if (line === '') {
      return;
    }
    const lines = this.logs.get(log.taskId) ?? [];
    lines.push(clip(this.redact(line), LINE_CHARS));
    lines.splice(0, Math.max(0, lines.length - LOG_LINES));
    this.logs.set(log.taskId, lines);
  }

  onTestRunEnd(modules: ReadonlyArray<TestModule>, errors: ReadonlyArray<{ message?: string; stack?: string }>): void {
    const files: Record<string, ReportTestFile> = {};
    const tests: ReportTest[] = [];
    for (const module of modules) {
      const file = relative(this.root, module.moduleId);
      files[file] = headerOf(module.moduleId);
      for (const test of module.children.allTests()) {
        tests.push(this.entry(file, test));
      }
      for (const error of module.errors()) {
        tests.push({ file, name: '(file failed to run)', state: 'failed', durationMs: 0, error: this.errorText(error) });
      }
    }

    const report: ReportFile = {
      relayUrl: process.env.RELAY_URL ?? '',
      draft: process.env.MOQT_VERSION ?? '',
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      counts: {
        passed: tests.filter((t) => t.state === 'passed').length,
        failed: tests.filter((t) => t.state === 'failed').length,
        skipped: tests.filter((t) => t.state === 'skipped').length,
      },
      errors: errors.map((e) => this.errorText(e)),
      files,
      tests,
    };
    mkdirSync(dirname(this.outPath), { recursive: true });
    writeFileSync(this.outPath, JSON.stringify(report, null, 1));
  }

  private entry(file: string, test: TestCase): ReportTest {
    const result = test.result();
    const state = result.state === 'failed' ? 'failed' : result.state === 'passed' ? 'passed' : 'skipped';
    const recorded = (test.meta() as { e2e?: E2eRecord }).e2e;
    const entry: ReportTest = {
      file,
      name: test.fullName,
      line: test.location?.line,
      state,
      durationMs: Math.round(test.diagnostic()?.duration ?? 0),
      flow: recorded?.flow?.map((step) => clip(this.redact(step), LINE_CHARS)),
      expected: recorded?.expected ? clip(this.redact(recorded.expected), RECORD_CHARS) : undefined,
      inputs: this.recordedFields(recorded?.inputs),
      observed: this.recordedFields(recorded?.observed),
    };
    if (state === 'failed') {
      entry.error = (result.errors ?? []).map((e) => this.errorText(e)).join('\n\n');
      entry.logs = this.logs.get(test.id) ?? [];
    }

    return entry;
  }

  /** Each value as capped, redacted JSON text; undefined when nothing was recorded */
  private recordedFields(fields: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    if (!fields || Object.keys(fields).length === 0) {
      return undefined;
    }

    return Object.fromEntries(Object.entries(fields).map(([key, value]) => {
      const text = this.redact(JSON.stringify(value) ?? 'undefined');
      return [key, text.length > RECORD_CHARS ? clip(text, RECORD_CHARS) : JSON.parse(text)];
    }));
  }

  private errorText(error: { message?: string; stack?: string; diff?: string }): string {
    const text = [error.message ?? '', error.diff ?? '', this.ownFrames(error.stack)].filter(Boolean).join('\n').replace(ANSI, '');
    return clip(this.redact(text), ERROR_CHARS);
  }

  /** The stack frames in our code, as repository paths: not Vitest's, not the dev server's URL */
  private ownFrames(stack: string | undefined): string {
    if (!stack) {
      return '';
    }
    const repoRoot = dirname(dirname(this.root));
    return stack.split('\n')
      .filter((line) => /^\s+at /.test(line) && !/node_modules|\/\.vite\/|@vitest/.test(line))
      .map((line) => line
        .replace(/https?:\/\/localhost:\d+\/(@fs)?/g, '/')
        .replace(/\?[^:)\s]*(?=:\d+:\d+)/g, '')
        .split(`${repoRoot}/`).join('')
        .replace(/\(\/+/g, '(').replace(/at \/+/g, 'at '))
      .join('\n');
  }
}
