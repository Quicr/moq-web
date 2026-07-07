// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview CAT/C4M Token Library for MoQ Transport
 *
 * Common Access Token (CAT) implementation using CBOR, COSE_Sign1, and CWT.
 * Provides standards-compliant token creation, decoding, and validation
 * for MoQ Transport authorization.
 *
 * @packageDocumentation
 *
 * @example
 * ```typescript
 * import {
 *   CatTokenBuilder,
 *   CatTokenDecoder,
 *   CoseAlgorithm,
 *   MoqtAction,
 * } from '@web-moq/cat';
 *
 * // Create a token
 * const token = await new CatTokenBuilder()
 *   .issuer('https://auth.example.com')
 *   .subject('user-123')
 *   .audience('moq-relay')
 *   .expiration(Date.now() / 1000 + 3600)
 *   .issuedAt()
 *   .moqtScopes([{
 *     actions: [MoqtAction.Subscribe],
 *     namespaceMatch: ['room', 'abc'],
 *   }])
 *   .sign(privateKey);
 *
 * // Validate a token
 * const result = await CatTokenDecoder.validate(token, publicKey);
 * ```
 */

// Types
export {
  C4M_TOKEN_TYPE,
  CoseAlgorithm,
  CoseHeaderParam,
  COSE_ALG_PARAMS,
  CwtClaimKey,
  MoqtAction,
  type CborValue,
  type CborTagged,
  type CoseSign1,
  type CwtClaims,
  type MoqtScope,
  type CatToken,
  type CatValidationResult,
  type CatValidationOptions,
  type CoseAlgParams,
} from './types.js';

// CBOR
export {
  cborEncode,
  cborDecode,
  cborDecodeTagged,
  cborEncodeTagged,
  CborError,
} from './cbor.js';

// COSE
export {
  coseSign1Encode,
  coseSign1Decode,
  coseSign1Sign,
  coseSign1Verify,
  coseSign1SigStructure,
  coseMac0MacStructure,
  coseSign1GetAlgorithm,
  coseSign1DecodeProtectedHeader,
  CoseError,
} from './cose.js';

// CWT
export {
  cwtClaimsEncode,
  cwtClaimsDecode,
  cwtClaimsFromMap,
  moqtScopesEncode,
  moqtScopesDecode,
  cwtIsExpired,
  cwtIsNotYetValid,
  cwtMatchesAudience,
  CwtError,
} from './cwt.js';

// CAT
export {
  CatTokenBuilder,
  CatTokenDecoder,
  base64urlDecode,
  base64urlEncode,
  CatError,
} from './cat.js';

// Test utilities
export {
  generateTestKeyPair,
  generateTestCatToken,
  catTokenToBase64url,
  generateWrongScopeToken,
  generateExpiredToken,
  generateBadSignatureToken,
  generateWrongKeyToken,
  type TestCatTokenOptions,
} from './test-utils.js';
