import { MOQTransport } from '@moq-web/core';
import { MOQTSession } from '@moq-web/session';
import type { NamespaceAnnouncedEvent } from '@moq-web/session';
import { MediaSession, type MediaConfig } from '@moq-web/media';
import { base64urlDecode, C4M_TOKEN_TYPE } from '@moq-web/cat';

import type { AuthToken } from '../auth/types';
import type { Participant, PeerAudioData, PeerMessage, PeerVideoFrame } from './types';

const CHAT_TRACK = 'chat';
const VIDEO_TRACK = 'video';
const AUDIO_TRACK = 'audio';

const MEDIA_CONFIG: MediaConfig = {
  videoBitrate: 800_000,
  audioBitrate: 64_000,
  videoResolution: '480p',
  videoEnabled: true,
  audioEnabled: true,
  deliveryMode: 'stream',
  audioDeliveryMode: 'datagram',
};

export interface RoomConnectOptions {
  relayUrl: string;
  roomPrefix: string[];
  selfId: string;
  displayName: string;
  chatToken: AuthToken;
  publish: {
    chat: boolean;
    video: boolean;
    audio: boolean;
  };
  onPeerJoined: (participant: Participant) => void;
  onPeerLeft: (participantId: string) => void;
  onMessage: (msg: PeerMessage) => void;
  onVideoFrame: (frame: PeerVideoFrame) => void;
  onAudioData: (audio: PeerAudioData) => void;
  onError: (err: Error) => void;
}

interface PeerState {
  participant: Participant;
  chatSubscribed: boolean;
  mediaSubscribed: boolean;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function tokenToRequestAuth(token: AuthToken) {
  return { tokenBytes: base64urlDecode(token.raw), tokenType: C4M_TOKEN_TYPE };
}

interface ChatWirePayload {
  senderId: string;
  senderName: string;
  text: string;
  timestamp: number;
}

export class MoqtRoom {
  private session?: MOQTSession;
  private mediaSession?: MediaSession;
  private mediaStream?: MediaStream;
  private selfNamespace: string[];
  private chatSeq = 0;
  private chatTrackAlias?: bigint;
  private peers = new Map<string, PeerState>();
  private mediaSubIdToPeer = new Map<number, string>();

  constructor(private readonly opts: RoomConnectOptions) {
    this.selfNamespace = [...opts.roomPrefix, opts.selfId];
  }

  async connect(): Promise<void> {
    const transport = new MOQTransport();
    await transport.connect(this.opts.relayUrl);

    const session = new MOQTSession(transport);
    session.setAuthToken(this.opts.chatToken.raw, C4M_TOKEN_TYPE);
    await session.setup();
    this.session = session;

    this.mediaSession = new MediaSession({ session });

    session.on('namespace-announced', (evt: NamespaceAnnouncedEvent) => {
      this.handleNamespaceAnnounced(evt.namespace);
    });

    this.mediaSession.on('video-frame', ({ subscriptionId, frame }) => {
      const peerId = this.mediaSubIdToPeer.get(subscriptionId);
      if (!peerId) {
        frame.close();
        return;
      }
      this.opts.onVideoFrame({ participantId: peerId, frame });
    });

    this.mediaSession.on('audio-data', ({ subscriptionId, audioData }) => {
      const peerId = this.mediaSubIdToPeer.get(subscriptionId);
      if (!peerId) {
        audioData.close();
        return;
      }
      this.opts.onAudioData({ participantId: peerId, audio: audioData });
    });

    await session.subscribeNamespace(this.opts.roomPrefix);
    await session.announceNamespace(this.selfNamespace, { deliveryMode: 'stream' });

    if (this.opts.publish.chat) {
      this.chatTrackAlias = await session.publish(this.selfNamespace, CHAT_TRACK, {
        deliveryMode: 'stream',
        deliveryTimeout: 0,
        skipForwardWait: true,
      });
    }

    if (this.opts.publish.video || this.opts.publish.audio) {
      await this.startLocalMedia();
    }
  }

  async close(): Promise<void> {
    for (const track of this.mediaStream?.getTracks() ?? []) {
      track.stop();
    }
    this.mediaStream = undefined;

    if (this.mediaSession) {
      await this.mediaSession.close();
      this.mediaSession = undefined;
    }
    if (this.session) {
      await this.session.close();
      this.session = undefined;
    }
    this.peers.clear();
    this.mediaSubIdToPeer.clear();
    this.chatTrackAlias = undefined;
  }

