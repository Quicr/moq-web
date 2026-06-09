import type { MOQTSession } from '@web-moq/session';
import type { MochaEvent } from '../session/types.js';
import type { MochaIdentity, MochaMessage, PresenceEntry, PresenceStatus, TypingIndicator, MessageContent } from '../types.js';
import type { SendMessageOptions } from './types.js';
import { MochaNamespace } from '../namespace.js';
import { encode, decode } from '../codec.js';

export class MochaChannel {
  private ns: MochaNamespace;
  private messageTrackAlias: bigint | null = null;
  private presenceTrackAlias: bigint | null = null;
  private typingTrackAlias: bigint | null = null;
  private subscriptionIds: number[] = [];
  private groupSeq = 0;
  private objectSeq = 0;
  private active = false;

  readonly id: string;

  constructor(
    private session: MOQTSession,
    realm: string,
    path: string[],
    channel: string,
    private identity: MochaIdentity,
    private emitToSession: (event: MochaEvent, data: unknown) => void,
  ) {
    this.ns = MochaNamespace.forChannel(realm, path, channel);
    this.id = this.ns.id;
  }

  async activate(): Promise<void> {
    if (this.active) return;
    this.active = true;

    const messages = this.ns.messages();
    const presence = this.ns.presence();
    const typing = this.ns.typing();

    // Publish tracks
    this.messageTrackAlias = await this.session.publish(
      messages.namespace,
      messages.trackName,
      { deliveryMode: 'stream' },
    );

    this.presenceTrackAlias = await this.session.publish(
      presence.namespace,
      presence.trackName,
      { deliveryMode: 'datagram' },
    );

    this.typingTrackAlias = await this.session.publish(
      typing.namespace,
      typing.trackName,
      { deliveryMode: 'datagram' },
    );

    // Subscribe to tracks
    const msgSubId = await this.session.subscribe(
      messages.namespace,
      messages.trackName,
      { groupOrder: 1 }, // ASCENDING
      (data: Uint8Array, groupId: number, objectId: number) => {
        this.handleMessage(data, groupId, objectId);
      },
    );
    this.subscriptionIds.push(msgSubId);

    const presSubId = await this.session.subscribe(
      presence.namespace,
      presence.trackName,
      {},
      (data: Uint8Array) => {
        this.handlePresence(data);
      },
    );
    this.subscriptionIds.push(presSubId);

    const typSubId = await this.session.subscribe(
      typing.namespace,
      typing.trackName,
      {},
      (data: Uint8Array) => {
        this.handleTyping(data);
      },
    );
    this.subscriptionIds.push(typSubId);

    // Announce presence
    await this.setPresence('online');
  }

  async deactivate(): Promise<void> {
    if (!this.active) return;
    this.active = false;

    await this.setPresence('offline');

    for (const subId of this.subscriptionIds) {
      await this.session.unsubscribe(subId);
    }
    this.subscriptionIds = [];
    this.messageTrackAlias = null;
    this.presenceTrackAlias = null;
    this.typingTrackAlias = null;
  }

  async sendMessage(content: MessageContent, options?: SendMessageOptions): Promise<MochaMessage> {
    if (!this.messageTrackAlias) throw new Error('Channel not active');

    const msg: MochaMessage = {
      id: { group: this.groupSeq, object: this.objectSeq++ },
      sender: { userId: this.identity.userId, displayName: this.identity.displayName },
      timestamp: Date.now(),
      content,
      replyTo: options?.replyTo,
      threadRoot: options?.threadRoot,
      mentions: options?.mentions,
    };

    await this.session.sendObject(this.messageTrackAlias, encode(msg), {
      groupId: msg.id.group,
      objectId: msg.id.object,
    });

    return msg;
  }

  async setPresence(status: PresenceStatus, statusMessage?: string): Promise<void> {
    if (!this.presenceTrackAlias) return;

    const entry: PresenceEntry = {
      userId: this.identity.userId,
      displayName: this.identity.displayName,
      status,
      statusMessage,
      lastSeen: Date.now(),
    };

    await this.session.sendObject(this.presenceTrackAlias, encode(entry), {
      groupId: 0,
      objectId: 0,
    });
  }

  async sendTypingIndicator(): Promise<void> {
    if (!this.typingTrackAlias) return;

    const indicator: TypingIndicator = {
      userId: this.identity.userId,
      displayName: this.identity.displayName,
      timestamp: Date.now(),
    };

    await this.session.sendObject(this.typingTrackAlias, encode(indicator), {
      groupId: 0,
      objectId: 0,
    });
  }

  private handleMessage(data: Uint8Array, groupId: number, objectId: number): void {
    try {
      const msg = decode<MochaMessage>(data);
      msg.id = { group: groupId, object: objectId };
      this.emitToSession('message', msg);
    } catch {
      // malformed message, skip
    }
  }

  private handlePresence(data: Uint8Array): void {
    try {
      const entry = decode<PresenceEntry>(data);
      this.emitToSession('presence-update', entry);
    } catch {
      // skip
    }
  }

  private handleTyping(data: Uint8Array): void {
    try {
      const indicator = decode<TypingIndicator>(data);
      this.emitToSession('typing-update', indicator);
    } catch {
      // skip
    }
  }
}
