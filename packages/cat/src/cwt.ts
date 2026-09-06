// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/** CTA-5007-B CWT claims and CAT-4-MOQT authorization scopes. */

import { cborEncode, cborDecodeExact } from './cbor.js';
import {
  CwtClaimKey,
  MoqtAction,
  MoqtMatchType,
  type CborMapKey,
  type CborValue,
  type CwtClaims,
  type MoqtMatch,
  type MoqtPattern,
  type MoqtScope,
} from './types.js';

const RESERVED_CLAIM_KEYS = new Set<number>(Object.values(CwtClaimKey).filter((value): value is number => typeof value === 'number'));
RESERVED_CLAIM_KEYS.add(65000); // legacy MoQT assignment accepted for migration
// These labels are requested by the generic DPoP draft and are intentionally
// kept in additionalClaims because they are not CAT claims.
RESERVED_CLAIM_KEYS.delete(CwtClaimKey.DPOP_ACTX);
RESERVED_CLAIM_KEYS.delete(CwtClaimKey.DPOP_NONCE);
RESERVED_CLAIM_KEYS.delete(CwtClaimKey.DPOP_ATH);

export function cwtClaimsEncode(claims: CwtClaims): Uint8Array {
  if (claims.catv !== undefined && claims.catv !== 1) throw new CwtError('Unsupported CAT version');
  if (claims.cnf !== undefined) validateConfirmation(claims.cnf);
  if (claims.catpor !== undefined) validateCatpor(claims.catpor);
  if (claims.catnip !== undefined) validateCatnip(claims.catnip);
  if (claims.catu !== undefined) validateCatu(claims.catu);
  if (claims.catm !== undefined) requiredStringArray(claims.catm, 'catm');
  if (claims.catalpn !== undefined) requiredBytesArray(claims.catalpn, 'catalpn');
  if (claims.cath !== undefined) validateCath(claims.cath);
  if (claims.catgeoiso3166 !== undefined) requiredStringArray(claims.catgeoiso3166, 'catgeoiso3166');
  if (claims.catgeocoord !== undefined) validateGeoCoordinate(claims.catgeocoord);
  if (claims.catgeoalt !== undefined) validateGeoAltitude(claims.catgeoalt);
  if (claims.geohash !== undefined) validateGeohash(claims.geohash);
  if (claims.catdpop !== undefined) validateCatDpopSettings(claims.catdpop);
  if (claims.catif !== undefined) validateCatIf(claims.catif);
  if (claims.catr !== undefined) validateCatr(claims.catr);
  const map = new Map<number, CborValue>();
  const set = (key: CwtClaimKey, value: CborValue | undefined) => { if (value !== undefined) map.set(key, value); };
  set(CwtClaimKey.ISS, claims.iss);
  set(CwtClaimKey.SUB, claims.sub);
  set(CwtClaimKey.AUD, claims.aud);
  set(CwtClaimKey.EXP, numericDate(claims.exp, 'exp'));
  set(CwtClaimKey.NBF, numericDate(claims.nbf, 'nbf'));
  set(CwtClaimKey.IAT, numericDate(claims.iat, 'iat'));
  set(CwtClaimKey.CTI, claims.cti);
  set(CwtClaimKey.CNF, claims.cnf);
  set(CwtClaimKey.CATREPLAY, claims.catreplay);
  set(CwtClaimKey.CATPOR, claims.catpor);
  set(CwtClaimKey.CATV, claims.catv);
  set(CwtClaimKey.CATNIP, claims.catnip);
  set(CwtClaimKey.CATU, claims.catu);
  set(CwtClaimKey.CATM, claims.catm);
  set(CwtClaimKey.CATALPN, claims.catalpn);
  set(CwtClaimKey.CATH, claims.cath);
  set(CwtClaimKey.CATGEOISO3166, claims.catgeoiso3166);
  set(CwtClaimKey.CATGEOCOORD, claims.catgeocoord);
  set(CwtClaimKey.GEOHASH, claims.geohash);
  set(CwtClaimKey.CATGEOALT, claims.catgeoalt);
  set(CwtClaimKey.CATTPK, claims.cattpk);
  set(CwtClaimKey.CATIFDATA, claims.catifdata);
  set(CwtClaimKey.CATDPOP, claims.catdpop);
  set(CwtClaimKey.CATIF, claims.catif);
  set(CwtClaimKey.CATR, claims.catr);
  if (claims.moqt !== undefined) set(CwtClaimKey.MOQT, moqtScopesEncode(claims.moqt));

  if (claims.additionalClaims) {
    for (const [key, value] of claims.additionalClaims) {
      if (!Number.isSafeInteger(key) || RESERVED_CLAIM_KEYS.has(key)) throw new CwtError(`Additional claim key ${key} is reserved`);
      map.set(key, value);
    }
  }
  return cborEncode(map);
}