  getLocalMediaStream(): MediaStream | undefined {
    return this.mediaStream;
  }

  async sendChatMessage(text: string): Promise<void> {
    if (!this.session) throw new Error('Room not connected');
    if (this.chatTrackAlias === undefined) throw new Error('Chat track not published');

    const payload: ChatWirePayload = {
      senderId: this.opts.selfId,
      senderName: this.opts.displayName,
      text,
      timestamp: Date.now(),
    };
    const bytes = textEncoder.encode(JSON.stringify(payload));

    const groupId = 0;
    const objectId = this.chatSeq++;
    await this.session.sendObject(this.chatTrackAlias, bytes, { groupId, objectId });
  }

  private async startLocalMedia(): Promise<void> {
    if (!this.mediaSession) return;

    const constraints: MediaStreamConstraints = {
      video: this.opts.publish.video ? { width: 854, height: 480 } : false,
      audio: this.opts.publish.audio,
    };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    this.mediaStream = stream;

    const config: MediaConfig = {
      ...MEDIA_CONFIG,
      videoEnabled: this.opts.publish.video,
      audioEnabled: this.opts.publish.audio,
      authToken: tokenToRequestAuth(this.opts.chatToken),
    };

    if (this.opts.publish.video) {
      await this.mediaSession.publish(this.selfNamespace, VIDEO_TRACK, stream, {
        ...config,
        audioEnabled: false,
      });
    }
    if (this.opts.publish.audio) {
      await this.mediaSession.publish(this.selfNamespace, AUDIO_TRACK, stream, {
        ...config,
        videoEnabled: false,
      });
    }
  }

  private handleNamespaceAnnounced(namespace: string[]): void {
    if (!this.isPeerNamespace(namespace)) return;
    const peerId = namespace[namespace.length - 1]!;
    if (peerId === this.opts.selfId) return;
    if (this.peers.has(peerId)) return;

    const participant: Participant = {
      id: peerId,
      displayName: peerId,
      namespace,
      isSelf: false,
    };
    this.peers.set(peerId, {
      participant,
      chatSubscribed: false,
      mediaSubscribed: false,
    });
    this.opts.onPeerJoined(participant);

    this.subscribePeerChat(peerId, namespace).catch((err) => {
      this.opts.onError(err instanceof Error ? err : new Error(String(err)));
    });
    this.subscribePeerMedia(peerId, namespace).catch((err) => {
      this.opts.onError(err instanceof Error ? err : new Error(String(err)));
    });
  }

  private isPeerNamespace(namespace: string[]): boolean {
    if (namespace.length !== this.opts.roomPrefix.length + 1) return false;
    for (let i = 0; i < this.opts.roomPrefix.length; i++) {
      if (namespace[i] !== this.opts.roomPrefix[i]) return false;
    }
    return true;
  }

  private async subscribePeerChat(peerId: string, namespace: string[]): Promise<void> {
    if (!this.session) return;
    const state = this.peers.get(peerId);
    if (!state || state.chatSubscribed) return;
    state.chatSubscribed = true;

    await this.session.subscribe(namespace, CHAT_TRACK, {}, (data) => {
      try {
        const parsed = JSON.parse(textDecoder.decode(data)) as ChatWirePayload;
        this.opts.onMessage({
          id: `${parsed.senderId}-${parsed.timestamp}`,
          senderId: parsed.senderId,
          senderName: parsed.senderName,
          text: parsed.text,
          timestamp: parsed.timestamp,
        });
      } catch (err) {
        this.opts.onError(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private async subscribePeerMedia(peerId: string, namespace: string[]): Promise<void> {
    if (!this.mediaSession) return;
    const state = this.peers.get(peerId);
    if (!state || state.mediaSubscribed) return;
    state.mediaSubscribed = true;

    const config: MediaConfig = {
      ...MEDIA_CONFIG,
      authToken: tokenToRequestAuth(this.opts.chatToken),
    };

    try {
      const videoSubId = await this.mediaSession.subscribe(namespace, VIDEO_TRACK, config, 'video');
      this.mediaSubIdToPeer.set(videoSubId, peerId);
    } catch (err) {
      this.opts.onError(err instanceof Error ? err : new Error(String(err)));
    }

    try {
      const audioSubId = await this.mediaSession.subscribe(namespace, AUDIO_TRACK, config, 'audio');
      this.mediaSubIdToPeer.set(audioSubId, peerId);
    } catch (err) {
      this.opts.onError(err instanceof Error ? err : new Error(String(err)));
    }
  }
}
