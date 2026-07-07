// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview CWT (CBOR Web Token) Claims Implementation (RFC 8392)
 *
 * Encodes and decodes CWT claims with integer keys, including
 * MoQT-specific authorization scopes.
 */

import { cborEncode, cborDecode } from './cbor.js';
import {
  CwtClaimKey,
  MoqtAction,
  type CwtClaims,
  type MoqtScope,
  type CborValue,
} from './types.js';

/** Standard CWT claim keys that cannot be overridden via additionalClaims */
const RESERVED_CLAIM_KEYS = new Set([
  CwtClaimKey.ISS, CwtClaimKey.SUB, CwtClaimKey.AUD,
  CwtClaimKey.EXP, CwtClaimKey.NBF, CwtClaimKey.IAT,
  CwtClaimKey.CTI, CwtClaimKey.MOQT, 65000,
]);

// ============================================================================
// CWT Claims Encode / Decode
// ============================================================================

/**
 * Encode CWT claims to a CBOR map (as bytes).
 */
export function cwtClaimsEncode(claims: CwtClaims): Uint8Array {
  const map = new Map<number, CborValue>();

  if (claims.iss !== undefined) map.set(CwtClaimKey.ISS, claims.iss);
  if (claims.sub !== undefined) map.set(CwtClaimKey.SUB, claims.sub);
  if (claims.aud !== undefined) {
    if (Array.isArray(claims.aud)) {
      map.set(CwtClaimKey.AUD, claims.aud as CborValue[]);
    } else {
      map.set(CwtClaimKey.AUD, claims.aud);
    }
  }
  if (claims.exp !== undefined) map.set(CwtClaimKey.EXP, claims.exp);
  if (claims.nbf !== undefined) map.set(CwtClaimKey.NBF, claims.nbf);
  if (claims.iat !== undefined) map.set(CwtClaimKey.IAT, claims.iat);
  if (claims.cti !== undefined) map.set(CwtClaimKey.CTI, claims.cti);
  if (claims.moqt !== undefined) {
    map.set(CwtClaimKey.MOQT, moqtScopesEncode(claims.moqt));
  }

  // M6: Additional claims — reject collisions with standard claim keys
  if (claims.additionalClaims) {
    for (const [key, value] of claims.additionalClaims) {
      if (RESERVED_CLAIM_KEYS.has(key)) {
        throw new CwtError(`Additional claim key ${key} conflicts with a reserved CWT claim key`);
      }
      map.set(key, value);
    }
  }

  return cborEncode(map);
}

/**
 * Decode CWT claims from CBOR map bytes.
 *
 * @throws {CwtError} If the data is not a valid CWT claims map
 */
export function cwtClaimsDecode(data: Uint8Array): CwtClaims {
  const decoded = cborDecode(data);
  if (!(decoded.value instanceof Map)) {
    throw new CwtError('CWT claims must be a CBOR map');
  }

  return cwtClaimsFromMap(decoded.value as Map<number, CborValue>);
}

/**
 * Convert a decoded CBOR map to CwtClaims.
 */
export function cwtClaimsFromMap(map: Map<number | string, CborValue>): CwtClaims {
  const claims: CwtClaims = {};
  const additional = new Map<number, CborValue>();

  for (const [key, value] of map) {
    const numKey = typeof key === 'string' ? parseInt(key, 10) : key;
    if (isNaN(numKey)) continue;

    switch (numKey) {
      case CwtClaimKey.ISS:
        if (typeof value === 'string') claims.iss = value;
        break;
      case CwtClaimKey.SUB:
        if (typeof value === 'string') claims.sub = value;
        break;
      case CwtClaimKey.AUD:
        if (typeof value === 'string') {
          claims.aud = value;
        } else if (Array.isArray(value)) {
          claims.aud = value.filter((v): v is string => typeof v === 'string');
        }
        break;
      case CwtClaimKey.EXP:
        // L5: Validate that time claims are integers
        if (typeof value === 'number') {
          if (!Number.isInteger(value)) {
            throw new CwtError(`CWT exp claim must be an integer, got ${value}`);
          }
          claims.exp = value;
        }
        break;
      case CwtClaimKey.NBF:
        if (typeof value === 'number') {
          if (!Number.isInteger(value)) {
            throw new CwtError(`CWT nbf claim must be an integer, got ${value}`);
          }
          claims.nbf = value;
        }
        break;
      case CwtClaimKey.IAT:
        if (typeof value === 'number') {
          if (!Number.isInteger(value)) {
            throw new CwtError(`CWT iat claim must be an integer, got ${value}`);
          }
          claims.iat = value;
        }
        break;
      case CwtClaimKey.CTI:
        if (value instanceof Uint8Array) claims.cti = value;
        break;
      case CwtClaimKey.MOQT:
      case 65000: // Legacy MoQT claim key
        claims.moqt = decodeMoqtScopesValue(value);
        break;
      default:
        additional.set(numKey, value);
        break;
    }
  }

  if (additional.size > 0) {
    claims.additionalClaims = additional;
  }

  return claims;
}

