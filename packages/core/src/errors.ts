// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview MoqError hierarchy for the public API.
 *
 * A single base class (`MoqError`) tagged with a machine-readable `code`
 * plus a small set of specializations covering the categories the public
 * surface can throw. Consumers can `instanceof MoqError` for coarse
 * classification and inspect `code` for fine-grained handling.
 *
 * All errors preserve the underlying cause via the standard
 * `ErrorOptions.cause` field (ES2022).
 */

/**
 * Base error class for the MoQ Web public API.
 *
 * Every error thrown from a public method should extend this class so that
 * downstream integrators can rely on `instanceof MoqError` and on a stable
 * `code` field for programmatic branching.
 */
export class MoqError extends Error {
  /** Stable, machine-readable error code (e.g. "MOQ_TIMEOUT"). */
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions | undefined);
    this.code = code;
    this.name = new.target.name;
    // Restore prototype chain for older TypeScript targets.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Codec / wire-format errors — malformed messages, unsupported types, etc.
 */
export class MoqCodecError extends MoqError {
  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(code, message, options);
  }
}

/**
 * Session lifecycle / protocol errors — invalid state, GOAWAY, close.
 */
export class MoqSessionError extends MoqError {
  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(code, message, options);
  }
}

/**
 * Timeout errors — awaited response never arrived within budget.
 */
export class MoqTimeoutError extends MoqError {
  constructor(message = 'operation timed out', options?: { cause?: unknown }) {
    super('MOQ_TIMEOUT', message, options);
  }
}

/**
 * Aborted-operation error — surfaced when the caller-supplied AbortSignal
 * fires before the operation completes.
 */
export class MoqAbortError extends MoqError {
  constructor(message = 'operation aborted', options?: { cause?: unknown }) {
    super('MOQ_ABORTED', message, options);
  }
}
