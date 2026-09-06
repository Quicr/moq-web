// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { describe, it, expect } from 'vitest';
import {
  CipherSuite as SoCipherSuite,
  PropertyType,
} from '@moq-web/secure-objects';
import {
  toSoCipherSuite,
  toMsfCipherSuite,
  CipherSuiteMappingError,
  isSecureObjectsTrack,
  createTrackContext,
  parseKeyIdToBigInt,
  TrackSecurityError,
  MsfSecurityGateway,
  ENCRYPTED_PROPERTIES_EXTENSION_ID,
  trackRequiresGateway,
} from './index.js';
import type { Track } from '../schemas/index.js';

function baseSecureTrack(overrides: Partial<Track> = {}): Track {
  return {
    name: 'video-1',
    packaging: 'loc',
    isLive: true,
    role: 'video',
    codec: 'avc1.4D401E',
    bitrate: 2_000_000,
    encryptionScheme: 'moq-secure-objects',
    cipherSuite: 'aes-128-gcm-sha256',
    keyId: 'AQID',
    namespace: ['conf', 'room-1'],
    ...overrides,
  } as Track;
}

describe('cipher-suite mapping (MSF §15 ↔ secure-objects enum)', () => {
  it('maps all three MSF Table 6 suites', () => {
    expect(toSoCipherSuite('aes-128-gcm-sha256')).toBe(
      SoCipherSuite.AES_128_GCM_SHA256_128
    );
    expect(toSoCipherSuite('aes-256-gcm-sha512')).toBe(
      SoCipherSuite.AES_256_GCM_SHA512_128
    );
    expect(toSoCipherSuite('aes-128-ctr-hmac-sha256-80')).toBe(
      SoCipherSuite.AES_128_CTR_HMAC_SHA256_80
    );
  });

  it('reverses cleanly for MSF-recognised suites', () => {
    expect(toMsfCipherSuite(SoCipherSuite.AES_128_GCM_SHA256_128)).toBe(
      'aes-128-gcm-sha256'
    );
  });

  it('rejects a secure-objects suite not in MSF Table 6', () => {
    expect(() =>
      toMsfCipherSuite(SoCipherSuite.AES_128_CTR_HMAC_SHA256_32)
    ).toThrow(CipherSuiteMappingError);
  });
});

describe('track predicate + keyId decoding', () => {
  it('recognises moq-secure-objects tracks', () => {
    expect(isSecureObjectsTrack(baseSecureTrack())).toBe(true);
    expect(trackRequiresGateway(baseSecureTrack())).toBe(true);
  });

  it('rejects plaintext tracks', () => {
    const plain = baseSecureTrack({ encryptionScheme: undefined });
    expect(isSecureObjectsTrack(plain)).toBe(false);
    expect(trackRequiresGateway(plain)).toBe(false);
  });

  it('decodes base64 keyId to bigint', () => {
    // Base64 'AQID' = bytes [1, 2, 3] → bigint 0x010203
    expect(parseKeyIdToBigInt('AQID')).toBe(0x010203n);
  });

  it('returns 0n for missing keyId', () => {
    expect(parseKeyIdToBigInt(undefined)).toBe(0n);
  });
});

describe('createTrackContext error cases', () => {
  const rawKey = new Uint8Array(16).fill(0x11);
  const keyResolver = () => rawKey;

  it('rejects non-secure-objects tracks', async () => {
    await expect(
      createTrackContext(
        baseSecureTrack({ encryptionScheme: undefined }),
        { keyResolver }
      )
    ).rejects.toBeInstanceOf(TrackSecurityError);
  });

  it('rejects when cipherSuite is missing', async () => {
    await expect(
      createTrackContext(
        baseSecureTrack({ cipherSuite: undefined }),
        { keyResolver }
      )
    ).rejects.toBeInstanceOf(TrackSecurityError);
  });

  it('rejects when namespace cannot be inferred', async () => {
    await expect(
      createTrackContext(
        baseSecureTrack({ namespace: undefined }),
        { keyResolver }
      )
    ).rejects.toBeInstanceOf(TrackSecurityError);
  });

  it('rejects when keyResolver returns nothing usable', async () => {
    await expect(
      createTrackContext(baseSecureTrack(), {
        keyResolver: () => new Uint8Array(0),
      })
    ).rejects.toBeInstanceOf(TrackSecurityError);
  });
});

describe('MsfSecurityGateway round-trip', () => {
  const rawKey = new Uint8Array(16).fill(0x22);
  const keyResolver = () => rawKey;

  it('seals then opens a payload', async () => {
    const gw = await MsfSecurityGateway.forTrack(baseSecureTrack(), {
      keyResolver,
    });
    const plaintext = new TextEncoder().encode('hello moq');
    const location = { groupId: 42n, objectId: 0 };

    const sealed = await gw.sealForPublish(plaintext, location);
    expect(sealed.ciphertext.length).toBeGreaterThan(plaintext.length);
    expect(sealed.encryptedPropertiesExtension).toBeUndefined();

    const opened = await gw.openFromSubscribe(sealed.ciphertext, location);
    expect(new TextDecoder().decode(opened.plaintext)).toBe('hello moq');
  });

  it('carries encrypted properties through a Type-0xA extension', async () => {
    const gw = await MsfSecurityGateway.forTrack(baseSecureTrack(), {
      keyResolver,
    });
    const plaintext = new TextEncoder().encode('body');
    const props = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const location = { groupId: 1n, objectId: 0 };

    const sealed = await gw.sealForPublish(plaintext, location, props);
    expect(sealed.encryptedPropertiesExtension).toBeDefined();
    expect(sealed.encryptedPropertiesExtension?.id).toBe(
      ENCRYPTED_PROPERTIES_EXTENSION_ID
    );
    expect(sealed.encryptedPropertiesExtension?.id).toBe(
      PropertyType.ENCRYPTED_PROPERTIES
    );
    expect(Array.from(sealed.encryptedPropertiesExtension!.data)).toEqual(
      Array.from(props)
    );

    const opened = await gw.openFromSubscribe(sealed.ciphertext, location);
    expect(new TextDecoder().decode(opened.plaintext)).toBe('body');
    expect(opened.encryptedProperties).toBeDefined();
    expect(Array.from(opened.encryptedProperties!)).toEqual(Array.from(props));
  });

  it('fails to decrypt with a different location (AEAD binds groupId/objectId)', async () => {
    const gw = await MsfSecurityGateway.forTrack(baseSecureTrack(), {
      keyResolver,
    });
    const plaintext = new TextEncoder().encode('lorem');
    const sealed = await gw.sealForPublish(plaintext, {
      groupId: 5n,
      objectId: 0,
    });
    await expect(
      gw.openFromSubscribe(sealed.ciphertext, { groupId: 5n, objectId: 1 })
    ).rejects.toBeTruthy();
  });
});