// ============================================================================
// MoQT Scopes
// ============================================================================

/**
 * Encode MoQT scopes to a CBOR array value.
 * Each scope: [actions_array, namespace_match?, track_match?]
 */
export function moqtScopesEncode(scopes: MoqtScope[]): CborValue[] {
  return scopes.map((scope) => {
    const entry: CborValue[] = [scope.actions.map((a) => a as number)];
    if (scope.namespaceMatch !== undefined) {
      entry.push(scope.namespaceMatch.map((n) =>
        n instanceof Uint8Array ? n : n as string,
      ) as CborValue[]);
    }
    if (scope.trackMatch !== undefined) {
      // Ensure namespace is present (even if null) before track
      if (scope.namespaceMatch === undefined) {
        entry.push(null);
      }
      entry.push(scope.trackMatch instanceof Uint8Array ? scope.trackMatch : scope.trackMatch);
    }
    return entry;
  });
}

/**
 * Decode MoQT scopes from a CBOR value.
 * Handles both direct CBOR array and bstr-wrapped CBOR.
 */
function decodeMoqtScopesValue(value: CborValue): MoqtScope[] {
  let scopesArray: CborValue[];

  if (value instanceof Uint8Array) {
    // bstr-wrapped CBOR
    try {
      const decoded = cborDecode(value);
      if (!Array.isArray(decoded.value)) return [];
      scopesArray = decoded.value;
    } catch {
      return [];
    }
  } else if (Array.isArray(value)) {
    scopesArray = value;
  } else {
    return [];
  }

  return moqtScopesDecode(scopesArray);
}

/**
 * Decode MoQT scopes from a CBOR array.
 */
export function moqtScopesDecode(scopesArray: CborValue[]): MoqtScope[] {
  const scopes: MoqtScope[] = [];

  for (const scopeValue of scopesArray) {
    if (!Array.isArray(scopeValue) || scopeValue.length === 0) continue;

    const actionsValue = scopeValue[0];
    if (!Array.isArray(actionsValue)) continue;

    const actions: MoqtAction[] = actionsValue
      .filter((a): a is number => typeof a === 'number')
      .filter((a) => a >= MoqtAction.ClientSetup && a <= MoqtAction.TrackStatus);

    const scope: MoqtScope = { actions };

    if (scopeValue.length > 1 && scopeValue[1] !== null) {
      const nsMatch = scopeValue[1];
      if (Array.isArray(nsMatch)) {
        // L6: Reject non-string/non-bytes namespace elements instead of coercing
        scope.namespaceMatch = nsMatch.filter((n): n is string | Uint8Array =>
          typeof n === 'string' || n instanceof Uint8Array
        );
      }
    }

    if (scopeValue.length > 2 && scopeValue[2] !== null) {
      const trackMatch = scopeValue[2];
      if (typeof trackMatch === 'string' || trackMatch instanceof Uint8Array) {
        scope.trackMatch = trackMatch;
      }
    }

    scopes.push(scope);
  }

  return scopes;
}

// ============================================================================
// Validation Helpers
// ============================================================================

/**
 * Check if CWT claims have expired.
 */
export function cwtIsExpired(
  claims: CwtClaims,
  nowSeconds?: number,
  clockSkewSeconds = 60,
): boolean {
  if (claims.exp === undefined) return false;
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  return now > claims.exp + clockSkewSeconds;
}

/**
 * Check if CWT claims are not yet valid (before nbf).
 */
export function cwtIsNotYetValid(
  claims: CwtClaims,
  nowSeconds?: number,
  clockSkewSeconds = 60,
): boolean {
  if (claims.nbf === undefined) return false;
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  return now < claims.nbf - clockSkewSeconds;
}

/**
 * Check if CWT claims match a required audience.
 */
export function cwtMatchesAudience(claims: CwtClaims, requiredAudience: string): boolean {
  if (claims.aud === undefined) return false;
  if (typeof claims.aud === 'string') return claims.aud === requiredAudience;
  return claims.aud.includes(requiredAudience);
}

/**
 * CWT encoding/decoding error.
 */
export class CwtError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CwtError';
  }
}
