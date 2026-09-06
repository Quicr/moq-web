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
export type CborMapKey = number | bigint | string | CborValue[];

export type CborValue =
  | number
  | bigint
  | string
  | Uint8Array
  | boolean
  | null
  | CborValue[]
  | CborTagged
  | Map<CborMapKey, CborValue>;

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
  /** HMAC w/ SHA-256 (full 256-bit tag) — COSE_Mac0 */
  HMAC_256_256 = 5,
  /** RSASSA-PSS w/ SHA-256 and 32-byte salt */
  PS256 = -37,
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
  /** Type */
  TYP = 16,
  /** Initialization vector */
  IV = 5,
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

/** COSE_Mac0 has the same four fields as COSE_Sign1, but a MAC tag. */
export type CoseMac0 = CoseSign1;

/** COSE_Encrypt0 structure (RFC 9052). */
export interface CoseEncrypt0 {
  protectedHeader: Uint8Array;
  unprotectedHeader: Map<number, CborValue>;
  ciphertext: Uint8Array;
}

/**
 * Maps CoseAlgorithm to WebCrypto parameters.
 */
/**
 * COSE algorithm parameter details.
 */
export interface CoseAlgParams {
  /** WebCrypto algorithm name */
  name: string;
  /** Hash algorithm */
  hash: string;
  /** EC named curve (ECDSA only) */
  namedCurve?: string;
  /** Expected signature/tag length in bytes */
  sigLength: number;
  /** Whether this is a MAC algorithm (COSE_Mac0) vs signing (COSE_Sign1) */
  isMac: boolean;
  /** WebCrypto key family. */
  keyType: 'EC' | 'RSA' | 'MAC';
  /** RSA-PSS salt length in bytes. */
  saltLength?: number;
}

// Frozen to prevent runtime mutation of algorithm parameters
export const COSE_ALG_PARAMS: Readonly<Record<CoseAlgorithm, Readonly<CoseAlgParams>>> = Object.freeze({
  [CoseAlgorithm.ES256]: Object.freeze({ name: 'ECDSA', hash: 'SHA-256', namedCurve: 'P-256', sigLength: 64, isMac: false, keyType: 'EC' }),
  [CoseAlgorithm.ES384]: Object.freeze({ name: 'ECDSA', hash: 'SHA-384', namedCurve: 'P-384', sigLength: 96, isMac: false, keyType: 'EC' }),
  [CoseAlgorithm.ES512]: Object.freeze({ name: 'ECDSA', hash: 'SHA-512', namedCurve: 'P-521', sigLength: 132, isMac: false, keyType: 'EC' }),
  [CoseAlgorithm.HMAC_256_256]: Object.freeze({ name: 'HMAC', hash: 'SHA-256', sigLength: 32, isMac: true, keyType: 'MAC' }),
  // RSA-PSS signature length is the modulus length, so it is checked against
  // the key by WebCrypto rather than as a fixed algorithm constant.
  [CoseAlgorithm.PS256]: Object.freeze({ name: 'RSA-PSS', hash: 'SHA-256', sigLength: 0, isMac: false, keyType: 'RSA', saltLength: 32 }),
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
  /** Confirmation */
  CNF = 8,
  /** Common Access Token replay */
  CATREPLAY = 308,
  /** Common Access Token probability of rejection */
  CATPOR = 309,
  /** Common Access Token version */
  CATV = 310,
  /** Common Access Token network IP */
  CATNIP = 311,
  /** Common Access Token URI */
  CATU = 312,
  /** Common Access Token methods */
  CATM = 313,
  /** Common Access Token ALPN */
  CATALPN = 314,
  /** Common Access Token header */
  CATH = 315,
  /** Common Access Token geographic ISO 3166 */
  CATGEOISO3166 = 316,
  /** Common Access Token geographic coordinate */
  CATGEOCOORD = 317,
  /** Common Access Token altitude */
  CATGEOALT = 318,
  /** Common Access Token TLS public key */
  CATTPK = 319,
  /** Common Access Token if-data */
  CATIFDATA = 320,
  /** Common Access Token DPoP settings */
  CATDPOP = 321,
  /** Common Access Token if */
  CATIF = 322,
  /** Common Access Token renewal */
  CATR = 323,
  /** Geohash */
  GEOHASH = 282,
  /** MoQT scopes (working-group draft assignment) */
  MOQT = 327,
  /** Generic DPoP authorization context (requested assignment) */
  DPOP_ACTX = 400,
  /** Generic DPoP nonce (requested assignment) */
  DPOP_NONCE = 401,
  /** Generic DPoP access-token hash (requested assignment) */
  DPOP_ATH = 402,
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
  cnf?: Map<number, CborValue>;
  catreplay?: number;
  catpor?: CborValue[];
  catv?: number;
  catnip?: CborValue[];
  catu?: Map<number, Map<number, CborValue>>;
  catm?: string[];
  catalpn?: Uint8Array[];
  cath?: Map<string, Map<number, CborValue>>;
  catgeoiso3166?: string[];
  catgeocoord?: CborValue;
  geohash?: CborValue;
  catgeoalt?: CborValue;
  cattpk?: Uint8Array;
  catifdata?: string | string[];
  catdpop?: Map<number, CborValue>;
  catif?: Map<number | string | number[], CborValue>;
  catr?: Map<number, CborValue>;
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
  /** Namespace match objects (optional; null terminates an exact namespace). */
  namespaceMatch?: (MoqtMatch | null)[];
  /** Track-name match object (optional). */
  trackMatch?: MoqtMatch;
}

export type MoqtMatch = string | Uint8Array | MoqtPattern;

export interface MoqtPattern {
  type: MoqtMatchType;
  value: string | Uint8Array;
}

export enum MoqtMatchType {
  Exact = 0,
  Prefix = 1,
  Suffix = 2,
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
  /** COSE message kind used by the token. */
  messageType: 'Sign1' | 'Mac0';
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
  /** Clock skew tolerance in seconds (CTA-5007-B default: 0) */
  clockSkewSeconds?: number;
  /** Required audience value */
  requiredAudience?: string;
  /** Required issuer value. */
  requiredIssuer?: string;
  /** Override current time for testing (Unix timestamp seconds) */
  now?: number;
  /** Required algorithm — rejects tokens using a different algorithm */
  requiredAlgorithm?: CoseAlgorithm;
  /** Require exp claim to be present (default: false; CTA claims are optional) */
  requireExp?: boolean;
}
