# Certificate Generation

This directory contains certificates for local development with WebTransport. The certificates are **not committed to the repository** for security reasons.

## Quick Start

Generate development certificates by running:

```bash
./scripts/create_server_cert.sh
```

This will create:
- `certs/certificate.key` - EC private key (P-384 curve)
- `certs/certificate.pem` - Self-signed certificate
- `certs/certificate_fingerprint.hex` - SHA-256 fingerprint for WebTransport

The script also copies the certificate and fingerprint to:
- `packages/client/public/`
- `packages/moqt-client/public/`

## Requirements

### Chrome WebTransport Requirements

Chrome has strict requirements for self-signed certificates used with WebTransport:

1. **Maximum validity**: 14 days (the script uses 12 days to be safe)
2. **EC key with P-384 curve**: Required for WebTransport
3. **SHA-384 signature**: Must use SHA-384 hash algorithm

### Optional: faketime

To avoid timezone issues between certificate generation (UTC) and Chrome validation (local time), install `faketime`:

```bash
# macOS
brew install libfaketime

# Ubuntu/Debian
apt-get install faketime
```

The script will use `faketime` if available to backdate the certificate by 1 day.

## Manual Generation

If you prefer to generate certificates manually:

```bash
# Generate EC private key
openssl ecparam -name secp384r1 -genkey -out certs/certificate.key

# Generate self-signed certificate (valid for 12 days)
openssl req -new -x509 \
  -days 12 \
  -subj '/CN=Test Certificate' \
  -addext "subjectAltName = DNS:localhost" \
  -key certs/certificate.key \
  -sha384 \
  -out certs/certificate.pem

# Generate SHA-256 fingerprint (binary format for WebTransport)
openssl x509 -in certs/certificate.pem -outform der | \
  openssl dgst -sha256 -binary > certs/certificate_fingerprint.hex
```

## Usage in Code

### Server-Side (moq-rs or similar relay)

Configure your MOQT relay to use the generated certificate:

```bash
# Example with moq-rs
moq-relay --cert certs/certificate.pem --key certs/certificate.key
```

### Client-Side (WebTransport)

The client needs the certificate fingerprint for WebTransport connections:

```typescript
// Fetch the fingerprint
const response = await fetch('/certificate_fingerprint.hex');
const fingerprint = await response.arrayBuffer();

// Connect with certificate hash
const transport = new WebTransport(url, {
  serverCertificateHashes: [{
    algorithm: 'sha-256',
    value: fingerprint,
  }],
});
```

## Certificate Expiry

Certificates are only valid for 12 days. When you see connection errors like:

```
ERR_QUIC_HANDSHAKE_FAILED
```

Regenerate the certificates:

```bash
./scripts/create_server_cert.sh
```

## Troubleshooting

### "Certificate expired" errors
Regenerate certificates - they're only valid for 12 days.

### "Invalid certificate" in Chrome
Ensure you're using the P-384 curve and SHA-384 signature. The script handles this automatically.

### Fingerprint mismatch
Make sure the fingerprint file matches the certificate. Regenerate both together using the script.

### Timezone issues
Install `faketime` to backdate certificates and avoid timezone-related validation failures.
