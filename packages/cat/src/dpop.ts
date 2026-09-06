// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * CWT-based generic DPoP for MOQT.
 *
 * The label values 400/401/402 are the assignments requested by the current
 * individual draft; callers can override them while the draft is still in
 * flux. CAT's `jkt` confirmation method remains the default binding because
 * CTA-5007-B explicitly requires it.
 */

import { cborEncode } from './cbor.js';
import { cwtClaimsEncode, cwtClaimsDecode } from './cwt.js';
import {
  coseSign1Sign,
  coseSign1Encode,
  coseSign1Decode,
  coseSign1Verify,
  coseSign1GetAlgorithm,
  coseSign1DecodeProtectedHeader,
} from './cose.js';
import {
  CoseAlgorithm,
  CoseHeaderParam,
  CwtClaimKey,
  COSE_ALG_PARAMS,
  type CborValue,
  type CwtClaims,
} from './types.js';

export const DPOP_PROOF_CWT_TYP = 'dpop-proof+cwt';

export interface DpopLabels {
  actx?: number;
  nonce?: number;
  ath?: number;
}

export interface MoqtDpopContext {
  action: string;
  trackNamespace: readonly (string | Uint8Array)[];
  trackName?: string | Uint8Array;
  parameters?: CborValue;
}

export interface DpopProofOptions {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  authorizationContext: CborValue | MoqtDpopContext;
  algorithm?: CoseAlgorithm;
  cti?: Uint8Array;
  issuedAt?: number;
  nonce?: string;
  accessToken?: Uint8Array;
  labels?: DpopLabels;
}

export interface DpopProof {
  cose: import('./types.js').CoseSign1;
  algorithm: CoseAlgorithm;
  key: Map<number, CborValue>;
  claims: CwtClaims;
  authorizationContext: CborValue;
}

export interface DpopValidationOptions {
  accessToken?: Uint8Array;
  expectedAuthorizationContext?: CborValue;
  expectedContextType?: string;
  expectedNonce?: string;
  expectedJkt?: Uint8Array;
  expectedCkt?: Uint8Array;
  now?: number;
  maxAgeSeconds?: number;
  clockSkewSeconds?: number;
  labels?: DpopLabels;
}

export interface DpopValidationResult {
  valid: boolean;
  proof?: DpopProof;
  error?: string;
}

const defaultLabels: Required<DpopLabels> = { actx: CwtClaimKey.DPOP_ACTX, nonce: CwtClaimKey.DPOP_NONCE, ath: CwtClaimKey.DPOP_ATH };
const MAX_DPOP_PROOF_SIZE = 8192;

export async function generateDpopKeyPair(algorithm: CoseAlgorithm = CoseAlgorithm.ES256): Promise<CryptoKeyPair> {
  const params = COSE_ALG_PARAMS[algorithm];
  if (!params || params.isMac) throw new DpopError('DPoP requires an asymmetric algorithm');
  const keyAlgorithm = params.keyType === 'EC'
    ? { name: 'ECDSA', namedCurve: params.namedCurve! }
    : { name: 'RSA-PSS', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: params.hash };
  // WebCrypto applies the extractable flag to both members of a generated
  // pair in some browser implementations. Generate once to obtain an
  // exportable public key, then re-import the public key as extractable and
  // the private key as non-extractable.
  const generated = await crypto.subtle.generateKey(keyAlgorithm, true, ['sign', 'verify']);
  const publicJwk = await crypto.subtle.exportKey('jwk', generated.publicKey);
  const privateJwk = await crypto.subtle.exportKey('jwk', generated.privateKey);
  const publicKey = await crypto.subtle.importKey('jwk', publicJwk, params.keyType === 'EC'
    ? { name: 'ECDSA', namedCurve: params.namedCurve! }
    : { name: 'RSA-PSS', hash: params.hash }, true, ['verify']);
  const privateKey = await crypto.subtle.importKey('jwk', privateJwk, params.keyType === 'EC'
    ? { name: 'ECDSA', namedCurve: params.namedCurve! }
    : { name: 'RSA-PSS', hash: params.hash }, false, ['sign']);
  return { publicKey, privateKey };
}

