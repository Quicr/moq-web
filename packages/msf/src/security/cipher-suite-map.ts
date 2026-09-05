// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Bridge between MSF `cipherSuite` catalog strings (§15 Table 6)
 * and the numeric `CipherSuite` enum from `@moq-web/secure-objects`.
 */

import { CipherSuite as SoCipherSuite } from '@moq-web/secure-objects';
import type { CipherSuite as MsfCipherSuite } from '../schemas/index.js';

/**
 * MSF Table 6 → secure-objects enum mapping.
 *
 * MSF §15 defines three MUST-implement / MAY suites, all of which map onto
 * the extended set in `moq-secure-objects`. The suites not surfaced by MSF
 * (weaker tag lengths) are intentionally omitted.
 */
export const MSF_TO_SO_CIPHER_SUITE: Record<
  MsfCipherSuite,
  SoCipherSuite
> = {
  'aes-128-gcm-sha256': SoCipherSuite.AES_128_GCM_SHA256_128,
  'aes-256-gcm-sha512': SoCipherSuite.AES_256_GCM_SHA512_128,
  'aes-128-ctr-hmac-sha256-80': SoCipherSuite.AES_128_CTR_HMAC_SHA256_80,
};

/**
 * Reverse map: secure-objects enum → MSF Table 6 identifier.
 * Only the MSF-recognised suites are represented; other enum values throw.
 */
export const SO_TO_MSF_CIPHER_SUITE: Partial<
  Record<SoCipherSuite, MsfCipherSuite>
> = {
  [SoCipherSuite.AES_128_GCM_SHA256_128]: 'aes-128-gcm-sha256',
  [SoCipherSuite.AES_256_GCM_SHA512_128]: 'aes-256-gcm-sha512',
  [SoCipherSuite.AES_128_CTR_HMAC_SHA256_80]: 'aes-128-ctr-hmac-sha256-80',
};

export class CipherSuiteMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CipherSuiteMappingError';
  }
}

/**
 * Look up the numeric secure-objects suite for an MSF cipher-suite string.
 */
export function toSoCipherSuite(msf: MsfCipherSuite): SoCipherSuite {
  const s = MSF_TO_SO_CIPHER_SUITE[msf];
  if (s === undefined) {
    throw new CipherSuiteMappingError(
      `MSF cipherSuite '${msf}' has no @moq-web/secure-objects equivalent`
    );
  }
  return s;
}

/**
 * Look up the MSF cipher-suite string for a numeric secure-objects suite.
 * Throws if the suite isn't in MSF Table 6.
 */
export function toMsfCipherSuite(so: SoCipherSuite): MsfCipherSuite {
  const s = SO_TO_MSF_CIPHER_SUITE[so];
  if (s === undefined) {
    throw new CipherSuiteMappingError(
      `secure-objects suite ${so} is not one of the MSF Table 6 identifiers`
    );
  }
  return s;
}
