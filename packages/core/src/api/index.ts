// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Unified Public API
 *
 * Re-exports all public API types and utilities.
 */

// Types
export * from './types.js';

// Codec adapters
export {
  capabilitiesFor,
  currentVersionFor,
  subscribeRequestToWire,
  subscribeResponseFromWire,
  publishRequestToWire,
  publishResponseFromWire,
  fetchRequestToWire,
  fetchResponseFromWire,
  subscribeNamespaceRequestToWire,
  publishNamespaceRequestToWire,
  errorFromWire,
} from './codec.js';
