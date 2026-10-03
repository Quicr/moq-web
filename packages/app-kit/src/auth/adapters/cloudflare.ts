// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Cloudflare moq-rs auth adapter.
 *
 * Cloudflare provisions per-relay JWT tokens scoped to `publish` or
 * `subscribe` (docs at https://developers.cloudflare.com/api/resources/moq/).
 * This adapter supports two modes, selected by `state.authMode`:
 *
 *   'api' (default):
 *     1. User pastes a Cloudflare API token + account ID (persisted in the
 *        transport store's provider state, localStorage).
 *     2. Adapter lists relays and lets the user pick one — its
 *        `config.upstreams` URL is treated as the WebTransport endpoint.
 *     3. On demand (`mintToken({operations:['publish']})`) the adapter first
 *        returns a cached JWT for those operations if unexpired; otherwise it
 *        POSTs to `/relays/{id}/tokens` and caches the returned `secret`.
 *
 *   'preminted':
 *     1. User pastes a relay WebTransport URL, a relayId, and one or more
 *        pre-minted JWTs (publish and/or subscribe) obtained out-of-band.
 *     2. The adapter decodes `jti`/`exp`/`operations` from each JWT and stores
 *        them in `state.tokens`.
 *     3. `mintToken` serves from this cache only — no API call is made, and
 *        apiToken/accountId are not required.
 *
 * In both modes `applyToUrl` appends `?jwt=<token>` to the WebTransport URL
 * — the token rides the HTTP/3 CONNECT and the relay sees it either as the
 * query string (browser) or as a MOQT SETUP-carried URL (raw QUIC).
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
  /**
   * How this adapter obtains tokens:
   *   - 'api' (default): drive the Cloudflare REST API via apiToken+accountId
   *     to list relays and mint tokens on demand.
   *   - 'preminted': user has already minted JWTs out-of-band and pasted them
   *     in; the adapter only reads `tokens` and never calls the API.
   */
  authMode?: 'api' | 'preminted';
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

/**
 * Decode the payload of a Cloudflare-issued JWT without verifying its
 * signature. We only need `jti`, `sub`, `exp`, and `operations` to populate
 * a `CloudflareCachedToken` and pre-fill the panel's Relay ID field;
 * signature verification is the relay's job.
 */
export function parseCloudflareJwt(jwt: string): {
  jti: string;
  sub?: string;
  operations: AuthOperation[];
  expiresAt: number;
} {
  const parts = jwt.split('.');
  if (parts.length !== 3) throw new Error('JWT must have three dot-separated parts');
  const [, payloadB64] = parts;
  const pad = payloadB64.length % 4 === 2 ? '==' : payloadB64.length % 4 === 3 ? '=' : '';
  const b64 = payloadB64.replace(/-/g, '+').replace(/_/g, '/') + pad;
  let payload: { jti?: string; sub?: string; exp?: number; operations?: string[] };
  try {
    payload = JSON.parse(atob(b64));
  } catch (err) {
    throw new Error(`JWT payload is not valid JSON: ${(err as Error).message}`);
  }
  if (!payload.jti || typeof payload.jti !== 'string') {
    throw new Error('JWT payload missing jti');
  }
  if (typeof payload.exp !== 'number') {
    throw new Error('JWT payload missing numeric exp');
  }
  const operations = (payload.operations ?? []).filter(
    (op): op is AuthOperation => op === 'publish' || op === 'subscribe',
  );
  if (operations.length === 0) {
    throw new Error('JWT payload missing publish/subscribe operations');
  }
  return {
    jti: payload.jti,
    sub: typeof payload.sub === 'string' ? payload.sub : undefined,
    operations,
    expiresAt: payload.exp * 1000,
  };
}

async function mintCloudflareToken(ctx: MintContext): Promise<MintedAuthToken> {
  const state = ctx.state as CloudflareState;
  const { apiToken, accountId, relayId, tokens = [] } = state;

  // Cache first: in both 'api' and 'preminted' modes, a non-expired cached
  // token covering the requested operations is returned without touching the
  // Cloudflare REST API. This is what lets 'preminted' mode work with no
  // apiToken/accountId at all.
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

  if (!apiToken || !accountId || !relayId) {
    throw new Error(
      `Cloudflare adapter has no cached token for ${ctx.operations.join('+')} ` +
      'and no API credentials to mint one — open Settings ▸ Auth',
    );
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