export function cwtClaimsDecode(data: Uint8Array): CwtClaims {
  let value: CborValue;
  try { value = cborDecodeExact(data); } catch (error) { throw new CwtError(error instanceof Error ? error.message : 'Invalid CWT'); }
  if (!(value instanceof Map)) throw new CwtError('CWT claims must be a CBOR map');
  return cwtClaimsFromMap(value);
}

export function cwtClaimsFromMap(map: Map<CborMapKey, CborValue>): CwtClaims {
  const claims: CwtClaims = {};
  const additional = new Map<number, CborValue>();
  for (const [key, value] of map) {
    const numKey = typeof key === 'number' ? key : typeof key === 'bigint' && key <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(key) : Number.NaN;
    if (!Number.isSafeInteger(numKey)) continue;
    switch (numKey) {
      case CwtClaimKey.ISS: claims.iss = requiredString(value, 'iss'); break;
      case CwtClaimKey.SUB: claims.sub = requiredString(value, 'sub'); break;
      case CwtClaimKey.AUD:
        if (typeof value === 'string') claims.aud = value;
        else if (Array.isArray(value) && value.every(item => typeof item === 'string')) claims.aud = value as string[];
        else throw new CwtError('aud must be a text string or array of text strings');
        break;
      case CwtClaimKey.EXP: claims.exp = requiredNumericDate(value, 'exp'); break;
      case CwtClaimKey.NBF: claims.nbf = requiredNumericDate(value, 'nbf'); break;
      case CwtClaimKey.IAT: claims.iat = requiredNumericDate(value, 'iat'); break;
      case CwtClaimKey.CTI: claims.cti = requiredBytes(value, 'cti'); break;
      case CwtClaimKey.CNF: claims.cnf = requiredIntegerMap(value, 'cnf'); validateConfirmation(claims.cnf); break;
      case CwtClaimKey.CATREPLAY: claims.catreplay = requiredUint(value, 'catreplay'); break;
      case CwtClaimKey.CATPOR: claims.catpor = requiredArray(value, 'catpor'); validateCatpor(claims.catpor); break;
      case CwtClaimKey.CATV:
        claims.catv = requiredUint(value, 'catv');
        if (claims.catv !== 1) throw new CwtError('Unsupported CAT version');
        break;
      case CwtClaimKey.CATNIP: claims.catnip = requiredArray(value, 'catnip'); validateCatnip(claims.catnip); break;
      case CwtClaimKey.CATU: claims.catu = requiredNestedMatchMap(value, 'catu'); break;
      case CwtClaimKey.CATM: claims.catm = requiredStringArray(value, 'catm'); break;
      case CwtClaimKey.CATALPN: claims.catalpn = requiredBytesArray(value, 'catalpn'); break;
      case CwtClaimKey.CATH: claims.cath = requiredNestedStringMatchMap(value, 'cath'); break;
      case CwtClaimKey.CATGEOISO3166: claims.catgeoiso3166 = requiredStringArray(value, 'catgeoiso3166'); break;
      case CwtClaimKey.CATGEOCOORD: claims.catgeocoord = value; validateGeoCoordinate(value); break;
      case CwtClaimKey.GEOHASH:
        validateGeohash(value);
        claims.geohash = value;
        break;
      case CwtClaimKey.CATGEOALT: claims.catgeoalt = value; validateGeoAltitude(value); break;
      case CwtClaimKey.CATTPK: claims.cattpk = requiredBytes(value, 'cattpk'); break;
      case CwtClaimKey.CATIFDATA:
        if (typeof value !== 'string' && !(Array.isArray(value) && value.every(item => typeof item === 'string'))) throw new CwtError('catifdata must be a string or string array');
        claims.catifdata = value as string | string[];
        break;
      case CwtClaimKey.CATDPOP: claims.catdpop = requiredIntegerMap(value, 'catdpop'); validateCatDpopSettings(claims.catdpop); break;
      case CwtClaimKey.CATIF: claims.catif = requiredMap(value, 'catif') as CwtClaims['catif']; validateCatIf(claims.catif!); break;
      case CwtClaimKey.CATR: claims.catr = requiredIntegerMap(value, 'catr'); validateCatr(claims.catr); break;
      case CwtClaimKey.MOQT:
      case 65000: claims.moqt = decodeMoqtScopesValue(value); break;
      default: additional.set(numKey, value); break;
    }
  }
  if (additional.size) claims.additionalClaims = additional;
  return claims;
}

