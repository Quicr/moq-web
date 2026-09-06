// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Pluggable auth provider surface (MSF §17).
 *
 * Apps register {@link AuthProvider}s for the schemes they support and hand
 * the registry to `MSFSession` at construction time. MSF stays agnostic of
 * any particular token format; concrete providers (CAT/CBOR, Privacy Pass,
 * OAuth) live in companion modules that compose this interface.
 */

export {
  AuthProviderRegistry,
  MissingAuthProviderError,
  type AuthProvider,
  type AuthContext,
  type AuthAction,
  type AuthToken,
  type AuthValidationResult,
} from './provider.js';
