// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview CAT/C4M auth provider entry point.
 *
 * Import via `@moq-web/msf/auth-cat` to opt into the `@moq-web/cat`
 * dependency without pulling it into core MSF.
 */

export {
  CatAuthProvider,
  createCatAuthProvider,
  type CatAuthProviderOptions,
  type CatDpopSigningOptions,
  type CatDpopProof,
} from './provider.js';
