import { create } from 'zustand';
import type { AuthStrategy, AuthToken, AuthUser } from '../lib/auth';
import { AnonymousStrategy, GoogleCatStrategy } from '../lib/auth';

interface AuthState {
  user: AuthUser | null;
  token: AuthToken | null;
  strategy: AuthStrategy | null;
  isLoading: boolean;
  error: string | null;

  loginWithGoogle: () => Promise<void>;
  loginAsGuest: () => Promise<void>;
  logout: () => Promise<void>;
  fetchToken: (roomId: string, role: 'publisher' | 'subscriber') => Promise<AuthToken>;
  clearError: () => void;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  token: null,
  strategy: null,
  isLoading: false,
  error: null,

  loginWithGoogle: async () => {
    set({ isLoading: true, error: null });
    try {
      const strategy = new GoogleCatStrategy();
      const user = await strategy.login();
      set({ user, strategy, isLoading: false });
    } catch (err) {
      set({ error: (err as Error).message, isLoading: false });
    }
  },

  loginAsGuest: async () => {
    set({ isLoading: true, error: null });
    try {
      const strategy = new AnonymousStrategy();
      const user = await strategy.login();
      set({ user, strategy, isLoading: false });
    } catch (err) {
      set({ error: (err as Error).message, isLoading: false });
    }
  },

  logout: async () => {
    const { strategy } = get();
    if (strategy) {
      await strategy.logout();
    }
    set({ user: null, token: null, strategy: null });
  },

  fetchToken: async (roomId: string, role: 'publisher' | 'subscriber') => {
    const { strategy } = get();
    if (!strategy) throw new Error('Not authenticated');

    const token = await strategy.getToken(roomId, role);
    set({ token });
    return token;
  },

  clearError: () => set({ error: null }),
}));
