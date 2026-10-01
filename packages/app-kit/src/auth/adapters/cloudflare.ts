// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Cloudflare moq-rs auth adapter.
 *
 * Cloudflare provisions per-relay JWT tokens scoped to `publish` or
 * `subscribe` (docs at https://developers.cloudflare.com/api/resources/moq/).
 * This adapter drives that API entirely from the browser:
 *
 *   1. User pastes a Cloudflare API token + account ID (persisted in the
 *      transport store's provider state, localStorage).
 *   2. Adapter lists relays and lets the user pick one — its `config.upstreams`
 *      URL is treated as the WebTransport endpoint for connect.
 *   3. On demand (`mintToken({operations:['publish']})`) the adapter first
 *      returns a cached JWT for those operations if unexpired; otherwise it
 *      POSTs to `/relays/{id}/tokens` and caches the returned `secret`.
 *   4. `applyToUrl` appends `?jwt=<token>` — the moq-rs convention today.
 *      When Cloudflare wires token acceptance into SETUP, we'll flip to
 *      `setupExtensions` without changing app code.
 */

import type {
  AuthAdapter,
  AuthOperation,
  MintContext,
  MintedAuthToken,
  ProviderState,
} from '../types.js';
import { CloudflareAuthPanel } from './cloudflare-panel.js';

/**
 * Base URL for the Cloudflare API. `api.cloudflare.com` does not emit CORS
 * headers, so a browser cannot call it directly — apps that host this
 * adapter must reverse-proxy `/cf-api/*` to `https://api.cloudflare.com/client/v4/*`
 * (see `apps/studio/vite.config.ts` for the dev-server setup). In non-browser
 * environments (SSR, tests) we fall back to the direct API base.
 */
const CF_API_BASE =
  typeof window !== 'undefined' ? '/cf-api' : 'https://api.cloudflare.com/client/v4';

export interface CloudflareRelay {
  uid: string;
  name: string;
  status?: string;
  config?: {
    upstreams?: {
      enabled?: boolean;
      upstreams?: Array<{ url: string }>;
    };
  };
}

export interface CloudflareCachedToken {
  operations: AuthOperation[];
  jwt: string;
  jti: string;
  expiresAt: number;
}

/**
 * Persisted state for the Cloudflare adapter.
 * `apiToken`+`accountId` are credentials the user pastes in.
 * `relayId` selects which relay we mint tokens against and connect to.
 * `tokens` caches minted JWTs so a page reload doesn't re-mint.
 */
export interface CloudflareState extends ProviderState {
  apiToken?: string;
  accountId?: string;
  relayId?: string;
  relayUrl?: string;
  tokens?: CloudflareCachedToken[];
}

interface CloudflareEnvelope<T> {
  success: boolean;
  result?: T;
  errors?: Array<{ code: number; message: string }>;
}

async function cfFetch<T>(
  path: string,
  init: RequestInit,
  apiToken: string,
): Promise<T> {
  const res = await fetch(`${CF_API_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiToken}`,
      ...(init.headers ?? {}),
    },
  });
  const body = (await res.json().catch(() => null)) as CloudflareEnvelope<T> | null;
  if (!res.ok || !body || body.success === false) {
    const msg = body?.errors?.map((e) => `${e.code}: ${e.message}`).join('; ')
      ?? `HTTP ${res.status}`;
    throw new Error(`Cloudflare API error: ${msg}`);
  }
  if (!body.result) throw new Error('Cloudflare API returned no result');
  return body.result;
}

export async function listCloudflareRelays(
  accountId: string,
  apiToken: string,
  signal?: AbortSignal,
): Promise<CloudflareRelay[]> {
  return cfFetch<CloudflareRelay[]>(
    `/accounts/${accountId}/moq/relays`,
    { method: 'GET', signal },
    apiToken,
  );
}

interface CloudflareTokenCreateResponse {
  issuers?: Array<{
    cloudflare_tokens?: Array<{
      jti: string;
      created: string;
      expires: string;
      operations: AuthOperation[];
      label?: string;
      secret: string;
    }>;
  }>;
}

export async function createCloudflareToken(
  accountId: string,
  relayId: string,
  operations: AuthOperation[],
  apiToken: string,
  signal?: AbortSignal,
  label?: string,
): Promise<CloudflareCachedToken> {
  const result = await cfFetch<CloudflareTokenCreateResponse>(
    `/accounts/${accountId}/moq/relays/${relayId}/tokens`,
    {
      method: 'POST',
      signal,
      body: JSON.stringify({ operations, label }),
    },
    apiToken,
  );
  const entry = result.issuers?.[0]?.cloudflare_tokens?.[0];
  if (!entry) throw new Error('Cloudflare token response missing secret');
  return {
    operations: entry.operations,
    jwt: entry.secret,
    jti: entry.jti,
    expiresAt: Date.parse(entry.expires),
  };
}

/** True if `cached` covers every operation in `needed`. */
function tokenCovers(cached: CloudflareCachedToken, needed: AuthOperation[]): boolean {
  return needed.every((op) => cached.operations.includes(op));
}

export function relayUrlFromRelay(relay: CloudflareRelay): string | null {
  const upstream = relay.config?.upstreams?.upstreams?.[0]?.url;
  return upstream ?? null;
}

const SKEW_MS = 30_000;

async function mintCloudflareToken(ctx: MintContext): Promise<MintedAuthToken> {
  const state = ctx.state as CloudflareState;
  const { apiToken, accountId, relayId, tokens = [] } = state;
  if (!apiToken || !accountId || !relayId) {
    throw new Error('Cloudflare adapter not configured — open Settings ▸ Auth');
  }

  const now = Date.now();
  const cached = tokens.find(
    (t) => tokenCovers(t, ctx.operations) && t.expiresAt - SKEW_MS > now,
  );
  if (cached) {
    return {
      token: cached.jwt,
      operations: cached.operations,
      expiresAt: cached.expiresAt,
      handle: cached.jti,
    };
  }

  const fresh = await createCloudflareToken(
    accountId,
    relayId,
    ctx.operations,
    apiToken,
    ctx.signal,
    `moq-web ${ctx.operations.join('+')} ${new Date().toISOString().slice(0, 19)}`,
  );

  // The connector-side updateState hook is not available inside mintToken —
  // we can't reach the store from here without a circular dep. Cache in the
  // in-memory adapter singleton and let the settings panel refresh explicitly.
  runtimeCache.push(fresh);

  return {
    token: fresh.jwt,
    operations: fresh.operations,
    expiresAt: fresh.expiresAt,
    handle: fresh.jti,
  };
}

/**
 * In-process cache of minted tokens for the current tab. Populated by both
 * the settings panel (which explicitly mints on button-click and writes to
 * store) and by `mintCloudflareToken` (which mints on demand at connect
 * time without a store reference). The settings panel reads this on mount
 * to reconcile any on-demand mints back into persisted state.
 */
export const runtimeCache: CloudflareCachedToken[] = [];

export const cloudflareAdapter: AuthAdapter = {
  id: 'cloudflare-moq-rs',
  displayName: 'Cloudflare moq-rs',
  description:
    'Provisions scoped JWTs against the Cloudflare MoQ API and passes them to the relay via ?jwt=<token>.',
  mintToken: mintCloudflareToken,
  applyToUrl(url, token) {
    const u = new URL(url);
    u.searchParams.set('jwt', token.token);
    return u.toString();
  },
  SettingsPanel: CloudflareAuthPanel,
};
