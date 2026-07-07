// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { describe, it, expect, beforeAll } from 'vitest';
import {
  coseSign1Encode,
  coseSign1Decode,
  coseSign1Sign,
  coseSign1Verify,
  coseSign1SigStructure,
  coseSign1GetAlgorithm,
  coseSign1DecodeProtectedHeader,
  cborEncode,
  cborDecode,
  CoseAlgorithm,
  CoseHeaderParam,
  COSE_ALG_PARAMS,
  CoseError,
} from '../index.js';
import type { CborValue, CoseSign1 } from '../index.js';

describe('COSE_Sign1', () => {
  let es256KeyPair: CryptoKeyPair;
  let es384KeyPair: CryptoKeyPair;

  beforeAll(async () => {
    es256KeyPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    );
    es384KeyPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-384' },
      true,
      ['sign', 'verify'],
    );
  });

  describe('encode/decode', () => {
    it('round-trips a COSE_Sign1 structure', () => {
      const headerMap = new Map<number, CborValue>([[CoseHeaderParam.ALG, CoseAlgorithm.ES256]]);
      const protectedHeader = cborEncode(headerMap);

      const sign1: CoseSign1 = {
        protectedHeader,
        unprotectedHeader: new Map(),
        payload: new Uint8Array([1, 2, 3]),
        signature: new Uint8Array(64),
      };

      const encoded = coseSign1Encode(sign1);
      const decoded = coseSign1Decode(encoded);

      expect(decoded.protectedHeader).toEqual(sign1.protectedHeader);
      expect(decoded.payload).toEqual(sign1.payload);
      expect(decoded.signature).toEqual(sign1.signature);
      expect(decoded.unprotectedHeader.size).toBe(0);
    });

    it('encodes as bare array (no CBOR Tag 18)', () => {
      const sign1: CoseSign1 = {
        protectedHeader: new Uint8Array([0xa0]),
        unprotectedHeader: new Map(),
        payload: new Uint8Array(0),
        signature: new Uint8Array(64),
      };
      const encoded = coseSign1Encode(sign1);
      // First byte should be 0x84 (4-element array), NOT 0xd2 (tag 18)
      expect(encoded[0]).toBe(0x84);
    });

    it('decodes tagged COSE_Sign1 (Tag 18)', () => {
      const sign1: CoseSign1 = {
        protectedHeader: new Uint8Array([0xa0]),
        unprotectedHeader: new Map(),
        payload: new Uint8Array([1]),
        signature: new Uint8Array(64),
      };
      const bareArray = coseSign1Encode(sign1);

      // Manually wrap with Tag 18: 0xd2 prefix
      const tagged = new Uint8Array(1 + bareArray.length);
      tagged[0] = 0xd2; // CBOR tag(18) in 1 byte
      tagged.set(bareArray, 1);

      const decoded = coseSign1Decode(tagged);
      expect(decoded.payload).toEqual(new Uint8Array([1]));
    });

    it('throws on wrong tag number', () => {
      const sign1: CoseSign1 = {
        protectedHeader: new Uint8Array([0xa0]),
        unprotectedHeader: new Map(),
        payload: new Uint8Array(0),
        signature: new Uint8Array(64),
      };
      const bareArray = coseSign1Encode(sign1);

      // Tag 99 instead of 18
      const wrongTag = new Uint8Array(2 + bareArray.length);
      wrongTag[0] = 0xd8; // tag(next byte)
      wrongTag[1] = 99;
      wrongTag.set(bareArray, 2);

      expect(() => coseSign1Decode(wrongTag)).toThrow(CoseError);
    });

    it('throws on non-array input', () => {
      const notArray = cborEncode(42);
      expect(() => coseSign1Decode(notArray)).toThrow(CoseError);
    });

    it('throws on wrong array length', () => {
      const wrongLen = cborEncode([new Uint8Array(0), new Map(), new Uint8Array(0)]);
      expect(() => coseSign1Decode(wrongLen)).toThrow(CoseError);
    });

    it('throws if protected header is not bstr', () => {
      const bad = cborEncode(['not-bstr', new Map(), new Uint8Array(0), new Uint8Array(0)]);
      expect(() => coseSign1Decode(bad)).toThrow(CoseError);
    });
  });

  describe('Sig_structure', () => {
    it('produces correct Sig_structure format', () => {
      const protectedHeader = new Uint8Array([0xa1, 0x01, 0x26]); // {1: -7}
      const payload = new Uint8Array([1, 2, 3]);
      const sigStructure = coseSign1SigStructure(protectedHeader, payload);

      const { value } = cborDecode(sigStructure);
      expect(Array.isArray(value)).toBe(true);
      const arr = value as CborValue[];
      expect(arr.length).toBe(4);
      expect(arr[0]).toBe('Signature1');
      expect(arr[1]).toEqual(protectedHeader);
      expect((arr[2] as Uint8Array).length).toBe(0); // empty external AAD
      expect(arr[3]).toEqual(payload);
    });

    it('includes external AAD when provided', () => {
      const protectedHeader = new Uint8Array([0xa0]);
      const payload = new Uint8Array([1]);
      const externalAAD = new Uint8Array([0xaa, 0xbb]);
      const sigStructure = coseSign1SigStructure(protectedHeader, payload, externalAAD);

      const { value } = cborDecode(sigStructure);
      const arr = value as CborValue[];
      expect(arr[2]).toEqual(externalAAD);
    });
  });

  describe('sign and verify', () => {
    it('signs and verifies with ES256', async () => {
      const headers = new Map<number, CborValue>();
      const payload = cborEncode(new Map<number, CborValue>([
        [1, 'test-issuer'],
        [2, 'test-subject'],
      ]));

      const sign1 = await coseSign1Sign(
        CoseAlgorithm.ES256,
        headers,
        payload,
        es256KeyPair.privateKey,
      );

      expect(sign1.signature.length).toBe(64); // ES256 = 64 bytes
      expect(await coseSign1Verify(sign1, es256KeyPair.publicKey)).toBe(true);
    });

    it('signs and verifies with ES384', async () => {
      const headers = new Map<number, CborValue>();
      const payload = new Uint8Array([1, 2, 3]);

      const sign1 = await coseSign1Sign(
        CoseAlgorithm.ES384,
        headers,
        payload,
        es384KeyPair.privateKey,
      );

      expect(sign1.signature.length).toBe(96); // ES384 = 96 bytes
      expect(await coseSign1Verify(sign1, es384KeyPair.publicKey)).toBe(true);
    });

    it('sets algorithm in protected header automatically', async () => {
      const headers = new Map<number, CborValue>();
      const payload = new Uint8Array([1]);

      const sign1 = await coseSign1Sign(
        CoseAlgorithm.ES256,
        headers,
        payload,
        es256KeyPair.privateKey,
      );

      const alg = coseSign1GetAlgorithm(sign1);
      expect(alg).toBe(CoseAlgorithm.ES256);
    });

    it('preserves custom protected headers', async () => {
      const headers = new Map<number, CborValue>([
        [CoseHeaderParam.KID, new Uint8Array([0x01, 0x02])],
      ]);
      const payload = new Uint8Array([1]);

      const sign1 = await coseSign1Sign(
        CoseAlgorithm.ES256,
        headers,
        payload,
        es256KeyPair.privateKey,
      );

      const decoded = coseSign1DecodeProtectedHeader(sign1.protectedHeader);
      expect(decoded.get(CoseHeaderParam.KID)).toEqual(new Uint8Array([0x01, 0x02]));
      expect(decoded.get(CoseHeaderParam.ALG)).toBe(CoseAlgorithm.ES256);
    });

    it('fails verification with wrong key', async () => {
      const otherKeyPair = await crypto.subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' },
        true,
        ['sign', 'verify'],
      );

      const headers = new Map<number, CborValue>();
      const payload = new Uint8Array([1, 2, 3]);

      const sign1 = await coseSign1Sign(
        CoseAlgorithm.ES256,
        headers,
        payload,
        es256KeyPair.privateKey,
      );

      expect(await coseSign1Verify(sign1, otherKeyPair.publicKey)).toBe(false);
    });

    it('fails verification with tampered payload', async () => {
      const headers = new Map<number, CborValue>();
      const payload = new Uint8Array([1, 2, 3]);

      const sign1 = await coseSign1Sign(
        CoseAlgorithm.ES256,
        headers,
        payload,
        es256KeyPair.privateKey,
      );

      // Tamper with payload
      const tampered: CoseSign1 = {
        ...sign1,
        payload: new Uint8Array([4, 5, 6]),
      };

      expect(await coseSign1Verify(tampered, es256KeyPair.publicKey)).toBe(false);
    });

    it('fails verification with corrupted signature', async () => {
      const headers = new Map<number, CborValue>();
      const payload = new Uint8Array([1, 2, 3]);

      const sign1 = await coseSign1Sign(
        CoseAlgorithm.ES256,
        headers,
        payload,
        es256KeyPair.privateKey,
      );

      // Corrupt signature
      const corrupted: CoseSign1 = {
        ...sign1,
        signature: new Uint8Array(64),
      };

      expect(await coseSign1Verify(corrupted, es256KeyPair.publicKey)).toBe(false);
    });

    it('fails verification with wrong signature length', async () => {
      const headers = new Map<number, CborValue>();
      const payload = new Uint8Array([1]);

      const sign1 = await coseSign1Sign(
        CoseAlgorithm.ES256,
        headers,
        payload,
        es256KeyPair.privateKey,
      );

      // Wrong signature length
      const wrongLen: CoseSign1 = {
        ...sign1,
        signature: new Uint8Array(32), // should be 64
      };

      expect(await coseSign1Verify(wrongLen, es256KeyPair.publicKey)).toBe(false);
    });
  });

  describe('encode/decode/sign round-trip', () => {
    it('full round-trip: sign -> encode -> decode -> verify', async () => {
      const headers = new Map<number, CborValue>([
        [CoseHeaderParam.KID, new Uint8Array([0xab, 0xcd])],
      ]);
      const payload = cborEncode(new Map<number, CborValue>([
        [1, 'https://auth.example.com'],
        [4, Math.floor(Date.now() / 1000) + 3600],
      ]));

      // Sign
      const sign1 = await coseSign1Sign(
        CoseAlgorithm.ES256,
        headers,
        payload,
        es256KeyPair.privateKey,
      );

      // Encode to bytes
      const encoded = coseSign1Encode(sign1);

      // Decode from bytes
      const decoded = coseSign1Decode(encoded);

      // Verify
      expect(await coseSign1Verify(decoded, es256KeyPair.publicKey)).toBe(true);

      // Check payload survived
      const claims = cborDecode(decoded.payload);
      expect((claims.value as Map<number, CborValue>).get(1)).toBe('https://auth.example.com');
    });
  });

  describe('algorithm extraction', () => {
    it('extracts ES256 algorithm', () => {
      const headerMap = new Map<number, CborValue>([[CoseHeaderParam.ALG, CoseAlgorithm.ES256]]);
      const protectedHeader = cborEncode(headerMap);
      const sign1: CoseSign1 = {
        protectedHeader,
        unprotectedHeader: new Map(),
        payload: new Uint8Array(0),
        signature: new Uint8Array(64),
      };
      expect(coseSign1GetAlgorithm(sign1)).toBe(CoseAlgorithm.ES256);
    });

    it('throws on empty protected header', () => {
      const sign1: CoseSign1 = {
        protectedHeader: new Uint8Array(0),
        unprotectedHeader: new Map(),
        payload: new Uint8Array(0),
        signature: new Uint8Array(0),
      };
      expect(() => coseSign1GetAlgorithm(sign1)).toThrow(CoseError);
    });

    it('throws on missing algorithm', () => {
      const headerMap = new Map<number, CborValue>([[CoseHeaderParam.KID, new Uint8Array([1])]]);
      const protectedHeader = cborEncode(headerMap);
      const sign1: CoseSign1 = {
        protectedHeader,
        unprotectedHeader: new Map(),
        payload: new Uint8Array(0),
        signature: new Uint8Array(0),
      };
      expect(() => coseSign1GetAlgorithm(sign1)).toThrow(CoseError);
    });
  });
});
