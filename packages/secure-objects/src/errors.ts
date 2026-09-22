// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Structured error types for @moq-web/secure-objects.
 *
 * Callers can branch on `instanceof` instead of parsing error message
 * strings, which is fragile and locale-dependent.  All errors extend
 * {@link SecureObjectsError} so a catch-all can still filter this
 * package's failures out of unrelated exceptions.
 */

export class SecureObjectsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** AEAD tag / HMAC verification failed. */
export class AuthenticationError extends SecureObjectsError {}

/** A (groupId, objectId) pair was reused within the recent-nonce window. */
export class NonceReuseError extends SecureObjectsError {}

/** Attempt to use a context after {@link SecureObjectsContext.dispose}. */
export class DisposedError extends SecureObjectsError {}

/** Ciphertext framing is malformed (too short, bad varint, length overrun). */
export class InvalidFramingError extends SecureObjectsError {}

/** Encryption invocation cap (2^32) reached; caller must rotate keys. */
export class EncryptionLimitError extends SecureObjectsError {}
