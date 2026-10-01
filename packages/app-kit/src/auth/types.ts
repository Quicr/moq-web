// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Relay-vendor auth adapter surface.
 *
 * Different relay implementations (moq-rs Cloudflare, moqx, ietf reference)
 * present tokens differently — some accept a JWT via query string, others
 * expect a MOQT SETUP-level auth-token parameter, others require an out-of-
 * band API dance to mint the token. This module lets apps register any
 * number of adapters and pick one at runtime through the settings dialog.
 *
 * Apps stay vendor-neutral: `connectMoqtSession({ auth: { operations: 'publish' } })`
 * resolves the currently-selected adapter, mints a token, and attaches it to
 * the WebTransport URL — all before the QUIC handshake. When no provider is
 * selected the connect path is unchanged.
 */

/** What the app intends to do on this session — the adapter uses this to
 *  pick or mint a token with matching capability. */
export type AuthOperation = 'publish' | 'subscribe';

/**
 * Blob of provider-specific state persisted in localStorage. Adapters own
 * the shape (credentials, chosen scope IDs, cached JWTs); the app-kit only
 * knows it's serializable JSON.
 */
export type ProviderState = Record<string, unknown>;

/** Token returned by an adapter, ready to attach to a connection. */
export interface MintedAuthToken {
  /** The bearer credential (typically a JWT). */
  token: string;
  /** Which operation(s) this token grants. */
  operations: AuthOperation[];
  /** Epoch-ms token expiry, if known. Adapters use this to skip re-mint. */
  expiresAt?: number;
  /** Optional adapter-specific handle so `revoke` can find the token later. */
  handle?: string;
}

/** Context handed to `mintToken` — the current relay URL, the requested
 *  operation, and the persisted provider state. */
export interface MintContext {
  relayUrl: string;
  operations: AuthOperation[];
  state: ProviderState;
  signal?: AbortSignal;
}

/**
 * Vendor-specific auth adapter. Adapters are registered globally via
 * {@link registerAuthAdapter} and looked up by `id` from persisted config.
 */
export interface AuthAdapter {
  /** Stable identifier persisted in `TransportConfig.auth.providerId`. */
  readonly id: string;
  /** Human-readable label shown in the settings dropdown. */
  readonly displayName: string;
  /** Short blurb rendered under the dropdown when this provider is active. */
  readonly description?: string;

  /**
   * Ask the adapter for a token good for the requested operation. Adapters
   * SHOULD cache and reuse a non-expired token from `state`. If they mint a
   * fresh one they SHOULD write it back through {@link SettingsPanelProps.updateState}
   * so subsequent connects hit the cache.
   *
   * Throw a plain `Error` on any failure; the connector surfaces the message.
   */
  mintToken(ctx: MintContext): Promise<MintedAuthToken>;

  /**
   * Attach the minted token to a WebTransport URL. Most adapters append a
   * query string; a future adapter that uses the MOQT SETUP CAT parameter
   * would return the input URL unchanged and rely on
   * {@link setupExtensions} instead.
   */
  applyToUrl(url: string, token: MintedAuthToken): string;

  /**
   * Optional: contribute MOQT SETUP kv extensions (draft-18 §13). Reserved
   * for the day moq-rs accepts the token via SETUP; today the Cloudflare
   * adapter returns `undefined` here.
   */
  setupExtensions?(token: MintedAuthToken): Map<number, ArrayBufferLike> | undefined;

  /**
   * React component that renders the adapter's settings UI inside the Auth
   * tab. Adapters own their entire form: login fields, scope lists, token
   * management. Kept opaque so the app-kit doesn't need per-vendor forms.
   */
  SettingsPanel: (props: SettingsPanelProps) => import('react').ReactElement;
}

export interface SettingsPanelProps {
  /** Live provider state read out of the transport store. */
  state: ProviderState;
  /** Merge a partial patch into the persisted provider state. */
  updateState: (patch: ProviderState) => void;
  /** Replace the whole provider state (used by "log out"). */
  resetState: () => void;
}
