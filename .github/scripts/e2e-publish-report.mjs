// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Merges the session-e2e cell reports of one workflow run into the data the
 * interop report page reads (the e2e-reports branch):
 *
 *   index.json         the latest runs, newest first, with per-cell counts
 *   runs/<id>.json     one run in full: every test of every cell
 *
 * Usage: node e2e-publish-report.mjs <artifacts dir> <e2e-reports checkout>
 *
 * Each artifact directory holds cell.json (relay, name, draft, relay_url,
 * experimental) and, when the tests ran, report.json (lib/report-reporter.ts).
 * Job links and conclusions come from the Actions API. A re-run attempt
 * replaces the run's earlier attempt.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const KEEP_RUNS = 30;

const [artifactsDir, outDir] = process.argv.slice(2);
if (!artifactsDir || !outDir) {
  console.error('usage: e2e-publish-report.mjs <artifacts dir> <e2e-reports checkout>');
  process.exit(1);
}

const env = process.env;
const repo = env.GITHUB_REPOSITORY;
const runId = Number(env.GITHUB_RUN_ID);
const attempt = Number(env.GITHUB_RUN_ATTEMPT ?? 1);
const server = env.GITHUB_SERVER_URL ?? 'https://github.com';
const api = env.GITHUB_API_URL ?? 'https://api.github.com';

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

/** The jobs of this attempt, by name */
async function jobsByName() {
  const jobs = new Map();
  for (let page = 1; page <= 5; page++) {
    const res = await fetch(`${api}/repos/${repo}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100&page=${page}`, {
      headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json' },
    });
    if (!res.ok) {
      console.warn(`jobs API: ${res.status}`);
      break;
    }
    const body = await res.json();
    for (const job of body.jobs) {
      jobs.set(job.name, job);
    }
    if (body.jobs.length < 100) {
      break;
    }
  }

  return jobs;
}

function cellStatus(counts, conclusion, hasReport) {
  if (!hasReport) {
    return conclusion === 'cancelled' ? 'cancelled' : 'error';
  }
  if (counts.failed > 0) {
    return 'failed';
  }

  return counts.passed > 0 ? 'passed' : 'skipped';
}

/** The job page opened at a step's log, or null when the job or step is unknown */
function stepLogUrl(job, stepName) {
  const step = job?.steps?.find((s) => s.name === stepName);
  return job?.html_url && step ? `${job.html_url}#step:${step.number}:1` : null;
}

const jobs = await jobsByName();
const cells = [];
for (const entry of readdirSync(artifactsDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) {
    continue;
  }
  const dir = join(artifactsDir, entry.name);
  const cell = readJson(join(dir, 'cell.json'), undefined);
  if (!cell) {
    continue;
  }
  const report = readJson(join(dir, 'report.json'), undefined);
  const job = jobs.get(`session-e2e (${cell.relay}, ${cell.draft})`);
  const counts = report?.counts ?? { passed: 0, failed: 0, skipped: 0 };
  cells.push({
    relay: cell.relay,
    name: cell.name,
    draft: cell.draft,
    relayUrl: cell.relay_url,
    experimental: Boolean(cell.experimental),
    status: cellStatus(counts, job?.conclusion, report !== undefined),
    conclusion: job?.conclusion ?? null,
    jobUrl: job?.html_url ?? null,
    logUrl: stepLogUrl(job, 'Run session-e2e'),
    startedAt: report?.startedAt ?? job?.started_at ?? null,
    finishedAt: report?.finishedAt ?? job?.completed_at ?? null,
    counts,
    errors: report?.errors ?? (report ? [] : ['No test report: the job ended before the tests ran. See the job log.']),
    files: report?.files ?? {},
    tests: report?.tests ?? [],
  });
}
cells.sort((a, b) => a.relay.localeCompare(b.relay) || b.draft.localeCompare(a.draft));

const run = {
  runId,
  runNumber: Number(env.GITHUB_RUN_NUMBER) || undefined,
  attempt,
  runUrl: `${server}/${repo}/actions/runs/${runId}`,
  event: env.GITHUB_EVENT_NAME ?? 'unknown',
  sha: env.GITHUB_SHA ?? '',
  ref: env.GITHUB_REF_NAME ?? '',
  custom: Boolean(env.CUSTOM_URL),
  publishedAt: new Date().toISOString(),
  cells,
};

mkdirSync(join(outDir, 'runs'), { recursive: true });
writeFileSync(join(outDir, 'runs', `${runId}.json`), JSON.stringify(run));

const index = readJson(join(outDir, 'index.json'), { runs: [] });
const summary = {
  ...run,
  cells: cells.map(({ files: _files, tests: _tests, errors, ...rest }) => ({ ...rest, errorCount: errors.length })),
};
const runs = [summary, ...index.runs.filter((r) => r.runId !== runId)]
  .sort((a, b) => b.runId - a.runId)
  .slice(0, KEEP_RUNS);
writeFileSync(join(outDir, 'index.json'), JSON.stringify({ repo, updatedAt: run.publishedAt, runs }, null, 1));

// Drop the run files that fell out of the index
const kept = new Set(runs.map((r) => `${r.runId}.json`));
for (const file of readdirSync(join(outDir, 'runs'))) {
  if (!kept.has(file)) {
    rmSync(join(outDir, 'runs', file));
  }
}

console.log(`Published run ${runId} attempt ${attempt}: ${cells.length} cells, ${runs.length} runs kept`);
