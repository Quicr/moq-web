// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/** RFC 9052 COSE_Sign1 and COSE_Mac0 with WebCrypto-backed algorithms. */

import { cborEncode, cborDecodeExact, cborDecodeTagged } from './cbor.js';
import {
  CoseAlgorithm,
  CoseHeaderParam,
  COSE_ALG_PARAMS,
  type CoseSign1,
  type CborValue,
} from './types.js';

const COSE_MAC0_TAG = 17;
const COSE_SIGN1_TAG = 18;

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

function coseArray(message: CoseSign1): CborValue[] {
  return [message.protectedHeader, message.unprotectedHeader, message.payload, message.signature];
}

function decodeMessage(data: Uint8Array, expectedTag: number, name: string): CoseSign1 {
  const decoded = cborDecodeTagged(data);
  if (decoded.bytesRead !== data.length) throw new CoseError('Trailing bytes after COSE message');
  if (decoded.tag !== -1 && decoded.tag !== expectedTag) throw new CoseError(`Unexpected CBOR tag: ${decoded.tag}`);
  if (!Array.isArray(decoded.value) || decoded.value.length !== 4) throw new CoseError(`${name} must be a four-element array`);
  const [protectedHeader, unprotectedHeader, payload, signature] = decoded.value;
  if (!(protectedHeader instanceof Uint8Array)) throw new CoseError('COSE protected header must be a bstr');
  if (!(unprotectedHeader instanceof Map)) throw new CoseError('COSE unprotected header must be a map');
  for (const key of unprotectedHeader.keys()) {
    if (typeof key !== 'number' || !Number.isSafeInteger(key)) throw new CoseError('COSE header labels must be safe integer labels');
  }
  if (!(payload instanceof Uint8Array)) throw new CoseError('COSE payload must be a bstr');
  if (!(signature instanceof Uint8Array)) throw new CoseError('COSE signature/MAC must be a bstr');
  const message = { protectedHeader, unprotectedHeader: unprotectedHeader as Map<number, CborValue>, payload, signature };
  validateHeaders(message);
  return message;
}

function validateHeaders(message: CoseSign1): void {
  if (message.protectedHeader.length === 0) throw new CoseError('Protected header must be a bstr containing a CBOR map');
  const protectedMap = cborDecodeExact(message.protectedHeader);
  if (!(protectedMap instanceof Map)) throw new CoseError('Protected header must be a CBOR map');
  for (const key of message.unprotectedHeader.keys()) {
    if (protectedMap.has(key)) throw new CoseError(`COSE header parameter appears in both protected and unprotected headers: ${key}`);
  }
}

export function coseSign1Encode(sign1: CoseSign1): Uint8Array {
  validateHeaders(sign1);
  return wrapCose(COSE_SIGN1_TAG, sign1);
}

export function coseSign1Decode(data: Uint8Array): CoseSign1 {
  return decodeMessage(data, COSE_SIGN1_TAG, 'COSE_Sign1');
}

export function coseMac0Encode(mac0: CoseSign1): Uint8Array {
  validateHeaders(mac0);
  return wrapCose(COSE_MAC0_TAG, mac0);
}

export function coseMac0Decode(data: Uint8Array): CoseSign1 {
  return decodeMessage(data, COSE_MAC0_TAG, 'COSE_Mac0');
}

function wrapCose(tag: number, message: CoseSign1): Uint8Array {
  return cborEncode({ tag, value: coseArray(message) });
}

export function coseSign1SigStructure(protectedHeader: Uint8Array, payload: Uint8Array, externalAAD = new Uint8Array(0)): Uint8Array {
  return cborEncode(['Signature1', protectedHeader, externalAAD, payload]);
}

export function coseMac0MacStructure(protectedHeader: Uint8Array, payload: Uint8Array, externalAAD = new Uint8Array(0)): Uint8Array {
  return cborEncode(['MAC0', protectedHeader, externalAAD, payload]);
}

export async function coseSign1Sign(
  algorithm: CoseAlgorithm,
  protectedHeaders: Map<number, CborValue>,
  payload: Uint8Array,
  privateKey: CryptoKey,
  unprotectedHeaders?: Map<number, CborValue>,
): Promise<CoseSign1> {
  const params = algorithmParams(algorithm);
  if (params.isMac) throw new CoseError('HMAC uses COSE_Mac0, not COSE_Sign1');
  const message = await signMessage(algorithm, protectedHeaders, payload, privateKey, unprotectedHeaders, false);
  return message;
}

export async function coseMac0Sign(
  algorithm: CoseAlgorithm,
  protectedHeaders: Map<number, CborValue>,
  payload: Uint8Array,
  secretKey: CryptoKey,
  unprotectedHeaders?: Map<number, CborValue>,
): Promise<CoseSign1> {
  const params = algorithmParams(algorithm);
  if (!params.isMac) throw new CoseError('COSE_Mac0 requires a MAC algorithm');
  return signMessage(algorithm, protectedHeaders, payload, secretKey, unprotectedHeaders, true);
}

