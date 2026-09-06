// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/** Algorithm-aware CAT verification-key resolution and import helpers. */

import { CatTokenDecoder } from './cat.js';
import { CoseAlgorithm, COSE_ALG_PARAMS, type CatToken } from './types.js';

export interface CatKeyResolver {
  resolve(kid: Uint8Array | undefined, algorithm: CoseAlgorithm): Promise<CryptoKey | undefined> | CryptoKey | undefined;
}

export async function resolveCatVerificationKey(token: CatToken | Uint8Array, resolver: CatKeyResolver): Promise<CryptoKey> {
  const decoded = token instanceof Uint8Array ? CatTokenDecoder.decode(token) : token;
  const kidValue = decoded.header.get(4);
  if (kidValue !== undefined && !(kidValue instanceof Uint8Array)) throw new KeyManagementError('CAT kid must be a byte string');
  const key = await resolver.resolve(kidValue, decoded.algorithm);
  if (!key || !isCompatibleKey(key, decoded.algorithm)) throw new KeyManagementError('No compatible CAT verification key');
  return key;
}

export function staticCatKeyResolver(keys: ReadonlyMap<string, CryptoKey> | Readonly<Record<string, CryptoKey>>, fallback?: CryptoKey): CatKeyResolver {
  return {
    resolve(kid, _algorithm) {
      if (kid === undefined) return fallback;
      const id = base64urlEncode(kid);
      return keys instanceof Map ? keys.get(id) : (keys as Readonly<Record<string, CryptoKey>>)[id];
    },
  };
}

export async function importCatJwk(jwk: JsonWebKey, algorithm: CoseAlgorithm, extractable = false): Promise<CryptoKey> {
  const params = COSE_ALG_PARAMS[algorithm];
  if (!params) throw new KeyManagementError('Unsupported CAT algorithm');
  if (params.keyType === 'EC') {
    if (jwk.kty !== 'EC' || jwk.crv !== params.namedCurve) throw new KeyManagementError('JWK does not match CAT EC algorithm');
    return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: params.namedCurve! }, extractable, ['verify']);
  }
  if (params.keyType === 'RSA') {
    if (jwk.kty !== 'RSA') throw new KeyManagementError('JWK does not match CAT RSA algorithm');
    return crypto.subtle.importKey('jwk', jwk, { name: 'RSA-PSS', hash: params.hash }, extractable, ['verify']);
  }
  if (jwk.kty !== 'oct') throw new KeyManagementError('JWK does not contain an HMAC key');
  return crypto.subtle.importKey('jwk', jwk, { name: 'HMAC', hash: params.hash }, extractable, ['verify']);
}

export function isCompatibleKey(key: CryptoKey, algorithm: CoseAlgorithm): boolean {
  const params = COSE_ALG_PARAMS[algorithm];
  if (!params) return false;
  if (params.keyType === 'EC') return key.type === 'public' && key.algorithm.name === 'ECDSA' && (key.algorithm as EcKeyAlgorithm).namedCurve === params.namedCurve;
  if (params.keyType === 'RSA') return key.type === 'public' && key.algorithm.name === 'RSA-PSS';
  return key.type === 'secret' && key.algorithm.name === 'HMAC';
}

function base64urlEncode(data: Uint8Array): string {
  let binary = '';
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

export class KeyManagementError extends Error { constructor(message: string) { super(message); this.name = 'KeyManagementError'; } }
