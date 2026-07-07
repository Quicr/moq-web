// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview COSE_Sign1 Implementation (RFC 9052)
 *
 * Implements COSE_Sign1 structure for creating and verifying
 * signed tokens using ECDSA (ES256/ES384/ES512) via WebCrypto.
 */

import { cborEncode, cborDecode, cborDecodeTagged } from './cbor.js';
import {
  CoseAlgorithm,
  CoseHeaderParam,
  COSE_ALG_PARAMS,
  type CoseSign1,
  type CborValue,
} from './types.js';

/** COSE_Sign1 CBOR tag number */
const COSE_SIGN1_TAG = 18;

/**
 * Convert Uint8Array to ArrayBuffer for WebCrypto API compatibility.
 */
function toArrayBuffer(arr: Uint8Array): ArrayBuffer {
  return arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength) as ArrayBuffer;
}

// ============================================================================
// Encoding / Decoding
// ============================================================================

/**
 * Encode a COSE_Sign1 structure to CBOR bytes.
 * Produces a bare 4-element array (no CBOR Tag 18) for relay compatibility.
 */
export function coseSign1Encode(sign1: CoseSign1): Uint8Array {
  const array: CborValue[] = [
    sign1.protectedHeader,
    sign1.unprotectedHeader,
    sign1.payload,
    sign1.signature,
  ];
  return cborEncode(array);
}

/**
 * Decode a COSE_Sign1 structure from CBOR bytes.
 * Handles both CBOR Tag 18 and bare 4-element array.
 *
 * @throws {CoseError} If the data is not a valid COSE_Sign1 structure
 */
export function coseSign1Decode(data: Uint8Array): CoseSign1 {
  const { tag, value } = cborDecodeTagged(data);

  // Accept both tagged (18) and bare array
  if (tag !== -1 && tag !== COSE_SIGN1_TAG) {
    throw new CoseError(`Unexpected CBOR tag: ${tag}, expected ${COSE_SIGN1_TAG}`);
  }

  if (!Array.isArray(value) || value.length !== 4) {
    throw new CoseError(`COSE_Sign1 must be a 4-element array, got ${Array.isArray(value) ? value.length : typeof value}`);
  }

  const [protectedHeader, unprotectedHeader, payload, signature] = value;

  if (!(protectedHeader instanceof Uint8Array)) {
    throw new CoseError('COSE_Sign1 protected header must be a bstr');
  }
  if (!(payload instanceof Uint8Array)) {
    throw new CoseError('COSE_Sign1 payload must be a bstr');
  }
  if (!(signature instanceof Uint8Array)) {
    throw new CoseError('COSE_Sign1 signature must be a bstr');
  }

  // Decode unprotected header map
  let unprotectedMap: Map<number, CborValue>;
  if (unprotectedHeader instanceof Map) {
    unprotectedMap = unprotectedHeader as Map<number, CborValue>;
  } else {
    unprotectedMap = new Map();
  }

  return {
    protectedHeader,
    unprotectedHeader: unprotectedMap,
    payload,
    signature,
  };
}

// ============================================================================
// Sig_structure (RFC 9052 Section 4.4)
// ============================================================================

/**
 * Construct the Sig_structure for COSE_Sign1 signing/verification.
 *
 * Sig_structure = [
 *   context : "Signature1",
 *   body_protected : bstr,
 *   external_aad : bstr,
 *   payload : bstr
 * ]
 */
export function coseSign1SigStructure(
  protectedHeader: Uint8Array,
  payload: Uint8Array,
  externalAAD: Uint8Array = new Uint8Array(0),
): Uint8Array {
  const structure: CborValue[] = [
    'Signature1',
    protectedHeader,
    externalAAD,
    payload,
  ];
  return cborEncode(structure);
}

/**
 * Construct the MAC_structure for COSE_Mac0 (RFC 9052 Section 6.3).
 *
 * MAC_structure = [
 *   context : "MAC0",
 *   body_protected : bstr,
 *   external_aad : bstr,
 *   payload : bstr
 * ]
 */
export function coseMac0MacStructure(
  protectedHeader: Uint8Array,
  payload: Uint8Array,
  externalAAD: Uint8Array = new Uint8Array(0),
): Uint8Array {
  const structure: CborValue[] = [
    'MAC0',
    protectedHeader,
    externalAAD,
    payload,
  ];
  return cborEncode(structure);
}

// ============================================================================
// Sign / Verify
// ============================================================================

/**
 * Create and sign a COSE_Sign1 or COSE_Mac0 structure.
 * Automatically selects Sig_structure vs MAC_structure based on algorithm.
 */
