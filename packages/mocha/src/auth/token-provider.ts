import type { MochaIdentity } from '../types.js';

export interface TokenProvider {
  getToken(roomId: string, role: 'publisher' | 'subscriber'): Promise<string>;
  refreshIfNeeded(): Promise<string | null>;
}

interface MoatGuestResponse {
  user_id: string;
  email: string;
  display_name: string;
  provider: string;
  session_token: string;
}

interface MoatTokenResponse {
  token: string;
  expires_at: number;
  scopes: Array<{ actions: string[]; namespace: string }>;
  dpop: boolean;
}

export class MoatTokenProvider implements TokenProvider {
  private sessionToken: string | null = null;
  private cachedToken: string | null = null;
  private tokenExpiresAt = 0;

  constructor(private baseUrl: string) {}

  async loginGuest(displayName: string): Promise<MochaIdentity> {
    const res = await fetch(`${this.baseUrl}/auth/guest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ display_name: displayName }),
    });
    if (!res.ok) throw new Error(`Guest login failed: ${res.status}`);
    const data: MoatGuestResponse = await res.json();
    this.sessionToken = data.session_token;
    return {
      userId: data.user_id,
      displayName: data.display_name || displayName,
    };
  }

  async loginGoogle(idToken: string): Promise<MochaIdentity> {
    const res = await fetch(`${this.baseUrl}/auth/google`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`,
      },
    });
    if (!res.ok) throw new Error(`Google login failed: ${res.status}`);
    const data: MoatGuestResponse = await res.json();
    this.sessionToken = data.session_token;
    return {
      userId: data.user_id,
      displayName: data.display_name || data.email,
    };
  }

  async getToken(roomId: string, role: 'publisher' | 'subscriber'): Promise<string> {
    if (this.cachedToken && Date.now() / 1000 < this.tokenExpiresAt - 60) {
      return this.cachedToken;
    }

    const endpoint = this.sessionToken
      ? `${this.baseUrl}/token`
      : `${this.baseUrl}/token/anonymous`;

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.sessionToken) {
      headers['Authorization'] = `Bearer ${this.sessionToken}`;
    }

    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ room_id: roomId, role }),
    });
    if (!res.ok) throw new Error(`Token mint failed: ${res.status}`);
    const data: MoatTokenResponse = await res.json();
    this.cachedToken = data.token;
    this.tokenExpiresAt = data.expires_at;
    return data.token;
  }

  async refreshIfNeeded(): Promise<string | null> {
    if (!this.cachedToken) return null;
    if (Date.now() / 1000 > this.tokenExpiresAt - 60) {
      this.cachedToken = null;
    }
    return this.cachedToken;
  }
}
