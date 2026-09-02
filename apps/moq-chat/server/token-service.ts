/**
 * Token Service for MoQ Chat
 *
 * Runs on the relay server. Bridges Google OAuth → CAT tokens.
 * Framework: Hono (Deno-compatible, also works with Node)
 *
 * Endpoints:
 *   POST /auth/google/callback - Exchange Google auth code for access token
 *   POST /token               - Issue CAT token for authenticated users
 *   POST /token/anonymous     - Issue restricted CAT token for guests
 *   GET  /health              - Health check
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';

const app = new Hono();

// Config from env
const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID') || '';
const GOOGLE_CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET') || '';
const SIGNING_KEY_HEX = Deno.env.get('CAT_SIGNING_KEY') || '';
const RELAY_AUDIENCE = Deno.env.get('RELAY_AUDIENCE') || 'moq-relay.snk-dev-1-m01x.org';
const TOKEN_ISSUER = Deno.env.get('TOKEN_ISSUER') || 'moq-chat-token-service';
const TOKEN_TTL = parseInt(Deno.env.get('TOKEN_TTL') || '3600', 10);

app.use('*', cors({
  origin: ['https://snk-dev-1-m01x.org', 'https://localhost:5174'],
  allowMethods: ['GET', 'POST'],
  allowHeaders: ['Content-Type', 'Authorization'],
}));

app.get('/health', (c) => c.json({ status: 'ok', service: 'moq-chat-token-service' }));

app.post('/auth/google/callback', async (c) => {
  const { code, code_verifier, redirect_uri } = await c.req.json();

  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri,
      grant_type: 'authorization_code',
      code_verifier,
    }),
  });

  if (!tokenResponse.ok) {
    const err = await tokenResponse.text();
    return c.json({ error: 'token_exchange_failed', details: err }, 400);
  }

  const tokens = await tokenResponse.json();
  return c.json({
    access_token: tokens.access_token,
    id_token: tokens.id_token,
    expires_in: tokens.expires_in,
    token_type: tokens.token_type,
  });
});

app.post('/token', async (c) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'missing_authorization' }, 401);
  }

  const googleToken = authHeader.slice(7);

  // Validate Google token
  const userInfo = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${googleToken}` },
  });

  if (!userInfo.ok) {
    return c.json({ error: 'invalid_google_token' }, 401);
  }

  const user = await userInfo.json();
  const { room_id, role } = await c.req.json();

  // Build CAT token with full access for authenticated users
  const now = Math.floor(Date.now() / 1000);
  const scopes = buildScopes(room_id, role, false);

  const token = await signCatToken({
    iss: TOKEN_ISSUER,
    aud: [RELAY_AUDIENCE],
    sub: user.sub,
    iat: now,
    exp: now + TOKEN_TTL,
    moqt: scopes.raw,
  });

  return c.json({
    token,
    expires_at: now + TOKEN_TTL,
    scopes: scopes.display,
    dpop: false,
  });
});

app.post('/token/anonymous', async (c) => {
  const { room_id, role } = await c.req.json();

  if (role === 'publisher') {
    return c.json({ error: 'anonymous_cannot_publish' }, 403);
  }

  const now = Math.floor(Date.now() / 1000);
  const scopes = buildScopes(room_id, 'subscriber', true);

  const token = await signCatToken({
    iss: TOKEN_ISSUER,
    aud: [RELAY_AUDIENCE],
    sub: `guest-${crypto.randomUUID().slice(0, 8)}`,
    iat: now,
    exp: now + 1800, // 30 min for guests
    moqt: scopes.raw,
  });

  return c.json({
    token,
    expires_at: now + 1800,
    scopes: scopes.display,
    dpop: false,
  });
});

interface ScopeResult {
  raw: Array<{ actions: number[]; namespace: string; track?: string }>;
  display: Array<{ actions: string[]; namespace: string; track?: string }>;
}

function buildScopes(roomId: string, role: string, isAnonymous: boolean): ScopeResult {
  const namespace = `moq-chat/${roomId}`;

  if (isAnonymous) {
    // Guests: subscribe-only on public rooms, no publish
    return {
      raw: [{ actions: [4, 5], namespace, track: '*' }], // Subscribe, Fetch
      display: [{ actions: ['subscribe', 'fetch'], namespace, track: '*' }],
    };
  }

  if (role === 'publisher') {
    return {
      raw: [
        { actions: [2, 6], namespace }, // PublishNamespace, Publish
      ],
      display: [
        { actions: ['publish_namespace', 'publish'], namespace },
      ],
    };
  }

  // Full subscriber: subscribe + fetch on all tracks
  return {
    raw: [
      { actions: [3, 4, 5, 8], namespace }, // SubscribeNamespace, Subscribe, Fetch, TrackStatus
    ],
    display: [
      { actions: ['subscribe_namespace', 'subscribe', 'fetch', 'track_status'], namespace },
    ],
  };
}

async function signCatToken(claims: Record<string, unknown>): Promise<string> {
  // HMAC-SHA256 signing (shared key with relay)
  const keyBytes = hexToBytes(SIGNING_KEY_HEX);
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'CAT' }))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  const payload = btoa(JSON.stringify(claims))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

  const signingInput = new TextEncoder().encode(`${header}.${payload}`);
  const signature = await crypto.subtle.sign('HMAC', key, signingInput);
  const sig = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

  return `${header}.${payload}.${sig}`;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

// Start server
const port = parseInt(Deno.env.get('PORT') || '3000', 10);
console.log(`Token service starting on port ${port}`);
Deno.serve({ port }, app.fetch);
