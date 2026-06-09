import { MOQTransport } from '@web-moq/core';
import { MOQTSession } from '@web-moq/session';
import type { MochaSessionConfig, MochaSessionState, MochaEvent } from './types.js';
import type { MochaIdentity } from '../types.js';
import { MochaChannel } from '../channel/channel.js';

export class MochaSession {
  private transport: MOQTransport | null = null;
  private session: MOQTSession | null = null;
  private _state: MochaSessionState = 'disconnected';
  private channels = new Map<string, MochaChannel>();
  private handlers = new Map<MochaEvent, Set<(data: unknown) => void>>();
  private readonly config: MochaSessionConfig;

  constructor(config: MochaSessionConfig) {
    this.config = config;
  }

  get state(): MochaSessionState {
    return this._state;
  }

  get identity(): MochaIdentity {
    return this.config.identity;
  }

  get realm(): string {
    return this.config.realm;
  }

  get moqtSession(): MOQTSession | null {
    return this.session;
  }

  async connect(): Promise<void> {
    if (this._state !== 'disconnected') return;
    this.setState('connecting');

    try {
      this.transport = new MOQTransport({
        serverCertificateHashes: this.config.serverCertificateHashes ?? [],
        connectionTimeout: this.config.connectionTimeout ?? 300000,
      });

      await this.transport.connect(this.config.relayUrl);

      this.session = new MOQTSession(this.transport);

      const token = await this.config.tokenProvider.getToken(this.config.realm, 'publisher');
      this.session.setAuthToken(token);

      await this.session.setup();
      this.setState('connected');
    } catch (err) {
      this.setState('error');
      this.emit('error', err);
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    for (const channel of this.channels.values()) {
      await channel.deactivate();
    }
    this.channels.clear();

    if (this.session) {
      await this.session.close();
      this.session = null;
    }
    this.transport = null;
    this.setState('disconnected');
  }

  async joinChannel(path: string[], channel: string): Promise<MochaChannel> {
    if (!this.session) throw new Error('Not connected');

    const ch = new MochaChannel(
      this.session,
      this.config.realm,
      path,
      channel,
      this.config.identity,
      (event, data) => this.emit(event, data),
    );
    this.channels.set(ch.id, ch);
    await ch.activate();
    return ch;
  }

  async leaveChannel(channelId: string): Promise<void> {
    const ch = this.channels.get(channelId);
    if (!ch) return;
    await ch.deactivate();
    this.channels.delete(channelId);
  }

  getChannel(channelId: string): MochaChannel | undefined {
    return this.channels.get(channelId);
  }

  getChannels(): MochaChannel[] {
    return [...this.channels.values()];
  }

  on(event: MochaEvent, handler: (data: unknown) => void): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler);
    return () => { this.handlers.get(event)?.delete(handler); };
  }

  private emit(event: MochaEvent, data: unknown): void {
    this.handlers.get(event)?.forEach((h) => h(data));
  }

  private setState(state: MochaSessionState): void {
    this._state = state;
    this.emit('state-change', state);
  }
}
