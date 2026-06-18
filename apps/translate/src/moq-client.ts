import { MOQTransport } from '@web-moq/core';
import { MOQTSession } from '@web-moq/session';
import type { IncomingPublishEvent } from '@web-moq/session';

export const EXT_EZDUBS_METADATA = 0x10;

export interface EzDubsMetadata {
  responseType: number;
  hasTranslated: boolean;
  hasEcho: boolean;
}

export interface SessionConfig {
  relayUrl: string;
  namespacePrefix: string[];
  sessionId: string;
  participantId: string;
  sourceLanguage: string;
  targetLanguage: string;
}

export interface RemoteParticipant {
  id: string;
  namespace: string[];
  trackName: string;
}

export type OnAudioReceived = (participantId: string, data: Uint8Array, groupId: number, objectId: number, metadata?: EzDubsMetadata) => void;
export type OnParticipantDiscovered = (participant: RemoteParticipant) => void;
export type OnStatusChange = (status: string) => void;

export class EzDubsWebClient {
  private transport: MOQTransport | null = null;
  private session: MOQTSession | null = null;
  private config: SessionConfig;
  private publishTrackAlias: bigint | null = null;
  private onAudioReceived: OnAudioReceived | null = null;
  private onParticipantDiscovered: OnParticipantDiscovered | null = null;
  private onStatusChange: OnStatusChange | null = null;
  private groupId = 0;
  private objectId = 0;
  private groupSize = 50;
  private discoveredParticipants = new Map<string, RemoteParticipant>();

  constructor(config: SessionConfig) {
    this.config = config;
  }

  setOnAudioReceived(cb: OnAudioReceived) { this.onAudioReceived = cb; }
  setOnParticipantDiscovered(cb: OnParticipantDiscovered) { this.onParticipantDiscovered = cb; }
  setOnStatusChange(cb: OnStatusChange) { this.onStatusChange = cb; }

  private status(msg: string) {
    this.onStatusChange?.(msg);
  }

  async connect(): Promise<void> {
    this.status('Connecting...');

    this.transport = new MOQTransport();
    await this.transport.connect(this.config.relayUrl);
    this.status('Transport connected, setting up session...');

    this.session = new MOQTSession(this.transport);
    await this.session.setup();
    this.status('Session ready');

    this.session.on('incoming-publish', (event: IncomingPublishEvent) => {
      this.handleIncomingPublish(event);
    });
  }

  async startPublishing(): Promise<void> {
    if (!this.session) throw new Error('Not connected');

    const namespace = this.getClientInputNamespace();
    const trackName = 'audio';

    this.status(`Publishing to ${namespace.join('/')}/${trackName}`);
    this.publishTrackAlias = await this.session.publish(namespace, trackName, {
      priority: 128,
      deliveryTimeout: 2000,
    });
    this.status('Publishing started');
  }

  async sendAudioObject(opusFrame: Uint8Array): Promise<void> {
    if (!this.session || this.publishTrackAlias === null) return;

    await this.session.sendObject(this.publishTrackAlias, opusFrame, {
      groupId: this.groupId,
      objectId: this.objectId,
      type: 'audio',
    });

    this.objectId++;
    if (this.objectId >= this.groupSize) {
      this.objectId = 0;
      this.groupId++;
    }
  }

  async subscribePassthrough(): Promise<void> {
    if (!this.session) throw new Error('Not connected');

    const prefix = this.getPassthroughSubNamespace();
    this.status(`Subscribing to passthrough: ${prefix.join('/')}`);

    await this.session.subscribeNamespace(prefix, {
      onObject: (data, groupId, objectId, _timestamp, extensions) => {
        this.handlePassthroughObject(data, groupId, objectId, extensions);
      },
    });
  }

  async subscribeServerOutput(): Promise<void> {
    if (!this.session) throw new Error('Not connected');

    const prefix = this.getServerSubNamespace();
    this.status(`Subscribing to server output: ${prefix.join('/')}`);

    await this.session.subscribeNamespace(prefix, {
      onObject: (data, groupId, objectId, _timestamp, extensions) => {
        this.handleServerObject(data, groupId, objectId, extensions);
      },
    });
  }

