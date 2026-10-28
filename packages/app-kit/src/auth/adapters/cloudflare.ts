// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Cloudflare moq-rs auth adapter.
 *
 * Cloudflare relays need a relay connection token (a JWT issued by
 * Cloudflare, `sub` = relay UID) to select the tenant relay. The user pastes
 * one JWT in the settings panel; `mintToken` serves it from state — no
 * Cloudflare API call is made (api.cloudflare.com has no CORS, so a browser
 * can't mint them anyway; operators mint them out-of-band).
 *
 * `applyToUrl` puts the token in the first path segment of the WebTransport
 * URL (`https://<relay-host>/<token>`) — the relay uses it to select the
 * tenant relay; a missing/invalid token closes the session with
 * `scope resolution failed` (code 3).
 *
 * `catEnabled` records whether the relay also requires a CAT (Cloudflare
 * draft-18 pilot, draft-ietf-moq-c4m). The adapter does not mint CATs: the
 * app owns login/room business logic, mints the CAT from its token service,
 * and passes it as `connectMoqtSession({ authToken })`, which rides SETUP
 * AUTHORIZATION_TOKEN (type 1). Both credentials are required when enabled.
 */

import type {
  AuthAdapter,
  AuthOperation,
  MintContext,
  MintedAuthToken,
  ProviderState,
} from '../types.js';
import { CloudflareAuthPanel } from './cloudflare-panel.js';

export interface CloudflareCachedToken {
  operations: AuthOperation[];
  jwt: string;
  jti: string;
  expiresAt: number;
}

/**
 * Persisted state for the Cloudflare adapter.
 * `relayJwt` is the pasted relay connection token; `catEnabled` tells the app
 * that the relay requires a CAT in SETUP.
 */
export interface CloudflareState extends ProviderState {
  relayJwt?: string;
  catEnabled?: boolean;
  /** @deprecated pre-minted token cache from the old panel; read as a fallback. */
  tokens?: CloudflareCachedToken[];
}

const SKEW_MS = 30_000;

/**
 * Decode the payload of a Cloudflare-issued JWT without verifying its
 * signature. We only need `jti`, `sub`, `exp`, and `operations` to show the
 * token in the panel and check it covers the requested operations;
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

/** True when the selected auth provider is Cloudflare with CAT required. */
export function isCloudflareCatEnabled(
  auth: { providerId: string | null; providerState: ProviderState } | undefined,
): boolean {
  return auth?.providerId === cloudflareAdapter.id && !!(auth.providerState as CloudflareState).catEnabled;
}

async function mintCloudflareToken(ctx: MintContext): Promise<MintedAuthToken> {
  const state = ctx.state as CloudflareState;
  const candidates = [
    ...(state.relayJwt ? [state.relayJwt] : []),
    ...(state.tokens ?? []).map((t) => t.jwt),
  ];
  const now = Date.now();
  for (const jwt of candidates) {
    let info: ReturnType<typeof parseCloudflareJwt>;
    try {
      info = parseCloudflareJwt(jwt);
    } catch {
      continue;
    }
    if (info.expiresAt - SKEW_MS <= now) continue;
    if (!ctx.operations.every((op) => info.operations.includes(op))) continue;
    return { token: jwt, operations: info.operations, expiresAt: info.expiresAt, handle: info.jti };
  }
  throw new Error(
    `No unexpired Cloudflare relay token covering ${ctx.operations.join('+')} — ` +
    'paste one in Settings ▸ Auth',
  );
}

export const cloudflareAdapter: AuthAdapter = {
  id: 'cloudflare-moq-rs',
  displayName: 'Cloudflare moq-rs',
  description:
    'Sends a Cloudflare relay connection token as the first URL path segment; optionally requires a CAT in SETUP.',
  mintToken: mintCloudflareToken,
  applyToUrl(url, token) {
    const u = new URL(url);
    // Token is the first path segment; keep any path the user configured after it.
    const rest = u.pathname.replace(/^\/+/, '');
    u.pathname = `/${token.token}${rest ? `/${rest}` : ''}`;
    u.searchParams.delete('jwt');
    return u.toString();
  },
  SettingsPanel: CloudflareAuthPanel,
};
