import { create } from 'zustand';

import type { AuthToken } from '../lib/auth/types';
import { MoqtRoom } from '../lib/chat/moqt-room';
import type { Participant, PeerAudioData, PeerMessage, PeerVideoFrame } from '../lib/chat/types';

const RELAY_URL =
  import.meta.env.VITE_MOQ_RELAY_URL || 'https://moqx-main.ci.openmoq.org:4433/moq-relay';

export interface JoinParams {
  roomId: string;
  namespacePrefix: string;
  selfId: string;
  displayName: string;
  token: AuthToken;
  publishVideo: boolean;
  publishAudio: boolean;
}

interface MoqtState {
  room: MoqtRoom | null;
  connecting: boolean;
  connectionError: string | null;
  participants: Participant[];
  messages: PeerMessage[];
  localStream: MediaStream | null;
  peerVideoFrames: Map<string, VideoFrame>;

  join: (params: JoinParams) => Promise<void>;
  leave: () => Promise<void>;
  sendMessage: (text: string) => Promise<void>;
  setLocalMuted: (muted: boolean) => void;
  setLocalVideoOff: (off: boolean) => void;
}

function parseNamespace(prefix: string): string[] {
  return prefix.split('/').filter((s) => s.length > 0);
}

export const useMoqtStore = create<MoqtState>((set, get) => {
  const audioContext = typeof AudioContext !== 'undefined' ? new AudioContext() : undefined;

  async function playAudio({ audio }: PeerAudioData): Promise<void> {
    if (!audioContext) {
      audio.close();
      return;
    }
    try {
      const channels = audio.numberOfChannels;
      const frames = audio.numberOfFrames;
      const buffer = audioContext.createBuffer(channels, frames, audio.sampleRate);
      for (let ch = 0; ch < channels; ch++) {
        const data = new Float32Array(frames);
        audio.copyTo(data, { planeIndex: ch });
        buffer.copyToChannel(data, ch);
      }
      const source = audioContext.createBufferSource();
      source.buffer = buffer;
      source.connect(audioContext.destination);
      source.start();
    } finally {
      audio.close();
    }
  }

  return {
    room: null,
    connecting: false,
    connectionError: null,
    participants: [],
    messages: [],
    localStream: null,
    peerVideoFrames: new Map(),

    join: async (params) => {
      const prev = get().room;
      if (prev) {
        await prev.close();
      }
      set({
        room: null,
        connecting: true,
        connectionError: null,
        participants: [],
        messages: [],
        localStream: null,
        peerVideoFrames: new Map(),
      });

      const roomPrefix = [...parseNamespace(params.namespacePrefix), params.roomId];
      const room = new MoqtRoom({
        relayUrl: RELAY_URL,
        roomPrefix,
        selfId: params.selfId,
        displayName: params.displayName,
        chatToken: params.token,
        publish: {
          chat: true,
          video: params.publishVideo,
          audio: params.publishAudio,
        },
        onPeerJoined: (participant: Participant) => {
          set((s) => {
            if (s.participants.some((p) => p.id === participant.id)) return s;
            return { participants: [...s.participants, participant] };
          });
        },
        onPeerLeft: (participantId: string) => {
          set((s) => {
            const next = new Map(s.peerVideoFrames);
            const prevFrame = next.get(participantId);
            if (prevFrame) prevFrame.close();
            next.delete(participantId);
            return {
              participants: s.participants.filter((p) => p.id !== participantId),
              peerVideoFrames: next,
            };
          });
        },
        onMessage: (msg: PeerMessage) => {
          set((s) => ({ messages: [...s.messages, msg] }));
        },
        onVideoFrame: ({ participantId, frame }: PeerVideoFrame) => {
          set((s) => {
            const next = new Map(s.peerVideoFrames);
            const prev = next.get(participantId);
            if (prev) prev.close();
            next.set(participantId, frame);
            return { peerVideoFrames: next };
          });
        },
        onAudioData: (audio: PeerAudioData) => {
          void playAudio(audio);
        },
        onError: (err: Error) => {
          console.error('[moqt-room]', err);
          set({ connectionError: err.message });
        },
      });

      try {
        await room.connect();
        set({
          room,
          connecting: false,
          localStream: room.getLocalMediaStream() ?? null,
        });
      } catch (err) {
        await room.close().catch(() => {});
        set({
          room: null,
          connecting: false,
          connectionError: (err as Error).message,
        });
        throw err;
      }
    },

    leave: async () => {
      const room = get().room;
      const stream = get().localStream;
      const frames = get().peerVideoFrames;
      for (const frame of frames.values()) frame.close();
      if (stream) for (const t of stream.getTracks()) t.stop();
      set({
        room: null,
        participants: [],
        messages: [],
        localStream: null,
        peerVideoFrames: new Map(),
      });
      if (room) await room.close();
    },

    sendMessage: async (text) => {
      const room = get().room;
      if (!room) throw new Error('Not connected to a room');
      await room.sendChatMessage(text);
    },

    setLocalMuted: (muted) => {
      const stream = get().localStream;
      if (!stream) return;
      for (const track of stream.getAudioTracks()) {
        track.enabled = !muted;
      }
    },

    setLocalVideoOff: (off) => {
      const stream = get().localStream;
      if (!stream) return;
      for (const track of stream.getVideoTracks()) {
        track.enabled = !off;
      }
    },
  };
});