export function moqtScopesEncode(scopes: MoqtScope[]): CborValue[] {
  return scopes.map((scope) => {
    if (!Array.isArray(scope.actions) || scope.actions.length === 0 || scope.actions.some(action => !Number.isInteger(action) || action < 0 || action > 8)) throw new CwtError('MoQT scope actions must be integers from 0 through 8');
    const entry: CborValue[] = [scope.actions.map(action => action as number)];
    if (scope.namespaceMatch !== undefined) {
      if (scope.namespaceMatch.length === 0) throw new CwtError('namespace match must not be empty');
      if (scope.namespaceMatch.some((match, index) => match === null && index !== scope.namespaceMatch!.length - 1)) throw new CwtError('nil namespace match must be last');
      entry.push(scope.namespaceMatch.map(encodeMatch));
    }
    if (scope.trackMatch !== undefined) {
      if (scope.namespaceMatch === undefined) entry.push(null);
      entry.push(encodeMatch(scope.trackMatch));
    }
    return entry;
  });
}

function encodeMatch(match: MoqtMatch | null): CborValue {
  if (match === null) return null;
  if (typeof match === 'string') return new TextEncoder().encode(match);
  if (match instanceof Uint8Array) return match;
  if (!Number.isInteger(match.type) || match.type < 0 || match.type > 2) throw new CwtError('invalid MoQT match type');
  const value = typeof match.value === 'string' ? new TextEncoder().encode(match.value) : match.value;
  return [match.type, value];
}

function decodeMatch(value: CborValue): MoqtMatch | null {
  if (value === null) return null;
  if (value instanceof Uint8Array) return decodeUtf8OrBytes(value);
  // Accept text strings from early draft vectors, but emit standards-compliant bstr on re-encode.
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'number' && (value[0] === 0 || value[0] === 1 || value[0] === 2) && value[1] instanceof Uint8Array) {
    return { type: value[0] as MoqtMatchType, value: decodeUtf8OrBytes(value[1]) } as MoqtPattern;
  }
  throw new CwtError('invalid MoQT match object');
}

export function moqtScopesDecode(scopesArray: CborValue[]): MoqtScope[] {
  const scopes: MoqtScope[] = [];
  for (const scopeValue of scopesArray) {
    if (!Array.isArray(scopeValue) || scopeValue.length < 1 || scopeValue.length > 3 || !Array.isArray(scopeValue[0]) || scopeValue[0].length === 0) throw new CwtError('invalid MoQT scope');
    const actions = scopeValue[0].map(action => typeof action === 'number' ? action : Number.NaN);
    if (actions.some(action => !Number.isInteger(action) || action < 0 || action > 8)) throw new CwtError('invalid MoQT action');
    const scope: MoqtScope = { actions: actions as MoqtAction[] };
    if (scopeValue.length >= 2) {
      if (scopeValue[1] === null) {
        if (scopeValue.length === 3) {
          const track = decodeMatch(scopeValue[2]);
          if (track === null) throw new CwtError('track match cannot be nil');
          scope.trackMatch = track;
        }
      } else if (Array.isArray(scopeValue[1])) {
        if (scopeValue[1].length === 0) throw new CwtError('namespace match must not be empty');
        const ns = scopeValue[1].map(decodeMatch);
        if (ns.some((match, index) => match === null && index !== ns.length - 1)) throw new CwtError('nil namespace match must be last');
        scope.namespaceMatch = ns;
        if (scopeValue.length === 3) {
          const track = decodeMatch(scopeValue[2]);
          if (track === null) throw new CwtError('track match cannot be nil');
          scope.trackMatch = track;
        }
      } else throw new CwtError('invalid MoQT namespace match');
    }
    scopes.push(scope);
  }
  return scopes;
}

function decodeMoqtScopesValue(value: CborValue): MoqtScope[] {
  if (value instanceof Uint8Array) {
    const decoded = cborDecodeExact(value);
    if (!Array.isArray(decoded)) throw new CwtError('moqt claim must contain an array');
    return moqtScopesDecode(decoded);
  }
  if (!Array.isArray(value)) throw new CwtError('moqt claim must contain an array');
  return moqtScopesDecode(value);
}

