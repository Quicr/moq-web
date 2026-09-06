// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/** Runtime evaluation of CTA and CAT-4-MOQT request constraints. */

import { MoqtAction, type CborValue, type CwtClaims, type MoqtMatch, type MoqtScope } from './types.js';

export type BinaryValue = string | Uint8Array;

export interface CatRequestContext {
  action?: MoqtAction;
  namespace?: readonly BinaryValue[];
  trackName?: BinaryValue;
  uri?: string | URL;
  method?: string;
  headers?: Headers | ReadonlyMap<string, string> | Readonly<Record<string, string>>;
  alpn?: Uint8Array;
  ipAddress?: string;
  countryCode?: string;
  coordinate?: readonly [number, number];
  altitude?: number;
}

export interface CatPolicyOptions {
  /** A missing moqt claim is treated as unrestricted when false. */
  requireMoqtClaim?: boolean;
  /** Regex URI/header matches are disabled by default to avoid ReDoS risk. */
  allowRegex?: boolean;
  maxRegexLength?: number;
}

export interface CatPolicyResult {
  allowed: boolean;
  reason?: string;
  scope?: MoqtScope;
}

export async function evaluateCatPolicy(claims: CwtClaims, request: CatRequestContext, options: CatPolicyOptions = {}): Promise<CatPolicyResult> {
  if (claims.moqt !== undefined) {
    if (request.action === undefined) return deny('MOQT request context is incomplete');
    const scope = claims.moqt.find(candidate => moqtScopeAllows(candidate, request.action!, request.namespace ?? [], request.trackName));
    if (!scope) return deny('MOQT action or track is not authorized');
    if (!(await evaluateNonMoqtClaims(claims, request, options))) return deny('CAT request constraints failed');
    return { allowed: true, scope };
  }
  if (options.requireMoqtClaim) return deny('MOQT claim is required');
  return (await evaluateNonMoqtClaims(claims, request, options)) ? { allowed: true } : deny('CAT request constraints failed');
}

export function moqtScopeAllows(scope: MoqtScope, action: MoqtAction, namespace: readonly BinaryValue[], trackName?: BinaryValue): boolean {
  if (!scope.actions.includes(action)) return false;
  if (scope.namespaceMatch !== undefined) {
    const namespaceMatch = scope.namespaceMatch;
    const exactLength = namespaceMatch.length > 0 && namespaceMatch[namespaceMatch.length - 1] === null;
    const matchCount = exactLength ? namespaceMatch.length - 1 : namespaceMatch.length;
    if (namespace.length < matchCount || exactLength && namespace.length !== matchCount) return false;
    for (let index = 0; index < matchCount; index++) {
      const match = namespaceMatch[index];
      if (match === null || !binaryMatch(match, namespace[index])) return false;
    }
  }
  return scope.trackMatch === undefined || trackName !== undefined && binaryMatch(scope.trackMatch, trackName);
}

async function evaluateNonMoqtClaims(claims: CwtClaims, request: CatRequestContext, options: CatPolicyOptions): Promise<boolean> {
  if (claims.catm !== undefined && (request.method === undefined || !claims.catm.includes(request.method))) return false;
  if (claims.catalpn !== undefined && (request.alpn === undefined || !claims.catalpn.some(value => bytesEqual(value, request.alpn!)))) return false;
  if (claims.catu !== undefined && (request.uri === undefined || !(await uriMatches(claims.catu, request.uri, options)))) return false;
  if (claims.cath !== undefined && (request.headers === undefined || !(await headersMatch(claims.cath, request.headers, options)))) return false;
  if (claims.catnip !== undefined && (request.ipAddress === undefined || !ipMatchesClaim(claims.catnip, request.ipAddress))) return false;
  if (claims.catgeoiso3166 !== undefined && (request.countryCode === undefined || !claims.catgeoiso3166.includes(request.countryCode))) return false;
  if (claims.catgeocoord !== undefined && (request.coordinate === undefined || !coordinateMatches(claims.catgeocoord, request.coordinate))) return false;
  if (claims.catgeoalt !== undefined && (request.altitude === undefined || !altitudeMatches(claims.catgeoalt, request.altitude))) return false;
  return true;
}

