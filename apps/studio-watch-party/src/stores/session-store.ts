import { create } from 'zustand';
import { DEFAULT_RELAY_URL, type RoomConnection } from '../lib/session';

export type ConnState =
  | { status: 'idle' }
  | { status: 'connecting' }
  | { status: 'connected'; connection: RoomConnection }
  | { status: 'error'; message: string };

interface SessionStore {
  relayUrl: string;
  conn: ConnState;
  setRelayUrl: (url: string) => void;
  setConn: (conn: ConnState) => void;
}

export const useSessionStore = create<SessionStore>((set) => ({
  relayUrl: DEFAULT_RELAY_URL,
  conn: { status: 'idle' },
  setRelayUrl: (url) => set({ relayUrl: url }),
  setConn: (conn) => set({ conn }),
}));
