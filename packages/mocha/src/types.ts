export interface MessageId {
  group: number;
  object: number;
}

export interface MessageSender {
  userId: string;
  displayName: string;
}

export type ContentType = 'text/plain' | 'text/markdown' | 'application/json';

export interface MessageContent {
  type: ContentType;
  body: string;
}

export interface MochaMessage {
  id: MessageId;
  sender: MessageSender;
  timestamp: number;
  content: MessageContent;
  replyTo?: MessageId;
  threadRoot?: MessageId;
  edited?: number;
  reactions?: Record<string, string[]>;
  mentions?: string[];
  attachments?: Attachment[];
  extensions?: Record<string, unknown>;
}

export interface Attachment {
  type: 'media' | 'file' | 'link';
  url?: string;
  mimeType?: string;
  name?: string;
  size?: number;
  trackNamespace?: string[];
}

export type PresenceStatus = 'online' | 'away' | 'dnd' | 'invisible' | 'offline';

export interface PresenceEntry {
  userId: string;
  displayName: string;
  status: PresenceStatus;
  statusMessage?: string;
  lastSeen: number;
}

export interface TypingIndicator {
  userId: string;
  displayName: string;
  timestamp: number;
}

export type ReceiptType = 'delivered' | 'displayed' | 'read';

export interface Receipt {
  userId: string;
  messageId: MessageId;
  type: ReceiptType;
  timestamp: number;
}

export type Affiliation = 'owner' | 'admin' | 'member' | 'guest' | 'banned';

export interface ChannelMeta {
  name: string;
  description?: string;
  createdAt: number;
  createdBy: string;
  isPublic: boolean;
}

export type TrackType =
  | 'messages'
  | 'history'
  | 'meta'
  | 'roster'
  | 'threads'
  | 'presence'
  | 'typing'
  | 'receipts'
  | 'mls'
  | 'moderation'
  | 'blocks'
  | 'media';

export interface MochaIdentity {
  userId: string;
  displayName: string;
  avatarUrl?: string;
}