export async function createDpopProof(options: DpopProofOptions): Promise<Uint8Array> {
  const algorithm = options.algorithm ?? algorithmForKey(options.privateKey);
  const params = COSE_ALG_PARAMS[algorithm];
  if (!params || params.isMac) throw new DpopError('DPoP requires an asymmetric algorithm');
  const labels = { ...defaultLabels, ...options.labels };
  validateLabels(labels);
  const key = await coseKeyFromPublicKey(options.publicKey);
  const context = normalizeAuthorizationContext(options.authorizationContext);
  const cti = options.cti ? options.cti.slice() : randomBytes(16);
  const issuedAt = options.issuedAt ?? Math.floor(Date.now() / 1000);
  const additionalClaims = new Map<number, CborValue>();
  additionalClaims.set(labels.actx, context);
  if (options.nonce !== undefined) additionalClaims.set(labels.nonce, options.nonce);
  if (options.accessToken !== undefined) additionalClaims.set(labels.ath, await sha256(options.accessToken));
  const cwtClaims: CwtClaims = { cti, iat: issuedAt, additionalClaims };

  const protectedHeaders = new Map<number, CborValue>([
    [CoseHeaderParam.ALG, algorithm],
    [CoseHeaderParam.TYP, DPOP_PROOF_CWT_TYP],
    [CoseHeaderParam.KID, key],
  ]);
  const cose = await coseSign1Sign(algorithm, protectedHeaders, cwtClaimsEncode(cwtClaims), options.privateKey);
  // coseSign1Sign overwrites alg and cborEncode sorts the map deterministically.
  return coseSign1Encode(cose);
}

export function decodeDpopProof(data: Uint8Array, labels: DpopLabels = {}): DpopProof {
  if (!(data instanceof Uint8Array) || data.length > MAX_DPOP_PROOF_SIZE) throw new DpopError('DPoP proof exceeds maximum size');
  const cose = coseSign1Decode(data);
  const algorithm = coseSign1GetAlgorithm(cose);
  const params = COSE_ALG_PARAMS[algorithm];
  if (!params || params.isMac) throw new DpopError('DPoP proof algorithm must be asymmetric');
  const protectedHeader = coseSign1DecodeProtectedHeader(cose.protectedHeader);
  if (protectedHeader.get(CoseHeaderParam.TYP) !== DPOP_PROOF_CWT_TYP) throw new DpopError('Invalid DPoP proof type');
  const keyValue = protectedHeader.get(CoseHeaderParam.KID);
  if (!(keyValue instanceof Map)) throw new DpopError('DPoP proof is missing a COSE_Key');
  const claims = cwtClaimsDecode(cose.payload);
  const labelSet = { ...defaultLabels, ...labels };
  validateLabels(labelSet);
  const context = claims.additionalClaims?.get(labelSet.actx);
  if (context === undefined) throw new DpopError('DPoP proof is missing actx');
  if (!(claims.cti instanceof Uint8Array) || claims.cti.length === 0) throw new DpopError('DPoP proof is missing cti');
  if (claims.iat === undefined || !Number.isFinite(claims.iat)) throw new DpopError('DPoP proof is missing iat');
  return { cose, algorithm, key: keyValue as Map<number, CborValue>, claims, authorizationContext: context };
}

export async function validateDpopProof(data: Uint8Array, options: DpopValidationOptions = {}): Promise<DpopValidationResult> {
  let proof: DpopProof;
  try { proof = decodeDpopProof(data, options.labels); } catch { return { valid: false, error: 'DPoP proof decode failed' }; }
  try {
    const publicKey = await publicKeyFromCoseKey(proof.key, proof.algorithm);
    if (!(await coseSign1Verify(proof.cose, publicKey, proof.algorithm))) return { valid: false, error: 'DPoP signature invalid' };
    const labels = { ...defaultLabels, ...options.labels };
    validateLabels(labels);
    const now = options.now ?? Math.floor(Date.now() / 1000);
    const skew = options.clockSkewSeconds ?? 0;
    const maxAge = options.maxAgeSeconds ?? 300;
    if (!Number.isFinite(now) || !Number.isFinite(skew) || skew < 0 || !Number.isFinite(maxAge) || maxAge < 0) return { valid: false, error: 'DPoP validation options are invalid' };
    if (proof.claims.iat! > now + skew || proof.claims.iat! < now - maxAge - skew) return { valid: false, error: 'DPoP proof outside validity window' };
    if (options.expectedAuthorizationContext !== undefined && !constantTimeEqual(cborEncode(options.expectedAuthorizationContext), cborEncode(proof.authorizationContext))) return { valid: false, error: 'DPoP authorization context mismatch' };
    if (options.expectedContextType !== undefined && proof.authorizationContext instanceof Map && proof.authorizationContext.get(0) !== options.expectedContextType) return { valid: false, error: 'DPoP context type mismatch' };
    const nonce = proof.claims.additionalClaims?.get(labels.nonce);
    if (options.expectedNonce !== undefined && nonce !== options.expectedNonce) return { valid: false, error: 'DPoP nonce mismatch' };
    if (options.accessToken !== undefined) {
      const ath = proof.claims.additionalClaims?.get(labels.ath);
      const expected = await sha256(options.accessToken);
      if (!(ath instanceof Uint8Array) || !constantTimeEqual(ath, expected)) return { valid: false, error: 'DPoP access-token hash mismatch' };
    }
    if (options.expectedJkt !== undefined && !constantTimeEqual(options.expectedJkt, await jwkThumbprint(publicKey))) return { valid: false, error: 'DPoP JWK binding mismatch' };
    if (options.expectedCkt !== undefined && !constantTimeEqual(options.expectedCkt, await coseKeyThumbprint(publicKey))) return { valid: false, error: 'DPoP COSE-key binding mismatch' };
    return { valid: true, proof };
  } catch { return { valid: false, error: 'DPoP proof validation failed' }; }
}