export function cwtIsExpired(claims: CwtClaims, nowSeconds = Math.floor(Date.now() / 1000), clockSkewSeconds = 0): boolean {
  return claims.exp !== undefined && nowSeconds > claims.exp + validSkew(clockSkewSeconds);
}

export function cwtIsNotYetValid(claims: CwtClaims, nowSeconds = Math.floor(Date.now() / 1000), clockSkewSeconds = 0): boolean {
  return claims.nbf !== undefined && nowSeconds < claims.nbf - validSkew(clockSkewSeconds);
}

export function cwtMatchesAudience(claims: CwtClaims, requiredAudience: string): boolean {
  return claims.aud === requiredAudience || (Array.isArray(claims.aud) && claims.aud.includes(requiredAudience));
}

function numericDate(value: number | undefined, name: string): CborValue | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || Object.is(value, -0)) throw new CwtError(`${name} must be a finite NumericDate`);
  return value;
}

function requiredNumericDate(value: CborValue, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Object.is(value, -0)) throw new CwtError(`${name} must be a NumericDate`);
  return value;
}

function requiredString(value: CborValue, name: string): string { if (typeof value !== 'string') throw new CwtError(`${name} must be a text string`); return value; }
function requiredBytes(value: CborValue, name: string): Uint8Array { if (!(value instanceof Uint8Array)) throw new CwtError(`${name} must be a byte string`); return value; }
function requiredArray(value: CborValue, name: string): CborValue[] { if (!Array.isArray(value)) throw new CwtError(`${name} must be an array`); return value; }
function requiredUint(value: CborValue, name: string): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new CwtError(`${name} must be an unsigned integer`); return value; }
function requiredStringArray(value: CborValue, name: string): string[] { if (!Array.isArray(value) || value.length === 0 || !value.every(item => typeof item === 'string')) throw new CwtError(`${name} must be a non-empty array of text strings`); return value as string[]; }
function requiredBytesArray(value: CborValue, name: string): Uint8Array[] { if (!Array.isArray(value) || value.length === 0 || !value.every(item => item instanceof Uint8Array)) throw new CwtError(`${name} must be a non-empty array of byte strings`); return value as Uint8Array[]; }
function requiredMap(value: CborValue, name: string): Map<number | string, CborValue> { if (!(value instanceof Map)) throw new CwtError(`${name} must be a map`); return value as Map<number | string, CborValue>; }
function requiredIntegerMap(value: CborValue, name: string): Map<number, CborValue> { const map = requiredMap(value, name); if ([...map.keys()].some(key => typeof key !== 'number' || !Number.isSafeInteger(key))) throw new CwtError(`${name} must use integer keys`); return map as Map<number, CborValue>; }
function decodeUtf8OrBytes(value: Uint8Array): string | Uint8Array { try { return new TextDecoder('utf-8', { fatal: true }).decode(value); } catch { return value.slice(); } }
function validSkew(value: number): number { if (!Number.isFinite(value) || value < 0) throw new CwtError('clock skew must be non-negative'); return value; }

function validateConfirmation(value: Map<number, CborValue>): void {
  for (const [key, item] of value) {
    if (key === 323 || key === 5) {
      if (!(item instanceof Uint8Array) || item.length !== 32) throw new CwtError('confirmation thumbprint must be a 32-byte bstr');
    }
  }
}

function validateCatDpopSettings(value: Map<number, CborValue>): void {
  const critical = value.get(-1);
  if (critical !== undefined) {
    if (!Array.isArray(critical) || critical.some(item => typeof item !== 'number' || !Number.isSafeInteger(item))) throw new CwtError('catdpop critical settings must be integer labels');
    if (critical.some(item => item !== -1 && item !== 0 && item !== 1)) throw new CwtError('catdpop contains an unsupported critical setting');
    if (critical.includes(-1) || critical.includes(0) || critical.includes(1)) throw new CwtError('catdpop standard settings cannot be critical');
  }
  const window = value.get(0);
  if (window !== undefined && (typeof window !== 'number' || !Number.isSafeInteger(window) || window < 0)) throw new CwtError('catdpop window must be an unsigned integer');
  const jti = value.get(1);
  if (jti !== undefined && (typeof jti !== 'number' || !Number.isSafeInteger(jti) || jti < 0)) throw new CwtError('catdpop jti must be an unsigned integer');
}

