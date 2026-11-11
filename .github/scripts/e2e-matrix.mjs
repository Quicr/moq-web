// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Prints the session-e2e matrix as a GitHub Actions output line:
 *   matrix=[{ relay, name, draft, relay_url, experimental }, ...]
 *
 * Built from .github/e2e-relays.json, narrowed by the workflow_dispatch
 * inputs (read from the environment, never interpolated into a shell):
 *   CUSTOM_URL   a relay URL to run instead of the registry; its cells are experimental
 *   CUSTOM_NAME  the name the report shows for it
 *   RELAYS       registry relay ids to run, comma separated (empty: all)
 *   DRAFTS       drafts to run, comma separated (empty: each relay's own)
 */

import { readFileSync } from 'node:fs';

const registry = JSON.parse(readFileSync(new URL('../e2e-relays.json', import.meta.url), 'utf8'));
const KNOWN_DRAFTS = new Set(registry.drafts);
const DEFAULT_CUSTOM_DRAFTS = ['draft-22', 'draft-23'];
const MAX_URL_LENGTH = 512;

function list(value) {
  return (value ?? '').split(',').map((v) => v.trim()).filter(Boolean);
}

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

function checkedDrafts(drafts) {
  for (const draft of drafts) {
    if (!KNOWN_DRAFTS.has(draft)) {
      fail(`Unknown draft "${draft}"; expected one of ${[...KNOWN_DRAFTS].join(', ')}`);
    }
  }

  return drafts;
}

/** A relay URL the browser can open with WebTransport, and nothing else */
function checkedUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`Relay URL "${value}" is not a URL`);
  }
  if (url.protocol !== 'https:' || value.length > MAX_URL_LENGTH || url.username || url.password) {
    fail('Relay URL must be an https:// URL without credentials, at most 512 characters');
  }

  return url.toString().replace(/\/$/, url.pathname === '/' ? '' : '/');
}

/** A label safe for job and artifact names */
function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'custom';
}

const drafts = checkedDrafts(list(process.env.DRAFTS));
const cells = [];

if (process.env.CUSTOM_URL?.trim()) {
  const relayUrl = checkedUrl(process.env.CUSTOM_URL.trim());
  const name = (process.env.CUSTOM_NAME?.trim() || new URL(relayUrl).host).slice(0, 60);
  for (const draft of drafts.length > 0 ? drafts : DEFAULT_CUSTOM_DRAFTS) {
    cells.push({ relay: slug(`custom-${name}`), name, draft, relay_url: relayUrl, experimental: true });
  }
} else {
  const only = new Set(list(process.env.RELAYS));
  for (const relay of registry.relays) {
    if (only.size > 0 && !only.has(relay.id)) {
      continue;
    }
    const own = [
      ...relay.drafts.map((draft) => ({ draft, experimental: false })),
      ...(relay.experimentalDrafts ?? []).map((draft) => ({ draft, experimental: true })),
    ];
    for (const { draft, experimental } of own) {
      if (drafts.length === 0 || drafts.includes(draft)) {
        cells.push({ relay: relay.id, name: relay.name, draft, relay_url: relay.url, experimental });
      }
    }
  }
}

if (cells.length === 0) {
  fail('No relay and draft matched the inputs');
}

console.log(`matrix=${JSON.stringify(cells)}`);
