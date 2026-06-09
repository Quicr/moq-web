import { create } from 'zustand';
import type { MochaSession, MochaChannel, MochaMessage, PresenceEntry, TypingIndicator } from '@web-moq/mocha';

interface Room {
  id: string;
  name: string;
  namespace_prefix: string;
}

interface ChannelState {
  rooms: Room[];
  activeChannel: MochaChannel | null;
  activeRoom: Room | null;
  messages: MochaMessage[];
  roster: Map<string, PresenceEntry>;
  typingUsers: Map<string, TypingIndicator>;

  fetchRooms: () => Promise<void>;
  joinChannel: (session: MochaSession, room: Room) => Promise<void>;
  leaveChannel: () => Promise<void>;
  addMessage: (msg: MochaMessage) => void;
  updatePresence: (entry: PresenceEntry) => void;
  updateTyping: (indicator: TypingIndicator) => void;
}

const TOKEN_SERVICE_URL = import.meta.env.VITE_TOKEN_SERVICE_URL || '/api';

export const useChannelStore = create<ChannelState>((set, get) => ({
  rooms: [],
  activeChannel: null,
  activeRoom: null,
  messages: [],
  roster: new Map(),
  typingUsers: new Map(),

  fetchRooms: async () => {
    try {
      const res = await fetch(`${TOKEN_SERVICE_URL}/rooms`);
      if (!res.ok) return;
      const data = await res.json();
      const rooms: Room[] = data.map((r: { id: string; name: string; namespace_prefix: string }) => ({
        id: r.id,
        name: r.name,
        namespace_prefix: r.namespace_prefix,
      }));
      set({ rooms });
    } catch {
      // silent
    }
  },

  joinChannel: async (session, room) => {
    const existing = get().activeChannel;
    if (existing) {
      await existing.deactivate();
    }

    const channel = await session.joinChannel([], room.name);

    session.on('message', (data) => {
      get().addMessage(data as MochaMessage);
    });

    session.on('presence-update', (data) => {
      get().updatePresence(data as PresenceEntry);
    });

    session.on('typing-update', (data) => {
      get().updateTyping(data as TypingIndicator);
    });

    set({ activeChannel: channel, activeRoom: room, messages: [] });
  },

  leaveChannel: async () => {
    const { activeChannel } = get();
    if (activeChannel) {
      await activeChannel.deactivate();
    }
    set({ activeChannel: null, activeRoom: null, messages: [], roster: new Map(), typingUsers: new Map() });
  },

  addMessage: (msg) => {
    set((s) => ({ messages: [...s.messages, msg] }));
  },

  updatePresence: (entry) => {
    set((s) => {
      const roster = new Map(s.roster);
      if (entry.status === 'offline') {
        roster.delete(entry.userId);
      } else {
        roster.set(entry.userId, entry);
      }
      return { roster };
    });
  },

  updateTyping: (indicator) => {
    set((s) => {
      const typingUsers = new Map(s.typingUsers);
      typingUsers.set(indicator.userId, indicator);
      return { typingUsers };
    });

    // Auto-remove after 5 seconds
    setTimeout(() => {
      set((s) => {
        const typingUsers = new Map(s.typingUsers);
        const current = typingUsers.get(indicator.userId);
        if (current && current.timestamp === indicator.timestamp) {
          typingUsers.delete(indicator.userId);
        }
        return { typingUsers };
      });
    }, 5000);
  },
}));
