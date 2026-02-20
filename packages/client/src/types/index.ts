// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Local type definitions for the MOQT client
 * These mirror types from moqt-core and moqt-transport
 */

/**
 * Transport connection states
 */
export type TransportState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'closing'
  | 'closed'
  | 'failed';

/**
 * Log levels
 */
export enum LogLevel {
  TRACE = 0,
  DEBUG = 1,
  INFO = 2,
  WARN = 3,
  ERROR = 4,
  SILENT = 5,
}

/**
 * Delivery mode for media
 */
export enum DeliveryMode {
  STREAM = 0,
  DATAGRAM = 1,
}