function validateCatpor(value: CborValue[]): void {
  if (value.length < 2 || value.length > 3) throw new CwtError('catpor must contain probability and identifier');
  const probability = value[0];
  if (typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1) throw new CwtError('catpor probability must be between zero and one');
  const identifier = value[1];
  if (!(identifier instanceof Uint8Array) && !isUnsignedInteger(identifier)) throw new CwtError('catpor identifier must be a label or byte string');
  if (value.length === 3) requiredNumericDate(value[2], 'catpor expiration');
}

function validateCatnip(value: CborValue[]): void {
  if (value.length === 0) throw new CwtError('catnip must not be empty');
  for (const item of value) {
    if (isUnsignedInteger(item)) continue;
    if (!isTagged(item) || (item.tag !== 52 && item.tag !== 54)) throw new CwtError('catnip contains an invalid network object');
    const bytesLength = item.tag === 52 ? 4 : 16;
    if (item.value instanceof Uint8Array) {
      if (item.value.length !== bytesLength) throw new CwtError('catnip address has an invalid length');
      continue;
    }
    if (!Array.isArray(item.value) || item.value.length !== 2 || !isUnsignedInteger(item.value[0]) || Number(item.value[0]) > (item.tag === 52 ? 32 : 128) || !(item.value[1] instanceof Uint8Array) || item.value[1].length > bytesLength) throw new CwtError('catnip prefix is malformed');
  }
}

function validateCatu(value: Map<number, Map<number, CborValue>>): void {
  for (const [part, match] of value) {
    if (!Number.isSafeInteger(part) || part < 0 || part > 8 || !Number.isInteger(part)) throw new CwtError('catu contains an invalid URI component');
    validateMatchMap(match);
  }
}

function validateCath(value: Map<string, Map<number, CborValue>>): void {
  const normalized = new Set<string>();
  for (const [name, match] of value) {
    if (typeof name !== 'string' || name.length === 0) throw new CwtError('cath contains an invalid header name');
    const key = name.toLowerCase();
    if (normalized.has(key)) throw new CwtError('cath contains duplicate case-insensitive header names');
    normalized.add(key);
    validateMatchMap(match);
  }
}

function validateMatchMap(value: Map<number, CborValue>): void {
  for (const [type, match] of value) {
    if (!Number.isSafeInteger(type)) throw new CwtError('URI match type must be an integer');
    if (type >= 0 && type <= 3) {
      if (typeof match !== 'string') throw new CwtError('text URI match must be a text string');
    } else if (type === 4) {
      if (!Array.isArray(match) || match.length === 0 || match.some(item => typeof item !== 'string' && item !== null)) throw new CwtError('regular-expression URI match is malformed');
    } else if (type === -1 || type === -2) {
      if (!(match instanceof Uint8Array) || match.length !== 32) throw new CwtError('hashed URI match must be a 32-byte bstr');
    } else {
      throw new CwtError('unsupported URI match type');
    }
  }
}

function requiredNestedMatchMap(value: CborValue, name: string): Map<number, Map<number, CborValue>> {
  const map = requiredMap(value, name);
  if ([...map.keys()].some(key => typeof key !== 'number' || !Number.isSafeInteger(key))) throw new CwtError(`${name} must use integer URI component keys`);
  const result = new Map<number, Map<number, CborValue>>();
  for (const [key, item] of map) {
    if (!(item instanceof Map) || [...item.keys()].some(matchKey => typeof matchKey !== 'number' || !Number.isSafeInteger(matchKey))) throw new CwtError(`${name} must contain integer-keyed match maps`);
    const match = item as Map<number, CborValue>;
    validateMatchMap(match);
    result.set(key as number, match);
  }
  return result;
}

function requiredNestedStringMatchMap(value: CborValue, name: string): Map<string, Map<number, CborValue>> {
  const map = requiredMap(value, name);
  if ([...map.keys()].some(key => typeof key !== 'string')) throw new CwtError(`${name} must use text header keys`);
  const result = new Map<string, Map<number, CborValue>>();
  for (const [key, item] of map) {
    if (!(item instanceof Map) || [...item.keys()].some(matchKey => typeof matchKey !== 'number' || !Number.isSafeInteger(matchKey))) throw new CwtError(`${name} must contain integer-keyed match maps`);
    const match = item as Map<number, CborValue>;
    validateMatchMap(match);
    result.set(key as string, match);
  }
  validateCath(result);
  return result;
}

