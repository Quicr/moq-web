import { create } from 'zustand';
import { MochaSession, type MochaSessionState, type MochaIdentity } from '@web-moq/mocha';
import type { MoatTokenProvider } from '@web-moq/mocha';

const RELAY_URL = import.meta.env.VITE_RELAY_URL || 'https://snk-dev-1.m10x.org:4443/moq';

interface ConnectionState {
  session: MochaSession | null;
  state: MochaSessionState;
  error: string | null;

  connect: (realm: string, identity: MochaIdentity, tokenProvider: MoatTokenProvider) => Promise<MochaSession>;
  disconnect: () => Promise<void>;
}

export const useConnectionStore = create<ConnectionState>((set, get) => ({
  session: null,
  state: 'disconnected',
  error: null,

  connect: async (realm, identity, tokenProvider) => {
    const existing = get().session;
    if (existing) return existing;

    const session = new MochaSession({
      relayUrl: RELAY_URL,
      tokenProvider,
      realm,
      identity,
    });

    session.on('state-change', (state) => {
      set({ state: state as MochaSessionState });
    });

    session.on('error', (err) => {
      set({ error: (err as Error).message });
    });

    set({ session, state: 'connecting' });

    try {
      await session.connect();
      return session;
    } catch (err) {
      set({ error: (err as Error).message, session: null });
      throw err;
    }
  },

  disconnect: async () => {
    const { session } = get();
    if (session) {
      await session.disconnect();
      set({ session: null, state: 'disconnected', error: null });
    }
  },
}));
