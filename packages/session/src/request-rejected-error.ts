// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * A request the peer answered with REQUEST_ERROR. `errorCode` is the wire code
 * (draft-22 §12.3, e.g. INVALID_FILTER or CONFLICTING_FILTERS), so callers can
 * branch on it instead of parsing the message.
 */
export class RequestRejectedError extends Error {
  readonly errorCode: number;
  readonly reasonPhrase: string;

  constructor(message: string, errorCode: number, reasonPhrase: string) {
    super(message);
    this.name = 'RequestRejectedError';
    this.errorCode = errorCode;
    this.reasonPhrase = reasonPhrase;
  }
}
