import { create } from 'zustand';
import { MoatTokenProvider, type MochaIdentity } from '@web-moq/mocha';

const TOKEN_SERVICE_URL = import.meta.env.VITE_TOKEN_SERVICE_URL || '/api';

interface AuthState {
  identity: MochaIdentity | null;
  tokenProvider: MoatTokenProvider;
  isLoading: boolean;
  error: string | null;

  loginAsGuest: (displayName?: string) => Promise<void>;
  loginWithGoogle: (idToken: string) => Promise<void>;
  logout: () => void;
  clearError: () => void;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  identity: null,
  tokenProvider: new MoatTokenProvider(TOKEN_SERVICE_URL),
  isLoading: false,
  error: null,

  loginAsGuest: async (displayName?: string) => {
    set({ isLoading: true, error: null });
    try {
      const name = displayName || `Guest-${crypto.randomUUID().slice(0, 8)}`;
      const identity = await get().tokenProvider.loginGuest(name);
      set({ identity, isLoading: false });
    } catch (err) {
      set({ error: (err as Error).message, isLoading: false });
    }
  },

  loginWithGoogle: async (idToken: string) => {
    set({ isLoading: true, error: null });
    try {
      const identity = await get().tokenProvider.loginGoogle(idToken);
      set({ identity, isLoading: false });
    } catch (err) {
      set({ error: (err as Error).message, isLoading: false });
    }
  },

  logout: () => {
    set({ identity: null });
  },

  clearError: () => set({ error: null }),
}));
