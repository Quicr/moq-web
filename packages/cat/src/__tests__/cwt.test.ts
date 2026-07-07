// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { describe, it, expect } from 'vitest';
import {
  cwtClaimsEncode,
  cwtClaimsDecode,
  cwtClaimsFromMap,
  moqtScopesEncode,
  moqtScopesDecode,
  cwtIsExpired,
  cwtIsNotYetValid,
  cwtMatchesAudience,
  cborEncode,
  cborDecode,
  CwtClaimKey,
  MoqtAction,
  CwtError,
} from '../index.js';
import type { CwtClaims, MoqtScope, CborValue } from '../index.js';

describe('CWT Claims', () => {
  describe('encode/decode', () => {
    it('round-trips all standard claims', () => {
      const now = Math.floor(Date.now() / 1000);
      const claims: CwtClaims = {
        iss: 'https://auth.example.com',
        sub: 'user-123',
        aud: 'moq-relay',
        exp: now + 3600,
        nbf: now,
        iat: now,
        cti: new Uint8Array([0x01, 0x02, 0x03, 0x04]),
      };

      const encoded = cwtClaimsEncode(claims);
      const decoded = cwtClaimsDecode(encoded);

      expect(decoded.iss).toBe(claims.iss);
      expect(decoded.sub).toBe(claims.sub);
      expect(decoded.aud).toBe(claims.aud);
      expect(decoded.exp).toBe(claims.exp);
      expect(decoded.nbf).toBe(claims.nbf);
      expect(decoded.iat).toBe(claims.iat);
      expect(decoded.cti).toEqual(claims.cti);
    });

    it('handles audience as array', () => {
      const claims: CwtClaims = {
        aud: ['relay-1', 'relay-2'],
      };
      const encoded = cwtClaimsEncode(claims);
      const decoded = cwtClaimsDecode(encoded);
      expect(decoded.aud).toEqual(['relay-1', 'relay-2']);
    });

    it('handles minimal claims (just iss)', () => {
      const claims: CwtClaims = { iss: 'test' };
      const encoded = cwtClaimsEncode(claims);
      const decoded = cwtClaimsDecode(encoded);
      expect(decoded.iss).toBe('test');
      expect(decoded.sub).toBeUndefined();
      expect(decoded.exp).toBeUndefined();
    });

    it('handles empty claims', () => {
      const claims: CwtClaims = {};
      const encoded = cwtClaimsEncode(claims);
      const decoded = cwtClaimsDecode(encoded);
      expect(decoded.iss).toBeUndefined();
    });

    it('uses integer keys (not string keys)', () => {
      const claims: CwtClaims = { iss: 'test', exp: 12345 };
      const encoded = cwtClaimsEncode(claims);
      const { value } = cborDecode(encoded);
      const map = value as Map<number, CborValue>;
      // Keys should be integers, not strings
      expect(map.has(CwtClaimKey.ISS)).toBe(true);
      expect(map.has(CwtClaimKey.EXP)).toBe(true);
      expect(map.get(CwtClaimKey.ISS)).toBe('test');
    });

    it('preserves additional claims', () => {
      const claims: CwtClaims = {
        iss: 'test',
        additionalClaims: new Map<number, CborValue>([
          [99, 'custom-value'],
          [100, 42],
        ]),
      };
      const encoded = cwtClaimsEncode(claims);
      const decoded = cwtClaimsDecode(encoded);
      expect(decoded.iss).toBe('test');
      expect(decoded.additionalClaims?.get(99)).toBe('custom-value');
      expect(decoded.additionalClaims?.get(100)).toBe(42);
    });

    it('throws on non-map CBOR data', () => {
      const notMap = cborEncode([1, 2, 3]);
      expect(() => cwtClaimsDecode(notMap)).toThrow(CwtError);
    });
  });

  describe('cwtClaimsFromMap', () => {
    it('converts a decoded CBOR map to claims', () => {
      const map = new Map<number, CborValue>([
        [1, 'issuer'],
        [2, 'subject'],
        [4, 9999999],
      ]);
      const claims = cwtClaimsFromMap(map);
      expect(claims.iss).toBe('issuer');
      expect(claims.sub).toBe('subject');
      expect(claims.exp).toBe(9999999);
    });

    it('handles legacy MOQT claim key 65000', () => {
      const scopes: CborValue[] = [
        [[0, 4], ['room', 'test']],
      ];
      const map = new Map<number, CborValue>([
        [65000, scopes],
      ]);
      const claims = cwtClaimsFromMap(map);
      expect(claims.moqt).toBeDefined();
      expect(claims.moqt!.length).toBe(1);
      expect(claims.moqt![0].actions).toContain(MoqtAction.ClientSetup);
      expect(claims.moqt![0].actions).toContain(MoqtAction.Subscribe);
    });
  });
});

