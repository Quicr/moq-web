// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Pluggable auth provider interface (MSF §17).
 *
 * MSF §17 defines an extensible authorization model where each track's
 * `authInfo.scheme` names the credential family (`privacy-pass`, `cat`, or a
 * reverse-DNS custom identifier). To keep MSF free of hard dependencies on
 * any specific auth stack (CAT/CBOR, Privacy Pass, OAuth, …), token
 * production and validation live behind this pluggable interface.
 *
 * Callers register one {@link AuthProvider} per scheme they want to support
 * (typically via {@link AuthProviderRegistry}). At publish or subscribe time
 * MSF looks up the provider that matches the track's declared scheme and
 * routes the request through it. Absent a matching provider, the track is
 * assumed to be open (no auth required).
 *
 * Providers are intentionally minimal — MSF only needs an opaque byte string
 * (or a base64url encoding, when the transport layer requires it). Anything
 * scheme-specific (signing keys, HTTP callouts, scope shaping) is the
 * provider's business.
 */

import type { AuthInfo, Track } from '../schemas/index.js';

/**
 * Direction of an auth request; providers may issue different tokens for
 * publish vs. subscribe (§17 examples such as CAT bind scopes per action).
 */
export type AuthAction = 'publish' | 'subscribe' | 'fetch';

/**
 * Context passed to a provider when obtaining or validating a token.
 *
 * MSF supplies everything it knows about the track and the action; the
 * provider decides which fields matter for its scheme. Free-form
 * `sessionContext` lets applications hand extra hints (user ID, tenant, …)
 * through without further API changes.
 */
export interface AuthContext {
  /** Namespace of the track being acted on. */
  namespace: string[];
  /** Track name. */
  trackName: string;
  /** Full track definition from the catalog, if available. */
  track?: Track;
  /** `authInfo` block from the track (§6 / §17). */
  authInfo?: AuthInfo;
  /** Action the token is being obtained/validated for. */
  action: AuthAction;
  /** Optional application-supplied hints (e.g. userId, tenant). */
  sessionContext?: Record<string, unknown>;
  /**
   * Optional wire-level details for scheme-specific policy checks
   * (URI, HTTP method, headers, ALPN, IP, geo). Providers that don't consume
   * these ignore them; the CAT provider forwards them to `evaluateCatPolicy`
   * (`catu`/`cath`/`catnip`/`catgeo*` claims).
   */
  request?: {
    uri?: string | URL;
    method?: string;
    headers?: Headers | ReadonlyMap<string, string> | Readonly<Record<string, string>>;
    alpn?: Uint8Array;
    ipAddress?: string;
    countryCode?: string;
    coordinate?: readonly [number, number];
    altitude?: number;
  };
  /**
   * Optional DPoP proof bytes carried alongside the token being validated.
   * Only meaningful on `validateToken` paths for schemes that support DPoP
   * (currently just `cat`).
   */
  dpopProof?: Uint8Array;
}

/**
 * Token material as delivered on the wire.
 *
 * MoQT `AUTHORIZATION_TOKEN` request parameters carry raw bytes plus a
 * token-type varint; providers return both so callers can encode the
 * parameter without knowing the scheme.
 */
export interface AuthToken {
  /** Raw token payload. */
  tokenBytes: Uint8Array;
  /**
   * Token-type identifier for the MoQT `AUTHORIZATION_TOKEN` parameter.
   * `undefined` lets the session pick its default (C4M = 0x63346d).
   */
  tokenType?: number;
  /** Optional expiration (epoch seconds); helps callers refresh eagerly. */
  expiresAt?: number;
  /**
   * Scheme-specific extras produced alongside the token (e.g. a DPoP proof).
   * Providers document their own shape; callers must key on `scheme` before
   * casting.
   */
  details?: Record<string, unknown>;
}

/**
 * Result of a `validateToken` call.
 */
export interface AuthValidationResult {
  valid: boolean;
  /** Free-form reason for a failed validation. */
  reason?: string;
  /** Optional resolved subject identity (e.g. `sub` claim). */
  subject?: string;
  /** Optional expiration (epoch seconds). */
  expiresAt?: number;
  /**
   * Scheme-specific detail bag. CAT populates `{ dpop?, policy?, replayChecked? }`;
   * other providers may attach their own shape. Kept `unknown`-friendly so the
   * base interface stays scheme-agnostic.
   */
  details?: Record<string, unknown>;
}

/**
 * Pluggable authorization provider (§17).
 *
 * Each provider handles exactly one scheme. Register instances with
 * {@link AuthProviderRegistry}; MSF selects the right one by matching
 * `track.authInfo.scheme` against {@link AuthProvider.scheme}.
 */
export interface AuthProvider {
  /**
   * Scheme identifier — either a reserved value (`privacy-pass`, `cat`) or a
   * reverse-DNS custom identifier per MSF §17.
   */
  readonly scheme: string;

  /**
   * Produce a fresh token for the given action. Return `null` to signal that
   * this provider cannot issue a token for the request; MSF will surface an
   * error to the caller rather than falling back silently.
   */
  obtainToken(context: AuthContext): Promise<AuthToken | null>;

  /**
   * Optional: validate an inbound token. When absent, callers must validate
   * tokens out-of-band (e.g. via a relay-side hook).
   */
  validateToken?(
    tokenBytes: Uint8Array,
    context: AuthContext
  ): Promise<AuthValidationResult>;
}

/**
 * Registry of {@link AuthProvider}s keyed by scheme.
 *
 * A single registry is typically attached to an `MSFSession`; providers can
 * be added or removed at runtime as long-lived apps rotate credentials.
 */
export class AuthProviderRegistry {
  private readonly providers = new Map<string, AuthProvider>();

  constructor(providers: readonly AuthProvider[] = []) {
    for (const p of providers) {
      this.register(p);
    }
  }

  /**
   * Register a provider. Replaces any existing provider for the same scheme.
   */
  register(provider: AuthProvider): void {
    this.providers.set(provider.scheme, provider);
  }

  /**
   * Remove a provider by scheme. Returns `true` if a provider was removed.
   */
  unregister(scheme: string): boolean {
    return this.providers.delete(scheme);
  }

  /**
   * Look up a provider by scheme identifier. Returns `undefined` when the
   * app has not registered any handler for the requested scheme.
   */
  get(scheme: string): AuthProvider | undefined {
    return this.providers.get(scheme);
  }

  /**
   * Enumerate registered scheme identifiers.
   */
  schemes(): string[] {
    return [...this.providers.keys()];
  }

  /**
   * Convenience: obtain a token for the given context by delegating to the
   * scheme-matched provider. Returns `null` when no scheme is declared (open
   * track) or when the registry has no provider for the declared scheme.
   */
  async obtainToken(context: AuthContext): Promise<AuthToken | null> {
    const scheme = context.authInfo?.scheme;
    if (scheme === undefined) return null;
    const provider = this.providers.get(scheme);
    if (provider === undefined) return null;
    return provider.obtainToken(context);
  }
}

/**
 * Error raised when an auth-required track has no matching provider.
 */
export class MissingAuthProviderError extends Error {
  constructor(scheme: string) {
    super(
      `no AuthProvider registered for scheme='${scheme}'; register one via MSFSession config or AuthProviderRegistry.register()`
    );
    this.name = 'MissingAuthProviderError';
  }
}