/** Check a validated proof against CTA's cnf.jkt / RFC 9679 cnf.ckt binding. */
export async function validateCatDpopBinding(catClaims: CwtClaims, proof: DpopProof): Promise<boolean> {
  if (!(catClaims.cnf instanceof Map)) return false;
  const publicKey = await publicKeyFromCoseKey(proof.key, proof.algorithm);
  const jkt = catClaims.cnf.get(323);
  const ckt = catClaims.cnf.get(5);
  return (jkt instanceof Uint8Array && jkt.length === 32 && constantTimeEqual(jkt, await jwkThumbprint(publicKey))) ||
    (ckt instanceof Uint8Array && ckt.length === 32 && constantTimeEqual(ckt, await coseKeyThumbprint(publicKey)));
}

export async function coseKeyFromPublicKey(publicKey: CryptoKey): Promise<Map<number, CborValue>> { return coseKeyFromPublicKeyImpl(publicKey); }

async function coseKeyFromPublicKeyImpl(publicKey: CryptoKey): Promise<Map<number, CborValue>> {
  const jwk = await crypto.subtle.exportKey('jwk', publicKey);
  if (jwk.kty === 'EC' && jwk.crv && jwk.x && jwk.y) {
    const curve = jwk.crv === 'P-256' ? 1 : jwk.crv === 'P-384' ? 2 : jwk.crv === 'P-521' ? 3 : 0;
    if (!curve) throw new DpopError('Unsupported EC curve');
    const key = new Map<number, CborValue>();
    key.set(1, 2);
    key.set(-1, curve);
    key.set(-2, base64urlDecode(jwk.x));
    key.set(-3, base64urlDecode(jwk.y));
    return key;
  }
  if (jwk.kty === 'RSA' && jwk.n && jwk.e) {
    const key = new Map<number, CborValue>();
    key.set(1, 3);
    key.set(-1, base64urlDecode(jwk.n));
    key.set(-2, base64urlDecode(jwk.e));
    return key;
  }
  throw new DpopError('DPoP key must be an EC or RSA public key');
}

async function publicKeyFromCoseKey(key: Map<number, CborValue>, algorithm: CoseAlgorithm): Promise<CryptoKey> {
  const params = COSE_ALG_PARAMS[algorithm];
  if (!params || params.isMac) throw new DpopError('DPoP proof algorithm must be asymmetric');
  const kty = key.get(1);
  if (kty === 2) {
    if (params.keyType !== 'EC') throw new DpopError('DPoP algorithm does not match EC COSE_Key');
    const crv = key.get(-1); const x = key.get(-2); const y = key.get(-3);
    if (typeof crv !== 'number' || !(x instanceof Uint8Array) || !(y instanceof Uint8Array)) throw new DpopError('Malformed EC COSE_Key');
    const curve = crv === 1 ? 'P-256' : crv === 2 ? 'P-384' : crv === 3 ? 'P-521' : undefined;
    if (!curve) throw new DpopError('Unsupported EC COSE_Key curve');
    if (curve !== params.namedCurve) throw new DpopError('DPoP EC curve does not match algorithm');
    return crypto.subtle.importKey('jwk', { kty: 'EC', crv: curve, x: base64urlEncode(x), y: base64urlEncode(y), ext: true }, { name: 'ECDSA', namedCurve: curve }, true, ['verify']);
  }
  if (kty === 3) {
    if (params.keyType !== 'RSA' || algorithm !== CoseAlgorithm.PS256) throw new DpopError('DPoP algorithm does not match RSA COSE_Key');
    const n = key.get(-1); const e = key.get(-2);
    if (!(n instanceof Uint8Array) || !(e instanceof Uint8Array)) throw new DpopError('Malformed RSA COSE_Key');
    return crypto.subtle.importKey('jwk', { kty: 'RSA', n: base64urlEncode(n), e: base64urlEncode(e), alg: 'PS256', ext: true }, { name: 'RSA-PSS', hash: 'SHA-256' }, true, ['verify']);
  }
  throw new DpopError('Unsupported COSE_Key type');
}

