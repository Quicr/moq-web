// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Transport Worker Exports
 *
 * Exports for the transport worker functionality.
 * The worker itself is exported as a separate entry point for applications.
 */

// Client API
export { TransportWorkerClient } from './transport-worker-api.js';
export type { TransportWorkerConfig, TransportState } from './transport-worker-api.js';

// Type definitions
export type {
  TransportWorkerRequest,
  TransportWorkerResponse,
} from './transport-worker-types.js';
