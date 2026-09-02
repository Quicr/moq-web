import type { AuthStrategy, AuthToken, AuthUser, TokenScope } from './types';

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || '';
const TOKEN_SERVICE_URL = import.meta.env.VITE_TOKEN_SERVICE_URL || '/api';

interface MoatAuthResponse {
  user_id: string;
  email: string;
  display_name: string | null;
  provider: string;
  session_token: string;
}

interface TokenServiceResponse {
  token: string;
  expires_at: number;
  scopes: TokenScope[];
  dpop: boolean;
}

export class GoogleCatStrategy implements AuthStrategy {
  readonly name = 'google-cat';
  private sessionToken: string | null = null;

  async login(): Promise<AuthUser> {
    const idToken = await this.getGoogleIdToken();

    const response = await fetch(`${TOKEN_SERVICE_URL}/auth/google`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${idToken}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Google login failed: ${response.status}`);
    }

    const data: MoatAuthResponse = await response.json();
    this.sessionToken = data.session_token;

    return {
      id: data.user_id,
      displayName: data.display_name || data.email,
      email: data.email,
      isAnonymous: false,
    };
  }

  async logout(): Promise<void> {
    this.sessionToken = null;
  }

  async getToken(roomId: string, role: 'publisher' | 'subscriber'): Promise<AuthToken> {
    if (!this.sessionToken) {
      throw new Error('Not authenticated');
    }

    const response = await fetch(`${TOKEN_SERVICE_URL}/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.sessionToken}`,
      },
      body: JSON.stringify({ room_id: roomId, role }),
    });

    if (!response.ok) {
      throw new Error(`Token service error: ${response.status}`);
    }

    const data: TokenServiceResponse = await response.json();
    return {
      raw: data.token,
      expiresAt: data.expires_at,
      scopes: data.scopes,
      hasDpop: data.dpop,
    };
  }

  async refreshToken(roomId: string, role: 'publisher' | 'subscriber'): Promise<AuthToken> {
    return this.getToken(roomId, role);
  }

  private async getGoogleIdToken(): Promise<string> {
    return new Promise((resolve, reject) => {
      const redirectUri = `${window.location.origin}/auth/callback`;
      const params = new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        redirect_uri: redirectUri,
        response_type: 'id_token',
        scope: 'openid email profile',
        nonce: crypto.randomUUID(),
      });

      const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
      const popup = window.open(authUrl, 'google-auth', 'width=500,height=600,left=200,top=100');
      if (!popup) {
        reject(new Error('Popup blocked'));
        return;
      }

      const interval = setInterval(() => {
        try {
          if (popup.closed) {
            clearInterval(interval);
            reject(new Error('Auth window closed'));
            return;
          }
          const url = popup.location.href;
          if (url.startsWith(redirectUri)) {
            clearInterval(interval);
            popup.close();
            const hash = new URL(url).hash.slice(1);
            const params = new URLSearchParams(hash);
            const idToken = params.get('id_token');
            if (idToken) {
              resolve(idToken);
            } else {
              reject(new Error(params.get('error') || 'No id_token returned'));
            }
          }
        } catch {
          // cross-origin - still waiting
        }
      }, 200);
    });
  }
}

export class AnonymousStrategy implements AuthStrategy {
  readonly name = 'anonymous';

  async login(): Promise<AuthUser> {
    const displayName = `Guest-${crypto.randomUUID().slice(0, 8)}`;

    const response = await fetch(`${TOKEN_SERVICE_URL}/auth/guest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ display_name: displayName }),
    });

    if (!response.ok) {
      throw new Error(`Guest login failed: ${response.status}`);
    }

    const data: MoatAuthResponse = await response.json();

    return {
      id: data.user_id,
      displayName: data.display_name || displayName,
      email: data.email,
      isAnonymous: true,
    };
  }

  async logout(): Promise<void> {}


  async getToken(roomId: string, role: 'publisher' | 'subscriber'): Promise<AuthToken> {
    const response = await fetch(`${TOKEN_SERVICE_URL}/token/anonymous`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room_id: roomId, role }),
    });

    if (!response.ok) {
      throw new Error(`Token service error: ${response.status}`);
    }

    const data: TokenServiceResponse = await response.json();
    return {
      raw: data.token,
      expiresAt: data.expires_at,
      scopes: data.scopes,
      hasDpop: data.dpop,
    };
  }

  async refreshToken(roomId: string, role: 'publisher' | 'subscriber'): Promise<AuthToken> {
    return this.getToken(roomId, role);
  }
}