export async function jwkThumbprint(publicKey: CryptoKey): Promise<Uint8Array> {
  const jwk = await crypto.subtle.exportKey('jwk', publicKey);
  let canonical: string;
  if (jwk.kty === 'EC' && jwk.crv && jwk.x && jwk.y) canonical = JSON.stringify({ crv: jwk.crv, kty: 'EC', x: jwk.x, y: jwk.y });
  else if (jwk.kty === 'RSA' && jwk.n && jwk.e) canonical = JSON.stringify({ e: jwk.e, kty: 'RSA', n: jwk.n });
  else throw new DpopError('Unsupported public key for JWK thumbprint');
  return sha256(new TextEncoder().encode(canonical));
}

export async function coseKeyThumbprint(publicKey: CryptoKey): Promise<Uint8Array> {
  const key = await coseKeyFromPublicKeyImpl(publicKey);
  return sha256(cborEncode(key));
}

async function sha256(value: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', toArrayBuffer(value)));
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

export function moqtAuthorizationContext(context: MoqtDpopContext): CborValue {
  if (!context.action || !Array.isArray(context.trackNamespace)) throw new DpopError('MOQT DPoP context requires action and trackNamespace');
  const map = new Map<number, CborValue>([[0, 'moqt'], [1, context.action], [2, serializeTrackNamespace(context.trackNamespace)]]);
  if (context.trackName !== undefined) map.set(3, serializeTrackName(context.trackName));
  if (context.parameters !== undefined) map.set(4, context.parameters);
  return map;
}

function normalizeAuthorizationContext(value: CborValue | MoqtDpopContext): CborValue { return isMoqtContext(value) ? moqtAuthorizationContext(value) : value; }
function isMoqtContext(value: CborValue | MoqtDpopContext): value is MoqtDpopContext { return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Map) && !(value instanceof Uint8Array) && 'action' in value && 'trackNamespace' in value; }
function serializeTrackNamespace(namespace: readonly (string | Uint8Array)[]): string { return namespace.map(serializeTrackName).join('-'); }
function serializeTrackName(value: string | Uint8Array): string {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  let result = '';
  for (const byte of bytes) {
    if (byte >= 0x30 && byte <= 0x39 || byte >= 0x41 && byte <= 0x5a || byte >= 0x61 && byte <= 0x7a || byte === 0x5f || byte === 0x7e) result += String.fromCharCode(byte);
    else result += `.${byte.toString(16).padStart(2, '0')}`;
  }
  return result;
}
function algorithmForKey(key: CryptoKey): CoseAlgorithm { const name = key.algorithm.name; if (name === 'ECDSA') { const curve = (key.algorithm as EcKeyAlgorithm).namedCurve; return curve === 'P-384' ? CoseAlgorithm.ES384 : curve === 'P-521' ? CoseAlgorithm.ES512 : CoseAlgorithm.ES256; } if (name === 'RSA-PSS') return CoseAlgorithm.PS256; throw new DpopError('Unsupported DPoP key'); }
function randomBytes(length: number): Uint8Array { const bytes = new Uint8Array(length); crypto.getRandomValues(bytes); return bytes; }
function base64urlEncode(bytes: Uint8Array): string { let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, ''); }
function base64urlDecode(value: string): Uint8Array { const base64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4); const binary = atob(base64); return Uint8Array.from(binary, char => char.charCodeAt(0)); }
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean { if (a.length !== b.length) return false; let difference = 0; for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i]; return difference === 0; }

function validateLabels(labels: Required<DpopLabels>): void {
  const values = [labels.actx, labels.nonce, labels.ath];
  if (values.some(label => !Number.isSafeInteger(label) || label < 0)) throw new DpopError('DPoP claim labels must be non-negative safe integers');
  if (new Set(values).size !== values.length) throw new DpopError('DPoP claim labels must be distinct');
}

export class DpopError extends Error { constructor(message: string) { super(message); this.name = 'DpopError'; } }
