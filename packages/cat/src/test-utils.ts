// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview CAT Token Test Utilities
 *
 * Helpers for generating test key pairs and properly-formatted
 * CAT (CWT/COSE) tokens for testing and demos.
 */

import { CatTokenBuilder, base64urlEncode } from './cat.js';
import { coseSign1Encode, coseSign1Decode } from './cose.js';
import {
  CoseAlgorithm,
  COSE_ALG_PARAMS,
  MoqtAction,
  type CwtClaims,
  type MoqtScope,
  type CoseSign1,
} from './types.js';

// ============================================================================
// Key Generation
// ============================================================================

/**
 * Generate a test ECDSA key pair for CAT token signing/verification.
 *
 * @param algorithm - COSE algorithm (default: ES256)
 * @returns WebCrypto key pair
 */
export async function generateTestKeyPair(
  algorithm: CoseAlgorithm = CoseAlgorithm.ES256,
): Promise<CryptoKeyPair> {
  const params = COSE_ALG_PARAMS[algorithm];
  return crypto.subtle.generateKey(
    { name: params.name, namedCurve: params.namedCurve },
    true, // extractable (for testing)
    ['sign', 'verify'],
  );
}

// ============================================================================
// Token Generation
// ============================================================================

export interface TestCatTokenOptions {
  /** Signing key pair (will generate if not provided) */
  keyPair?: CryptoKeyPair;
  /** Partial claims to set */
  claims?: Partial<CwtClaims>;
  /** MoQT scopes */
  scopes?: MoqtScope[];
  /** Signing algorithm (default: ES256) */
  algorithm?: CoseAlgorithm;
  /** Generate an expired token */
  expired?: boolean;
  /** Token lifetime in seconds (default: 3600) */
  lifetimeSeconds?: number;
}

/**
 * Generate a properly-formatted test CAT token (CWT/COSE_Sign1).
 * Unlike JWT fake tokens, these use proper CBOR encoding and ECDSA signatures.
 *
 * @returns COSE_Sign1 CBOR bytes
 */
export async function generateTestCatToken(
  options: TestCatTokenOptions = {},
): Promise<{ tokenBytes: Uint8Array; keyPair: CryptoKeyPair }> {
  const algorithm = options.algorithm ?? CoseAlgorithm.ES256;
  const keyPair = options.keyPair ?? await generateTestKeyPair(algorithm);
  const now = Math.floor(Date.now() / 1000);
  const lifetime = options.lifetimeSeconds ?? 3600;

  const builder = new CatTokenBuilder().withAlgorithm(algorithm);

  // Set default claims
  builder
    .issuer(options.claims?.iss ?? 'https://test.moq.example')
    .subject(options.claims?.sub ?? 'test-user')
    .audience(options.claims?.aud ?? 'moq-relay');

  if (options.expired) {
    builder.issuedAt(now - lifetime * 2);
    builder.expiration(now - lifetime);
  } else {
    builder.issuedAt(options.claims?.iat ?? now);
    builder.expiration(options.claims?.exp ?? now + lifetime);
  }

  if (options.claims?.nbf !== undefined) {
    builder.notBefore(options.claims.nbf);
  }

  if (options.claims?.cti) {
    builder.cwtId(options.claims.cti);
  }

  // Set scopes
  const scopes = options.scopes ?? [{
    actions: [MoqtAction.Subscribe, MoqtAction.Publish, MoqtAction.SubscribeNamespace, MoqtAction.PublishNamespace],
  }];
  builder.moqtScopes(scopes);

  const tokenBytes = await builder.sign(keyPair.privateKey);
  return { tokenBytes, keyPair };
}

/**
 * Encode CAT token bytes to base64url string for session.setAuthToken().
 */
export function catTokenToBase64url(tokenBytes: Uint8Array): string {
  return base64urlEncode(tokenBytes);
}

// ============================================================================
// Invalid Token Generators (for denial testing)
// ============================================================================

/**
 * Generate an invalid CAT token with a wrong namespace scope.
 */
export async function generateWrongScopeToken(
  _roomId: string,
  keyPair?: CryptoKeyPair,
): Promise<{ tokenBytes: Uint8Array; keyPair: CryptoKeyPair }> {
  const kp = keyPair ?? await generateTestKeyPair();
  return generateTestCatToken({
    keyPair: kp,
    scopes: [{
      actions: [MoqtAction.Subscribe],
      namespaceMatch: ['mocha', `WRONG-ROOM-${Date.now().toString(36)}`],
    }],
    claims: { sub: 'wrong-scope-user' },
  });
}

/**
 * Generate an expired CAT token.
 */
export async function generateExpiredToken(
  keyPair?: CryptoKeyPair,
): Promise<{ tokenBytes: Uint8Array; keyPair: CryptoKeyPair }> {
  const kp = keyPair ?? await generateTestKeyPair();
  return generateTestCatToken({
    keyPair: kp,
    expired: true,
    claims: { sub: 'expired-user' },
  });
}

/**
 * Generate a CAT token with a corrupted signature.
 */
export async function generateBadSignatureToken(
  keyPair?: CryptoKeyPair,
): Promise<{ tokenBytes: Uint8Array; keyPair: CryptoKeyPair }> {
  const kp = keyPair ?? await generateTestKeyPair();
  const { tokenBytes } = await generateTestCatToken({ keyPair: kp });

  // Decode, corrupt signature, re-encode
  const sign1 = coseSign1Decode(tokenBytes);
  const corrupted: CoseSign1 = {
    ...sign1,
    signature: new Uint8Array(sign1.signature.length),
  };
  crypto.getRandomValues(corrupted.signature);

  return { tokenBytes: coseSign1Encode(corrupted), keyPair: kp };
}

/**
 * Generate a CAT token signed with a different key (signature won't verify
 * against the original key pair).
 */
export async function generateWrongKeyToken(
  algorithm: CoseAlgorithm = CoseAlgorithm.ES256,
): Promise<{ tokenBytes: Uint8Array; signingKeyPair: CryptoKeyPair; verifyKeyPair: CryptoKeyPair }> {
  const signingKeyPair = await generateTestKeyPair(algorithm);
  const verifyKeyPair = await generateTestKeyPair(algorithm);

  const { tokenBytes } = await generateTestCatToken({
    keyPair: signingKeyPair,
    claims: { sub: 'wrong-key-user' },
  });

  return { tokenBytes, signingKeyPair, verifyKeyPair };
}
