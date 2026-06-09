export { MochaSession } from './session/mocha-session.js';
export { MochaChannel } from './channel/channel.js';
export { MochaNamespace } from './namespace.js';
export { encode, decode } from './codec.js';
export { MoatTokenProvider } from './auth/token-provider.js';

export type { MochaSessionConfig, MochaSessionState, MochaEvent } from './session/types.js';
export type { TokenProvider } from './auth/token-provider.js';
export type { SendMessageOptions, ChannelConfig } from './channel/types.js';
export type { TrackRef } from './namespace.js';
export type {
  MochaIdentity,
  MochaMessage,
  MessageId,
  MessageSender,
  MessageContent,
  ContentType,
  Attachment,
  PresenceStatus,
  PresenceEntry,
  TypingIndicator,
  Receipt,
  ReceiptType,
  Affiliation,
  ChannelMeta,
  TrackType,
} from './types.js';