export async function coseSign1Sign(
  algorithm: CoseAlgorithm,
  protectedHeaders: Map<number, CborValue>,
  payload: Uint8Array,
  privateKey: CryptoKey,
  unprotectedHeaders?: Map<number, CborValue>,
): Promise<CoseSign1> {
  const algParams = COSE_ALG_PARAMS[algorithm];
  if (!algParams) {
    throw new CoseError(`Unsupported COSE algorithm: ${algorithm}`);
  }

  // Build protected header map with algorithm
  const headerMap = new Map<number, CborValue>(protectedHeaders);
  headerMap.set(CoseHeaderParam.ALG, algorithm);

  // Encode protected header to CBOR
  const protectedHeader = cborEncode(headerMap);

  // Construct signing/MAC input based on algorithm type
  const toBeSigned = algParams.isMac
    ? coseMac0MacStructure(protectedHeader, payload)
    : coseSign1SigStructure(protectedHeader, payload);

  // Sign or MAC with WebCrypto
  let signatureBuffer: ArrayBuffer;
  if (algParams.isMac) {
    signatureBuffer = await crypto.subtle.sign(
      algParams.name,
      privateKey,
      toArrayBuffer(toBeSigned),
    );
  } else {
    signatureBuffer = await crypto.subtle.sign(
      { name: algParams.name, hash: algParams.hash },
      privateKey,
      toArrayBuffer(toBeSigned),
    );
  }

  const signature = new Uint8Array(signatureBuffer);

  // Validate signature/tag length
  if (signature.length !== algParams.sigLength) {
    throw new CoseError(
      `Unexpected signature length: ${signature.length}, expected ${algParams.sigLength}`,
    );
  }

  return {
    protectedHeader,
    unprotectedHeader: unprotectedHeaders ?? new Map(),
    payload,
    signature,
  };
}

/**
 * Verify the signature of a COSE_Sign1 structure.
 *
 * Accepts an optional `requiredAlgorithm` to prevent algorithm confusion.
 * When provided, the token's algorithm must match exactly.
 *
 * Only catches DOMException from WebCrypto. Other errors propagate.
 */
export async function coseSign1Verify(
  sign1: CoseSign1,
  publicKey: CryptoKey,
  requiredAlgorithm?: CoseAlgorithm,
): Promise<boolean> {
  // Extract algorithm from protected header
  const algorithm = coseSign1GetAlgorithm(sign1);
  const algParams = COSE_ALG_PARAMS[algorithm];
  if (!algParams) {
    return false;
  }

  // Enforce required algorithm if specified
  if (requiredAlgorithm !== undefined && algorithm !== requiredAlgorithm) {
    return false;
  }

  // For ECDSA: verify algorithm matches the public key's curve
  if (!algParams.isMac) {
    const keyAlg = publicKey.algorithm as EcKeyAlgorithm;
    if (keyAlg.namedCurve && keyAlg.namedCurve !== algParams.namedCurve) {
      return false;
    }
  }

  // Validate signature/tag length
  if (sign1.signature.length !== algParams.sigLength) {
    return false;
  }

  // Construct signing/MAC input based on algorithm type
  const toBeVerified = algParams.isMac
    ? coseMac0MacStructure(sign1.protectedHeader, sign1.payload)
    : coseSign1SigStructure(sign1.protectedHeader, sign1.payload);

  // Only catch DOMException from WebCrypto, let other errors propagate
  try {
    if (algParams.isMac) {
      return await crypto.subtle.verify(
        algParams.name,
        publicKey, // for HMAC, this is the shared secret key
        toArrayBuffer(sign1.signature),
        toArrayBuffer(toBeVerified),
      );
    }
    return await crypto.subtle.verify(
      { name: algParams.name, hash: algParams.hash },
      publicKey,
      toArrayBuffer(sign1.signature),
      toArrayBuffer(toBeVerified),
    );
  } catch (e) {
    if (e instanceof DOMException) {
      return false;
    }
    throw e;
  }
}

/**
 * Extract the algorithm from a COSE_Sign1 protected header.
 *
 * @throws {CoseError} If the algorithm is missing or unsupported
 */
export function coseSign1GetAlgorithm(sign1: CoseSign1): CoseAlgorithm {
  // Empty protected header (zero bytes) is invalid — must contain at least an empty map
  if (sign1.protectedHeader.length === 0) {
    throw new CoseError('Empty protected header');
  }

  const decoded = cborDecode(sign1.protectedHeader);
  if (!(decoded.value instanceof Map)) {
    throw new CoseError('Protected header must be a CBOR map');
  }

  const alg = decoded.value.get(CoseHeaderParam.ALG);
  if (alg === undefined) {
    throw new CoseError('Algorithm (alg) not found in protected header');
  }

  const algValue = typeof alg === 'number' ? alg : Number(alg);
  if (!(algValue in COSE_ALG_PARAMS)) {
    throw new CoseError(`Unsupported algorithm: ${algValue}`);
  }

  return algValue as CoseAlgorithm;
}

/**
 * Decode the protected header of a COSE_Sign1 as a map.
 *
 * Rejects truly empty headers (0 bytes). Accepts empty CBOR map (0xa0).
 */
export function coseSign1DecodeProtectedHeader(
  protectedHeader: Uint8Array,
): Map<number, CborValue> {
  if (protectedHeader.length === 0) {
    throw new CoseError('Protected header must not be empty');
  }
  const decoded = cborDecode(protectedHeader);
  if (!(decoded.value instanceof Map)) {
    throw new CoseError('Protected header must be a CBOR map');
  }
  return decoded.value as Map<number, CborValue>;
}

/**
 * COSE encoding/decoding error.
 */
export class CoseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoseError';
  }
}
