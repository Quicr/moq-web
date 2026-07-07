// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview CAT Token Builder and Decoder
 *
 * High-level API for creating, decoding, and validating
 * Common Access Tokens (CAT/C4M) for MoQ Transport.
 */

import {
  coseSign1Sign,
  coseSign1Decode,
  coseSign1Encode,
  coseSign1Verify,
  coseSign1GetAlgorithm,
  coseSign1DecodeProtectedHeader,
} from './cose.js';
import {
  cwtClaimsEncode,
  cwtClaimsDecode,
  cwtIsExpired,
  cwtIsNotYetValid,
  cwtMatchesAudience,
  moqtScopesEncode,
} from './cwt.js';
import {
  CoseAlgorithm,
  CwtClaimKey,
  type CborValue,
  type CwtClaims,
  type MoqtScope,
  type CatToken,
  type CatValidationResult,
  type CatValidationOptions,
} from './types.js';

// ============================================================================
// Constants
// ============================================================================

/** Maximum token size in bytes (8 KiB — generous for auth tokens) */
const MAX_TOKEN_SIZE = 8192;

/** Maximum base64url input length */
const MAX_BASE64URL_LENGTH = 12000; // ~8 KiB decoded

/** Valid base64url character set */
const BASE64URL_REGEX = /^[A-Za-z0-9_-]+$/;

// ============================================================================
// Base64url Utilities
// ============================================================================

/**
 * Decode a base64url string to bytes.
 *
 * Validates character set before decoding.
 * Enforces maximum input length.
 */
