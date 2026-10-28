/**
 * Moat token-service client for studio's C4M (CAT) flow.
 *
 * Moat owns identity and rooms: a user signs in (Google ID token or guest),
 * gets a moat session token, then mints a CAT scoped to a room's namespace
 * prefix. Studio rooms are moat rooms whose prefix is `studio/<slug>` — the
 * CAT then covers `studio/<slug>/<selfId>/*`, exactly what openStudioBroadcast
 * publishes and subscribes under.
 */

export const MOAT_URL: string =
  import.meta.env.VITE_MOAT_URL || 'https://api.mocha-net.dev/v2';
export const GOOGLE_CLIENT_ID: string =
  import.meta.env.VITE_GOOGLE_CLIENT_ID ||
  '671105403127-u8qe711ovdobtgh2hsfb91u6m7k3qgu9.apps.googleusercontent.com';

/** CAT token type per draft-ietf-moq-c4m-01 §7.1.1. */
export const CAT_TOKEN_TYPE = 1;

const STUDIO_PREFIX = 'studio/';
const SESSION_KEY = 'moq-web:studio:moat-session';
// Moat rejects session tokens older than 24h; drop ours a little earlier.
const SESSION_MAX_AGE_MS = 23 * 3_600_000;

export interface MoatSession {
  sessionToken: string;
  userId: string;
  email: string;
  displayName: string;
  provider: string;
  issuedAt: number;
}

export type RoomVisibility = 'public' | 'authenticated' | 'private';

export interface MoatRoom {
  id: string;
  name: string;
  namespace_prefix: string;
  visibility: RoomVisibility;
  created_at: string;
}

export interface StudioRoom extends MoatRoom {
  /** Room segment studio uses in its namespace: `studio/<slug>/<selfId>`. */
  slug: string;
}

/** Thrown when moat rejects the session token; the caller should sign in again. */
export class MoatAuthError extends Error {}

interface AuthResponse {
  user_id: string;
  email: string;
  display_name: string | null;
  provider: string;
  session_token: string;
}

async function moatFetch<T>(path: string, init: RequestInit = {}, sessionToken?: string): Promise<T> {
  const res = await fetch(`${MOAT_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (res.status === 401) throw new MoatAuthError('Session expired — please sign in again');
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let msg = body;
    try { msg = (JSON.parse(body) as { error?: string }).error ?? body; } catch { /* not JSON */ }
    throw new Error(`moat ${path}: HTTP ${res.status}${msg ? ` — ${msg}` : ''}`);
  }
  return res.json() as Promise<T>;
}

function toSession(r: AuthResponse): MoatSession {
  return {
    sessionToken: r.session_token,
    userId: r.user_id,
    email: r.email,
    displayName: r.display_name || r.email,
    provider: r.provider,
    issuedAt: Date.now(),
  };
}

export function loadSession(): MoatSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as MoatSession;
    if (Date.now() - s.issuedAt > SESSION_MAX_AGE_MS) return null;
    return s;
  } catch {
    return null;
  }
}

export function saveSession(s: MoatSession | null): void {
  try {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else localStorage.removeItem(SESSION_KEY);
  } catch { /* storage unavailable */ }
}

/** Guest sign-in: moat creates a user with a server-chosen UUID. */
export async function guestLogin(displayName: string): Promise<MoatSession> {
  return toSession(await moatFetch<AuthResponse>('/v1/auth/guest', {
    method: 'POST',
    body: JSON.stringify({ display_name: displayName }),
  }));
}

/** Google sign-in: moat verifies the ID token and upserts the user. */
export async function googleLogin(idToken: string): Promise<MoatSession> {
  return toSession(await moatFetch<AuthResponse>('/v1/auth/google', {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}` },
  }));
}

/** Studio rooms only: moat rooms whose prefix is exactly `studio/<slug>`. */
export async function listStudioRooms(): Promise<StudioRoom[]> {
  const rooms = await moatFetch<MoatRoom[]>('/v1/rooms?limit=1000');
  return rooms
    .filter((r) => r.namespace_prefix.startsWith(STUDIO_PREFIX) && r.visibility !== 'private')
    .map((r) => ({ ...r, slug: r.namespace_prefix.slice(STUDIO_PREFIX.length) }))
    .filter((r) => r.slug.length > 0 && !r.slug.includes('/'))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export function slugify(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
}

export async function createStudioRoom(
  session: MoatSession,
  name: string,
  visibility: RoomVisibility,
): Promise<StudioRoom> {
  const slug = slugify(name);
  if (!slug) throw new Error('Room name needs at least one letter or digit');
  const room = await moatFetch<MoatRoom>('/v1/rooms', {
    method: 'POST',
    body: JSON.stringify({ name: name.trim(), namespace_prefix: `${STUDIO_PREFIX}${slug}`, visibility }),
  }, session.sessionToken);
  return { ...room, slug };
}

/**
 * Mint a CAT for `room`. Moat auto-joins the user to public rooms (and to
 * sign-in-required rooms for IdP users). Studio always publishes its timeline
 * and catalog, so it asks for publish + subscribe scopes.
 */
export async function mintCat(session: MoatSession, room: StudioRoom): Promise<{ raw: string; type: number }> {
  const r = await moatFetch<{ token: string }>('/v1/token', {
    method: 'POST',
    body: JSON.stringify({ room_id: room.id, role: 'pubsub' }),
  }, session.sessionToken);
  return { raw: r.token, type: CAT_TOKEN_TYPE };
}