  async disconnect(): Promise<void> {
    if (this.transport) {
      await this.transport.close();
      this.transport = null;
      this.session = null;
      this.publishTrackAlias = null;
    }
    this.groupId = 0;
    this.objectId = 0;
    this.discoveredParticipants.clear();
    this.status('Disconnected');
  }

  private handleIncomingPublish(event: IncomingPublishEvent) {
    const ns = event.namespace;
    const nsStr = ns.join('/');

    const ptPrefix = this.getPassthroughSubNamespace();
    if (ns.length === ptPrefix.length + 1 && this.matchesPrefix(ns, ptPrefix)) {
      const participantId = ns[ns.length - 1];
      if (participantId === this.config.participantId) return;

      const participant: RemoteParticipant = {
        id: participantId,
        namespace: ns,
        trackName: event.trackName,
      };
      this.discoveredParticipants.set(participantId, participant);
      this.onParticipantDiscovered?.(participant);
      this.status(`Discovered participant: ${participantId}`);
      return;
    }

    const srvPrefix = this.getServerSubNamespace();
    if (this.matchesPrefix(ns, srvPrefix)) {
      this.status(`Server track discovered: ${nsStr}/${event.trackName}`);
      return;
    }

    this.status(`Unknown publish: ${nsStr}/${event.trackName}`);
  }

  private handlePassthroughObject(data: Uint8Array, _groupId: number, _objectId: number, extensions?: Map<number, Uint8Array>) {
    if (data.length === 0) return;
    const metadata = this.parseMetadata(extensions);
    this.onAudioReceived?.('passthrough', data, _groupId, _objectId, metadata);
  }

  private handleServerObject(data: Uint8Array, _groupId: number, _objectId: number, extensions?: Map<number, Uint8Array>) {
    if (data.length === 0) return;
    const metadata = this.parseMetadata(extensions);
    this.onAudioReceived?.('server', data, _groupId, _objectId, metadata);
  }

  private parseMetadata(extensions?: Map<number, Uint8Array>): EzDubsMetadata | undefined {
    if (!extensions) return undefined;
    const ext = extensions.get(EXT_EZDUBS_METADATA);
    if (!ext || ext.length < 8) return undefined;
    const view = new DataView(ext.buffer, ext.byteOffset, ext.byteLength);
    const responseType = view.getUint32(0, false);
    const flags = view.getUint32(4, false);
    return {
      responseType,
      hasTranslated: (flags & 0x01) !== 0,
      hasEcho: (flags & 0x02) !== 0,
    };
  }

  private matchesPrefix(ns: string[], prefix: string[]): boolean {
    if (ns.length < prefix.length) return false;
    for (let i = 0; i < prefix.length; i++) {
      if (ns[i] !== prefix[i]) return false;
    }
    return true;
  }

  // Namespace layout (matches C++ client):
  // Client input:       [prefix..., session_id, "client", "in", participant_id, source_language]
  // Passthrough:        [prefix..., session_id, "client", "passthrough", participant_id]
  // Passthrough sub-ns: [prefix..., session_id, "client", "passthrough"]
  // Server sub-ns:      [prefix..., session_id, "server"]

  private getClientInputNamespace(): string[] {
    return [
      ...this.config.namespacePrefix,
      this.config.sessionId,
      'client', 'in',
      this.config.participantId,
      this.config.sourceLanguage,
    ];
  }

  getPassthroughSubNamespace(): string[] {
    return [
      ...this.config.namespacePrefix,
      this.config.sessionId,
      'client', 'passthrough',
    ];
  }

  private getServerSubNamespace(): string[] {
    return [
      ...this.config.namespacePrefix,
      this.config.sessionId,
      'server',
    ];
  }

  getDiscoveredParticipants(): RemoteParticipant[] {
    return Array.from(this.discoveredParticipants.values());
  }
}
