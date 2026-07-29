import { create } from 'zustand';

export type GridLayout = '1x2' | '2x2';
export type RankMode = 'equal' | 'speaker-priority';

export interface Participant {
  id: string;
  trackName: string;
  videoElement?: HTMLCanvasElement;
  isSpeaking: boolean;
  currentRendition?: string;
  gridPosition?: number;
}

interface MeetState {
  // Connection
  relayUrl: string;
  setRelayUrl: (url: string) => void;

  // Room
  roomId: string;
  setRoomId: (id: string) => void;
  displayName: string;
  setDisplayName: (name: string) => void;
  isJoined: boolean;
  setJoined: (joined: boolean) => void;
  isBot: boolean;
  setIsBot: (bot: boolean) => void;

  // Settings
  topNVideo: number;
  setTopNVideo: (n: number) => void;
  gridLayout: GridLayout;
  setGridLayout: (layout: GridLayout) => void;
  rankMode: RankMode;
  setRankMode: (mode: RankMode) => void;
  simulcastEnabled: boolean;
  setSimulcastEnabled: (enabled: boolean) => void;

  // Network simulation
  bandwidthCapKbps: number;
  setBandwidthCapKbps: (kbps: number) => void;

  // Media
  isMicOn: boolean;
  toggleMic: () => void;
  isCamOn: boolean;
  toggleCam: () => void;

  // Participants (remote)
  participants: Map<string, Participant>;
  addParticipant: (id: string, p: Participant) => void;
  removeParticipant: (id: string) => void;
  updateParticipant: (id: string, update: Partial<Participant>) => void;
  clearParticipants: () => void;
}

export const useStore = create<MeetState>((set) => ({
  relayUrl: 'auto',
  setRelayUrl: (relayUrl) => set({ relayUrl }),

  roomId: '',
  setRoomId: (roomId) => set({ roomId }),
  displayName: '',
  setDisplayName: (displayName) => set({ displayName }),
  isJoined: false,
  setJoined: (isJoined) => set({ isJoined }),
  isBot: false,
  setIsBot: (isBot) => set({ isBot }),

  topNVideo: 2,
  setTopNVideo: (topNVideo) => set({ topNVideo }),
  gridLayout: '1x2',
  setGridLayout: (gridLayout) => set({ gridLayout }),
  rankMode: 'speaker-priority',
  setRankMode: (rankMode) => set({ rankMode }),
  simulcastEnabled: true,
  setSimulcastEnabled: (simulcastEnabled) => set({ simulcastEnabled }),

  bandwidthCapKbps: 6000,
  setBandwidthCapKbps: (bandwidthCapKbps) => set({ bandwidthCapKbps }),

  isMicOn: true,
  toggleMic: () => set((s) => ({ isMicOn: !s.isMicOn })),
  isCamOn: true,
  toggleCam: () => set((s) => ({ isCamOn: !s.isCamOn })),

  participants: new Map(),
  addParticipant: (id, p) =>
    set((s) => {
      const participants = new Map(s.participants);
      participants.set(id, p);
      return { participants };
    }),
  removeParticipant: (id) =>
    set((s) => {
      const participants = new Map(s.participants);
      participants.delete(id);
      return { participants };
    }),
  updateParticipant: (id, update) =>
    set((s) => {
      const participants = new Map(s.participants);
      const existing = participants.get(id);
      if (existing) participants.set(id, { ...existing, ...update });
      return { participants };
    }),
  clearParticipants: () => set({ participants: new Map() }),
}));
