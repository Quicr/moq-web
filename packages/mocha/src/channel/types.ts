import type { MochaMessage, PresenceEntry, TypingIndicator, Receipt, MochaIdentity, MessageId } from '../types.js';

export interface SendMessageOptions {
  replyTo?: MessageId;
  threadRoot?: MessageId;
  mentions?: string[];
}

export interface ChannelEvents {
  message: MochaMessage;
  'presence-update': PresenceEntry;
  'typing-update': TypingIndicator;
  receipt: Receipt;
}

export type ChannelEventType = keyof ChannelEvents;

export interface ChannelConfig {
  identity: MochaIdentity;
  deliveryMode?: 'stream' | 'datagram';
}
