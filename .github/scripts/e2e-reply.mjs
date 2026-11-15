// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Comments on the issue that started a session-e2e run (its reply_to input):
 *
 *   node e2e-reply.mjs started             the run's link
 *   node e2e-reply.mjs results <run.json>  per-cell results and the report link
 *
 * Env: REPLY_TO, GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID.
 */

import { readFileSync } from 'node:fs';

const env = process.env;
const [mode, runFile] = process.argv.slice(2);
const issue = env.REPLY_TO ?? '';
if (!/^\d{1,9}$/.test(issue)) {
  console.log('No issue to reply to');
  process.exit(0);
}
const repo = env.GITHUB_REPOSITORY;
const api = env.GITHUB_API_URL ?? 'https://api.github.com';
const runUrl = `${env.GITHUB_SERVER_URL ?? 'https://github.com'}/${repo}/actions/runs/${env.GITHUB_RUN_ID}`;
const [owner, name] = repo.split('/');
const page = `https://${owner.toLowerCase()}.github.io/${name}/interop/${repo === 'Quicr/moq-web' ? '' : `?repo=${repo}`}`;

function body() {
  if (mode === 'started') {
    return `Started the e2e run: ${runUrl}. Results will be posted here when it finishes, in about 15 minutes.`;
  }
  const run = JSON.parse(readFileSync(runFile, 'utf8'));
  const rows = run.cells.map((c) => {
    const k = c.counts;
    const icon = c.status === 'passed' ? '✅' : c.status === 'failed' ? '❌' : '⚠️';
    const failing = [...new Set(c.tests.filter((t) => t.state === 'failed').map((t) => t.file.replace(/^tests\//, '').split('-')[0]))];
    return `| ${icon} ${c.name} | ${c.draft} | ${k.passed}/${k.passed + k.failed}${k.unsupported ? ` (${k.unsupported} not supported)` : ''} | ${failing.length > 12 ? `${failing.length} files` : failing.join(', ') || '—'} |`;
  });
  return [
    `e2e results for ${runUrl}`,
    '',
    '| Relay | Draft | Passed | Failing tests |',
    '|---|---|---|---|',
    ...rows,
    '',
    `Every test's flow, inputs and failure: ${page}#run=${env.GITHUB_RUN_ID}`,
  ].join('\n');
}

const res = await fetch(`${api}/repos/${repo}/issues/${issue}/comments`, {
  method: 'POST',
  headers: {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${env.GITHUB_TOKEN}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify({ body: body() }),
});
if (!res.ok) {
  console.warn(`Could not comment on #${issue}: ${res.status} ${await res.text()}`);
}
