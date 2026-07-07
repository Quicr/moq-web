// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview CAT/C4M Token Types
 *
 * Type definitions for CBOR, COSE, CWT, and MoQT-specific token structures.
 */

// ============================================================================
// CBOR Types
// ============================================================================

/**
 * Represents any value that can be encoded/decoded as CBOR.
 */
export type CborValue =
  | number
  | bigint
  | string
  | Uint8Array
  | boolean
  | null
  | CborValue[]
  | Map<number | string, CborValue>;

/**
 * CBOR tagged value.
 */
export interface CborTagged {
  tag: number;
  value: CborValue;
}

// ============================================================================
// COSE Types (RFC 9052)
// ============================================================================

/**
 * COSE algorithm identifiers.
 * @see RFC 9053 Section 2.1
 */
export enum CoseAlgorithm {
  /** ECDSA w/ SHA-256 on P-256 */
  ES256 = -7,
  /** ECDSA w/ SHA-384 on P-384 */
  ES384 = -35,
  /** ECDSA w/ SHA-512 on P-521 */
  ES512 = -36,
}

/**
 * COSE header parameter keys.
 * @see RFC 9052 Section 3.1
 */
export enum CoseHeaderParam {
  /** Algorithm identifier */
  ALG = 1,
  /** Content type */
  CTY = 3,
  /** Key ID */
  KID = 4,
}

/**
 * COSE_Sign1 structure.
 * @see RFC 9052 Section 4.2
 */
export interface CoseSign1 {
  /** CBOR-encoded protected header (bstr) */
  protectedHeader: Uint8Array;
  /** Unprotected header (map) */
  unprotectedHeader: Map<number, CborValue>;
  /** Payload (bstr — CBOR-encoded CWT claims for CAT tokens) */
  payload: Uint8Array;
  /** Signature (bstr) */
  signature: Uint8Array;
}

/**
 * Maps CoseAlgorithm to WebCrypto parameters.
 */
// Frozen to prevent runtime mutation of algorithm parameters
export const COSE_ALG_PARAMS: Readonly<Record<CoseAlgorithm, Readonly<{
  name: string;
  hash: string;
  namedCurve: string;
  sigLength: number;
}>>> = Object.freeze({
  [CoseAlgorithm.ES256]: Object.freeze({ name: 'ECDSA', hash: 'SHA-256', namedCurve: 'P-256', sigLength: 64 }),
  [CoseAlgorithm.ES384]: Object.freeze({ name: 'ECDSA', hash: 'SHA-384', namedCurve: 'P-384', sigLength: 96 }),
  [CoseAlgorithm.ES512]: Object.freeze({ name: 'ECDSA', hash: 'SHA-512', namedCurve: 'P-521', sigLength: 132 }),
});

// ============================================================================
// CWT Types (RFC 8392)
// ============================================================================

/**
 * CWT claim keys (integer-based per RFC 8392 Section 4).
 */
export enum CwtClaimKey {
  /** Issuer */
  ISS = 1,
  /** Subject */
  SUB = 2,
  /** Audience */
  AUD = 3,
  /** Expiration Time (NumericDate) */
  EXP = 4,
  /** Not Before (NumericDate) */
  NBF = 5,
  /** Issued At (NumericDate) */
  IAT = 6,
  /** CWT ID */
  CTI = 7,
  /** MoQT scopes (pending IANA assignment) */
  MOQT = 327,
}

/**
 * CWT claims structure.
 */
export interface CwtClaims {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  iat?: number;
  cti?: Uint8Array;
  moqt?: MoqtScope[];
  /** Additional claims keyed by integer */
  additionalClaims?: Map<number, CborValue>;
}

// ============================================================================
// MoQT Auth Types
// ============================================================================

/**
 * MoQT action codes for token scopes.
 * @see draft-ietf-moq-transport
 */
export enum MoqtAction {
  ClientSetup = 0,
  ServerSetup = 1,
  PublishNamespace = 2,
  SubscribeNamespace = 3,
  Subscribe = 4,
  RequestUpdate = 5,
  Publish = 6,
  Fetch = 7,
  TrackStatus = 8,
}

/**
 * A single MoQT authorization scope.
 */
export interface MoqtScope {
  /** Permitted actions */
  actions: MoqtAction[];
  /** Namespace prefix to match (optional — null means any) */
  namespaceMatch?: (string | Uint8Array)[];
  /** Track name to match (optional — null means any) */
  trackMatch?: string | Uint8Array;
}

// ============================================================================
// CAT Token Types
// ============================================================================

/**
 * C4M token type identifier (ASCII "c4m").
 */
export const C4M_TOKEN_TYPE = 0x63346d;

/**
 * Decoded CAT token.
 */
export interface CatToken {
  /** Decoded protected header as map */
  header: Map<number, CborValue>;
  /** Decoded CWT claims */
  claims: CwtClaims;
  /** Raw COSE_Sign1 structure */
  coseSign1: CoseSign1;
  /** Algorithm used for signing */
  algorithm: CoseAlgorithm;
}

/**
 * Result of CAT token validation.
 */
export interface CatValidationResult {
  valid: boolean;
  token?: CatToken;
  error?: string;
  expired?: boolean;
}

/**
 * Options for CAT token validation.
 */
export interface CatValidationOptions {
  /** Clock skew tolerance in seconds (default: 60) */
  clockSkewSeconds?: number;
  /** Required audience value */
  requiredAudience?: string;
  /** Override current time for testing (Unix timestamp seconds) */
  now?: number;
  /** Required algorithm — rejects tokens using a different algorithm */
  requiredAlgorithm?: CoseAlgorithm;
  /** Require exp claim to be present (default: true) */
  requireExp?: boolean;
}