async function uriMatches(claim: Map<number, Map<number, CborValue>>, input: string | URL, options: CatPolicyOptions): Promise<boolean> {
  let uri: URL;
  try { uri = typeof input === 'string' ? new URL(input) : new URL(input.href); } catch { return false; }
  for (const [part, matches] of claim) {
    const component = uriComponent(uri, part);
    if (component === undefined || !(await matchMap(matches, component, options))) return false;
  }
  return true;
}

function uriComponent(uri: URL, part: number): string | undefined {
  switch (part) {
    case 0: return uri.protocol.slice(0, -1).toLowerCase();
    case 1: return uri.hostname.toLowerCase();
    case 2: return uri.port;
    case 3: return uri.pathname;
    case 4: return uri.search.slice(1);
    case 5: { const path = uri.pathname; const slash = path.lastIndexOf('/'); return slash <= 0 ? '' : path.slice(0, slash); }
    case 6: { const path = uri.pathname; return path.slice(path.lastIndexOf('/') + 1); }
    case 7: { const filename = uriComponent(uri, 6)!; const dot = filename.lastIndexOf('.'); return dot <= 0 ? filename : filename.slice(0, dot); }
    case 8: { const filename = uriComponent(uri, 6)!; const dot = filename.lastIndexOf('.'); return dot < 0 ? '' : filename.slice(dot); }
    default: return undefined;
  }
}

async function headersMatch(claim: Map<string, Map<number, CborValue>>, headers: Headers | ReadonlyMap<string, string> | Readonly<Record<string, string>>, options: CatPolicyOptions): Promise<boolean> {
  for (const [name, matches] of claim) {
    const actual = headerValue(headers, name);
    if (actual === undefined || !(await matchMap(matches, actual, options))) return false;
  }
  return true;
}

function headerValue(headers: Headers | ReadonlyMap<string, string> | Readonly<Record<string, string>>, name: string): string | undefined {
  if (typeof Headers !== 'undefined' && headers instanceof Headers) return headers.get(name) ?? undefined;
  if (headers instanceof Map) {
    for (const [key, value] of headers) if (key.toLowerCase() === name.toLowerCase()) return value;
    return undefined;
  }
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === name.toLowerCase()) return value;
  return undefined;
}

async function matchMap(matches: Map<number, CborValue>, actual: string, options: CatPolicyOptions): Promise<boolean> {
  for (const [type, expected] of matches) {
    if (type >= 0 && type <= 3 && typeof expected === 'string') {
      if (type === 0 && actual !== expected || type === 1 && !actual.startsWith(expected) || type === 2 && !actual.endsWith(expected) || type === 3 && !actual.includes(expected)) return false;
    } else if (type === 4 && Array.isArray(expected)) {
      if (!options.allowRegex || typeof expected[0] !== 'string' || expected[0].length > (options.maxRegexLength ?? 256)) return false;
      let expression: RegExp;
      try { expression = new RegExp(expected[0]); } catch { return false; }
      const result = expression.exec(actual);
      if (!result) return false;
      for (let index = 1; index < expected.length; index++) if (expected[index] !== null && expected[index] !== result[index]) return false;
    } else if (type === -1 && expected instanceof Uint8Array) {
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', toArrayBuffer(new TextEncoder().encode(actual))));
      if (!bytesEqual(digest, expected)) return false;
    } else return false;
  }
  return true;
}

function binaryMatch(match: MoqtMatch, actual: BinaryValue): boolean {
  const candidate = toBytes(actual);
  if (typeof match === 'string' || match instanceof Uint8Array) return bytesEqual(toBytes(match), candidate);
  const expected = toBytes(match.value);
  if (match.type === 1) return startsWith(candidate, expected);
  if (match.type === 2) return endsWith(candidate, expected);
  return false;
}

