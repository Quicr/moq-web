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
  if (v === 'draft-22') return 'draft-22';
  if (v === 'draft-18') return 'draft-18';
  return 'draft-16';
}

/**
 * Redirect the browser to the sibling build of a different draft, preserving
 * path + query when possible.
 *
 * The deploy layout depends on the hosting environment:
 *   - Self-hosted: `/` → d16, `/18/` → d18, `/22/` → d22
 *   - GitHub Pages: all drafts at the same path, different branches/builds
 *   - Dev server: same origin, different build via MOQT_VERSION env var
 *
 * When a simple prefix-based layout is detected (pathname starts at root or
 * a known draft prefix), the function navigates to the sibling path.
 * Otherwise it reloads with a query parameter hint and logs a warning.
 */
export function switchDraftInBrowser(target: Draft): void {
  if (typeof window === 'undefined') return;
  const cur = getBundledDraft();
  if (cur === target) return;
  const { pathname, search, hash } = window.location;

  // Detect prefix-based layout: pathname starts with / or /18/ or /22/
  // but NOT a deeper path like /moq-web/branches/... (GitHub Pages)
  const prefixMatch = pathname.match(/^\/(18|22)?(\/.*)?$/);
  if (prefixMatch && !pathname.includes('/branches/') && !pathname.includes('/moq-web/')) {
    const stripped = pathname.replace(/^\/(18|22)(\/|$)/, '/');
    const nextPath =
      target === 'draft-22' ? '/22' + stripped :
      target === 'draft-18' ? '/18' + stripped :
      stripped;
    const targetUrl = `${nextPath}${search}${hash}`;
    if (window.location.pathname !== nextPath) {
      window.location.assign(targetUrl);
      return;
    }
  }

  // Fallback: can't determine sibling build URL — reload with hint
  console.warn(
    `[app-kit] draft switch: bundled=${cur} requested=${target}. ` +
      `This build is compiled for ${cur}. To use ${target}, rebuild with MOQT_VERSION=${target}.`,
  );
  // Reload current page with draft query param as a hint for future builds
  const params = new URLSearchParams(search);
  params.set('draft', target);
  window.location.assign(`${pathname}?${params.toString()}${hash}`);
}
