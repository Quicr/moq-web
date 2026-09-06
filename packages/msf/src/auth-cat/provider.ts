// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview CAT/C4M {@link AuthProvider} implementation (MSF §17).
 *
 * Bridges the {@link AuthProvider} contract to `@moq-web/cat`. Signing side
 * composes {@link CatTokenBuilder} + optional {@link createDpopProof} so the
 * MoQT `AUTHORIZATION_TOKEN` parameter and any adjacent DPoP proof can be
 * produced in one call. Validation side composes {@link validateCatRequest},
 * which layers signature check, DPoP binding, replay protection, and
 * CAT-4-MOQT request policy (scope + URI/headers/geo constraints) on top of
 * the plain CWT validator.
 *
 * This module lives in a subpath so core MSF stays free of the `@moq-web/cat`
 * dependency; apps that want CAT auth import it explicitly via
 * `@moq-web/msf/auth-cat`.
 */

import {
  CatTokenBuilder,
  C4M_TOKEN_TYPE,
  CoseAlgorithm,
  MoqtAction,
  createDpopProof,
  jwkThumbprint,
  moqtAuthorizationContext,
  resolveCatVerificationKey,
  validateCatRequest,
  type CatKeyResolver,
  type CatPolicyOptions,
  type CatRequestContext,
  type CatSecurityValidationOptions,
  type CatSecurityValidationResult,
  type CatValidationOptions,
  type CborValue,
  type DpopValidationOptions,
  type MoqtScope,
  type ReplayStore,
} from '@moq-web/cat';

import type {
  AuthAction,
  AuthContext,
  AuthProvider,
  AuthToken,
  AuthValidationResult,
} from '../auth/provider.js';

/**
 * DPoP signing keypair + optional labels/nonce hook used when the provider
 * needs to emit a proof alongside the CAT.
 */
export interface CatDpopSigningOptions {
  /** DPoP keypair (private = sign, public = key binding). */
  keyPair: CryptoKeyPair;
  /** COSE algorithm for the proof (default: {@link CoseAlgorithm.ES256}). */
  algorithm?: CoseAlgorithm;
  /**
   * Nonce resolver invoked per proof. Return `undefined` to skip the `nonce`
   * claim. Callers wire this to whatever replay-nonce mechanism the relay
   * uses.
   */
  nonce?: (context: AuthContext) => string | undefined | Promise<string | undefined>;
}

/**
 * DPoP-side of the {@link AuthToken} returned by {@link CatAuthProvider.obtainToken}.
 */
export interface CatDpopProof {
  proofBytes: Uint8Array;
  algorithm: CoseAlgorithm;
}

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
   * When both this and `keyResolver` are absent, `validateToken` short-circuits
   * with `valid: false` so callers know validation is out-of-scope.
   */
  verificationKey?: CryptoKey;
  /**
   * Alternative to `verificationKey` — resolves the key from the token's
   * `kid` (see {@link staticCatKeyResolver}). Takes precedence over
   * `verificationKey` when both are set.
   */
  keyResolver?: CatKeyResolver;
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
  /**
   * When set, {@link CatAuthProvider.obtainToken} also produces a DPoP proof
   * bound to the returned CAT (matches CTA-5007-B `cnf.jkt`). The proof is
   * returned via {@link AuthToken.details.dpopProof} so callers can forward
   * it alongside the token (relay side-channel, HTTP header, etc.).
   */
  dpop?: CatDpopSigningOptions;
  /**
   * Replay store threaded to {@link validateCatRequest} — required for tokens
   * that assert `catreplay` or DPoP proofs that demand `jti` uniqueness.
   */
  replayStore?: ReplayStore;
  /**
   * Static extra options for DPoP validation (nonce, expected JKT/CKT, etc.).
   * Runtime values from the {@link AuthContext} (namespace/track/action) are
   * merged in automatically.
   */
  dpopValidation?: Omit<DpopValidationOptions, 'expectedJkt' | 'expectedCkt'>;
  /**
   * Policy knobs for {@link evaluateCatPolicy} (require `moqt` claim, allow
   * regex matchers, …). See {@link CatPolicyOptions}.
   */
  policy?: CatPolicyOptions;
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
 * Build the CAT request context passed to `evaluateCatPolicy` from
 * MSF-level {@link AuthContext}.
 */
function toCatRequestContext(context: AuthContext): CatRequestContext {
  const base: CatRequestContext = {
    action: actionToMoqt(context.action),
    namespace: context.namespace,
    trackName: context.trackName,
  };
  const req = context.request;
  if (!req) return base;
  return {
    ...base,
    uri: req.uri,
    method: req.method,
    headers: req.headers,
    alpn: req.alpn,
    ipAddress: req.ipAddress,
    countryCode: req.countryCode,
    coordinate: req.coordinate,
    altitude: req.altitude,
  };
}

