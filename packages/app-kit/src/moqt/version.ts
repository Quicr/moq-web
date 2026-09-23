// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import type { Draft } from './adapter.js';

/**
 * Bundled draft version (compile-time constant injected by Vite). Apps must
 * expose this through `import.meta.env.VITE_MOQT_VERSION` from their vite
 * config; if it's missing we assume draft-16 to match the historical default.
 */
export function getBundledDraft(): Draft {
  const env = (import.meta as unknown as { env?: Record<string, string> }).env;
  const v = env?.VITE_MOQT_VERSION;
  return v === 'draft-18' ? 'draft-18' : 'draft-16';
}

/**
 * Redirect the browser to the sibling build of a different draft, preserving
 * path + query when possible. The deploy layout is:
 *   /               → draft-16 bundle
 *   /18/            → draft-18 bundle
 * In dev, both drafts run on the same origin but a different build script is
 * needed, so we just reload and print a hint.
 */
export function switchDraftInBrowser(target: Draft): void {
  if (typeof window === 'undefined') return;
  const cur = getBundledDraft();
  if (cur === target) return;
  const { pathname, search, hash } = window.location;
  const stripped = pathname.replace(/^\/18(\/|$)/, '/');
  const nextPath = target === 'draft-18' ? '/18' + stripped : stripped;
  const targetUrl = `${nextPath}${search}${hash}`;
  if (window.location.pathname === nextPath) {
    console.warn(
      `[app-kit] draft mismatch: bundled=${cur} requested=${target}. ` +
        `Restart the dev server with MOQT_VERSION=${target} to change bundled versions.`,
    );
    return;
  }
  window.location.assign(targetUrl);
}