describe('MoQT Scopes', () => {
  describe('encode/decode', () => {
    it('encodes/decodes simple scopes', () => {
      const scopes: MoqtScope[] = [{
        actions: [MoqtAction.Subscribe, MoqtAction.Publish],
      }];
      const encoded = moqtScopesEncode(scopes);
      const decoded = moqtScopesDecode(encoded);
      expect(decoded.length).toBe(1);
      expect(decoded[0].actions).toContain(MoqtAction.Subscribe);
      expect(decoded[0].actions).toContain(MoqtAction.Publish);
    });

    it('encodes/decodes scopes with namespace match', () => {
      const scopes: MoqtScope[] = [{
        actions: [MoqtAction.Subscribe],
        namespaceMatch: ['mocha', 'room-123'],
      }];
      const encoded = moqtScopesEncode(scopes);
      const decoded = moqtScopesDecode(encoded);
      expect(decoded[0].namespaceMatch).toEqual(['mocha', 'room-123']);
    });

    it('encodes/decodes scopes with namespace and track match', () => {
      const scopes: MoqtScope[] = [{
        actions: [MoqtAction.Subscribe],
        namespaceMatch: ['mocha', 'room-1'],
        trackMatch: 'video',
      }];
      const encoded = moqtScopesEncode(scopes);
      const decoded = moqtScopesDecode(encoded);
      expect(decoded[0].trackMatch).toBe('video');
    });

    it('encodes/decodes multiple scopes', () => {
      const scopes: MoqtScope[] = [
        {
          actions: [MoqtAction.Publish, MoqtAction.PublishNamespace],
          namespaceMatch: ['room', 'abc'],
        },
        {
          actions: [MoqtAction.Subscribe, MoqtAction.SubscribeNamespace],
          namespaceMatch: ['room', 'abc'],
        },
      ];
      const encoded = moqtScopesEncode(scopes);
      const decoded = moqtScopesDecode(encoded);
      expect(decoded.length).toBe(2);
      expect(decoded[0].actions).toContain(MoqtAction.Publish);
      expect(decoded[1].actions).toContain(MoqtAction.Subscribe);
    });

    it('handles all action types', () => {
      const allActions = [
        MoqtAction.ClientSetup, MoqtAction.ServerSetup,
        MoqtAction.PublishNamespace, MoqtAction.SubscribeNamespace,
        MoqtAction.Subscribe, MoqtAction.RequestUpdate,
        MoqtAction.Publish, MoqtAction.Fetch, MoqtAction.TrackStatus,
      ];
      const scopes: MoqtScope[] = [{ actions: allActions }];
      const encoded = moqtScopesEncode(scopes);
      const decoded = moqtScopesDecode(encoded);
      expect(decoded[0].actions).toEqual(allActions);
    });

    it('round-trips scopes through CWT claims', () => {
      const scopes: MoqtScope[] = [{
        actions: [MoqtAction.Subscribe, MoqtAction.Publish],
        namespaceMatch: ['conference', 'room-1'],
      }];
      const claims: CwtClaims = {
        iss: 'test',
        moqt: scopes,
      };
      const encoded = cwtClaimsEncode(claims);
      const decoded = cwtClaimsDecode(encoded);
      expect(decoded.moqt).toBeDefined();
      expect(decoded.moqt!.length).toBe(1);
      expect(decoded.moqt![0].actions).toContain(MoqtAction.Subscribe);
      expect(decoded.moqt![0].namespaceMatch).toEqual(['conference', 'room-1']);
    });
  });

  describe('handles invalid scope data gracefully', () => {
    it('returns empty for non-array scopes', () => {
      const result = moqtScopesDecode([42 as unknown as CborValue]);
      expect(result.length).toBe(0);
    });

    it('skips scopes with non-array actions', () => {
      const result = moqtScopesDecode([['not-an-array-of-nums']]);
      expect(result.length).toBe(0);
    });

    it('filters out invalid action numbers', () => {
      const result = moqtScopesDecode([[[0, 99, 4]]]);
      expect(result.length).toBe(1);
      expect(result[0].actions).toEqual([MoqtAction.ClientSetup, MoqtAction.Subscribe]);
    });
  });
});