function ipMatchesClaim(claim: CborValue[], address: string): boolean {
  const candidate = parseIp(address);
  if (!candidate) return false;
  return claim.some(item => {
    if (isUnsigned(item)) return false; // ASN matching requires an ASN resolver, not an IP string.
    if (!isTagged(item) || (item.tag !== 52 && item.tag !== 54)) return false;
    const bytesLength = item.tag === 52 ? 4 : 16;
    if (candidate.bytes.length !== bytesLength) return false;
    if (item.value instanceof Uint8Array) return bytesEqual(candidate.bytes, item.value);
    if (!Array.isArray(item.value) || item.value.length !== 2 || !isUnsigned(item.value[0]) || !(item.value[1] instanceof Uint8Array)) return false;
    const bits = Number(item.value[0]);
    if (bits > bytesLength * 8 || item.value[1].length > bytesLength) return false;
    return prefixEqual(candidate.bytes, item.value[1], bits);
  });
}

function coordinateMatches(claim: CborValue, coordinate: readonly [number, number]): boolean {
  const locations = isTagged(claim) && claim.tag === 279 && Array.isArray(claim.value) ? claim.value[1] : claim;
  if (!Array.isArray(locations)) return false;
  return locations.some(location => {
    const point = isTagged(location) && location.tag === 279 && Array.isArray(location.value) ? location.value[1] : location;
    if (!Array.isArray(point) || point.length !== 3 || typeof point[0] !== 'number' || typeof point[1] !== 'number' || typeof point[2] !== 'number') return false;
    return haversineMeters(coordinate[0], coordinate[1], point[0], point[1]) <= point[2];
  });
}

function altitudeMatches(claim: CborValue, altitude: number): boolean {
  const spec = isTagged(claim) && claim.tag === 279 && Array.isArray(claim.value) ? claim.value[1] : claim;
  return Array.isArray(spec) && spec.length === 2 && typeof spec[0] === 'number' && typeof spec[1] === 'number' && Math.abs(altitude - spec[0]) <= spec[1];
}

function parseIp(value: string): { bytes: Uint8Array } | undefined {
  if (value.includes('.')) {
    const parts = value.split('.').map(Number);
    return parts.length === 4 && parts.every(part => Number.isInteger(part) && part >= 0 && part <= 255) ? { bytes: new Uint8Array(parts) } : undefined;
  }
  const halves = value.split('::');
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && left.length !== 8 || halves.length === 2 && left.length + right.length >= 8) return undefined;
  const words = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right].map(part => Number.parseInt(part, 16));
  if (words.length !== 8 || words.some(word => !Number.isInteger(word) || word < 0 || word > 0xffff)) return undefined;
  const bytes = new Uint8Array(16);
  words.forEach((word, index) => { bytes[index * 2] = word >>> 8; bytes[index * 2 + 1] = word & 0xff; });
  return { bytes };
}

const textEncoder = new TextEncoder();
function toBytes(value: BinaryValue): Uint8Array { return typeof value === 'string' ? textEncoder.encode(value) : value; }
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean { return a.length === b.length && a.every((value, index) => value === b[index]); }
function startsWith(value: Uint8Array, prefix: Uint8Array): boolean { if (prefix.length > value.length) return false; for (let index = 0; index < prefix.length; index++) if (value[index] !== prefix[index]) return false; return true; }
function endsWith(value: Uint8Array, suffix: Uint8Array): boolean { if (suffix.length > value.length) return false; const offset = value.length - suffix.length; for (let index = 0; index < suffix.length; index++) if (value[offset + index] !== suffix[index]) return false; return true; }
function prefixEqual(value: Uint8Array, prefix: Uint8Array, bits: number): boolean { if (prefix.length * 8 < bits) return false; for (let bit = 0; bit < bits; bit++) if ((value[bit >> 3] & (0x80 >> (bit & 7))) !== (prefix[bit >> 3] & (0x80 >> (bit & 7)))) return false; return true; }
function isUnsigned(value: CborValue): boolean { return typeof value === 'bigint' ? value >= 0n : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function isTagged(value: CborValue): value is { tag: number; value: CborValue } { return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Uint8Array) && !(value instanceof Map) && 'tag' in value && 'value' in value; }
function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number { const radians = Math.PI / 180; const a = Math.sin((lat2 - lat1) * radians / 2) ** 2 + Math.cos(lat1 * radians) * Math.cos(lat2 * radians) * Math.sin((lon2 - lon1) * radians / 2) ** 2; return 6371008.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)); }
function toArrayBuffer(value: Uint8Array): ArrayBuffer { return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer; }
function deny(reason: string): CatPolicyResult { return { allowed: false, reason }; }
