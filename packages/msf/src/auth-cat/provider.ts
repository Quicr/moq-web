// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview CAT/C4M {@link AuthProvider} implementation (MSF §17).
 *
 * Bridges the {@link AuthProvider} contract to `@moq-web/cat`'s
 * {@link CatTokenBuilder}. Each `obtainToken` call assembles a fresh
 * COSE_Sign1 token scoped to the requesting track and action, signs it with
 * the caller-supplied private key, and returns raw bytes plus the C4M token
 * type (`0x63346d`) so the session can populate the MoQT
 * `AUTHORIZATION_TOKEN` parameter directly.
 *
 * This module lives in a subpath so core MSF stays free of the `@moq-web/cat`
 * dependency; apps that want CAT auth import it explicitly via
 * `@moq-web/msf/auth-cat`.
 */

import {
  CatTokenBuilder,
  CatTokenDecoder,
  C4M_TOKEN_TYPE,
  CoseAlgorithm,
  MoqtAction,
  type CatValidationOptions,
  type MoqtScope,
} from '@moq-web/cat';

import type {
  AuthAction,
  AuthContext,
  AuthProvider,
  AuthToken,
  AuthValidationResult,
} from '../auth/provider.js';

/**
 * Configuration for {@link CatAuthProvider}.
 */
export interface CatAuthProviderOptions {
  /** Signing key used to mint tokens (must match `algorithm`). */
  signingKey: CryptoKey;
  /** COSE algorithm identifier (default: {@link CoseAlgorithm.ES256}). */
  algorithm?: CoseAlgorithm;
  /**
   * `iss` claim written into every minted token. Applications typically
   * source this from their identity provider configuration.
   */
  issuer: string;
  /**
   * `aud` claim written into every minted token. Usually a relay identifier
   * that will validate the token.
   */
  audience: string | string[];
  /**
   * `sub` claim — resolved per-token. May be a static string (single-user
   * app) or a function of the {@link AuthContext} (multi-tenant / logged-in
   * user extracted from `sessionContext`).
   */
  subject: string | ((context: AuthContext) => string);
  /**
   * Token lifetime in seconds (default: 300). Applied as `exp = now + ttl`.
   */
  ttlSeconds?: number;
  /**
   * Optional verification key used by {@link CatAuthProvider.validateToken}.
   * When omitted, `validateToken` is not exposed (undefined on the provider
   * instance) so callers know validation is out-of-scope for this provider.
   */
  verificationKey?: CryptoKey;
  /**
   * Extra validation options threaded to {@link CatTokenDecoder.validate}
   * (audience match, clock skew, required algorithm, …).
   */
  validationOptions?: Omit<CatValidationOptions, 'requiredAudience'> & {
    requiredAudience?: string;
  };
  /**
   * Hook for callers who want to shape the {@link MoqtScope} beyond the
   * default (single scope per token, action derived from
   * {@link AuthAction}, namespace + track from the catalog entry). Returning
   * an empty array yields a token with no `moqt` claim.
   */
  scopeBuilder?: (context: AuthContext) => MoqtScope[];
}

/**
 * Map an MSF-level {@link AuthAction} onto MoQT action codes carried in the
 * `moqt` scope claim.
 */
function actionToMoqt(action: AuthAction): MoqtAction {
  switch (action) {
    case 'publish':
      return MoqtAction.Publish;
    case 'subscribe':
      return MoqtAction.Subscribe;
    case 'fetch':
      return MoqtAction.Fetch;
  }
}

/**
 * Default {@link MoqtScope} builder: single scope, one action, namespace +
 * track name copied from the track being acted on.
 */
function defaultScope(context: AuthContext): MoqtScope[] {
  return [
    {
      actions: [actionToMoqt(context.action)],
      namespaceMatch: [...context.namespace],
      trackMatch: context.trackName,
    },
  ];
}

/**
 * {@link AuthProvider} that mints CAT/C4M tokens using `@moq-web/cat`.
 *
 * @example
 * ```typescript
 * const { privateKey } = await generateTestKeyPair();
 * const provider = new CatAuthProvider({
 *   signingKey: privateKey,
 *   issuer: 'https://auth.example.com',
 *   audience: 'moq-relay',
 *   subject: (ctx) => (ctx.sessionContext?.userId as string) ?? 'anon',
 * });
 * const session = createMSFSession(moqt, ns, { authProviders: [provider] });
 * ```
 */
export class CatAuthProvider implements AuthProvider {
  readonly scheme = 'cat' as const;

  private readonly options: CatAuthProviderOptions;
  private readonly algorithm: CoseAlgorithm;

  constructor(options: CatAuthProviderOptions) {
    this.options = options;
    this.algorithm = options.algorithm ?? CoseAlgorithm.ES256;
  }

  async obtainToken(context: AuthContext): Promise<AuthToken> {
    const ttl = this.options.ttlSeconds ?? 300;
    const now = Math.floor(Date.now() / 1000);
    const sub =
      typeof this.options.subject === 'function'
        ? this.options.subject(context)
        : this.options.subject;

    const scopes = (this.options.scopeBuilder ?? defaultScope)(context);

    const builder = new CatTokenBuilder()
      .withAlgorithm(this.algorithm)
      .issuer(this.options.issuer)
      .subject(sub)
      .audience(this.options.audience)
      .issuedAt(now)
      .expiration(now + ttl);

    if (scopes.length > 0) {
      builder.moqtScopes(scopes);
    }

    const tokenBytes = await builder.sign(this.options.signingKey);
    return {
      tokenBytes,
      tokenType: C4M_TOKEN_TYPE,
      expiresAt: now + ttl,
    };
  }

  async validateToken(
    tokenBytes: Uint8Array,
    _context: AuthContext
  ): Promise<AuthValidationResult> {
    if (this.options.verificationKey === undefined) {
      return {
        valid: false,
        reason: 'CatAuthProvider was configured without a verificationKey',
      };
    }
    const result = await CatTokenDecoder.validate(
      tokenBytes,
      this.options.verificationKey,
      {
        requiredAlgorithm: this.algorithm,
        ...this.options.validationOptions,
      }
    );
    return {
      valid: result.valid,
      reason: result.error,
      subject: result.token?.claims.sub,
      expiresAt: result.token?.claims.exp,
    };
  }
}

/**
 * Convenience factory mirroring the {@link AuthProviderRegistry} constructor
 * ergonomics — lets apps write `new AuthProviderRegistry([createCatAuthProvider(...)])`.
 */
export function createCatAuthProvider(
  options: CatAuthProviderOptions
): CatAuthProvider {
  return new CatAuthProvider(options);
}
