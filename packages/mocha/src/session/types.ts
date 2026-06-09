import type { MochaIdentity } from '../types.js';
import type { TokenProvider } from '../auth/token-provider.js';

export interface MochaSessionConfig {
  relayUrl: string;
  tokenProvider: TokenProvider;
  realm: string;
  identity: MochaIdentity;
  serverCertificateHashes?: ArrayBuffer[];
  connectionTimeout?: number;
}

export type MochaSessionState = 'disconnected' | 'connecting' | 'connected' | 'error';

export type MochaEvent =
  | 'state-change'
  | 'error'
  | 'message'
  | 'presence-update'
  | 'typing-update'
  | 'receipt'
  | 'media-track';
