export interface Participant {
  id: string;
  displayName: string;
  namespace: string[];
  isSelf: boolean;
  /** Current audio activity value (0=silent, 1=continuous, 2=speechStart) */
  activityValue?: number;
  /** Timestamp of last received video frame (for staleness detection) */
  lastFrameTime?: number;
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