function validateGeoCoordinate(value: CborValue): void {
  const locations = isTagged(value) ? taggedPayload(value, 279) : value;
  if (!Array.isArray(locations) || locations.length === 0) throw new CwtError('catgeocoord must contain locations');
  validateLocations(locations);
}

function validateLocations(value: CborValue[]): void {
  for (const location of value) {
    const unwrapped = isTagged(location) ? taggedPayload(location, 279) : location;
    if (!Array.isArray(unwrapped) || unwrapped.length !== 3 || typeof unwrapped[0] !== 'number' || !Number.isFinite(unwrapped[0]) || typeof unwrapped[1] !== 'number' || !Number.isFinite(unwrapped[1]) || !isUnsignedInteger(unwrapped[2])) throw new CwtError('invalid geographic coordinate');
  }
}

function validateGeoAltitude(value: CborValue): void {
  const spec = isTagged(value) ? taggedPayload(value, 279) : value;
  if (spec === undefined) throw new CwtError('invalid tagged altitude claim');
  if (!Array.isArray(spec) || spec.length !== 2 || typeof spec[0] !== 'number' || !Number.isFinite(spec[0]) || typeof spec[1] !== 'number' || !Number.isFinite(spec[1])) throw new CwtError('invalid altitude claim');
}

function validateGeohash(value: CborValue): void {
  const unwrapped = isTagged(value) ? taggedPayload(value, 279) : value;
  if (typeof unwrapped === 'string') {
    if (unwrapped.length === 0) throw new CwtError('geohash must not be empty');
    return;
  }
  if (!Array.isArray(unwrapped)) throw new CwtError('geohash must be a string or array');
  for (const item of unwrapped) {
    const geohash = isTagged(item) ? taggedPayload(item, 279) : item;
    if (typeof geohash !== 'string' || geohash.length === 0) throw new CwtError('geohash array contains an invalid value');
  }
}

function validateCatIf(value: NonNullable<CwtClaims['catif']>): void {
  for (const [key, action] of value) {
    const validKey = typeof key === 'number' && Number.isSafeInteger(key) || Array.isArray(key) && key.length > 0 && key.every(label => typeof label === 'number' && Number.isSafeInteger(label));
    if (!validKey || !Array.isArray(action) || action.length < 1 || action.length > 3 || !isUnsignedInteger(action[0])) throw new CwtError('catif action is malformed');
    if (action.length >= 2 && !(action[1] instanceof Map)) throw new CwtError('catif headers must be a map');
    if (action.length === 3 && typeof action[2] !== 'string') throw new CwtError('catif key id must be text');
    if (action[1] instanceof Map) {
      for (const [header, headerValue] of action[1]) {
        if (typeof header !== 'string' || !(typeof headerValue === 'string' || (Array.isArray(headerValue) && headerValue.length > 0 && headerValue.every(item => typeof item === 'string' || isInteger(item) || item instanceof Map)))) throw new CwtError('catif header value is malformed');
      }
    }
  }
}

function validateCatr(value: Map<number, CborValue>): void {
  if (!value.has(0) || !value.has(1) || !isInteger(value.get(0)!) || typeof value.get(1) !== 'number' || !Number.isFinite(value.get(1))) throw new CwtError('catr requires renewal type and expiration extension');
  for (const [key, item] of value) {
    if (!Number.isSafeInteger(key)) throw new CwtError('catr keys must be integers');
    if ((key === 3 || key === 4) && typeof item !== 'string') throw new CwtError('catr name must be text');
    if ((key === 5 || key === 6) && (!Array.isArray(item) || item.some(parameter => typeof parameter !== 'string'))) throw new CwtError('catr parameters must be text strings');
    if (key === 7 && !isInteger(item)) throw new CwtError('catr code must be an integer');
  }
}

function taggedPayload(value: CborValue, tag: number): CborValue | undefined {
  if (!isTagged(value) || value.tag !== tag || !Array.isArray(value.value) || value.value.length !== 2) return undefined;
  return value.value[1];
}

function isTagged(value: CborValue): value is { tag: number; value: CborValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Uint8Array) && !(value instanceof Map) && 'tag' in value && 'value' in value;
}

function isUnsignedInteger(value: CborValue): boolean {
  return typeof value === 'bigint' ? value >= 0n : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isInteger(value: CborValue): boolean {
  return typeof value === 'bigint' || typeof value === 'number' && Number.isSafeInteger(value);
}

export class CwtError extends Error { constructor(message: string) { super(message); this.name = 'CwtError'; } }
