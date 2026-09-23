import { create } from 'zustand';

const TOKEN_SERVICE_URL = import.meta.env.VITE_TOKEN_SERVICE_URL || '/api';

export interface Room {
  id: string;
  name: string;
  namespace_prefix: string;
  isPublic: boolean;
  participants: number;
  createdBy: string;
  hasVideo: boolean;
  hasAudio: boolean;
}

export interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  text: string;
  timestamp: number;
  isSystem?: boolean;
}

interface RoomState {
  rooms: Room[];
  currentRoom: Room | null;
  messages: ChatMessage[];
  isConnecting: boolean;

  fetchRooms: () => Promise<void>;
  setRooms: (rooms: Room[]) => void;
  joinRoom: (room: Room) => void;
  leaveRoom: () => void;
  addMessage: (msg: ChatMessage) => void;
  setConnecting: (v: boolean) => void;
}

export const useRoomStore = create<RoomState>((set) => ({
  rooms: [],
  currentRoom: null,
  messages: [],
  isConnecting: false,

  fetchRooms: async () => {
    try {
      const response = await fetch(`${TOKEN_SERVICE_URL}/rooms`);
      if (!response.ok) return;
      const data = await response.json();
      const rooms: Room[] = data.map((r: { id: string; name: string; namespace_prefix: string }) => ({
        id: r.id,
        name: r.name,
        namespace_prefix: r.namespace_prefix,
        isPublic: true,
        participants: 0,
        createdBy: 'system',
        hasVideo: true,
        hasAudio: true,
      }));
      set({ rooms });
    } catch {
      // silently fail, UI will show empty state
    }
  },

  setRooms: (rooms) => set({ rooms }),
  joinRoom: (room) => set({ currentRoom: room, messages: [] }),
  leaveRoom: () => set({ currentRoom: null, messages: [] }),
  addMessage: (msg) => set((s) => ({ messages: [...s.messages, msg] })),
  setConnecting: (v) => set({ isConnecting: v }),
}));
