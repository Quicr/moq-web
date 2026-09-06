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
 * } from '@moq-web/cat';
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
  MoqtMatchType,
  type CborValue,
  type CborMapKey,
  type CborTagged,
  type CoseSign1,
  type CoseMac0,
  type CoseEncrypt0,
  type CwtClaims,
  type MoqtScope,
  type MoqtMatch,
  type MoqtPattern,
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
  cborDecodeExact,
  cborEncodeTagged,
  CborError,
} from './cbor.js';

// COSE
export {
  coseSign1Encode,
  coseSign1Decode,
  coseMac0Encode,
  coseMac0Decode,
  coseSign1Sign,
  coseMac0Sign,
  coseSign1Verify,
  coseMac0Verify,
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

// Generic CWT DPoP
export {
  DPOP_PROOF_CWT_TYP,
  generateDpopKeyPair,
  createDpopProof,
  decodeDpopProof,
  validateDpopProof,
  validateCatDpopBinding,
  coseKeyFromPublicKey,
  jwkThumbprint,
  coseKeyThumbprint,
  moqtAuthorizationContext,
  DpopError,
  type DpopLabels,
  type DpopProofOptions,
  type DpopProof,
  type DpopValidationOptions,
  type DpopValidationResult,
  type MoqtDpopContext,
} from './dpop.js';

// Request policy and replay protection
export {
  evaluateCatPolicy,
  moqtScopeAllows,
  type BinaryValue,
  type CatRequestContext,
  type CatPolicyOptions,
  type CatPolicyResult,
} from './policy.js';
export {
  MemoryReplayStore,
  acceptCatReplay,
  acceptDpopReplay,
  ReplayError,
  type ReplayStore,
  type ReplayStoreOptions,
  type CatReplayOptions,
  type DpopReplayOptions,
} from './replay.js';

// Encrypted CWT payloads
export {
  COSE_ENCRYPT0_TAG,
  COSE_AES_GCM_ALGORITHMS,
  coseEncrypt0Encode,
  coseEncrypt0Decode,
  coseEncrypt0Encrypt,
  coseEncrypt0Decrypt,
  encryptCwtClaims,
  decryptCwtClaims,
  generateAesGcmKey,
  EncryptionError,
  type CoseEncrypt0Options,
} from './encryption.js';

// Verification-key resolution
export {
  resolveCatVerificationKey,
  staticCatKeyResolver,
  importCatJwk,
  isCompatibleKey,
  KeyManagementError,
  type CatKeyResolver,
} from './keys.js';

// Composed security validation
export {
  validateCatRequest,
  validateCatRequestWithResolver,
  type CatSecurityValidationOptions,
  type CatSecurityValidationResult,
} from './security.js';

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
