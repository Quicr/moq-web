export interface AuthUser {
  id: string;
  displayName: string;
  email?: string;
  avatarUrl?: string;
  isAnonymous: boolean;
}

export interface AuthToken {
  raw: string;
  expiresAt: number;
  scopes: TokenScope[];
  hasDpop: boolean;
}

export interface TokenScope {
  actions: string[];
  namespace: string;
  track?: string;
}

export interface AuthStrategy {
  readonly name: string;
  login(): Promise<AuthUser>;
  logout(): Promise<void>;
  getToken(roomId: string, role: 'publisher' | 'subscriber'): Promise<AuthToken>;
  refreshToken(roomId: string, role: 'publisher' | 'subscriber'): Promise<AuthToken>;
}
