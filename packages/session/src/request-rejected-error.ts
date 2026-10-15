// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/** Where a REDIRECT asks the requester to retry (draft-22 §9.4.1) */
export interface RequestRedirect {
  /** URI to connect to; empty means the current session's URI */
  connectUri: string;
  trackNamespace: string[];
  /** Empty for a namespace-scoped request */
  trackName: string;
}

/**
 * A request the peer answered with REQUEST_ERROR. `errorCode` is the wire code
 * (draft-22 §12.3, e.g. INVALID_FILTER or CONFLICTING_FILTERS), so callers can
 * branch on it instead of parsing the message.
 *
 * `retryAfterMs` is the minimum wait before sending the request again; it is
 * undefined when the peer says the request should not be retried (Retry
 * Interval 0, draft-22 §9.4.2). `redirect` is set for the REDIRECT code.
 */
export class RequestRejectedError extends Error {
  readonly errorCode: number;
  readonly reasonPhrase: string;
  readonly retryAfterMs?: number;
  readonly redirect?: RequestRedirect;

  constructor(
    message: string,
    errorCode: number,
    reasonPhrase: string,
    retryAfterMs?: number,
    redirect?: RequestRedirect,
  ) {
    super(message);
    this.name = 'RequestRejectedError';
    this.errorCode = errorCode;
    this.reasonPhrase = reasonPhrase;
    this.retryAfterMs = retryAfterMs;
    this.redirect = redirect;
  }
}
