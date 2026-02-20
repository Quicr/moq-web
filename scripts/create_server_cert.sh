#!/usr/bin/env bash

# Copyright (c) Meta Platforms, Inc. and affiliates.
# This source code is licensed under the MIT license found in the
# LICENSE file in the root directory of this source tree.

# Create certs dir if it does not exist
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CERTS_DIR="$SCRIPT_DIR/../certs"
PUBLIC_DIR_MOQT="$SCRIPT_DIR/../packages/moqt-client/public"
PUBLIC_DIR_CLIENT="$SCRIPT_DIR/../packages/client/public"
mkdir -p "$CERTS_DIR"
mkdir -p "$PUBLIC_DIR_MOQT"
mkdir -p "$PUBLIC_DIR_CLIENT"

KEY_FILE="$CERTS_DIR/certificate.key"
CERT_FILE="$CERTS_DIR/certificate.pem"
FINGERPRINT_FILE="$CERTS_DIR/certificate_fingerprint.hex"

# Generate EC private key using secp384r1 (P-384) curve
# This is what Chrome expects for WebTransport self-signed certs
openssl ecparam -name secp384r1 -genkey -out "$KEY_FILE"

# Generate self-signed certificate
# IMPORTANT: Chrome requires validity <= 14 days (we use 12 to be safe)
# Use faketime to backdate by 1 day to avoid timezone issues
# (Chrome validates against local time, but OpenSSL uses UTC)
if command -v faketime &> /dev/null; then
  faketime -f '-1d' openssl req -new -x509 \
    -days 12 \
    -subj '/CN=Test Certificate' \
    -addext "subjectAltName = DNS:localhost" \
    -key "$KEY_FILE" \
    -sha384 \
    -out "$CERT_FILE"
else
  echo "Warning: faketime not installed. Certificate may have timezone issues."
  echo "Install with: brew install libfaketime"
  openssl req -new -x509 \
    -days 12 \
    -subj '/CN=Test Certificate' \
    -addext "subjectAltName = DNS:localhost" \
    -key "$KEY_FILE" \
    -sha384 \
    -out "$CERT_FILE"
fi

# Generate SHA-256 fingerprint as raw binary
# This is what WebTransport's serverCertificateHashes expects
openssl x509 -in "$CERT_FILE" -outform der | \
  openssl dgst -sha256 -binary > "$FINGERPRINT_FILE"

# Copy cert and fingerprint to public folders for the clients to fetch
cp "$CERT_FILE" "$PUBLIC_DIR_MOQT/"
cp "$FINGERPRINT_FILE" "$PUBLIC_DIR_MOQT/"
cp "$CERT_FILE" "$PUBLIC_DIR_CLIENT/"
cp "$FINGERPRINT_FILE" "$PUBLIC_DIR_CLIENT/"

echo "Certificate generated:"
openssl x509 -in "$CERT_FILE" -noout -dates
echo ""
echo "Certificate fingerprint (base64):"
cat "$FINGERPRINT_FILE" | base64
echo ""
echo "Files created:"
echo "  - $KEY_FILE"
echo "  - $CERT_FILE"
echo "  - $FINGERPRINT_FILE"
echo "  - $PUBLIC_DIR_MOQT/certificate.pem"
echo "  - $PUBLIC_DIR_CLIENT/certificate.pem"