export function base64urlDecode(str: string): Uint8Array {
  if (str.length > MAX_BASE64URL_LENGTH) {
    throw new CatError(`base64url input too large: ${str.length} chars`);
  }
  if (str.length > 0 && !BASE64URL_REGEX.test(str)) {
    throw new CatError('Invalid base64url characters');
  }
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(base64 + padding);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Encode bytes to a base64url string (no padding).
 */
export function base64urlEncode(data: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < data.length; i++) binary += String.fromCharCode(data[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// ============================================================================
// CatTokenBuilder
// ============================================================================

/**
 * Fluent builder for creating CAT (C4M) tokens.
 *
 * @example
 * ```typescript
 * const token = await new CatTokenBuilder()
 *   .issuer('https://auth.example.com')
 *   .subject('user-123')
 *   .audience('moq-relay')
 *   .expiration(Date.now() / 1000 + 3600)
 *   .issuedAt()
 *   .moqtScopes([{
 *     actions: [MoqtAction.Subscribe, MoqtAction.Publish],
 *     namespaceMatch: ['room', 'abc'],
 *   }])
 *   .sign(privateKey);
 * ```
 */
export class CatTokenBuilder {
  private _claims: CwtClaims = {};
  private _algorithm: CoseAlgorithm = CoseAlgorithm.ES256;
  private _protectedHeaders = new Map<number, CborValue>();
  private _unprotectedHeaders = new Map<number, CborValue>();
  private _moqtClaimKey: number = CwtClaimKey.MOQT;

  /** Set the issuer claim. */
  issuer(iss: string): this {
    this._claims.iss = iss;
    return this;
  }

  /** Set the subject claim. */
  subject(sub: string): this {
    this._claims.sub = sub;
    return this;
  }

  /** Set the audience claim. */
  audience(aud: string | string[]): this {
    this._claims.aud = aud;
    return this;
  }

  /** Set the expiration time (Unix timestamp in seconds, or Date). */
  expiration(exp: number | Date): this {
    this._claims.exp = exp instanceof Date ? Math.floor(exp.getTime() / 1000) : Math.floor(exp);
    return this;
  }

  /** Set the not-before time (Unix timestamp in seconds, or Date). */
  notBefore(nbf: number | Date): this {
    this._claims.nbf = nbf instanceof Date ? Math.floor(nbf.getTime() / 1000) : Math.floor(nbf);
    return this;
  }

  /** Set the issued-at time. Defaults to current time if no argument given. */
  issuedAt(iat?: number | Date): this {
    if (iat === undefined) {
      this._claims.iat = Math.floor(Date.now() / 1000);
    } else {
      this._claims.iat = iat instanceof Date ? Math.floor(iat.getTime() / 1000) : Math.floor(iat);
    }
    return this;
  }

  /** Set the CWT ID (unique token identifier). */
  cwtId(cti: Uint8Array): this {
    this._claims.cti = cti;
    return this;
  }

  /** Set the MoQT authorization scopes. */
  moqtScopes(scopes: MoqtScope[]): this {
    this._claims.moqt = scopes;
    return this;
  }

  /** Set an additional claim by integer key. */
  claim(key: number, value: CborValue): this {
    if (!this._claims.additionalClaims) {
      this._claims.additionalClaims = new Map();
    }
    this._claims.additionalClaims.set(key, value);
    return this;
  }

  /** Set the signing algorithm (default: ES256). */
  withAlgorithm(alg: CoseAlgorithm): this {
    this._algorithm = alg;
    return this;
  }

  /** Add a protected header parameter. */
  protectedHeader(key: number, value: CborValue): this {
    this._protectedHeaders.set(key, value);
    return this;
  }

  /** Add an unprotected header parameter. */
  unprotectedHeader(key: number, value: CborValue): this {
    this._unprotectedHeaders.set(key, value);
    return this;
  }

  /** Set the MoQT claim key (default: 327, alternative: 65000). */
  moqtClaimKey(key: number): this {
    this._moqtClaimKey = key;
    return this;
  }

  /**
   * Build the CWT claims payload (CBOR bytes) without signing.
   * Useful for testing.
   */
  buildPayload(): Uint8Array {
    // If using a non-default MOQT claim key, move the moqt scopes
    const claims = { ...this._claims };
    if (this._moqtClaimKey !== CwtClaimKey.MOQT && claims.moqt) {
      if (!claims.additionalClaims) claims.additionalClaims = new Map();
      claims.additionalClaims.set(this._moqtClaimKey, moqtScopesEncode(claims.moqt));
      claims.moqt = undefined;
    }
    return cwtClaimsEncode(claims);
  }

  /**
   * Sign the token and return COSE_Sign1 CBOR bytes.
   */
  async sign(privateKey: CryptoKey): Promise<Uint8Array> {
    const payload = cwtClaimsEncode(this._claims);

    const sign1 = await coseSign1Sign(
      this._algorithm,
      this._protectedHeaders,
      payload,
      privateKey,
      this._unprotectedHeaders.size > 0 ? this._unprotectedHeaders : undefined,
    );

    return coseSign1Encode(sign1);
  }

  /**
   * Sign the token and return a base64url-encoded string
   * suitable for session.setAuthToken().
   */
  async signToBase64url(privateKey: CryptoKey): Promise<string> {
    const bytes = await this.sign(privateKey);
    return base64urlEncode(bytes);
  }
}

// ============================================================================
// CatTokenDecoder
// ============================================================================

/**
 * Decoder and validator for CAT (C4M) tokens.
 */
export class CatTokenDecoder {
  /**
   * Decode a CAT token from raw COSE_Sign1 CBOR bytes.
   * Does NOT verify the signature.
   *
   * Enforces maximum token size.
   *
   * @throws {CatError} If the token cannot be decoded
   */
  static decode(data: Uint8Array): CatToken {
    if (data.length > MAX_TOKEN_SIZE) {
      throw new CatError('Token exceeds maximum size');
    }
    const sign1 = coseSign1Decode(data);
    return CatTokenDecoder.fromCoseSign1(sign1);
  }

  /**
   * Decode a CAT token from a base64url-encoded string.
   * Does NOT verify the signature.
   */
  static decodeFromBase64url(encoded: string): CatToken {
    const data = base64urlDecode(encoded);
    return CatTokenDecoder.decode(data);
  }

  /**
   * Decode a CAT token from a legacy dot-separated format.
   * The dot-separated format has 3 base64url parts: header.payload.signature.
   * Each part is expected to contain CBOR data (NOT JSON — that would be JWT, not CWT).
   */
  static decodeFromDotSeparated(dotToken: string): CatToken {
    const parts = dotToken.split('.');
    if (parts.length !== 3) {
      throw new CatError('Dot-separated token must have exactly 3 parts');
    }

    const protectedHeader = base64urlDecode(parts[0]);
    const payload = base64urlDecode(parts[1]);
    const signature = base64urlDecode(parts[2]);

    const sign1: import('./types.js').CoseSign1 = {
      protectedHeader,
      unprotectedHeader: new Map(),
      payload,
      signature,
    };

    return CatTokenDecoder.fromCoseSign1(sign1);
  }

  /**
   * Decode from a COSE_Sign1 structure.
   *
   * No silent algorithm fallback — missing algorithm is an error.
   */
  private static fromCoseSign1(sign1: import('./types.js').CoseSign1): CatToken {
    // Decode protected header — throws if empty or invalid
    const header = coseSign1DecodeProtectedHeader(sign1.protectedHeader);

    // Extract algorithm — throws if missing/unsupported, no silent default
    const algorithm = coseSign1GetAlgorithm(sign1);

    // Decode payload as CWT claims
    let claims: CwtClaims;
    try {
      claims = cwtClaimsDecode(sign1.payload);
    } catch {
      throw new CatError('Failed to decode CWT claims from token payload');
    }

    return { header, claims, coseSign1: sign1, algorithm };
  }

  /**
   * Fully validate a CAT token: decode, verify signature, check expiration/nbf/audience.
   *
   * Signature is verified FIRST, before any claims are inspected.
   * Supports requiredAlgorithm to prevent algorithm confusion.
   * Supports requireExp to reject tokens without expiration.
   * Returns generic error messages — no internal details.
   */
  static async validate(
    data: Uint8Array,
    publicKey: CryptoKey,
    options?: CatValidationOptions,
  ): Promise<CatValidationResult> {
    const clockSkew = options?.clockSkewSeconds ?? 60;
    const now = options?.now ?? Math.floor(Date.now() / 1000);

    // Step 1: Decode structure (but do NOT return claims to caller yet)
    let token: CatToken;
    try {
      token = CatTokenDecoder.decode(data);
    } catch {
      // M3: Generic error — don't leak internal decode details
      return { valid: false, error: 'Token decode failed' };
    }

    // Step 2: Verify signature FIRST — before inspecting any claims
    let signatureValid: boolean;
    try {
      signatureValid = await coseSign1Verify(
        token.coseSign1,
        publicKey,
        options?.requiredAlgorithm,
      );
    } catch {
      return { valid: false, error: 'Signature verification failed' };
    }

    if (!signatureValid) {
      // Do NOT return the token — claims are untrusted
      return { valid: false, error: 'Invalid signature' };
    }

    // Signature is valid — now safe to inspect claims

    // Step 3: Check that exp is present if required
    if ((options?.requireExp ?? true) && token.claims.exp === undefined) {
      return { valid: false, token, error: 'Token missing required exp claim' };
    }

    // Step 4: Check expiration
    if (cwtIsExpired(token.claims, now, clockSkew)) {
      return { valid: false, token, error: 'Token expired', expired: true };
    }

    // Step 5: Check not-before
    if (cwtIsNotYetValid(token.claims, now, clockSkew)) {
      return { valid: false, token, error: 'Token not yet valid' };
    }

    // Step 6: Check audience
    if (options?.requiredAudience) {
      if (!cwtMatchesAudience(token.claims, options.requiredAudience)) {
        return { valid: false, token, error: 'Audience mismatch' };
      }
    }

    return { valid: true, token };
  }

  /**
   * Validate from a base64url-encoded string.
   */
  static async validateFromBase64url(
    encoded: string,
    publicKey: CryptoKey,
    options?: CatValidationOptions,
  ): Promise<CatValidationResult> {
    const data = base64urlDecode(encoded);
    return CatTokenDecoder.validate(data, publicKey, options);
  }
}

/**
 * CAT token error.
 */
export class CatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatError';
  }
}
