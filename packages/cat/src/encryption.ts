// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/** AES-GCM COSE_Encrypt0 support for encrypted CWT claim payloads. */

import { cborDecodeExact, cborDecodeTagged, cborEncode } from './cbor.js';
import { cwtClaimsDecode, cwtClaimsEncode } from './cwt.js';
import { CoseHeaderParam, type CborValue, type CoseEncrypt0, type CwtClaims } from './types.js';

export const COSE_ENCRYPT0_TAG = 16;
export const COSE_AES_GCM_ALGORITHMS = Object.freeze({ A128GCM: 1, A192GCM: 2, A256GCM: 3 });

export interface CoseEncrypt0Options {
  algorithm?: 1 | 2 | 3;
  iv?: Uint8Array;
  externalAAD?: Uint8Array;
}

export function coseEncrypt0Encode(message: CoseEncrypt0): Uint8Array {
  validateMessage(message);
  return cborEncode({ tag: COSE_ENCRYPT0_TAG, value: [message.protectedHeader, message.unprotectedHeader, message.ciphertext] });
}

export function coseEncrypt0Decode(data: Uint8Array): CoseEncrypt0 {
  const decoded = cborDecodeTagged(data);
  if (decoded.bytesRead !== data.length || decoded.tag !== COSE_ENCRYPT0_TAG) throw new EncryptionError('Invalid COSE_Encrypt0 encoding');
  if (!Array.isArray(decoded.value) || decoded.value.length !== 3) throw new EncryptionError('COSE_Encrypt0 must be a three-element array');
  const [protectedHeader, unprotectedHeader, ciphertext] = decoded.value;
  if (!(protectedHeader instanceof Uint8Array) || !(unprotectedHeader instanceof Map) || !(ciphertext instanceof Uint8Array)) throw new EncryptionError('Malformed COSE_Encrypt0');
  const message = { protectedHeader, unprotectedHeader: unprotectedHeader as Map<number, CborValue>, ciphertext };
  validateMessage(message);
  return message;
}

export async function coseEncrypt0Encrypt(plaintext: Uint8Array, key: CryptoKey, options: CoseEncrypt0Options = {}): Promise<Uint8Array> {
  if (!(plaintext instanceof Uint8Array)) throw new EncryptionError('Plaintext must be bytes');
  const algorithm = options.algorithm ?? 3;
  validateAesKey(key, algorithm);
  const iv = options.iv?.slice() ?? randomBytes(12);
  if (iv.length !== 12) throw new EncryptionError('AES-GCM IV must be 12 bytes');
  const protectedHeader = cborEncode(new Map<number, CborValue>([[CoseHeaderParam.ALG, algorithm]]));
  const unprotectedHeader = new Map<number, CborValue>([[CoseHeaderParam.IV, iv]]);
  const aad = encrypt0Structure(protectedHeader, options.externalAAD ?? new Uint8Array(0));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: toArrayBuffer(iv), additionalData: toArrayBuffer(aad), tagLength: 128 }, key, toArrayBuffer(plaintext)));
  return coseEncrypt0Encode({ protectedHeader, unprotectedHeader, ciphertext });
}

export async function coseEncrypt0Decrypt(data: Uint8Array, key: CryptoKey, externalAAD = new Uint8Array(0)): Promise<Uint8Array> {
  const message = coseEncrypt0Decode(data);
  const header = decodeProtectedHeader(message.protectedHeader);
  const algorithm = header.get(CoseHeaderParam.ALG);
  if (algorithm !== 1 && algorithm !== 2 && algorithm !== 3) throw new EncryptionError('Unsupported AES-GCM algorithm');
  validateAesKey(key, algorithm);
  const iv = message.unprotectedHeader.get(CoseHeaderParam.IV);
  if (!(iv instanceof Uint8Array) || iv.length !== 12) throw new EncryptionError('Missing or invalid AES-GCM IV');
  try {
    const aad = encrypt0Structure(message.protectedHeader, externalAAD);
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: toArrayBuffer(iv), additionalData: toArrayBuffer(aad), tagLength: 128 }, key, toArrayBuffer(message.ciphertext)));
  } catch { throw new EncryptionError('COSE_Encrypt0 authentication failed'); }
}

export async function encryptCwtClaims(claims: CwtClaims, key: CryptoKey, options: CoseEncrypt0Options = {}): Promise<Uint8Array> {
  return coseEncrypt0Encrypt(cwtClaimsEncode(claims), key, options);
}

export async function decryptCwtClaims(data: Uint8Array, key: CryptoKey, externalAAD = new Uint8Array(0)): Promise<CwtClaims> {
  return cwtClaimsDecode(await coseEncrypt0Decrypt(data, key, externalAAD));
}

export async function generateAesGcmKey(algorithm: 1 | 2 | 3 = 3, extractable = false): Promise<CryptoKey> {
  const length = algorithm === 1 ? 128 : algorithm === 2 ? 192 : 256;
  return crypto.subtle.generateKey({ name: 'AES-GCM', length }, extractable, ['encrypt', 'decrypt']);
}

function validateAesKey(key: CryptoKey, algorithm: number): asserts key is CryptoKey {
  if (algorithm !== 1 && algorithm !== 2 && algorithm !== 3 || key.type !== 'secret' || key.algorithm.name !== 'AES-GCM') {
    throw new EncryptionError('AES-GCM key and algorithm are required');
  }
  const actualLength = (key.algorithm as AesKeyAlgorithm).length;
  const expectedLength = algorithm === 1 ? 128 : algorithm === 2 ? 192 : 256;
  if (actualLength !== expectedLength) throw new EncryptionError('AES-GCM key length does not match algorithm');
}

function validateMessage(message: CoseEncrypt0): void {
  if (!(message.protectedHeader instanceof Uint8Array) || message.protectedHeader.length === 0 || !(message.unprotectedHeader instanceof Map) || !(message.ciphertext instanceof Uint8Array)) throw new EncryptionError('Malformed COSE_Encrypt0');
  const protectedHeader = decodeProtectedHeader(message.protectedHeader);
  const algorithm = protectedHeader.get(CoseHeaderParam.ALG);
  if (algorithm !== 1 && algorithm !== 2 && algorithm !== 3) throw new EncryptionError('COSE_Encrypt0 must contain a supported AES-GCM algorithm');
  for (const key of message.unprotectedHeader.keys()) if (typeof key !== 'number' || !Number.isSafeInteger(key)) throw new EncryptionError('COSE headers must use integer labels');
}

function decodeProtectedHeader(data: Uint8Array): Map<number, CborValue> {
  const value = cborDecodeExact(data);
  if (!(value instanceof Map) || [...value.keys()].some(key => typeof key !== 'number' || !Number.isSafeInteger(key))) throw new EncryptionError('Invalid protected header');
  return value as Map<number, CborValue>;
}

function encrypt0Structure(protectedHeader: Uint8Array, externalAAD: Uint8Array): Uint8Array { return cborEncode(['Encrypt0', protectedHeader, externalAAD]); }
function randomBytes(length: number): Uint8Array { const result = new Uint8Array(length); crypto.getRandomValues(result); return result; }
function toArrayBuffer(value: Uint8Array): ArrayBuffer { return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer; }

export class EncryptionError extends Error { constructor(message: string) { super(message); this.name = 'EncryptionError'; } }
