# @web-moq/secure-objects

WebCrypto-based end-to-end encryption for Media over QUIC Transport (MOQT).

Implements [draft-ietf-moq-secure-objects](https://datatracker.ietf.org/doc/draft-ietf-moq-secure-objects/) for encrypting MOQT objects with authenticated encryption and AAD (Additional Authenticated Data) binding.

## Features

- **High Performance**: 1GB/s+ encryption/decryption throughput using WebCrypto
- **Zero-Copy Design**: Minimizes memory allocations for real-time media
- **All Cipher Suites**: AES-128/256-GCM and AES-128-CTR-HMAC variants
- **AAD Binding**: Cryptographically binds ciphertext to track, group, and object IDs
- **Secure Key Derivation**: HKDF-based key derivation with track-specific labels

## Installation

```bash
pnpm add @web-moq/secure-objects
```

## Quick Start

```typescript
import { SecureObjectsContext, CipherSuite } from '@web-moq/secure-objects';

// Create encryption context with a track base key
const ctx = await SecureObjectsContext.create({
  trackBaseKey: yourSecretKey,  // Uint8Array (16-32 bytes)
  track: {
    namespace: ['conference', 'room-1'],
    trackName: 'video',
  },
  cipherSuite: CipherSuite.AES_128_GCM_SHA256_128, // Optional, this is default
  keyId: 0n, // Optional, for key rotation
});

// Encrypt an object
const encrypted = await ctx.encrypt(
  plaintext,  // Uint8Array
  { groupId: 0n, objectId: 0 }
);

// Decrypt an object
const decrypted = await ctx.decrypt(
  encrypted.ciphertext,
  { groupId: 0n, objectId: 0 }
);

console.log(decrypted.plaintext); // Original data
```

## Cipher Suites

| ID | Name | Key Size | Tag Size | Recommended |
|---|---|---|---|---|
| 0x0001 | AES_128_CTR_HMAC_SHA256_80 | 48B | 10B | Yes |
| 0x0002 | AES_128_CTR_HMAC_SHA256_64 | 48B | 8B | Yes |
| 0x0003 | AES_128_CTR_HMAC_SHA256_32 | 48B | 4B | No |
| 0x0004 | AES_128_GCM_SHA256_128 | 16B | 16B | Yes (default) |
| 0x0005 | AES_256_GCM_SHA512_128 | 32B | 16B | Yes |

**Recommendation**: Use `AES_128_GCM_SHA256_128` for best performance with WebCrypto.

## API Reference

### `SecureObjectsContext.create(config)`

Creates an encryption/decryption context.

```typescript
interface EncryptionConfig {
  trackBaseKey: Uint8Array;  // Secret key material
  track: {
    namespace: string[];     // Track namespace tuple
    trackName: string;       // Track name
  };
  cipherSuite?: CipherSuite; // Default: AES_128_GCM_SHA256_128
  keyId?: bigint;            // Default: 0n
}
```

### `ctx.encrypt(plaintext, objectId, encryptedProperties?)`

Encrypts data with AAD binding to the object identifier.

```typescript
const result = await ctx.encrypt(
  plaintext,           // Uint8Array
  { groupId, objectId },
  encryptedProperties  // Optional Uint8Array
);
// result.ciphertext: Uint8Array
// result.keyId: bigint
// result.cipherSuite: CipherSuite
```

### `ctx.decrypt(ciphertext, objectId)`

Decrypts and authenticates data.

```typescript
const result = await ctx.decrypt(ciphertext, { groupId, objectId });
// result.plaintext: Uint8Array
// result.encryptedProperties?: Uint8Array
```

### `ctx.verifyAAD(ciphertext, objectId)`

Verifies authentication without returning plaintext.

```typescript
const isValid = await ctx.verifyAAD(ciphertext, { groupId, objectId });
```

## Key Derivation

Keys are derived using HKDF with track-specific labels:

```
moq_secret = HKDF-Extract("", track_base_key)
encryption_key = HKDF-Expand(moq_secret, key_label, key_length)
salt = HKDF-Expand(moq_secret, salt_label, 12)
```

Labels include the serialized track name, cipher suite ID, and key ID to ensure unique keys per track and key rotation epoch.

## Nonce Construction

Nonces are constructed by XORing the derived salt with the counter:

```
CTR = groupId (64 bits) || objectId (32 bits)
nonce = salt XOR CTR
```

## AAD Format

Additional Authenticated Data includes:
- Key ID
- Group ID
- Object ID
- Track namespace
- Track name
- Key ID property (immutable)

This binds the ciphertext to the specific object location, preventing replay attacks.

## Performance

Benchmarks on Apple M1 (Node.js 20):

| Operation | 1KB | 16KB | 64KB |
|---|---|---|---|
| AES-GCM Encrypt | 30 MB/s | 500 MB/s | 1.2 GB/s |
| AES-GCM Decrypt | 45 MB/s | 280 MB/s | 1.0 GB/s |
| AES-CTR-HMAC Encrypt | - | - | 500 MB/s |

Frame processing time is well under 1ms for typical video frame sizes.

## Security Considerations

- **Key Management**: Track base keys must be distributed securely out-of-band
- **Key Rotation**: Use different `keyId` values for key rotation epochs
- **Limits**: Respect AEAD operation limits per key (see draft-irtf-cfrg-aead-limits)
- **Constant Time**: HMAC verification uses constant-time comparison

## License

BSD-2-Clause