describe('CWT Validation Helpers', () => {
  describe('cwtIsExpired', () => {
    it('returns false when not expired', () => {
      const claims: CwtClaims = { exp: Math.floor(Date.now() / 1000) + 3600 };
      expect(cwtIsExpired(claims)).toBe(false);
    });

    it('returns true when expired', () => {
      const claims: CwtClaims = { exp: Math.floor(Date.now() / 1000) - 3600 };
      expect(cwtIsExpired(claims)).toBe(true);
    });

    it('returns false when no exp claim', () => {
      const claims: CwtClaims = {};
      expect(cwtIsExpired(claims)).toBe(false);
    });

    it('respects clock skew', () => {
      const now = 1000000;
      // Token expired 30 seconds ago, but clock skew is 60
      const claims: CwtClaims = { exp: now - 30 };
      expect(cwtIsExpired(claims, now, 60)).toBe(false);
      // Token expired 90 seconds ago, clock skew is 60
      const claims2: CwtClaims = { exp: now - 90 };
      expect(cwtIsExpired(claims2, now, 60)).toBe(true);
    });

    it('uses explicit now parameter', () => {
      const claims: CwtClaims = { exp: 500 };
      expect(cwtIsExpired(claims, 400)).toBe(false);
      expect(cwtIsExpired(claims, 600)).toBe(true);
    });
  });

  describe('cwtIsNotYetValid', () => {
    it('returns false when valid', () => {
      const claims: CwtClaims = { nbf: Math.floor(Date.now() / 1000) - 60 };
      expect(cwtIsNotYetValid(claims)).toBe(false);
    });

    it('returns true when not yet valid', () => {
      const claims: CwtClaims = { nbf: Math.floor(Date.now() / 1000) + 3600 };
      expect(cwtIsNotYetValid(claims)).toBe(true);
    });

    it('returns false when no nbf claim', () => {
      expect(cwtIsNotYetValid({})).toBe(false);
    });

    it('respects clock skew', () => {
      const now = 1000000;
      // Token valid in 30 seconds, clock skew is 60
      const claims: CwtClaims = { nbf: now + 30 };
      expect(cwtIsNotYetValid(claims, now, 60)).toBe(false);
    });
  });

  describe('cwtMatchesAudience', () => {
    it('matches single audience string', () => {
      const claims: CwtClaims = { aud: 'moq-relay' };
      expect(cwtMatchesAudience(claims, 'moq-relay')).toBe(true);
      expect(cwtMatchesAudience(claims, 'other')).toBe(false);
    });

    it('matches audience array', () => {
      const claims: CwtClaims = { aud: ['relay-1', 'relay-2'] };
      expect(cwtMatchesAudience(claims, 'relay-1')).toBe(true);
      expect(cwtMatchesAudience(claims, 'relay-2')).toBe(true);
      expect(cwtMatchesAudience(claims, 'relay-3')).toBe(false);
    });

    it('returns false when no aud claim', () => {
      expect(cwtMatchesAudience({}, 'moq-relay')).toBe(false);
    });
  });
});
