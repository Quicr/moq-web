export interface Participant {
  id: string;
  displayName: string;
  namespace: string[];
  isSelf: boolean;
}

export interface PeerMessage {
  id: string;
  senderId: string;
  senderName: string;
  text: string;
  timestamp: number;
}

export interface PeerVideoFrame {
  participantId: string;
  frame: VideoFrame;
}

export interface PeerAudioData {
  participantId: string;
  audio: AudioData;
}
