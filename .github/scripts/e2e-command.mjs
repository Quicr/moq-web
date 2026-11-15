// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Starts a session-e2e run from an /e2e command in an issue or a comment, for
 * people allowed by .github/e2e-runners.json who have no write access.
 *
 *   /e2e                                     every registered relay
 *   /e2e relays=cloudflare,meta drafts=draft-22
 *   /e2e url=https://relay.example/moq drafts=draft-18 name="My relay"
 *   /e2e help
 *
 * Everything comes in through the environment (TEXT, AUTHOR, ASSOCIATION,
 * ISSUE, GITHUB_REPOSITORY, GITHUB_TOKEN) and nothing reaches a shell. The run
 * itself (session-e2e.yml, given reply_to) posts its link and its results on
 * the issue.
 */

import { readFileSync } from 'node:fs';

const env = process.env;
const repo = env.GITHUB_REPOSITORY;
const api = env.GITHUB_API_URL ?? 'https://api.github.com';
const issue = Number(env.ISSUE);
const author = env.AUTHOR ?? '';
const WORKFLOW = 'session-e2e.yml';
/** Runs of the workflow already queued or running before a command is refused */
const MAX_ACTIVE = 3;

const registry = JSON.parse(readFileSync(new URL('../e2e-relays.json', import.meta.url), 'utf8'));
const runners = JSON.parse(readFileSync(new URL('../e2e-runners.json', import.meta.url), 'utf8'));

const USAGE = [
  'Usage, on a line of its own:',
  '',
  '```',
  '/e2e                                        every registered relay, each on its drafts',
  '/e2e relays=cloudflare,meta drafts=draft-22',
  '/e2e url=https://relay.example/moq drafts=draft-18 name="My relay"',
  '```',
  '',
  `Relays: ${registry.relays.map((r) => `\`${r.id}\``).join(', ')}. Drafts: ${registry.drafts.map((d) => `\`${d}\``).join(', ')}.`,
].join('\n');

async function gh(method, path, body) {
  const res = await fetch(`${api}${path}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      'x-github-api-version': '2022-11-28',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  }
  return res.status === 204 ? null : res.json();
}

const reply = (text) => gh('POST', `/repos/${repo}/issues/${issue}/comments`, { body: text });

/** The first line that starts with /e2e, as key=value options; throws on anything else */
function parse(text) {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => /^\/e2e(\s|$)/.test(l));
  if (line === undefined) {
    return null;
  }
  const rest = line.slice(4).trim();
  if (rest === 'help') {
    return { help: true };
  }
  const options = {};
  const pattern = /(\w+)=(?:"([^"]*)"|(\S+))|(\S+)/g;
  for (const m of rest.matchAll(pattern)) {
    if (m[4] !== undefined) {
      throw new Error(`\`${m[4].slice(0, 40)}\` is not a key=value option.`);
    }
    options[m[1]] = m[2] ?? m[3];
  }
  return options;
}

function list(value) {
  return (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** The workflow inputs for these options, or throws with what is wrong */
function inputsFor(options) {
  const unknown = Object.keys(options).filter((k) => !['relays', 'drafts', 'url', 'name'].includes(k));
  if (unknown.length) {
    throw new Error(`Unknown option${unknown.length > 1 ? 's' : ''} ${unknown.map((k) => `\`${k}\``).join(', ')}.`);
  }
  const relays = list(options.relays);
  const ids = new Set(registry.relays.map((r) => r.id));
  const badRelays = relays.filter((r) => !ids.has(r));
  if (badRelays.length) {
    throw new Error(`Not a registered relay: ${badRelays.map((r) => `\`${r.slice(0, 40)}\``).join(', ')}.`);
  }
  const drafts = list(options.drafts);
  const badDrafts = drafts.filter((d) => !registry.drafts.includes(d));
  if (badDrafts.length) {
    throw new Error(`Not a known draft: ${badDrafts.map((d) => `\`${d.slice(0, 40)}\``).join(', ')}.`);
  }
  let url = '';
  if (options.url !== undefined) {
    if (relays.length) {
      throw new Error('Give either `url` or `relays`, not both.');
    }
    let parsed;
    try {
      parsed = new URL(options.url);
    } catch {
      throw new Error('`url` is not a valid URL.');
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || options.url.length > 300) {
      throw new Error('`url` must be an https URL without credentials, at most 300 characters.');
    }
    url = options.url;
  }
  // eslint-disable-next-line no-control-regex
  const name = (options.name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 60);
  if (name && !url) {
    throw new Error('`name` goes with `url`.');
  }
  return { relay_url: url, relay_name: name, relays: relays.join(','), drafts: drafts.join(','), reply_to: String(issue) };
}

function allowed() {
  if (['OWNER', 'MEMBER', 'COLLABORATOR'].includes(env.ASSOCIATION)) {
    return true;
  }
  return (runners.users ?? []).some((u) => u.toLowerCase() === author.toLowerCase());
}

const options = (() => {
  try {
    return parse(env.TEXT ?? '');
  } catch (err) {
    return { error: err.message };
  }
})();
if (!options) {
  console.log('No /e2e command');
  process.exit(0);
}

if (!allowed()) {
  await reply(`@${author} you are not on the list of people who can start e2e runs. A maintainer can add you to [\`.github/e2e-runners.json\`](${env.GITHUB_SERVER_URL ?? 'https://github.com'}/${repo}/blob/main/.github/e2e-runners.json).`);
  process.exit(0);
}
if (options.help) {
  await reply(USAGE);
  process.exit(0);
}
if (options.error) {
  await reply(`${options.error}\n\n${USAGE}`);
  process.exit(0);
}

let inputs;
try {
  inputs = inputsFor(options);
} catch (err) {
  await reply(`${err.message}\n\n${USAGE}`);
  process.exit(0);
}

const active = await Promise.all(['queued', 'in_progress'].map((status) =>
  gh('GET', `/repos/${repo}/actions/workflows/${WORKFLOW}/runs?status=${status}&per_page=10`)));
const busy = active.reduce((n, r) => n + r.total_count, 0);
if (busy >= MAX_ACTIVE) {
  await reply(`${busy} e2e runs are already queued or running; try again when they finish.`);
  process.exit(0);
}

await gh('POST', `/repos/${repo}/actions/workflows/${WORKFLOW}/dispatches`, { ref: 'main', inputs });
console.log(`Dispatched ${WORKFLOW} for @${author}: ${JSON.stringify(inputs)}`);