async function signMessage(
  algorithm: CoseAlgorithm,
  protectedHeaders: Map<number, CborValue>,
  payload: Uint8Array,
  key: CryptoKey,
  unprotectedHeaders: Map<number, CborValue> | undefined,
  isMac: boolean,
): Promise<CoseSign1> {
  const params = algorithmParams(algorithm);
  const headerMap = new Map<number, CborValue>(protectedHeaders);
  headerMap.set(CoseHeaderParam.ALG, algorithm);
  const protectedHeader = cborEncode(headerMap);
  const unprotectedHeader = unprotectedHeaders ?? new Map<number, CborValue>();
  const message: CoseSign1 = { protectedHeader, unprotectedHeader, payload, signature: new Uint8Array(0) };
  validateHeaders(message);
  const input = isMac ? coseMac0MacStructure(protectedHeader, payload) : coseSign1SigStructure(protectedHeader, payload);
  const signature = await crypto.subtle.sign(cryptoAlgorithm(params), key, toArrayBuffer(input));
  const bytes = new Uint8Array(signature);
  if (params.sigLength > 0 && bytes.length !== params.sigLength) throw new CoseError(`Unexpected signature length: ${bytes.length}`);
  message.signature = bytes;
  return message;
}

export async function coseSign1Verify(sign1: CoseSign1, publicKey: CryptoKey, requiredAlgorithm?: CoseAlgorithm): Promise<boolean> {
  const algorithm = coseSign1GetAlgorithm(sign1);
  const params = algorithmParams(algorithm);
  if (params.isMac || (requiredAlgorithm !== undefined && algorithm !== requiredAlgorithm)) return false;
  if (publicKey.type !== 'public') return false;
  if (!keyMatches(params, publicKey)) return false;
  return verifyMessage(sign1, publicKey, false, requiredAlgorithm);
}

export async function coseMac0Verify(mac0: CoseSign1, secretKey: CryptoKey, requiredAlgorithm?: CoseAlgorithm): Promise<boolean> {
  const algorithm = coseSign1GetAlgorithm(mac0);
  const params = algorithmParams(algorithm);
  if (!params.isMac || (requiredAlgorithm !== undefined && algorithm !== requiredAlgorithm)) return false;
  if (secretKey.type !== 'secret' || !keyMatches(params, secretKey)) return false;
  return verifyMessage(mac0, secretKey, true, requiredAlgorithm);
}

async function verifyMessage(message: CoseSign1, key: CryptoKey, isMac: boolean, requiredAlgorithm?: CoseAlgorithm): Promise<boolean> {
  try {
    validateHeaders(message);
    const algorithm = coseSign1GetAlgorithm(message);
    const params = algorithmParams(algorithm);
    if (requiredAlgorithm !== undefined && algorithm !== requiredAlgorithm) return false;
    if (params.sigLength > 0 && message.signature.length !== params.sigLength) return false;
    const input = isMac ? coseMac0MacStructure(message.protectedHeader, message.payload) : coseSign1SigStructure(message.protectedHeader, message.payload);
    return await crypto.subtle.verify(cryptoAlgorithm(params), key, toArrayBuffer(message.signature), toArrayBuffer(input));
  } catch (error) {
    if (error instanceof DOMException || error instanceof CoseError) return false;
    throw error;
  }
}

function cryptoAlgorithm(params: Readonly<(typeof COSE_ALG_PARAMS)[CoseAlgorithm]>): AlgorithmIdentifier | RsaPssParams | EcKeyImportParams {
  if (params.keyType === 'MAC') return { name: params.name };
  if (params.keyType === 'RSA') return { name: params.name, hash: params.hash, saltLength: params.saltLength! } as RsaPssParams;
  return { name: params.name, hash: params.hash } as EcdsaParams;
}

function keyMatches(params: Readonly<(typeof COSE_ALG_PARAMS)[CoseAlgorithm]>, key: CryptoKey): boolean {
  const algorithm = key.algorithm as EcKeyAlgorithm & RsaHashedKeyAlgorithm;
  if (params.keyType === 'EC') return algorithm.name === 'ECDSA' && algorithm.namedCurve === params.namedCurve;
  if (params.keyType === 'RSA') return algorithm.name === 'RSA-PSS';
  return algorithm.name === 'HMAC';
}

function algorithmParams(algorithm: CoseAlgorithm) {
  const params = COSE_ALG_PARAMS[algorithm];
  if (!params) throw new CoseError(`Unsupported COSE algorithm: ${algorithm}`);
  return params;
}

export function coseSign1GetAlgorithm(sign1: CoseSign1): CoseAlgorithm {
  const header = coseSign1DecodeProtectedHeader(sign1.protectedHeader);
  const value = header.get(CoseHeaderParam.ALG);
  if (typeof value !== 'number' && typeof value !== 'bigint') throw new CoseError('Algorithm missing from protected header');
  const algorithm = Number(value);
  if (!Number.isSafeInteger(algorithm) || !(algorithm in COSE_ALG_PARAMS)) throw new CoseError(`Unsupported algorithm: ${algorithm}`);
  return algorithm as CoseAlgorithm;
}

export function coseSign1DecodeProtectedHeader(protectedHeader: Uint8Array): Map<number, CborValue> {
  if (protectedHeader.length === 0) throw new CoseError('Protected header must not be empty');
  const value = cborDecodeExact(protectedHeader);
  if (!(value instanceof Map)) throw new CoseError('Protected header must be a CBOR map');
  for (const key of value.keys()) if (typeof key !== 'number') throw new CoseError('COSE header labels must be integers');
  return value as Map<number, CborValue>;
}

export class CoseError extends Error {
  constructor(message: string) { super(message); this.name = 'CoseError'; }
}