/**
 * {@link AuthProvider} that mints CAT/C4M tokens using `@moq-web/cat`.
 *
 * @example Basic signing + validation
 * ```typescript
 * const { privateKey, publicKey } = await generateTestKeyPair();
 * const provider = new CatAuthProvider({
 *   signingKey: privateKey,
 *   verificationKey: publicKey,
 *   issuer: 'https://auth.example.com',
 *   audience: 'moq-relay',
 *   subject: (ctx) => (ctx.sessionContext?.userId as string) ?? 'anon',
 * });
 * ```
 *
 * @example DPoP-bound tokens + replay protection
 * ```typescript
 * const dpop = await generateDpopKeyPair();
 * const provider = new CatAuthProvider({
 *   signingKey, verificationKey, issuer, audience, subject,
 *   dpop: { keyPair: dpop },
 *   replayStore: new MemoryReplayStore(),
 * });
 * const token = await provider.obtainToken(ctx);
 * // token.details.dpopProof carries the paired DPoP proof
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

    if (this.options.dpop !== undefined) {
      // Bind the CAT to the DPoP public-key thumbprint (CTA-5007-B cnf.jkt).
      const jkt = await jwkThumbprint(this.options.dpop.keyPair.publicKey);
      const cnf = new Map<number, CborValue>([[323, jkt]]);
      builder.confirmation(cnf);
    }

    const tokenBytes = await builder.sign(this.options.signingKey);
    const dpopProof = await this.maybeCreateDpopProof(context, tokenBytes);
    return {
      tokenBytes,
      tokenType: C4M_TOKEN_TYPE,
      expiresAt: now + ttl,
      ...(dpopProof !== undefined
        ? { details: { dpopProof } as Record<string, unknown> }
        : {}),
    };
  }

  async validateToken(
    tokenBytes: Uint8Array,
    context: AuthContext
  ): Promise<AuthValidationResult> {
    let verificationKey: CryptoKey;
    if (this.options.keyResolver !== undefined) {
      try {
        verificationKey = await resolveCatVerificationKey(
          tokenBytes,
          this.options.keyResolver
        );
      } catch (err) {
        return {
          valid: false,
          reason: err instanceof Error ? err.message : 'CAT key resolution failed',
        };
      }
    } else if (this.options.verificationKey !== undefined) {
      verificationKey = this.options.verificationKey;
    } else {
      return {
        valid: false,
        reason:
          'CatAuthProvider was configured without a verificationKey or keyResolver',
      };
    }

    const validationOptions: CatSecurityValidationOptions = {
      requiredAlgorithm: this.algorithm,
      ...this.options.validationOptions,
      dpopProof: context.dpopProof,
      dpop: this.options.dpopValidation,
      replayStore: this.options.replayStore,
      request: toCatRequestContext(context),
      policy: this.options.policy,
    };

    const result = await validateCatRequest(
      tokenBytes,
      verificationKey,
      validationOptions
    );
    return this.toAuthValidationResult(result);
  }

  /**
   * Convenience: sign a token *and* immediately validate it against the same
   * provider config. Useful for local round-trip tests; production callers
   * ship the bytes across the wire.
   */
  async roundTrip(context: AuthContext): Promise<AuthValidationResult> {
    const token = await this.obtainToken(context);
    const dpopProof = (token.details?.dpopProof as CatDpopProof | undefined)
      ?.proofBytes;
    return this.validateToken(token.tokenBytes, { ...context, dpopProof });
  }

  private async maybeCreateDpopProof(
    context: AuthContext,
    tokenBytes: Uint8Array
  ): Promise<CatDpopProof | undefined> {
    const dpop = this.options.dpop;
    if (!dpop) return undefined;
    const nonce = dpop.nonce ? await dpop.nonce(context) : undefined;
    const proofBytes = await createDpopProof({
      privateKey: dpop.keyPair.privateKey,
      publicKey: dpop.keyPair.publicKey,
      algorithm: dpop.algorithm ?? CoseAlgorithm.ES256,
      authorizationContext: moqtAuthorizationContext({
        action: context.action,
        trackNamespace: context.namespace,
        trackName: context.trackName,
      }),
      accessToken: tokenBytes,
      ...(nonce !== undefined ? { nonce } : {}),
    });
    return { proofBytes, algorithm: dpop.algorithm ?? CoseAlgorithm.ES256 };
  }

  private toAuthValidationResult(
    result: CatSecurityValidationResult
  ): AuthValidationResult {
    const details: Record<string, unknown> = {};
    if (result.dpop !== undefined) details.dpop = result.dpop;
    if (result.policy !== undefined) details.policy = result.policy;
    if (result.replayChecked !== undefined) {
      details.replayChecked = result.replayChecked;
    }
    return {
      valid: result.valid,
      reason: result.error,
      subject: result.token?.claims.sub,
      expiresAt: result.token?.claims.exp,
      ...(Object.keys(details).length > 0 ? { details } : {}),
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
