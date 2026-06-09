import type { MochaMessage, PresenceEntry, TypingIndicator, Receipt } from './types.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type MochaPayload = MochaMessage | PresenceEntry | TypingIndicator | Receipt;

export function encode(payload: MochaPayload): Uint8Array {
  return encoder.encode(JSON.stringify(payload));
}

export function decode<T = MochaPayload>(data: Uint8Array): T {
  return JSON.parse(decoder.decode(data)) as T;
}
