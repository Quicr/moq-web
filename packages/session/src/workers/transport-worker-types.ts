// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Transport Worker Type Definitions
 *
 * Message types for communication between main thread and transport worker.
 * The transport worker runs WebTransport connection in a dedicated worker thread.
 */

/**
 * Transport state
 */
export type TransportState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'closing'
  | 'closed'
  | 'failed';

/**
 * Worker configuration for connecting to relay
 */
export interface TransportWorkerConfig {
  /** WebTransport URL (must start with https://) */
  url: string;
  /**
   * MOQT draft version the worker should speak. String selector so the
   * config is structured-cloneable across the postMessage boundary.
   * Defaults to 'draft-16' in the worker when omitted.
   */
  draft?: 'draft-16' | 'draft-17' | 'draft-18';
  /** Server certificate hashes for self-signed certs */
  serverCertificateHashes?: ArrayBuffer[];
  /** Connection timeout in ms (default: 300000 = 5 minutes) */
  connectionTimeout?: number;
  /** Maximum datagram size in bytes (default: 1200) */
  maxDatagramSize?: number;
  /** Enable debug logging */
  debug?: boolean;
}

/**
 * Messages from main thread to worker
 */
export type TransportWorkerRequest =
  | { type: 'connect'; config: TransportWorkerConfig }
  | { type: 'disconnect'; code?: number; reason?: string }
  | { type: 'send-control'; data: Uint8Array }
  | { type: 'send-datagram'; data: Uint8Array }
  | { type: 'create-stream'; id: number }
  | { type: 'create-bidi-stream'; id: number }
  | { type: 'write-stream'; streamId: number; data: Uint8Array; close?: boolean }
  | { type: 'close-stream'; streamId: number };

/**
 * A single metric event forwarded from the transport worker to the main
 * thread. Workers can't share a `MetricsSink` object across the boundary, so
 * we serialize each `counter/gauge/histogram` call and replay it against the
 * main-thread sink in `TransportWorkerClient`.
 *
 * Wave 2 Track E — introduced so the worker can emit
 * `moq.transport.stream.*` / `moq.transport.bytes_*` /
 * `moq.transport.datagram.*` counters against the session's `MetricsSink`.
 */
export interface TransportWorkerMetricEvent {
  kind: 'counter' | 'gauge' | 'histogram';
  name: string;
  value: number;
  attrs?: Record<string, string>;
}

/**
 * Messages from worker to main thread
 */
export type TransportWorkerResponse =
  | { type: 'ready' }
  | { type: 'connected' }
  | { type: 'disconnected'; reason?: string; closeCode?: number; remote?: boolean }
  | { type: 'state-change'; state: TransportState }
  | { type: 'control-message'; data: Uint8Array }
  | { type: 'setup-message'; data: Uint8Array }
  | { type: 'datagram'; data: Uint8Array }
  | { type: 'stream-created'; id: number; streamId: number }
  | { type: 'bidi-stream-created'; id: number; streamId: number }
  | { type: 'bidi-stream-data'; streamId: number; data: Uint8Array }
  | { type: 'incoming-stream'; streamId: number }
  | { type: 'incoming-bidi-stream'; streamId: number }
  | { type: 'stream-data'; streamId: number; data: Uint8Array }
  | { type: 'stream-closed'; streamId: number }
  | { type: 'metric'; metric: TransportWorkerMetricEvent }
  | { type: 'error'; message: string; code?: number };

/**
 * Stream info tracked by worker
 */
export interface StreamInfo {
  id: number;
  writer: WritableStreamDefaultWriter<Uint8Array>;
}
